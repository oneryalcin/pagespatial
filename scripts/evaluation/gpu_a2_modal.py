#!/usr/bin/env python3
"""Bounded end-to-end A2 benchmark: up to four Tiny/Small FP32 TensorRT owners.

This is an evaluation adapter, not the production Modal deployment. Four Node
producer processes execute the real render/native stages and feed this class's
bounded persistent GPU objects through a bounded JSONL queue. The Node controller
then runs the real PageSpatial assembly stage.

Typical bounded run:

  modal run scripts/evaluation/gpu_a2_modal.py \
    --pdf-path .evaluation/gpu-spike/a2-50page-v1.pdf \
    --out-dir .evaluation/gpu-spike/2026-08-24/a2 \
    --repeats 4
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import queue
import signal
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import modal

# Refuse before importing/constructing the TensorRT image. That imported image
# contains a paid GPU build step, so validating inside the local entrypoint is
# too late.
if modal.is_local():
    from gpu_a2_budget import DEFAULT_LEDGER, validate_reservation

    _reservation_id = os.environ.get("PAGESPATIAL_A2_RESERVATION", "")
    _ledger_path = Path(os.environ.get("PAGESPATIAL_A2_LEDGER", str(DEFAULT_LEDGER)))
    if not _reservation_id:
        raise RuntimeError("PAGESPATIAL_A2_RESERVATION is required before image construction")
    validate_reservation(_ledger_path, _reservation_id, "E1-GPU")

from gpu_spike_modal import (
    GPU_TYPE,
    MODEL_MANIFEST,
    REMOTE_ROOT,
    _GpuSampler,
    _attest_backend,
    _backend_lines,
    _capture_native_output,
    _construct_ocr,
    _device_truth,
    _installed_versions,
    _instrument_batch_samplers,
    _source_state,
    _walk_interesting_attrs,
)


# These values are part of the measured A2 arm identity. Keep them available
# without importing the image-construction harness in a remote container: a
# class-hydration import failure can otherwise make Modal repeatedly allocate
# the requested GPU before user code gets a chance to fail or clean up.
ULTRA_INFER_SOURCE_REV = "ffb64904d23708863ff5b8da312a5cbd52a7f462"
ULTRA_INFER_PATCH_SHA256 = (
    "b03632bbfae1372f21a2e31babbf72f8936943a0848ff3db853a2f1cd5216bd6"
)

if modal.is_local():
    from gpu_spike_trt_modal import (
        ULTRA_INFER_PATCH_SHA256 as SPIKE_ULTRA_INFER_PATCH_SHA256,
        ULTRA_INFER_SOURCE_REV as SPIKE_ULTRA_INFER_SOURCE_REV,
        trt_image,
    )

    if (
        SPIKE_ULTRA_INFER_SOURCE_REV != ULTRA_INFER_SOURCE_REV
        or SPIKE_ULTRA_INFER_PATCH_SHA256 != ULTRA_INFER_PATCH_SHA256
    ):
        raise RuntimeError("A2 TensorRT source identity drifted from the spike harness")
else:
    # The deployed function already has its server-side image assignment. This
    # placeholder only lets Modal import the source module during hydration.
    trt_image = modal.Image.debian_slim(python_version="3.10")


APP_NAME = os.environ.get("PAGESPATIAL_A2_APP_NAME", "pagespatial-gpu-a2-e2e-m1")
if modal.is_local() and not APP_NAME.startswith("pagespatial-gpu-a2-"):
    raise RuntimeError("A2 app name must start with pagespatial-gpu-a2-")
CPU_CORES = 4.0
MEMORY_MIB = 24576
MAX_INPUT_BYTES = 90 * 1024 * 1024
EXPECTED_PAGES = 50
METHOD_TIMEOUT_S = 1200
MAX_RESULT_BYTES = 64 * 1024 * 1024
NODE_VERSION = "26.0.0"
NODE_LINUX_X64_SHA256 = (
    "345d558514c62622b5c7d1f7b5f2a19c31ab1405d217df49f010c5ea8decc0f4"
)
RECOGNITION_BATCH_SIZE = int(
    os.environ.get("PAGESPATIAL_A2_RECOGNITION_BATCH_SIZE", "1")
)
if RECOGNITION_BATCH_SIZE not in {1, 4, 8}:
    raise ValueError("PAGESPATIAL_A2_RECOGNITION_BATCH_SIZE must be 1, 4, or 8")
INFERENCE_OWNERS = int(os.environ.get("PAGESPATIAL_A2_INFERENCE_OWNERS", "1"))
if INFERENCE_OWNERS not in {1, 2, 4}:
    raise ValueError("PAGESPATIAL_A2_INFERENCE_OWNERS must be 1, 2, or 4")
MODEL_TIER = os.environ.get("PAGESPATIAL_A2_MODEL_TIER", "small")
if MODEL_TIER not in {"tiny", "small"}:
    raise ValueError("PAGESPATIAL_A2_MODEL_TIER must be tiny or small")
STAGE_PROFILE = os.environ.get("PAGESPATIAL_A2_STAGE_PROFILE", "0") == "1"
SPLIT_RECOGNITION = os.environ.get("PAGESPATIAL_A2_SPLIT_RECOGNITION", "0") == "1"
if STAGE_PROFILE and (
    MODEL_TIER != "tiny"
    or RECOGNITION_BATCH_SIZE != 1
    or INFERENCE_OWNERS != 2
):
    raise ValueError("stage profiling is bounded to Tiny B1 with two owners")
if SPLIT_RECOGNITION and (
    MODEL_TIER != "tiny"
    or RECOGNITION_BATCH_SIZE != 1
    or INFERENCE_OWNERS != 2
):
    raise ValueError("split recognition is bounded to Tiny B1 with two owners")
if STAGE_PROFILE and SPLIT_RECOGNITION:
    raise ValueError("stage profiling and split recognition are separate A3 arms")

if modal.is_local():
    REPO_ROOT = Path(__file__).resolve().parents[2]
else:
    REPO_ROOT = Path("/app")

CONTROLLER = REPO_ROOT / "scripts/evaluation/gpu_a2_controller.mjs"
STAGE_PROFILER = REPO_ROOT / "scripts/evaluation/gpu_a3_stage_profile.py"
SPLIT_RECOGNITION_ADAPTER = (
    REPO_ROOT / "scripts/evaluation/gpu_a3_split_recognition.py"
)
WORKLOAD_MANIFEST = REPO_ROOT / "evaluation/gpu-spike/a2-50page-v1.json"

app = modal.App(APP_NAME)


def _process_group_exists(process_group_id: int) -> bool:
    try:
        os.killpg(process_group_id, 0)
        return True
    except ProcessLookupError:
        return False


def _stop_process_group(controller: subprocess.Popen[str], grace_s: float = 10.0) -> None:
    """Close the protocol, allow normal cleanup, then kill the whole tree."""
    process_group_id = controller.pid
    try:
        if controller.stdin is not None and not controller.stdin.closed:
            controller.stdin.close()
    except Exception:
        pass
    deadline = time.monotonic() + grace_s
    while time.monotonic() < deadline and _process_group_exists(process_group_id):
        if controller.poll() is None:
            time.sleep(0.05)
        else:
            time.sleep(0.05)
    if _process_group_exists(process_group_id):
        os.killpg(process_group_id, signal.SIGKILL)
    try:
        controller.wait(timeout=5)
    except subprocess.TimeoutExpired:
        controller.kill()
        controller.wait(timeout=5)
    if _process_group_exists(process_group_id):
        raise RuntimeError("A2 controller process group did not drain")


def _node_install_command() -> str:
    archive = f"node-v{NODE_VERSION}-linux-x64.tar.xz"
    return (
        "set -eu; "
        f"curl -fsSLo /tmp/{archive} https://nodejs.org/dist/v{NODE_VERSION}/{archive}; "
        f"echo '{NODE_LINUX_X64_SHA256}  /tmp/{archive}' | sha256sum -c -; "
        "mkdir -p /opt/node; "
        f"tar -xJf /tmp/{archive} --strip-components=1 -C /opt/node; "
        f"rm /tmp/{archive}; "
        "/opt/node/bin/node --version"
    )


if modal.is_local():
    a2_image = (
        trt_image
        .apt_install("curl", "xz-utils", "poppler-utils", "tesseract-ocr")
        .run_commands(_node_install_command())
        .add_local_file(str(REPO_ROOT / "package.json"), "/app/package.json", copy=True)
        .add_local_file(str(REPO_ROOT / "package-lock.json"), "/app/package-lock.json", copy=True)
        .run_commands("cd /app && PATH=/opt/node/bin:$PATH /opt/node/bin/npm ci")
        .add_local_file(str(REPO_ROOT / "tsconfig.json"), "/app/tsconfig.json", copy=True)
        .add_local_dir(str(REPO_ROOT / "src"), "/app/src", copy=True)
        .add_local_dir(str(REPO_ROOT / "schemas"), "/app/schemas", copy=True)
        .add_local_file(
            str(REPO_ROOT / "scripts/generate-schema.mjs"),
            "/app/scripts/generate-schema.mjs",
            copy=True,
        )
        .run_commands("cd /app && PATH=/opt/node/bin:$PATH /opt/node/bin/npm run build")
        .add_local_dir(str(REPO_ROOT / "service"), "/app/service", copy=True)
        .add_local_file(str(CONTROLLER), "/app/scripts/evaluation/gpu_a2_controller.mjs", copy=True)
        .add_local_file(str(STAGE_PROFILER), "/root/gpu_a3_stage_profile.py", copy=True)
        .add_local_file(
            str(SPLIT_RECOGNITION_ADAPTER),
            "/root/gpu_a3_split_recognition.py",
            copy=True,
        )
        .add_local_file(
            str(WORKLOAD_MANIFEST),
            "/app/evaluation/gpu-spike/a2-50page-v1.json",
            copy=True,
        )
        .env(
            {
                "PATH": (
                    "/opt/node/bin:/usr/local/sbin:/usr/local/bin:"
                    "/usr/sbin:/usr/bin:/sbin:/bin"
                ),
                "PAGESPATIAL_A2_RECOGNITION_BATCH_SIZE": str(
                    RECOGNITION_BATCH_SIZE
                ),
                "PAGESPATIAL_A2_INFERENCE_OWNERS": str(INFERENCE_OWNERS),
                "PAGESPATIAL_A2_MODEL_TIER": MODEL_TIER,
                "PAGESPATIAL_A2_STAGE_PROFILE": "1" if STAGE_PROFILE else "0",
                "PAGESPATIAL_A2_SPLIT_RECOGNITION": (
                    "1" if SPLIT_RECOGNITION else "0"
                ),
            }
        )
    )
else:
    a2_image = modal.Image.debian_slim(python_version="3.10")


ARM = {
    "name": (
        f"g-trt-{MODEL_TIER}-fp32-a2-b{RECOGNITION_BATCH_SIZE}"
        f"c4o{INFERENCE_OWNERS}"
        + ("-profile" if STAGE_PROFILE else "")
        + ("-split-rec" if SPLIT_RECOGNITION else "")
    ),
    "tier": MODEL_TIER,
    "device": "gpu:0",
    "runtime": "hpi-ort-trt",
    "enableHpi": True,
    "precision": "fp32",
    "recognitionBatchSize": RECOGNITION_BATCH_SIZE,
    "pageBatchSize": 1,
    "producerCount": 4,
    "inferenceOwners": INFERENCE_OWNERS,
    "requiredBackendTokens": ["onnxruntime", "tensorrt"],
    "providerLayout": {
        "textDetection": "onnxruntime",
        "textRecognition": "tensorrt",
    },
    "deploymentProfile": "en-gpu",
    "stageProfile": STAGE_PROFILE,
    "splitRecognition": SPLIT_RECOGNITION,
}


def _paddle_lines(results: list[Any]) -> list[dict[str, Any]]:
    lines: list[dict[str, Any]] = []
    for result in results:
        data = result if isinstance(result, dict) else result.json.get("res", result.json)
        texts = data.get("rec_texts", [])
        scores = data.get("rec_scores", [])
        polygons = data.get("rec_polys", data.get("dt_polys", []))
        for index, text in enumerate(texts):
            polygon = polygons[index] if index < len(polygons) else None
            if polygon is None:
                raise RuntimeError(f"OCR line {index} has no polygon")
            score = float(scores[index]) if index < len(scores) else None
            if score is None or not 0 <= score <= 1:
                raise RuntimeError(f"OCR line {index} has invalid confidence {score}")
            lines.append(
                {
                    "text": str(text),
                    "score": score,
                    "poly": [[float(point[0]), float(point[1])] for point in polygon],
                }
            )
    return lines


def _numeric_gpu_summary(samples: list[dict[str, Any]]) -> dict[str, Any]:
    util = [sample["gpuUtilPercent"] for sample in samples if sample.get("gpuUtilPercent") is not None]
    memory = [sample["memoryUsedMiB"] for sample in samples if sample.get("memoryUsedMiB") is not None]
    return {
        "samples": samples,
        "medianGpuUtilPercent": statistics.median(util) if util else None,
        "maxGpuUtilPercent": max(util) if util else None,
        "maxMemoryUsedMiB": max(memory) if memory else None,
    }


def _enforce_result_size(result: dict[str, Any]) -> None:
    result["serializedResultBytes"] = 0
    size = len(json.dumps(result, separators=(",", ":")).encode("utf-8"))
    result["serializedResultBytes"] = size
    size = len(json.dumps(result, separators=(",", ":")).encode("utf-8"))
    result["serializedResultBytes"] = size
    if size > MAX_RESULT_BYTES:
        raise RuntimeError(f"ResultTooLarge: {size} bytes exceeds {MAX_RESULT_BYTES}")


def _container_snapshot() -> dict[str, Any]:
    deadline = time.monotonic() + 10
    mine: list[dict[str, Any]] = []
    while time.monotonic() < deadline:
        rows = json.loads(
            subprocess.run(
                ["modal", "container", "list", "--json"],
                check=True,
                capture_output=True,
                text=True,
                timeout=120,
            ).stdout
        )
        mine = [row for row in rows if row.get("app_name") == APP_NAME]
        if len(mine) == 1 and mine[0].get("container_id") and mine[0].get("app_id"):
            return mine[0]
        time.sleep(0.5)
    raise RuntimeError(f"expected one attributable GPU container, found {mine}")


@app.cls(
    image=a2_image,
    gpu=GPU_TYPE,
    cpu=CPU_CORES,
    memory=MEMORY_MIB,
    timeout=METHOD_TIMEOUT_S,
    startup_timeout=1800,
    retries=0,
    min_containers=0,
    buffer_containers=0,
    max_containers=1,
)
class GpuA2Container:
    @modal.enter()
    def start_owner(self) -> None:
        import gpu_spike_modal as harness
        from ultra_infer import code_version

        if code_version.git_version != ULTRA_INFER_SOURCE_REV:
            raise RuntimeError(
                f"patched UltraInfer source mismatch: {code_version.git_version!r} != {ULTRA_INFER_SOURCE_REV!r}"
            )
        source_tier = REMOTE_ROOT / "models" / MODEL_TIER
        self.private_model_root = Path("/tmp/pagespatial-a2-models")
        private_tier = self.private_model_root / MODEL_TIER
        if not private_tier.exists():
            private_tier.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(source_tier, private_tier)
        harness.MODEL_ROOT = self.private_model_root

        self.device_truth = _device_truth()
        all_started = time.monotonic()
        self.ocrs = []
        self.owner_init_per_owner_s = []
        self.startup_backend_attrs_by_owner = []
        self.backend_attrs_by_owner = []
        self.backend_logs_by_owner = []
        self.batch_observations_by_owner = []
        self.stage_profilers = []
        self.stage_profile_identities = []
        self.split_recognition_models = []
        for owner_index in range(INFERENCE_OWNERS):
            owner_started = time.monotonic()
            with _capture_native_output() as log_path:
                ocr = _construct_ocr(ARM)
            native_text = log_path.read_text(errors="replace")
            log_path.unlink(missing_ok=True)
            attrs = _walk_interesting_attrs(ocr)
            effective_recognition_batch = attrs.get(
                "ocr.paddlex_pipeline._pipeline.text_rec_model.batch_sampler.batch_size"
            )
            if effective_recognition_batch != ARM["recognitionBatchSize"]:
                raise RuntimeError(
                    f"recognition batch mismatch before inference for owner {owner_index}: "
                    f"requested {ARM['recognitionBatchSize']}, "
                    f"effective {effective_recognition_batch!r}"
                )
            self.ocrs.append(ocr)
            self.owner_init_per_owner_s.append(time.monotonic() - owner_started)
            self.startup_backend_attrs_by_owner.append(dict(attrs))
            self.backend_attrs_by_owner.append(attrs)
            self.backend_logs_by_owner.append(_backend_lines(native_text))
            # Capture the unwrapped live configuration before installing probes.
            self.batch_observations_by_owner.append(
                _instrument_batch_samplers(ocr, ARM["pageBatchSize"])
            )
            if SPLIT_RECOGNITION:
                from gpu_a3_split_recognition import install_split_recognition

                split_model = install_split_recognition(ocr, queue_depth=2)
                self.split_recognition_models.append(split_model)
            if STAGE_PROFILE:
                from gpu_a3_stage_profile import install_ocr_stage_profiler

                profiler, identity = install_ocr_stage_profiler(ocr, owner_index)
                self.stage_profilers.append(profiler)
                self.stage_profile_identities.append(identity)
            else:
                self.stage_profilers.append(None)
        self.owner_init_s = time.monotonic() - all_started
        # Provider construction is lazy. Final attestation must include the
        # first real workload inference for every owner; construction-only attributes are not
        # accepted as proof that TensorRT actually served a page.
        self.backend_attestations = [None] * INFERENCE_OWNERS
        self.backend_mutations = [None] * INFERENCE_OWNERS
        self.versions = _installed_versions()
        self.model_verification = json.loads(
            (REMOTE_ROOT / "model-verification.json").read_text()
        )[MODEL_TIER]
        self.container_cold = True
        self.first_inference_ms_by_owner: list[float | None] = [None] * INFERENCE_OWNERS

    def _predict_page(
        self, owner_index: int, message: dict[str, Any], *, attest: bool
    ) -> tuple[dict[str, Any], float]:
        queue_wait_ms = max(
            0.0,
            (time.monotonic_ns() - int(message["producedAtNs"])) / 1_000_000,
        )
        import cv2

        profiler = self.stage_profilers[owner_index]
        if profiler is not None:
            profiler.begin_page(int(message["pageNumber"]), str(message["id"]))
        try:
            with (
                profiler.span("png.decode")
                if profiler is not None
                else contextlib.nullcontext()
            ):
                image = cv2.imread(message["pngPath"], cv2.IMREAD_COLOR)
            if image is None:
                raise RuntimeError(
                    f"unreadable controller PNG for page {message['pageNumber']}"
                )
            inference_started = time.monotonic()
            with (
                profiler.span("predict.total")
                if profiler is not None
                else contextlib.nullcontext()
            ):
                if attest:
                    with _capture_native_output() as inference_log_path:
                        results = list(self.ocrs[owner_index].predict(image))
                    inference_text = inference_log_path.read_text(errors="replace")
                    inference_log_path.unlink(missing_ok=True)
                    self.backend_logs_by_owner[owner_index] = [
                        *self.backend_logs_by_owner[owner_index],
                        *_backend_lines(inference_text),
                    ]
                    self.backend_attrs_by_owner[owner_index] = {
                        **self.startup_backend_attrs_by_owner[owner_index],
                        **_walk_interesting_attrs(self.ocrs[owner_index]),
                    }
                    attestation = _attest_backend(
                        ARM,
                        self.device_truth,
                        self.backend_attrs_by_owner[owner_index],
                        self.backend_logs_by_owner[owner_index],
                    )
                    if not attestation["pass"]:
                        raise RuntimeError(
                            f"backend attestation failed for owner {owner_index}: "
                            + "; ".join(attestation["reasons"])
                        )
                    missing_provider = _attest_backend(ARM, self.device_truth, {}, [])
                    wrong_device = _attest_backend(
                        ARM,
                        {
                            **self.device_truth,
                            "paddleDevice": "cpu",
                            "cudaCompiled": False,
                            "nvidiaSmiIdentity": [],
                        },
                        self.backend_attrs_by_owner[owner_index],
                        self.backend_logs_by_owner[owner_index],
                    )
                    if missing_provider["pass"] or wrong_device["pass"]:
                        raise RuntimeError(
                            "backend-attestation mutation unexpectedly passed"
                        )
                    self.backend_attestations[owner_index] = attestation
                    self.backend_mutations[owner_index] = {
                        "missingProviderEvidence": {
                            "pass": True,
                            "reasons": missing_provider["reasons"],
                        },
                        "wrongDevice": {
                            "pass": True,
                            "reasons": wrong_device["reasons"],
                        },
                    }
                else:
                    results = list(self.ocrs[owner_index].predict(image))
            inference_ms = (time.monotonic() - inference_started) * 1000
            with (
                profiler.span("result.decode")
                if profiler is not None
                else contextlib.nullcontext()
            ):
                lines = _paddle_lines(results)
            stage_profile = profiler.finish_page() if profiler is not None else None
        except BaseException:
            if profiler is not None:
                profiler.abort_page()
            raise
        if self.first_inference_ms_by_owner[owner_index] is None:
            self.first_inference_ms_by_owner[owner_index] = inference_ms
        response = {
            "kind": "ocr-result",
            "id": message["id"],
            "lines": lines,
            "inferenceMs": inference_ms,
            "queueWaitMs": queue_wait_ms,
            "ownerIndex": owner_index,
        }
        if stage_profile is not None:
            response["stageProfile"] = stage_profile
        return response, inference_ms

    @modal.method()
    def parse_document(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise ValueError("payload must be a dictionary")
        pdf_bytes = payload.get("pdf_bytes")
        if not isinstance(pdf_bytes, bytes) or not pdf_bytes:
            raise ValueError("pdf_bytes must be non-empty bytes")
        if len(pdf_bytes) > MAX_INPUT_BYTES:
            raise ValueError(f"pdf_bytes exceeds {MAX_INPUT_BYTES}")
        expected_sha = payload.get("expected_sha256")
        actual_sha = hashlib.sha256(pdf_bytes).hexdigest()
        if expected_sha != actual_sha:
            raise ValueError("PDF SHA-256 mismatch")
        if payload.get("expected_pages") != EXPECTED_PAGES:
            raise ValueError(f"expected_pages must be {EXPECTED_PAGES}")
        native_evidence_bytes = payload.get("native_evidence_bytes")
        if not isinstance(native_evidence_bytes, bytes) or not native_evidence_bytes:
            raise ValueError("native_evidence_bytes must be non-empty bytes")
        if len(native_evidence_bytes) > MAX_RESULT_BYTES:
            raise ValueError("native_evidence_bytes exceeds the bounded result size")
        expected_native_sha = payload.get("native_evidence_sha256")
        if hashlib.sha256(native_evidence_bytes).hexdigest() != expected_native_sha:
            raise ValueError("native evidence SHA-256 mismatch")

        method_started = time.monotonic()
        profile_started_ns = time.monotonic_ns()
        for stage_profiler in self.stage_profilers:
            if stage_profiler is not None:
                stage_profiler.begin_method(profile_started_ns)
        for split_model in self.split_recognition_models:
            split_model.reset_metrics()
        method_first_inference_ms: float | None = None
        was_cold = self.container_cold
        self.container_cold = False
        run_id = payload.get("run_id") or f"gpu-a2-{uuid.uuid4().hex[:12]}"
        scratch = Path(tempfile.mkdtemp(prefix="pagespatial-a2-", dir="/tmp"))
        pdf_path = scratch / "input.pdf"
        native_evidence_path = scratch / "native-evidence.json"
        result_path = scratch / "result.json"
        controller_scratch = scratch / "controller"
        stderr_path = scratch / "controller.stderr"
        pdf_path.write_bytes(pdf_bytes)
        native_evidence_path.write_bytes(native_evidence_bytes)
        sampler = _GpuSampler()
        sampler.start()
        batch_observation_starts = [
            len(items) for items in self.batch_observations_by_owner
        ]
        controller = None
        ocr_calls = 0
        stage_profile_pages: list[dict[str, Any]] = []
        try:
            with stderr_path.open("wb") as stderr:
                controller = subprocess.Popen(
                    [
                        "/opt/node/bin/node",
                        "/app/scripts/evaluation/gpu_a2_controller.mjs",
                        "--pdf", str(pdf_path),
                        "--native-evidence", str(native_evidence_path),
                        "--result", str(result_path),
                        "--scratch", str(controller_scratch),
                        "--run-id", run_id,
                        "--expected-pages", str(EXPECTED_PAGES),
                        "--tier", MODEL_TIER,
                    ],
                    cwd="/app",
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=stderr,
                    text=True,
                    bufsize=1,
                    start_new_session=True,
                )
                assert controller.stdin is not None and controller.stdout is not None
                done = False
                available_owners: queue.Queue[int] = queue.Queue()
                for owner_index in range(INFERENCE_OWNERS):
                    available_owners.put(owner_index)
                write_lock = threading.Lock()
                state_lock = threading.Lock()
                async_errors: list[BaseException] = []

                def record_and_write(response: dict[str, Any], inference_ms: float) -> None:
                    nonlocal ocr_calls, method_first_inference_ms
                    stage_profile = response.pop("stageProfile", None)
                    with state_lock:
                        ocr_calls += 1
                        if method_first_inference_ms is None:
                            method_first_inference_ms = inference_ms
                        if stage_profile is not None:
                            stage_profile_pages.append(stage_profile)
                    with write_lock:
                        controller.stdin.write(json.dumps(response) + "\n")
                        controller.stdin.flush()

                def run_available(message: dict[str, Any]) -> tuple[dict[str, Any], float]:
                    owner_index = available_owners.get()
                    try:
                        return self._predict_page(owner_index, message, attest=False)
                    finally:
                        available_owners.put(owner_index)

                def finish_async(future: Any) -> None:
                    try:
                        response, inference_ms = future.result()
                        record_and_write(response, inference_ms)
                    except BaseException as error:
                        with state_lock:
                            async_errors.append(error)
                        try:
                            with write_lock:
                                controller.stdin.write(
                                    json.dumps(
                                        {"kind": "fatal", "error": f"GPU owner failed: {error}"}
                                    )
                                    + "\n"
                                )
                                controller.stdin.flush()
                        except Exception:
                            pass

                with ThreadPoolExecutor(max_workers=INFERENCE_OWNERS) as executor:
                    for raw in controller.stdout:
                        message = json.loads(raw)
                        if message.get("kind") == "fatal":
                            detail = message.get("error")
                            if async_errors:
                                detail = f"{detail}; owner error: {async_errors[0]}"
                            raise RuntimeError(f"A2 controller failed: {detail}")
                        if message.get("kind") == "done":
                            done = True
                            break
                        if message.get("kind") != "ocr":
                            raise RuntimeError(
                                f"unknown controller message: {message.get('kind')}"
                            )
                        unattested = next(
                            (
                                index
                                for index, value in enumerate(self.backend_attestations)
                                if value is None
                            ),
                            None,
                        )
                        if unattested is not None:
                            response, inference_ms = self._predict_page(
                                unattested, message, attest=True
                            )
                            record_and_write(response, inference_ms)
                        else:
                            executor.submit(run_available, message).add_done_callback(
                                finish_async
                            )
                if not done:
                    raise RuntimeError("A2 controller exited without a terminal result")
                if async_errors:
                    raise RuntimeError(f"GPU owner failed: {async_errors[0]}")
                controller.stdin.close()
                exit_code = controller.wait(timeout=60)
                if exit_code != 0:
                    raise RuntimeError(f"A2 controller exited {exit_code}")
                _stop_process_group(controller, grace_s=10)
            result = json.loads(result_path.read_text())
            if result.get("status") != "completed" or len(result.get("pages", [])) != EXPECTED_PAGES:
                raise RuntimeError("A2 terminal result did not reconcile 50 successful pages")
            method_total_ms = (time.monotonic() - method_started) * 1000
            result.update(
                {
                    "arm": ARM,
                    "resources": {
                        "physicalCpuCores": CPU_CORES,
                        "memoryMiB": MEMORY_MIB,
                        "gpu": GPU_TYPE,
                        "inferenceOwners": INFERENCE_OWNERS,
                    },
                    "method": {
                        "ownerPid": os.getpid(),
                        "containerCold": was_cold,
                        "ownerInitS": self.owner_init_s if was_cold else 0,
                        "ownerInitPerOwnerS": (
                            self.owner_init_per_owner_s if was_cold else []
                        ),
                        "ownerFirstInferenceMs": self.first_inference_ms_by_owner[0],
                        "ownerFirstInferenceMsByOwner": self.first_inference_ms_by_owner,
                        "methodFirstInferenceMs": method_first_inference_ms,
                        "totalMethodMs": method_total_ms,
                        "ocrCalls": ocr_calls,
                        "processGroupClean": True,
                    },
                    "versions": self.versions,
                    "modelVerification": self.model_verification,
                    "deviceTruth": self.device_truth,
                    "backendAttrs": self.backend_attrs_by_owner[0],
                    "backendAttrsByOwner": self.backend_attrs_by_owner,
                    "backendLogLines": self.backend_logs_by_owner[0],
                    "backendLogLinesByOwner": self.backend_logs_by_owner,
                    "backendAttestation": self.backend_attestations[0],
                    "backendAttestations": self.backend_attestations,
                    "backendMutationTests": self.backend_mutations[0],
                    "backendMutationTestsByOwner": self.backend_mutations,
                    "ultraInferPatch": {
                        "sourceRevision": ULTRA_INFER_SOURCE_REV,
                        "patchSha256": ULTRA_INFER_PATCH_SHA256,
                    },
                    "gpuTelemetry": _numeric_gpu_summary(sampler.samples),
                    "batchObservations": [
                        {**observation, "ownerIndex": owner_index}
                        for owner_index, observations in enumerate(
                            self.batch_observations_by_owner
                        )
                        for observation in observations[
                            batch_observation_starts[owner_index]:
                        ]
                    ],
                }
            )
            if SPLIT_RECOGNITION:
                result["splitRecognition"] = {
                    "schemaVersion": "pagespatial-gpu-a3-split-recognition-run-v1",
                    "owners": [
                        {**model.metrics(), "ownerIndex": owner_index}
                        for owner_index, model in enumerate(
                            self.split_recognition_models
                        )
                    ],
                }
            if STAGE_PROFILE:
                from gpu_a3_stage_profile import summarize_method_profile

                if len(stage_profile_pages) != EXPECTED_PAGES:
                    raise RuntimeError(
                        "stage profile did not reconcile exactly 50 pages: "
                        f"{len(stage_profile_pages)}"
                    )
                result["stageProfile"] = summarize_method_profile(
                    sorted(stage_profile_pages, key=lambda item: item["pageNumber"]),
                    self.stage_profile_identities,
                    method_total_ms,
                )
            _enforce_result_size(result)
            self.last_result = result
            self.last_result_json = json.dumps(
                result, separators=(",", ":")
            ).encode("utf-8")
            self.last_result_sha256 = hashlib.sha256(
                self.last_result_json
            ).hexdigest()
            return result
        except Exception:
            if controller is not None and controller.poll() is None:
                try:
                    if controller.stdin is not None:
                        controller.stdin.write(
                            json.dumps({"kind": "fatal", "error": "GPU owner aborted"}) + "\n"
                        )
                        controller.stdin.flush()
                except Exception:
                    pass
            if controller is not None:
                _stop_process_group(controller, grace_s=10)
            detail = stderr_path.read_text(errors="replace")[-4000:] if stderr_path.exists() else ""
            if detail:
                print(json.dumps({"event": "a2_controller_stderr", "tail": detail}), flush=True)
            raise
        finally:
            sampler.stop()
            shutil.rmtree(scratch, ignore_errors=True)

    @modal.method()
    def probe_last_response(self, mode: str) -> Any:
        if not hasattr(self, "last_result"):
            raise RuntimeError("response probe requires one completed parse")
        if mode == "tiny":
            return {
                "sha256": self.last_result_sha256,
                "bytes": len(self.last_result_json),
            }
        if mode == "json-bytes":
            return self.last_result_json
        if mode == "object":
            return self.last_result
        raise ValueError("response probe mode must be tiny, json-bytes, or object")


@app.local_entrypoint()
def main(
    pdf_path: str,
    native_evidence_path: str,
    out_dir: str,
    repeats: int = 4,
    allow_dirty: bool = False,
) -> None:
    if repeats != 4:
        raise ValueError("E1 requires exactly four calls: one cold plus three warm")
    source = _source_state(allow_dirty)
    pdf = Path(pdf_path).read_bytes()
    pdf_sha = hashlib.sha256(pdf).hexdigest()
    native_evidence = Path(native_evidence_path).read_bytes()
    native_evidence_sha = hashlib.sha256(native_evidence).hexdigest()
    manifest = json.loads(
        (Path(__file__).resolve().parents[2] / "evaluation/gpu-spike/a2-50page-v1.json").read_text()
    )
    if pdf_sha != manifest["output"]["sha256"] or len(pdf) != manifest["output"]["bytes"]:
        raise RuntimeError("50-page workload identity does not match the frozen manifest")

    run_id = f"{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}-{uuid.uuid4().hex[:8]}"
    run_dir = Path(out_dir) / run_id
    run_dir.mkdir(parents=True, exist_ok=False)
    metadata = {
        "schemaVersion": "pagespatial-gpu-a2-run-v1",
        "runId": run_id,
        "appName": APP_NAME,
        "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": source,
        "workload": manifest,
        "arm": ARM,
        "nativeEvidence": {
            "mode": "precomputed-cpu",
            "path": str(Path(native_evidence_path)),
            "sha256": native_evidence_sha,
            "bytes": len(native_evidence),
        },
        "repeats": repeats,
        "budget": {
            "ownerCeilingUsd": 75,
            "operationalExposureStopUsd": 75,
            "reservationId": _reservation_id,
        },
    }
    (run_dir / "run.json").write_text(json.dumps(metadata, indent=1) + "\n")
    owner = GpuA2Container()
    outcomes = []
    container_ids = []
    last_remote_result_json = b""
    last_remote_result: dict[str, Any] = {}
    for repeat in range(1, repeats + 1):
        call_started = time.monotonic()
        result = owner.parse_document.remote(
            {
                "run_id": f"{run_id}-r{repeat}",
                "pdf_bytes": pdf,
                "native_evidence_bytes": native_evidence,
                "native_evidence_sha256": native_evidence_sha,
                "expected_sha256": pdf_sha,
                "expected_pages": EXPECTED_PAGES,
            }
        )
        if result.get("arm") != ARM:
            raise RuntimeError(
                f"remote arm mismatch: requested {ARM!r}, returned {result.get('arm')!r}"
            )
        last_remote_result_json = json.dumps(
            result, separators=(",", ":")
        ).encode("utf-8")
        last_remote_result = dict(result)
        result["client"] = {
            "repeat": repeat,
            "spawnToResultS": time.monotonic() - call_started,
        }
        snapshot = _container_snapshot()
        result["client"].update(
            {"containerId": snapshot["container_id"], "appId": snapshot["app_id"]}
        )
        container_ids.append(snapshot["container_id"])
        path = run_dir / f"gpu-repeat-{repeat}.json"
        path.write_text(json.dumps(result, indent=1) + "\n")
        outcomes.append(result)
        print(
            f"repeat {repeat}: {result['timing']['pagesPerS']:.3f} terminal pages/s; "
            f"method={result['method']['totalMethodMs'] / 1000:.1f}s; "
            f"client={result['client']['spawnToResultS']:.1f}s -> {path}",
            flush=True,
        )
    last_remote_result_sha256 = hashlib.sha256(last_remote_result_json).hexdigest()
    response_probe = []
    server_identity: dict[str, Any] | None = None
    for probe_repeat in range(1, 3):
        for mode in ("tiny", "json-bytes", "object"):
            probe_started = time.monotonic()
            value = owner.probe_last_response.remote(mode)
            elapsed_s = time.monotonic() - probe_started
            if mode == "tiny":
                server_identity = value
                returned_bytes = len(
                    json.dumps(value, separators=(",", ":")).encode("utf-8")
                )
                semantic_match = None
                byte_reencode_match = (
                    value.get("sha256") == last_remote_result_sha256
                    and value.get("bytes") == len(last_remote_result_json)
                )
            elif mode == "json-bytes":
                returned_bytes = len(value)
                if server_identity is None or (
                    hashlib.sha256(value).hexdigest() != server_identity.get("sha256")
                    or len(value) != server_identity.get("bytes")
                ):
                    raise RuntimeError("JSON-byte response probe identity mismatch")
                semantic_match = None
                byte_reencode_match = True
            else:
                encoded = json.dumps(value, separators=(",", ":")).encode("utf-8")
                returned_bytes = len(encoded)
                semantic_match = value == last_remote_result
                byte_reencode_match = (
                    server_identity is not None
                    and hashlib.sha256(encoded).hexdigest()
                    == server_identity.get("sha256")
                    and len(encoded) == server_identity.get("bytes")
                )
                if not semantic_match:
                    raise RuntimeError("object response probe semantic mismatch")
            response_probe.append(
                {
                    "repeat": probe_repeat,
                    "mode": mode,
                    "roundTripS": elapsed_s,
                    "returnedBytes": returned_bytes,
                    "semanticMatch": semantic_match,
                    "byteReencodeMatch": byte_reencode_match,
                }
            )
    cold_pattern = [item["method"]["containerCold"] for item in outcomes]
    owner_pids = {item["method"]["ownerPid"] for item in outcomes}
    if (
        cold_pattern != [True, False, False, False]
        or len(owner_pids) != 1
        or len(set(container_ids)) != 1
    ):
        raise RuntimeError(
            "warm-lifetime proof failed: "
            f"cold={cold_pattern}, ownerPids={sorted(owner_pids)}, containers={container_ids}"
        )
    metadata["completedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    metadata["responseProbe"] = response_probe
    metadata["summary"] = {
        "medianControllerPagesPerS": statistics.median(
            item["timing"]["pagesPerS"] for item in outcomes
        ),
        "medianClientPagesPerS": statistics.median(
            EXPECTED_PAGES / item["client"]["spawnToResultS"] for item in outcomes
        ),
        "warmReuse": {
            "coldPattern": cold_pattern,
            "ownerPids": sorted(owner_pids),
            "containerIds": container_ids,
        },
    }
    (run_dir / "run.json").write_text(json.dumps(metadata, indent=1) + "\n")
    print(f"evidence={run_dir}")

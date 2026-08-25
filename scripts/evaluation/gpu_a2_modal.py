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

from gpu_process_tree import reap_marked_process_groups

_SOURCE_PATH = Path(__file__).resolve()
_COPIED_REMOTE_SOURCE = _SOURCE_PATH in {
    Path("/root/gpu_a2_modal.py"),
    Path("/app/scripts/evaluation/gpu_a2_modal.py"),
}
_LOCAL_BUILD_CONTEXT = modal.is_local() and not _COPIED_REMOTE_SOURCE

_REQUESTED_APP_NAME = os.environ.get(
    "PAGESPATIAL_A2_APP_NAME", "pagespatial-gpu-a2-e2e-m1"
)
INSTRUMENTATION_MODE = _REQUESTED_APP_NAME.startswith(
    "pagespatial-gpu-instrumentation-m1-"
)

# Refuse before importing/constructing the TensorRT image. That imported image
# contains a paid GPU build step, so validating inside the local entrypoint is
# too late.
if _LOCAL_BUILD_CONTEXT:
    if INSTRUMENTATION_MODE:
        from gpu_instrumentation_budget import (
            DEFAULT_LEDGER,
            validate_reservation,
        )

        _reservation_id = os.environ.get(
            "PAGESPATIAL_GPU_INSTRUMENTATION_RESERVATION", ""
        )
        _ledger_path = Path(
            os.environ.get(
                "PAGESPATIAL_GPU_INSTRUMENTATION_LEDGER", str(DEFAULT_LEDGER)
            )
        )
        if not _reservation_id:
            raise RuntimeError(
                "a paid GPU reservation is required before image construction"
            )
        validate_reservation(_ledger_path, _reservation_id, "M1-PARITY")
    else:
        from gpu_a2_budget import DEFAULT_LEDGER, validate_reservation

        _reservation_id = os.environ.get("PAGESPATIAL_A2_RESERVATION", "")
        _ledger_path = Path(
            os.environ.get("PAGESPATIAL_A2_LEDGER", str(DEFAULT_LEDGER))
        )
        if not _reservation_id:
            raise RuntimeError(
                "a paid GPU reservation is required before image construction"
            )
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

if _LOCAL_BUILD_CONTEXT:
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


APP_NAME = _REQUESTED_APP_NAME
if _LOCAL_BUILD_CONTEXT and not (
    APP_NAME.startswith("pagespatial-gpu-a2-") or INSTRUMENTATION_MODE
):
    raise RuntimeError("A2 app name has an unsupported prefix")
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
NVTX_VERSION = "0.2.16"
NVTX_CP310_X86_64_WHEEL_SHA256 = (
    "23f30fcaf68f53d1895282315cb35aed5f605d59aeb33e75e276545ff95c4af6"
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
NVTX_ENABLED = os.environ.get("PAGESPATIAL_A2_NVTX", "0") == "1"
if STAGE_PROFILE and (
    MODEL_TIER != "tiny"
    or RECOGNITION_BATCH_SIZE != 1
    or INFERENCE_OWNERS != 2
):
    raise ValueError("stage profiling is bounded to Tiny B1 with two owners")

if _LOCAL_BUILD_CONTEXT:
    REPO_ROOT = Path(__file__).resolve().parents[2]
else:
    REPO_ROOT = Path("/app")

CONTROLLER = REPO_ROOT / "scripts/evaluation/gpu_a2_controller.mjs"
STAGE_PROFILER = REPO_ROOT / "scripts/evaluation/gpu_a3_stage_profile.py"
TRACE_WORKER = REPO_ROOT / "scripts/evaluation/gpu_a2_trace_worker.py"
WORKLOAD_MANIFEST = REPO_ROOT / "evaluation/gpu-spike/a2-50page-v1.json"

app = modal.App(APP_NAME)

_nvtx_domain = None


def _nvtx_start(stage: str, **identity: Any) -> Any:
    if not NVTX_ENABLED:
        return None
    import nvtx

    global _nvtx_domain
    if _nvtx_domain is None:
        _nvtx_domain = nvtx.Domain("pagespatial.ocr")
    tags = ";".join(f"{key}={value}" for key, value in identity.items())
    message = stage if not tags else f"{stage};{tags}"
    return _nvtx_domain.start_range(message=message)


def _nvtx_end(handle: Any) -> None:
    if handle is None:
        return
    if _nvtx_domain is None:
        raise RuntimeError("NVTX range ended before domain initialization")
    _nvtx_domain.end_range(handle)


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


def _nvtx_install_command() -> str:
    return (
        "set -eu; mkdir -p /tmp/nvtx-wheel; "
        f"python -m pip download --only-binary=:all: --no-deps --dest /tmp/nvtx-wheel nvtx=={NVTX_VERSION}; "
        "wheel=$(find /tmp/nvtx-wheel -type f -name 'nvtx-*.whl'); "
        f"echo '{NVTX_CP310_X86_64_WHEEL_SHA256}  '$wheel | sha256sum -c -; "
        "python -m pip install --no-cache-dir --no-deps \"$wheel\"; "
        "rm -rf /tmp/nvtx-wheel"
    )


if _LOCAL_BUILD_CONTEXT:
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
        .add_local_file(str(STAGE_PROFILER), "/app/scripts/evaluation/gpu_a3_stage_profile.py", copy=True)
        .add_local_file(
            str(REPO_ROOT / "scripts/evaluation/gpu_spike_modal.py"),
            "/app/scripts/evaluation/gpu_spike_modal.py",
            copy=True,
        )
        .add_local_file(
            str(REPO_ROOT / "scripts/evaluation/gpu_process_tree.py"),
            "/app/scripts/evaluation/gpu_process_tree.py",
            copy=True,
        )
        .add_local_file(
            str(REPO_ROOT / "scripts/evaluation/gpu_process_tree.py"),
            "/root/gpu_process_tree.py",
            copy=True,
        )
        .add_local_file(str(Path(__file__)), "/app/scripts/evaluation/gpu_a2_modal.py", copy=True)
        .add_local_file(str(TRACE_WORKER), "/app/scripts/evaluation/gpu_a2_trace_worker.py", copy=True)
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
                "PAGESPATIAL_A2_NVTX": "1" if NVTX_ENABLED else "0",
                "PAGESPATIAL_A2_APP_NAME": APP_NAME,
            }
        )
    )
else:
    a2_image = modal.Image.debian_slim(python_version="3.10")

if _LOCAL_BUILD_CONTEXT and INSTRUMENTATION_MODE:
    a2_image = a2_image.run_commands(_nvtx_install_command())


ARM = {
    "name": (
        f"g-trt-{MODEL_TIER}-fp32-a2-b{RECOGNITION_BATCH_SIZE}"
        f"c4o{INFERENCE_OWNERS}"
        + ("-profile" if STAGE_PROFILE else "")
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
    "nvtx": NVTX_ENABLED,
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


class A2ExecutionCore:
    """One evaluation-only A2 implementation shared by every launch boundary."""

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
            profiler.begin_page(
                int(message["pageNumber"]),
                str(message["id"]),
                str(message["id"]).split(":", 1)[0],
            )
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
        method_first_inference_ms: float | None = None
        was_cold = self.container_cold
        self.container_cold = False
        run_id = payload.get("run_id") or f"gpu-a2-{uuid.uuid4().hex[:12]}"
        capture_plan = payload.get("capture_plan")
        capture_controller = None
        if capture_plan is not None:
            if not NVTX_ENABLED or not STAGE_PROFILE:
                raise ValueError("capture_plan requires NVTX and stage profiling")
            capture_name = capture_plan.get("captureName")
            raw_windows = capture_plan.get("windows")
            if capture_name not in {
                "m2.capture",
                "m2.cpu.capture",
                "m3.native.capture",
            }:
                raise ValueError("capture_plan has an invalid capture name")
            if not isinstance(raw_windows, (list, tuple)):
                raise ValueError("capture_plan windows must be a sequence")
            windows = tuple(
                (int(window[0]), int(window[1]))
                for window in raw_windows
                if isinstance(window, (list, tuple)) and len(window) == 2
            )
            if len(windows) != len(raw_windows):
                raise ValueError("capture_plan has an invalid window")
            from gpu_instrumentation_capture import CaptureWindowController

            capture_controller = CaptureWindowController(
                run_id=run_id,
                capture_name=capture_name,
                windows=windows,
                start_range=lambda name: _nvtx_start(name),
                end_range=_nvtx_end,
            )
        document_nvtx = _nvtx_start("document", run=run_id)
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
        assembly_nvtx: dict[str, dict[str, Any]] = {}
        assembly_stage_events: list[dict[str, Any]] = []
        ocr_calls = 0
        stage_profile_pages: list[dict[str, Any]] = []
        try:
            with stderr_path.open("wb") as stderr:
                controller_command = [
                    "/opt/node/bin/node",
                    "/app/scripts/evaluation/gpu_a2_controller.mjs",
                    "--pdf", str(pdf_path),
                    "--native-evidence", str(native_evidence_path),
                    "--result", str(result_path),
                    "--scratch", str(controller_scratch),
                    "--run-id", run_id,
                    "--expected-pages", str(EXPECTED_PAGES),
                    "--tier", MODEL_TIER,
                ]
                if NVTX_ENABLED:
                    controller_command.append("--instrument-stages")
                controller = subprocess.Popen(
                    controller_command,
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
                        if capture_controller is not None:
                            capture_controller.observe_ocr_enter(
                                int(message["pageNumber"]), str(message["id"])
                            )
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
                        if message.get("kind") == "stage":
                            if message.get("stage") != "result.assemble":
                                raise RuntimeError(
                                    f"unknown controller stage: {message.get('stage')}"
                                )
                            stage_id = str(message.get("id"))
                            stage_scope = message.get("scope")
                            if stage_scope not in {"page", "document"}:
                                raise RuntimeError(
                                    "result assembly stage lacks a valid scope"
                                )
                            source_at_ns = message.get("atNs")
                            if (
                                not isinstance(source_at_ns, int)
                                or source_at_ns <= 0
                            ):
                                raise RuntimeError(
                                    "result assembly stage lacks a source timestamp"
                                )
                            if message.get("phase") == "start":
                                if stage_id in assembly_nvtx:
                                    raise RuntimeError(
                                        f"duplicate result assembly start: {stage_id}"
                                    )
                                assembly_nvtx[stage_id] = {
                                    "handle": _nvtx_start(
                                        "result.assemble",
                                        run=run_id,
                                        page=message.get("pageNumber"),
                                        request=stage_id,
                                        owner="node",
                                        scope=stage_scope,
                                        proxy="protocol",
                                        sourceStartNs=source_at_ns,
                                    ),
                                    "pageNumber": message.get("pageNumber"),
                                    "scope": stage_scope,
                                    "sourceStartedNs": source_at_ns,
                                    "proxyStartedNs": time.monotonic_ns(),
                                }
                            elif message.get("phase") == "end":
                                if stage_id not in assembly_nvtx:
                                    raise RuntimeError(
                                        f"result assembly end without start: {stage_id}"
                                    )
                                started = assembly_nvtx.pop(stage_id)
                                if message.get("pageNumber") != started["pageNumber"]:
                                    raise RuntimeError(
                                        "result assembly page identity changed"
                                    )
                                if source_at_ns <= started["sourceStartedNs"]:
                                    raise RuntimeError(
                                        "result assembly timestamps are not increasing"
                                    )
                                _nvtx_end(started["handle"])
                                assembly_stage_events.append(
                                    {
                                        "stage": "result.assemble",
                                        "requestId": stage_id,
                                        "pageNumber": started["pageNumber"],
                                        "scope": started["scope"],
                                        "sourceStartedNs": started[
                                            "sourceStartedNs"
                                        ],
                                        "sourceEndedNs": source_at_ns,
                                        "sourceWallMs": (
                                            source_at_ns
                                            - started["sourceStartedNs"]
                                        )
                                        / 1_000_000,
                                        "proxyStartedNs": started[
                                            "proxyStartedNs"
                                        ],
                                        "proxyEndedNs": time.monotonic_ns(),
                                        "nvtxRangeKind": "protocol-proxy",
                                    }
                                )
                                if (
                                    capture_controller is not None
                                    and started["scope"] == "page"
                                ):
                                    capture_controller.observe_assembly_end(
                                        int(started["pageNumber"]), stage_id
                                    )
                            else:
                                raise RuntimeError(
                                    f"unknown result assembly phase: {message.get('phase')}"
                                )
                            continue
                        if message.get("kind") == "fatal":
                            detail = message.get("error")
                            if async_errors:
                                detail = f"{detail}; owner error: {async_errors[0]}"
                            raise RuntimeError(f"A2 controller failed: {detail}")
                        if message.get("kind") == "done":
                            if assembly_nvtx:
                                raise RuntimeError(
                                    f"unfinished result assembly ranges: {sorted(assembly_nvtx)}"
                                )
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
                            if capture_controller is not None:
                                capture_controller.observe_ocr_enter(
                                    int(message["pageNumber"]), str(message["id"])
                                )
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
            result = json.loads(result_path.read_text(encoding="utf-8"))
            if result.get("status") != "completed" or len(result.get("pages", [])) != EXPECTED_PAGES:
                raise RuntimeError("A2 terminal result did not reconcile 50 successful pages")
            method_total_ms = (time.monotonic() - method_started) * 1000
            capture_result = (
                capture_controller.finish()
                if capture_controller is not None
                else None
            )
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
                    "instrumentation": {
                        "nvtx": {
                            "enabled": NVTX_ENABLED,
                            "version": self.versions.get("nvtx"),
                            "wheelSha256": NVTX_CP310_X86_64_WHEEL_SHA256,
                            "domain": "pagespatial.ocr",
                        },
                        "nodeStages": assembly_stage_events,
                        "capture": capture_result,
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
            for active in assembly_nvtx.values():
                _nvtx_end(active["handle"])
            _nvtx_end(document_nvtx)

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
    """Modal transport only; all document work remains in A2ExecutionCore."""

    @modal.enter()
    def start_owner(self) -> None:
        self.core = A2ExecutionCore()
        self.core.start_owner()

    @modal.method()
    def parse_document(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self.core.parse_document(payload)

    @modal.method()
    def parse_child_sequence(
        self, payload: dict[str, Any], repeats: int = 2
    ) -> list[dict[str, Any]]:
        """Run the shared core in one persistent child for launch-boundary parity."""
        if repeats != 2:
            raise ValueError("M1 child sequence requires one cold and one warm document")
        pdf_bytes = payload.get("pdf_bytes")
        native_bytes = payload.get("native_evidence_bytes")
        if not isinstance(pdf_bytes, bytes) or not isinstance(native_bytes, bytes):
            raise ValueError("child payload requires byte inputs")
        scratch = Path(tempfile.mkdtemp(prefix="pagespatial-a2-child-", dir="/tmp"))
        try:
            pdf_path = scratch / "input.pdf"
            native_path = scratch / "native-evidence.json"
            manifest_path = scratch / "requests.json"
            result_path = scratch / "results.json"
            stderr_path = scratch / "worker.stderr"
            pdf_path.write_bytes(pdf_bytes)
            native_path.write_bytes(native_bytes)
            requests = []
            for repeat in range(1, repeats + 1):
                requests.append(
                    {
                        "run_id": f"{payload['run_id']}-child-r{repeat}",
                        "pdf_path": str(pdf_path),
                        "native_evidence_path": str(native_path),
                        "native_evidence_sha256": payload["native_evidence_sha256"],
                        "expected_sha256": payload["expected_sha256"],
                        "expected_pages": payload["expected_pages"],
                    }
                )
            manifest_path.write_text(json.dumps(requests, separators=(",", ":")))
            started = time.monotonic()
            worker = None
            with stderr_path.open("wb") as stderr:
                worker = subprocess.Popen(
                    [
                        sys.executable,
                        "/app/scripts/evaluation/gpu_a2_trace_worker.py",
                        "--requests",
                        str(manifest_path),
                        "--output",
                        str(result_path),
                    ],
                    cwd="/app",
                    stdout=subprocess.DEVNULL,
                    stderr=stderr,
                    start_new_session=True,
                )
                try:
                    return_code = worker.wait(timeout=METHOD_TIMEOUT_S)
                except subprocess.TimeoutExpired as error:
                    _stop_process_group(worker, grace_s=3)
                    reap_marked_process_groups(str(scratch), grace_s=3)
                    raise RuntimeError("A2 child worker deadline exceeded") from error
            cleanup_interventions = reap_marked_process_groups(str(scratch))
            if return_code != 0:
                detail = stderr_path.read_text(errors="replace")[-4000:]
                raise RuntimeError(
                    f"A2 child worker exited {return_code}: {detail}"
                )
            results = json.loads(result_path.read_text())
            if not isinstance(results, list) or len(results) != repeats:
                raise RuntimeError("A2 child worker returned an invalid result sequence")
            child_pids = {item.get("launch", {}).get("workerPid") for item in results}
            if None in child_pids or len(child_pids) != 1:
                raise RuntimeError("A2 child worker did not preserve one process lifetime")
            for item in results:
                item["launch"]["processTreeClean"] = True
                item["launch"]["cleanupInterventions"] = cleanup_interventions
            results[-1]["launch"]["sequenceWallS"] = time.monotonic() - started
            return results
        finally:
            reap_marked_process_groups(str(scratch), grace_s=1)
            shutil.rmtree(scratch, ignore_errors=True)

    @modal.method()
    def probe_last_response(self, mode: str) -> Any:
        return self.core.probe_last_response(mode)


def _run_m1_parity(
    *,
    pdf: bytes,
    pdf_sha: str,
    native_evidence: bytes,
    native_evidence_sha: str,
    out_dir: Path,
    source: dict[str, Any],
    manifest: dict[str, Any],
) -> None:
    """Four remote calls: cold, control-before, child sequence, control-after."""
    run_id = f"{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}-{uuid.uuid4().hex[:8]}"
    run_dir = out_dir / run_id
    run_dir.mkdir(parents=True, exist_ok=False)
    (run_dir / "run.json").write_text(
        json.dumps(
            {
                "schemaVersion": "pagespatial-gpu-instrumentation-m1-run-v1",
                "runId": run_id,
                "appName": APP_NAME,
                "source": source,
                "workload": manifest,
                "arm": ARM,
                "remoteCalls": [
                    "ordinary-cold",
                    "ordinary-before",
                    "child-cold-and-warm",
                    "ordinary-after",
                ],
                "reservationId": _reservation_id,
            },
            indent=1,
        )
        + "\n"
    )
    owner = GpuA2Container()

    def payload(label: str) -> dict[str, Any]:
        return {
            "run_id": f"{run_id}-{label}",
            "pdf_bytes": pdf,
            "native_evidence_bytes": native_evidence,
            "native_evidence_sha256": native_evidence_sha,
            "expected_sha256": pdf_sha,
            "expected_pages": EXPECTED_PAGES,
        }

    container_ids: list[str] = []

    def ordinary(label: str) -> dict[str, Any]:
        started = time.monotonic()
        result = owner.parse_document.remote(payload(label))
        snapshot = _container_snapshot()
        result["client"] = {
            "launchBoundary": "modal-method",
            "spawnToResultS": time.monotonic() - started,
            "containerId": snapshot["container_id"],
            "appId": snapshot["app_id"],
        }
        container_ids.append(snapshot["container_id"])
        return result

    cold = ordinary("ordinary-cold")
    before = ordinary("ordinary-before")
    child_started = time.monotonic()
    child_results = owner.parse_child_sequence.remote(payload("child"), repeats=2)
    snapshot = _container_snapshot()
    container_ids.append(snapshot["container_id"])
    for result in child_results:
        result["client"] = {
            "launchBoundary": "child-worker",
            "sequenceSpawnToResultS": time.monotonic() - child_started,
            "containerId": snapshot["container_id"],
            "appId": snapshot["app_id"],
        }
    after = ordinary("ordinary-after")
    if len(set(container_ids)) != 1:
        raise RuntimeError(f"M1 parity crossed container lifetimes: {container_ids}")

    named = {
        "ordinary-cold": cold,
        "ordinary-before": before,
        "child-cold": child_results[0],
        "child-warm": child_results[1],
        "ordinary-after": after,
    }
    paths = {}
    for name, result in named.items():
        path = run_dir / f"{name}.json"
        path.write_text(json.dumps(result, indent=1) + "\n")
        paths[name] = path

    analysis_path = run_dir / "m1-parity.json"
    subprocess.run(
        [
            "/opt/node/bin/node" if Path("/opt/node/bin/node").exists() else "node",
            str(REPO_ROOT / "scripts/evaluation/analyze_gpu_instrumentation_m1.mjs"),
            "--cold",
            str(paths["ordinary-cold"]),
            "--before",
            str(paths["ordinary-before"]),
            "--child-cold",
            str(paths["child-cold"]),
            "--child-warm",
            str(paths["child-warm"]),
            "--after",
            str(paths["ordinary-after"]),
            "--output",
            str(analysis_path),
        ],
        cwd=REPO_ROOT,
        check=True,
    )
    print(f"M1 parity evidence -> {run_dir}", flush=True)


@app.local_entrypoint()
def main(
    pdf_path: str,
    native_evidence_path: str,
    out_dir: str,
    repeats: int = 4,
    allow_dirty: bool = False,
    mode: str = "a2",
) -> None:
    if mode not in {"a2", "m1-parity"}:
        raise ValueError("mode must be a2 or m1-parity")
    if repeats != 4:
        raise ValueError("A2 and M1 require exactly four remote calls")
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

    if mode == "m1-parity":
        if not INSTRUMENTATION_MODE:
            raise RuntimeError("M1 parity requires an instrumentation-prefixed app")
        if not (
            MODEL_TIER == "tiny"
            and RECOGNITION_BATCH_SIZE == 1
            and INFERENCE_OWNERS == 2
        ):
            raise RuntimeError("M1 parity is fixed to Tiny FP32 B1 O2")
        _run_m1_parity(
            pdf=pdf,
            pdf_sha=pdf_sha,
            native_evidence=native_evidence,
            native_evidence_sha=native_evidence_sha,
            out_dir=Path(out_dir),
            source=source,
            manifest=manifest,
        )
        return

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

#!/usr/bin/env python3
"""Bounded end-to-end A2 benchmark: one Small FP32 TensorRT owner.

This is an evaluation adapter, not the production Modal deployment. Four Node
producer processes execute the real render/native stages and feed this class's
single persistent GPU object through a bounded JSONL queue. The Node controller
then runs the real PageSpatial assembly stage.

Typical bounded run:

  modal run scripts/evaluation/gpu_a2_modal.py \
    --pdf-path .evaluation/gpu-spike/a2-50page-v1.pdf \
    --out-dir .evaluation/gpu-spike/2026-08-24/a2 \
    --repeats 4
"""

from __future__ import annotations

import hashlib
import json
import os
import signal
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
import uuid
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
    _GpuSampler,
    _attest_backend,
    _backend_lines,
    _capture_native_output,
    _construct_ocr,
    _device_truth,
    _installed_versions,
    _source_state,
    _walk_interesting_attrs,
)
from gpu_spike_trt_modal import (
    GPU_TYPE,
    MODEL_MANIFEST,
    REMOTE_ROOT,
    ULTRA_INFER_PATCH_SHA256,
    ULTRA_INFER_SOURCE_REV,
    trt_image,
)


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

if modal.is_local():
    REPO_ROOT = Path(__file__).resolve().parents[2]
else:
    REPO_ROOT = Path("/app")

CONTROLLER = REPO_ROOT / "scripts/evaluation/gpu_a2_controller.mjs"
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
    .add_local_file(str(WORKLOAD_MANIFEST), "/app/evaluation/gpu-spike/a2-50page-v1.json", copy=True)
    .env({"PATH": "/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"})
)


ARM = {
    "name": "g-trt-small-fp32-a2-b1c4",
    "tier": "small",
    "device": "gpu:0",
    "runtime": "hpi-ort-trt",
    "enableHpi": True,
    "precision": "fp32",
    "recognitionBatchSize": 1,
    "pageBatchSize": 1,
    "producerCount": 4,
    "requiredBackendTokens": ["onnxruntime", "tensorrt"],
    "providerLayout": {
        "textDetection": "onnxruntime",
        "textRecognition": "tensorrt",
    },
    "deploymentProfile": "en-gpu",
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
        source_tier = REMOTE_ROOT / "models" / "small"
        self.private_model_root = Path("/tmp/pagespatial-a2-models")
        private_tier = self.private_model_root / "small"
        if not private_tier.exists():
            private_tier.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(source_tier, private_tier)
        harness.MODEL_ROOT = self.private_model_root

        started = time.monotonic()
        with _capture_native_output() as log_path:
            self.ocr = _construct_ocr(ARM)
        native_text = log_path.read_text(errors="replace")
        log_path.unlink(missing_ok=True)
        self.owner_init_s = time.monotonic() - started
        self.device_truth = _device_truth()
        self.backend_attrs = _walk_interesting_attrs(self.ocr)
        self.backend_logs = _backend_lines(native_text)
        # Provider construction is lazy. Final attestation must include the
        # first REAL workload inference; construction-only attributes are not
        # accepted as proof that TensorRT actually served a page.
        self.backend_attestation = None
        self.backend_mutation = None
        self.versions = _installed_versions()
        self.model_verification = json.loads(
            (REMOTE_ROOT / "model-verification.json").read_text()
        )["small"]
        self.container_cold = True
        self.first_inference_ms: float | None = None

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

        method_started = time.monotonic()
        method_first_inference_ms: float | None = None
        was_cold = self.container_cold
        self.container_cold = False
        run_id = payload.get("run_id") or f"gpu-a2-{uuid.uuid4().hex[:12]}"
        scratch = Path(tempfile.mkdtemp(prefix="pagespatial-a2-", dir="/tmp"))
        pdf_path = scratch / "input.pdf"
        result_path = scratch / "result.json"
        controller_scratch = scratch / "controller"
        stderr_path = scratch / "controller.stderr"
        pdf_path.write_bytes(pdf_bytes)
        sampler = _GpuSampler()
        sampler.start()
        controller = None
        ocr_calls = 0
        try:
            with stderr_path.open("wb") as stderr:
                controller = subprocess.Popen(
                    [
                        "/opt/node/bin/node",
                        "/app/scripts/evaluation/gpu_a2_controller.mjs",
                        "--pdf", str(pdf_path),
                        "--result", str(result_path),
                        "--scratch", str(controller_scratch),
                        "--run-id", run_id,
                        "--expected-pages", str(EXPECTED_PAGES),
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
                for raw in controller.stdout:
                    message = json.loads(raw)
                    if message.get("kind") == "fatal":
                        raise RuntimeError(f"A2 controller failed: {message.get('error')}")
                    if message.get("kind") == "done":
                        done = True
                        break
                    if message.get("kind") != "ocr":
                        raise RuntimeError(f"unknown controller message: {message.get('kind')}")
                    received_ns = time.monotonic_ns()
                    queue_wait_ms = max(
                        0.0, (received_ns - int(message["producedAtNs"])) / 1_000_000
                    )
                    import cv2

                    image = cv2.imread(message["pngPath"], cv2.IMREAD_COLOR)
                    if image is None:
                        raise RuntimeError(f"unreadable controller PNG for page {message['pageNumber']}")
                    inference_started = time.monotonic()
                    if self.backend_attestation is None:
                        with _capture_native_output() as inference_log_path:
                            results = list(self.ocr.predict(image))
                        inference_text = inference_log_path.read_text(errors="replace")
                        inference_log_path.unlink(missing_ok=True)
                        self.backend_logs = [
                            *self.backend_logs,
                            *_backend_lines(inference_text),
                        ]
                        self.backend_attrs = _walk_interesting_attrs(self.ocr)
                        self.backend_attestation = _attest_backend(
                            ARM, self.device_truth, self.backend_attrs, self.backend_logs
                        )
                        if not self.backend_attestation["pass"]:
                            raise RuntimeError(
                                "backend attestation failed after first inference: "
                                + "; ".join(self.backend_attestation["reasons"])
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
                            self.backend_attrs,
                            self.backend_logs,
                        )
                        if missing_provider["pass"] or wrong_device["pass"]:
                            raise RuntimeError("backend-attestation mutation unexpectedly passed")
                        self.backend_mutation = {
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
                        results = list(self.ocr.predict(image))
                    inference_ms = (time.monotonic() - inference_started) * 1000
                    ocr_calls += 1
                    if method_first_inference_ms is None:
                        method_first_inference_ms = inference_ms
                    if self.first_inference_ms is None:
                        self.first_inference_ms = inference_ms
                    response = {
                        "kind": "ocr-result",
                        "id": message["id"],
                        "lines": _paddle_lines(results),
                        "inferenceMs": inference_ms,
                        "queueWaitMs": queue_wait_ms,
                    }
                    controller.stdin.write(json.dumps(response) + "\n")
                    controller.stdin.flush()
                if not done:
                    raise RuntimeError("A2 controller exited without a terminal result")
                controller.stdin.close()
                exit_code = controller.wait(timeout=60)
                if exit_code != 0:
                    raise RuntimeError(f"A2 controller exited {exit_code}")
                _stop_process_group(controller, grace_s=10)
            result = json.loads(result_path.read_text())
            if result.get("status") != "completed" or len(result.get("pages", [])) != EXPECTED_PAGES:
                raise RuntimeError("A2 terminal result did not reconcile 50 successful pages")
            result.update(
                {
                    "arm": ARM,
                    "resources": {
                        "physicalCpuCores": CPU_CORES,
                        "memoryMiB": MEMORY_MIB,
                        "gpu": GPU_TYPE,
                    },
                    "method": {
                        "ownerPid": os.getpid(),
                        "containerCold": was_cold,
                        "ownerInitS": self.owner_init_s if was_cold else 0,
                        "ownerFirstInferenceMs": self.first_inference_ms,
                        "methodFirstInferenceMs": method_first_inference_ms,
                        "totalMethodMs": (time.monotonic() - method_started) * 1000,
                        "ocrCalls": ocr_calls,
                        "processGroupClean": True,
                    },
                    "versions": self.versions,
                    "modelVerification": self.model_verification,
                    "deviceTruth": self.device_truth,
                    "backendAttrs": self.backend_attrs,
                    "backendLogLines": self.backend_logs,
                    "backendAttestation": self.backend_attestation,
                    "backendMutationTests": self.backend_mutation,
                    "ultraInferPatch": {
                        "sourceRevision": ULTRA_INFER_SOURCE_REV,
                        "patchSha256": ULTRA_INFER_PATCH_SHA256,
                    },
                    "gpuTelemetry": _numeric_gpu_summary(sampler.samples),
                }
            )
            _enforce_result_size(result)
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


@app.local_entrypoint()
def main(
    pdf_path: str,
    out_dir: str,
    repeats: int = 4,
    allow_dirty: bool = False,
) -> None:
    if repeats != 4:
        raise ValueError("E1 requires exactly four calls: one cold plus three warm")
    source = _source_state(allow_dirty)
    pdf = Path(pdf_path).read_bytes()
    pdf_sha = hashlib.sha256(pdf).hexdigest()
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
        "repeats": repeats,
        "budget": {
            "ownerCeilingUsd": 50,
            "operationalExposureStopUsd": 40,
            "reservationId": _reservation_id,
        },
    }
    (run_dir / "run.json").write_text(json.dumps(metadata, indent=1) + "\n")
    owner = GpuA2Container()
    outcomes = []
    container_ids = []
    for repeat in range(1, repeats + 1):
        call_started = time.monotonic()
        result = owner.parse_document.remote(
            {
                "run_id": f"{run_id}-r{repeat}",
                "pdf_bytes": pdf,
                "expected_sha256": pdf_sha,
                "expected_pages": EXPECTED_PAGES,
            }
        )
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

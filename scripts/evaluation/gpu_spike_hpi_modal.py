#!/usr/bin/env python3
"""Conditional GPU-HPI arm for the PP-OCRv6 spike.

This is separate from gpu_spike_modal.py so ordinary CPU/Paddle runs never
eagerly build the optional provider dependency image.
"""
from __future__ import annotations

import json
import glob
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any

import modal

from gpu_spike_modal import (
    APT,
    CPU_CORES,
    GPU_TYPE,
    MEMORY_MIB,
    MODEL_FETCHER,
    MODEL_FETCH_COMMAND,
    MODEL_MANIFEST,
    REMOTE_ROOT,
    _load_pages,
    _run_arm,
    _source_state,
)


app = modal.App("pagespatial-gpu-spike-hpi-m1")
BASE_HARNESS_SOURCE = Path(__file__).with_name("gpu_spike_modal.py")

def _install_gpu_hpi_dependencies() -> None:
    """Run Paddle's device-sensitive installer in a GPU-backed build step."""
    subprocess.run(["paddleocr", "install_hpi_deps", "gpu"], check=True)
    nvidia_library_dirs = sorted(
        glob.glob("/usr/local/lib/python3.11/site-packages/nvidia/*/lib")
    )
    if not nvidia_library_dirs:
        raise RuntimeError("Paddle GPU image exposed no NVIDIA library directories")
    Path("/etc/ld.so.conf.d/pagespatial-python-nvidia.conf").write_text(
        "\n".join(nvidia_library_dirs) + "\n"
    )
    subprocess.run(["ldconfig"], check=True)
    print("Registered NVIDIA library directories:", nvidia_library_dirs)


# UltraInfer expects a system CUDA runtime, including nvJPEG. Paddle's Python
# CUDA wheels alone do not provide that complete linker contract, so HPI uses
# NVIDIA's matching runtime image instead of repairing missing libraries one by
# one. Model pins and application packages remain identical to the base arms.
cuda_hpi_base = (
    modal.Image.from_registry(
        "nvidia/cuda:12.6.3-cudnn-runtime-ubuntu22.04", add_python="3.11"
    )
    .apt_install(*APT)
    .uv_pip_install("huggingface-hub==0.34.4")
    .add_local_file(
        str(MODEL_MANIFEST), str(REMOTE_ROOT / "model-pins-v1.json"), copy=True
    )
    .add_local_file(
        str(MODEL_FETCHER), str(REMOTE_ROOT / "fetch_gpu_spike_models.py"), copy=True
    )
    .run_commands(MODEL_FETCH_COMMAND)
    .uv_pip_install(
        "paddleocr==3.7.0", "paddlex==3.7.2", "psutil==7.0.0", "setuptools"
    )
    .uv_pip_install(
        "paddlepaddle-gpu==3.2.1",
        extra_index_url="https://www.paddlepaddle.org.cn/packages/stable/cu126/",
    )
)

# The installer imports Paddle to inspect CUDA. Modal captures this GPU-backed
# build function's filesystem as a reusable image; measured calls perform no
# package download.
gpu_hpi_image = cuda_hpi_base.add_local_file(
    str(BASE_HARNESS_SOURCE), "/root/gpu_spike_modal.py", copy=True
).run_function(
    _install_gpu_hpi_dependencies,
    gpu=GPU_TYPE,
    cpu=2.0,
    memory=MEMORY_MIB,
    timeout=1800,
)

ARMS = {
    "g-hpi-tiny": {
        "tier": "tiny",
        "device": "gpu:0",
        "runtime": "hpi-auto",
        "enableHpi": True,
        "precision": "provider-selected-recorded",
        "recognitionBatchSize": 1,
        "pageBatchSize": 1,
    },
    "g-hpi-small": {
        "tier": "small",
        "device": "gpu:0",
        "runtime": "hpi-auto",
        "enableHpi": True,
        "precision": "provider-selected-recorded",
        "recognitionBatchSize": 1,
        "pageBatchSize": 1,
    },
    "g-ort-tiny": {
        "tier": "tiny",
        "device": "gpu:0",
        "runtime": "hpi-ort-ort",
        "enableHpi": True,
        "precision": "provider-default-recorded",
        "recognitionBatchSize": 1,
        "pageBatchSize": 1,
        "requiredBackendTokens": ["onnxruntime"],
    },
    "g-ort-small": {
        "tier": "small",
        "device": "gpu:0",
        "runtime": "hpi-ort-ort",
        "enableHpi": True,
        "precision": "provider-default-recorded",
        "recognitionBatchSize": 1,
        "pageBatchSize": 1,
        "requiredBackendTokens": ["onnxruntime"],
    },
    "g-ort4-small": {
        "tier": "small",
        "device": "gpu:0",
        "runtime": "hpi-ort-ort",
        "enableHpi": True,
        "precision": "provider-default-recorded",
        "recognitionBatchSize": 1,
        "pageBatchSize": 1,
        "providerCpuThreads": 4,
        "requiredBackendTokens": ["onnxruntime"],
    },
}


@app.function(
    image=gpu_hpi_image,
    gpu=GPU_TYPE,
    cpu=CPU_CORES,
    memory=MEMORY_MIB,
    timeout=3600,
)
def bench_hpi(config: dict[str, Any], pages: list[tuple[str, bytes]], repeats: int) -> dict:
    return _run_arm(config, pages, repeats)


@app.local_entrypoint()
def main(
    pages_dir: str,
    out_dir: str,
    arms: str = "g-hpi-tiny,g-hpi-small",
    repeats: int = 3,
    page_limit: int = 0,
    allow_dirty: bool = False,
) -> None:
    if repeats < 1:
        raise ValueError("repeats must be positive")
    source = _source_state(allow_dirty)
    pages, manifest_sha = _load_pages(Path(pages_dir), page_limit)
    if not pages:
        raise ValueError("page manifest selected no pages")
    run_id = f"{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}-{uuid.uuid4().hex[:8]}"
    run_dir = Path(out_dir) / run_id
    run_dir.mkdir(parents=True, exist_ok=False)
    requested_arms = arms.split(",")
    metadata = {
        "schemaVersion": "pagespatial-gpu-spike-run-v1",
        "runId": run_id,
        "appName": "pagespatial-gpu-spike-hpi-m1",
        "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": source,
        "inputManifestSha256": manifest_sha,
        "inputPages": len(pages),
        "inputBytes": sum(len(data) for _, data in pages),
        "requestedArms": requested_arms,
        "repeats": repeats,
    }
    (run_dir / "run.json").write_text(json.dumps(metadata, indent=1) + "\n")
    print(f"run={run_id} pages={len(pages)} bytes={metadata['inputBytes']}")

    for arm_name in requested_arms:
        if arm_name not in ARMS:
            raise ValueError(f"unknown arm: {arm_name}")
        config = dict(ARMS[arm_name], name=arm_name)
        attempt_started_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        started = time.monotonic()
        try:
            result = bench_hpi.remote(config, pages, repeats)
            result["attempt"] = {
                "startedAt": attempt_started_at,
                "remoteCallWallS": time.monotonic() - started,
                "terminal": "success",
            }
            status = "success"
        except Exception as error:
            result = {
                "schemaVersion": "pagespatial-gpu-spike-arm-v1",
                "arm": config,
                "attempt": {
                    "startedAt": attempt_started_at,
                    "remoteCallWallS": time.monotonic() - started,
                    "terminal": "failed",
                    "errorType": type(error).__name__,
                    "error": str(error),
                },
            }
            status = "failed"
        arm_path = run_dir / f"{arm_name}.json"
        arm_path.write_text(json.dumps(result, indent=1) + "\n")
        if status == "success":
            speeds = sorted(repeat["pagesPerS"] for repeat in result["repetitions"])
            print(
                f"{arm_name}: {speeds[len(speeds) // 2]:.3f} pages/s median; "
                f"init={result['initS']:.1f}s; provider={result['backendLogLines'][:3]} -> {arm_path}"
            )
        else:
            print(f"{arm_name}: FAILED -> {arm_path}: {result['attempt']['error']}")

    metadata["completedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    (run_dir / "run.json").write_text(json.dumps(metadata, indent=1) + "\n")
    print(f"evidence={run_dir}")

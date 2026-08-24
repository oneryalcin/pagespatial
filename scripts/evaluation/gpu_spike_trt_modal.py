#!/usr/bin/env python3
"""Conditional CUDA 11.8 / TensorRT arm for the PP-OCRv6 GPU spike.

The base image is PaddleX's documented CUDA 11.8, cuDNN 8.9, TensorRT 8.6
image.  The measured arm requires ONNX Runtime detection plus TensorRT FP16
recognition and fails if both providers are not observable at runtime.
"""
from __future__ import annotations

import json
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any

import modal

from gpu_spike_modal import (
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


APP_NAME = "pagespatial-gpu-spike-trt-m1"
OFFICIAL_PADDLEX_IMAGE = (
    "ccr-2vdh3abv-pub.cnc.bj.baidubce.com/paddlex/paddlex:"
    "paddlex3.3.11-paddlepaddle3.2.0-gpu-cuda11.8-cudnn8.9-trt8.6"
)
BASE_HARNESS_SOURCE = Path(__file__).with_name("gpu_spike_modal.py")
app = modal.App(APP_NAME)


def _install_hpi() -> None:
    """Install the PaddleOCR 3.7 GPU HPI plugin against the image GPU stack."""
    subprocess.run(["paddleocr", "install_hpi_deps", "gpu"], check=True)


trt_image = (
    modal.Image.from_registry(OFFICIAL_PADDLEX_IMAGE)
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
        extra_index_url="https://www.paddlepaddle.org.cn/packages/stable/cu118/",
    )
    .add_local_file(str(BASE_HARNESS_SOURCE), "/root/gpu_spike_modal.py", copy=True)
    .run_function(
        _install_hpi,
        gpu=GPU_TYPE,
        cpu=2.0,
        memory=MEMORY_MIB,
        timeout=1800,
    )
)

ARMS = {}
for _tier in ("tiny", "small"):
    ARMS[f"g-trt-{_tier}"] = {
        "tier": _tier,
        "device": "gpu:0",
        "runtime": "hpi-ort-trt",
        "enableHpi": True,
        "precision": "fp16",
        "recognitionBatchSize": 1,
        "pageBatchSize": 1,
        "requiredBackendTokens": ["onnxruntime", "tensorrt"],
        "providerLayout": {
            "textDetection": "onnxruntime",
            "textRecognition": "tensorrt",
        },
    }


@app.function(
    image=trt_image,
    gpu=GPU_TYPE,
    cpu=CPU_CORES,
    memory=MEMORY_MIB,
    timeout=3600,
)
def bench_trt(config: dict[str, Any], pages: list[tuple[str, bytes]], repeats: int) -> dict:
    return _run_arm(config, pages, repeats)


@app.local_entrypoint()
def main(
    pages_dir: str,
    out_dir: str,
    arms: str = "g-trt-tiny,g-trt-small",
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
        "appName": APP_NAME,
        "baseImage": OFFICIAL_PADDLEX_IMAGE,
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
            result = bench_trt.remote(config, pages, repeats)
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
                f"init={result['initS']:.1f}s; providers attested -> {arm_path}"
            )
        else:
            print(f"{arm_name}: FAILED -> {arm_path}: {result['attempt']['error']}")

    metadata["completedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    (run_dir / "run.json").write_text(json.dumps(metadata, indent=1) + "\n")
    print(f"evidence={run_dir}")

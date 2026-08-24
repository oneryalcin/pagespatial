#!/usr/bin/env python3
"""Conditional CUDA 11.8 / TensorRT arm for the PP-OCRv6 GPU spike.

The smaller PaddlePaddle image is the vendor-documented CUDA 11.8, cuDNN 8.9,
TensorRT 8.6 stack. Measured arms require ONNX Runtime detection plus an
explicit TensorRT recognizer and fail if both providers are not observable.
"""
from __future__ import annotations

import json
import hashlib
import shutil
import statistics
import subprocess
import sys
import time
import uuid
from glob import glob
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


APP_NAME = "pagespatial-gpu-spike-trt-direct-m1"
ULTRA_INFER_SOURCE_REV = "ffb64904d23708863ff5b8da312a5cbd52a7f462"
ULTRA_INFER_PATCH = Path(__file__).with_name(
    "ultra-infer-trt-runtime-lifetime.patch"
)
ULTRA_INFER_PATCH_SHA256 = (
    "b03632bbfae1372f21a2e31babbf72f8936943a0848ff3db853a2f1cd5216bd6"
)
REMOTE_ULTRA_INFER_PATCH = Path("/root/ultra-infer-trt-runtime-lifetime.patch")
OFFICIAL_PADDLE_TRT_IMAGE = (
    "ccr-2vdh3abv-pub.cnc.bj.baidubce.com/paddlepaddle/paddle:"
    "3.0.0-gpu-cuda11.8-cudnn8.9-trt8.6"
)
BASE_HARNESS_SOURCE = Path(__file__).with_name("gpu_spike_modal.py")
app = modal.App(APP_NAME)


def _install_hpi() -> None:
    """Install the image's exact TRT wheel and matching CUDA 11 HPI plugin."""
    wheels = sorted(
        glob("/usr/local/TensorRT-*/python/tensorrt-8.6.1-cp310-none-linux_x86_64.whl")
    )
    if len(wheels) != 1:
        raise RuntimeError(f"expected one TensorRT 8.6.1 cp310 wheel, found {wheels}")
    subprocess.run([sys.executable, "-m", "pip", "install", wheels[0]], check=True)
    subprocess.run(["paddleocr", "install_hpi_deps", "gpu"], check=True)
    import paddle
    import tensorrt

    if not str(tensorrt.__version__).startswith("8.6.1"):
        raise RuntimeError(f"unexpected TensorRT version: {tensorrt.__version__}")
    if str(paddle.version.cuda()) != "11.8":
        raise RuntimeError(f"unexpected Paddle CUDA version: {paddle.version.cuda()}")


trt_image = (
    modal.Image.from_registry(OFFICIAL_PADDLE_TRT_IMAGE)
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
    .add_local_file(str(BASE_HARNESS_SOURCE), "/root/gpu_spike_modal.py", copy=True)
    .run_function(
        _install_hpi,
        gpu=GPU_TYPE,
        cpu=2.0,
        memory=MEMORY_MIB,
        timeout=1800,
    )
    # UltraInfer 1.2.0 destroys TensorRT's IRuntime immediately after it
    # deserializes the long-lived engine. TensorRT 8.6 rejects that ownership
    # order. Build the same pinned UltraInfer source with the minimal lifetime
    # repair instead of hiding the error or changing inference providers.
    .add_local_file(
        str(ULTRA_INFER_PATCH), str(REMOTE_ULTRA_INFER_PATCH), copy=True
    )
    .apt_install("python3.10-dev", "rapidjson-dev")
    .run_commands(
        "git init /opt/paddlex-source",
        "git -C /opt/paddlex-source remote add origin https://github.com/PaddlePaddle/PaddleX.git",
        "git -C /opt/paddlex-source config core.sparseCheckout true",
        "mkdir -p /opt/paddlex-source/.git/info",
        "echo deploy/ultra-infer/ > /opt/paddlex-source/.git/info/sparse-checkout",
        f"git -C /opt/paddlex-source fetch --depth=1 origin {ULTRA_INFER_SOURCE_REV}",
        "git -C /opt/paddlex-source checkout --detach FETCH_HEAD",
        f"git -C /opt/paddlex-source apply {REMOTE_ULTRA_INFER_PATCH}",
        (
            "cd /opt/paddlex-source/deploy/ultra-infer/python && "
            "python setup.py build"
        ),
        (
            "cd /opt/paddlex-source/deploy/ultra-infer/python && "
            "patchelf --set-rpath "
            "'$ORIGIN/libs/third_libs/onnxruntime/lib:"
            "$ORIGIN/libs/third_libs/paddle2onnx/lib:"
            "$ORIGIN/libs/third_libs/tensorrt/lib' "
            "build/lib.*/ultra_infer/ultra_infer_main*.so"
        ),
        (
            "cd /opt/paddlex-source/deploy/ultra-infer/python && "
            "python setup.py bdist_wheel"
        ),
        (
            "python -m pip install --force-reinstall --no-deps "
            "/opt/paddlex-source/deploy/ultra-infer/python/dist/*.whl"
        ),
        env={
            "WITH_GPU": "ON",
            "DEVICE_TYPE": "GPU",
            "ENABLE_ORT_BACKEND": "ON",
            "ENABLE_TRT_BACKEND": "ON",
            "ENABLE_PADDLE_BACKEND": "OFF",
            "ENABLE_OPENVINO_BACKEND": "OFF",
            "ENABLE_VISION": "OFF",
            "ENABLE_TEXT": "OFF",
            "TRT_DIRECTORY": "/usr/local/TensorRT-8.6.1.6",
            "CC": "/usr/local/gcc-8.2/bin/gcc",
            "CXX": "/usr/local/gcc-8.2/bin/g++",
            "CMAKE_ARGS": (
                "-DPython_EXECUTABLE=/usr/bin/python "
                "-DPython_INCLUDE_DIR=/usr/include/python3.10 "
                "-DPython_LIBRARY=/usr/lib/x86_64-linux-gnu/libpython3.10.so"
            ),
        },
    )
)

ARMS = {}
for _tier in ("tiny", "small"):
    for _precision in ("fp32", "fp16"):
        _base_name = f"g-trt-{_tier}-{_precision}"
        ARMS[_base_name] = {
            "tier": _tier,
            "device": "gpu:0",
            "runtime": "hpi-ort-trt",
            "enableHpi": True,
            "precision": _precision,
            "recognitionBatchSize": 1,
            "pageBatchSize": 1,
            "requiredBackendTokens": ["onnxruntime", "tensorrt"],
            "providerLayout": {
                "textDetection": "onnxruntime",
                "textRecognition": "tensorrt",
            },
        }
        for _batch_size in (4, 8):
            ARMS[f"{_base_name}-b{_batch_size}"] = {
                **ARMS[_base_name],
                "recognitionBatchSize": _batch_size,
            }


@app.function(
    image=trt_image,
    gpu=GPU_TYPE,
    cpu=CPU_CORES,
    memory=MEMORY_MIB,
    timeout=3600,
)
def bench_trt(
    config: dict[str, Any],
    pages: list[tuple[str, bytes]],
    repeats: int,
    cache_reload_probe: bool = False,
) -> dict:
    # UltraInfer otherwise writes every precision to the same
    # ``.cache/tensorrt/trt_serialized.trt`` path under the model directory.
    # Give each tier/precision its own private writable model tree so an FP16
    # arm cannot silently load an FP32 engine (or vice versa).
    import gpu_spike_modal as harness
    from ultra_infer import code_version

    if code_version.git_version != ULTRA_INFER_SOURCE_REV:
        raise RuntimeError(
            "patched UltraInfer source mismatch: "
            f"{code_version.git_version!r} != {ULTRA_INFER_SOURCE_REV!r}"
        )

    source_tier = REMOTE_ROOT / "models" / config["tier"]
    private_root = Path("/tmp/pagespatial-trt-models") / config["precision"]
    private_tier = private_root / config["tier"]
    if not private_tier.exists():
        private_tier.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(source_tier, private_tier)
    harness.MODEL_ROOT = private_root
    result = _run_arm(config, pages, repeats)
    result["ultraInferPatch"] = {
        "sourceRevision": ULTRA_INFER_SOURCE_REV,
        "patchSha256": ULTRA_INFER_PATCH_SHA256,
    }
    runtime_error = "Destroying a runtime before destroying deserialized engines"
    if runtime_error in "\n".join(result.get("backendLogLines", [])):
        raise RuntimeError("TensorRT runtime-lifetime error remains after patch")
    if cache_reload_probe:
        reload_started = time.monotonic()
        reload_result = _run_arm(config, pages[:1], 1)
        reload_logs = reload_result.get("backendLogLines", [])
        reload_log_text = "\n".join(reload_logs)
        reload_pass = (
            reload_result.get("backendAttestation", {}).get("pass") is True
            and runtime_error not in reload_log_text
            and "Start to building TensorRT Engine" not in reload_log_text
        )
        result["cacheReloadProbe"] = {
            "pass": reload_pass,
            "wallS": time.monotonic() - reload_started,
            "initS": reload_result.get("initS"),
            "backendAttestation": reload_result.get("backendAttestation"),
            "backendLogLines": reload_logs,
            "page": pages[0][0],
        }
        if not reload_pass:
            raise RuntimeError("TensorRT cached-engine lifetime probe failed")
    return result


@app.local_entrypoint()
def main(
    pages_dir: str,
    out_dir: str,
    arms: str = "g-trt-small-fp32,g-trt-small-fp16",
    repeats: int = 3,
    page_limit: int = 0,
    cache_reload_probe: bool = False,
    allow_dirty: bool = False,
) -> None:
    if repeats < 1:
        raise ValueError("repeats must be positive")
    patch_sha = hashlib.sha256(ULTRA_INFER_PATCH.read_bytes()).hexdigest()
    if patch_sha != ULTRA_INFER_PATCH_SHA256:
        raise RuntimeError(
            f"UltraInfer patch hash mismatch: {patch_sha} != {ULTRA_INFER_PATCH_SHA256}"
        )
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
        "baseImage": OFFICIAL_PADDLE_TRT_IMAGE,
        "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": source,
        "inputManifestSha256": manifest_sha,
        "inputPages": len(pages),
        "inputBytes": sum(len(data) for _, data in pages),
        "requestedArms": requested_arms,
        "repeats": repeats,
        "cacheReloadProbe": cache_reload_probe,
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
            result = bench_trt.remote(config, pages, repeats, cache_reload_probe)
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
            speeds = [repeat["pagesPerS"] for repeat in result["repetitions"]]
            print(
                f"{arm_name}: {statistics.median(speeds):.3f} pages/s median; "
                f"init={result['initS']:.1f}s; providers attested -> {arm_path}"
            )
        else:
            print(f"{arm_name}: FAILED -> {arm_path}: {result['attempt']['error']}")

    metadata["completedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    (run_dir / "run.json").write_text(json.dumps(metadata, indent=1) + "\n")
    print(f"evidence={run_dir}")

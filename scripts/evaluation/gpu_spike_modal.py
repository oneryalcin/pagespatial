"""Bounded M1/M1.5 Modal harness for the PP-OCRv6 GPU spike.

The harness benchmarks already-rendered, hash-frozen English pages. It never
downloads a model during a measured call. Each arm captures model hashes,
runtime/device/backend evidence, native backend logs, requested and observed
batch sizes, raw page results, warm repetitions, resource telemetry, and the
dirty-source diff hash when the explicit development override is used.

Typical M1 run from the repository root:

  modal run scripts/evaluation/gpu_spike_modal.py -- \
    --pages-dir .evaluation/gpu-spike/english-diagnostic-v1 \
    --out-dir .evaluation/gpu-spike/2026-08-24 \
    --arms c-hpi-small,g-pd-small,c-hpi-tiny,g-pd-tiny \
    --allow-dirty

The design source of truth is docs/design/2026-08-24-gpu-ocr-spike.md.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import random
import re
import statistics
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Iterable

import modal


APP_NAME = "pagespatial-gpu-spike-m1"
CPU_CORES = 4.0
MEMORY_MIB = 8192
GPU_TYPE = "L4"
MODEL_ROOT = Path("/opt/pagespatial/models")
VERIFICATION_PATH = Path("/opt/pagespatial/model-verification.json")
REMOTE_ROOT = Path("/opt/pagespatial")
BACKEND_WORDS = (
    "backend",
    "hpi",
    "hpip",
    "openvino",
    "onnxruntime",
    "paddle_infer",
    "paddle inference",
    "tensorrt",
    "run_mode",
    "precision",
)

if modal.is_local():
    REPO_ROOT = Path(__file__).resolve().parents[2]
    MODEL_MANIFEST = REPO_ROOT / "evaluation/gpu-spike/model-pins-v1.json"
    MODEL_FETCHER = REPO_ROOT / "scripts/evaluation/fetch_gpu_spike_models.py"
else:
    REPO_ROOT = Path("/opt/pagespatial")
    MODEL_MANIFEST = REPO_ROOT / "model-pins-v1.json"
    MODEL_FETCHER = REPO_ROOT / "fetch_gpu_spike_models.py"

app = modal.App(APP_NAME)

APT = ["libgl1", "libglib2.0-0", "libgomp1", "ccache"]
MODEL_FETCH_COMMAND = (
    "python /opt/pagespatial/fetch_gpu_spike_models.py "
    "--manifest /opt/pagespatial/model-pins-v1.json "
    "--models-dir /opt/pagespatial/models "
    "--verification-out /opt/pagespatial/model-verification.json"
)

model_base = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install(*APT)
    .uv_pip_install("huggingface-hub==0.34.4")
    .add_local_file(str(MODEL_MANIFEST), str(REMOTE_ROOT / "model-pins-v1.json"), copy=True)
    .add_local_file(str(MODEL_FETCHER), str(REMOTE_ROOT / "fetch_gpu_spike_models.py"), copy=True)
    .run_commands(MODEL_FETCH_COMMAND)
)

cpu_image = (
    model_base
    .uv_pip_install(
        "paddlepaddle==3.2.1",
        "paddleocr==3.7.0",
        "paddlex==3.7.2",
        "psutil==7.0.0",
        "setuptools",
    )
    .run_commands("paddleocr install_hpi_deps cpu")
)

gpu_image = model_base.uv_pip_install(
    "paddleocr==3.7.0",
    "paddlex==3.7.2",
    "psutil==7.0.0",
    "setuptools",
).uv_pip_install(
    "paddlepaddle-gpu==3.2.1",
    extra_index_url="https://www.paddlepaddle.org.cn/packages/stable/cu126/",
)

ARMS = {
    "c-hpi-tiny": {
        "tier": "tiny",
        "device": "cpu",
        "runtime": "hpi-auto",
        "enableHpi": True,
        "precision": "fp32",
        "recognitionBatchSize": 1,
        "pageBatchSize": 1,
    },
    "c-hpi-small": {
        "tier": "small",
        "device": "cpu",
        "runtime": "hpi-auto",
        "enableHpi": True,
        "precision": "fp32",
        "recognitionBatchSize": 1,
        "pageBatchSize": 1,
    },
    "g-pd-tiny": {
        "tier": "tiny",
        "device": "gpu:0",
        "runtime": "paddle-static",
        "enableHpi": False,
        "precision": "fp32",
        "recognitionBatchSize": 1,
        "pageBatchSize": 1,
    },
    "g-pd-small": {
        "tier": "small",
        "device": "gpu:0",
        "runtime": "paddle-static",
        "enableHpi": False,
        "precision": "fp32",
        "recognitionBatchSize": 1,
        "pageBatchSize": 1,
    },
}

# M1.5 prepared-image smoke variants. Keeping these as named arms makes B1/C1
# and B8/C8 run in one app window and records the treatment in the arm ID; a
# global CLI override would make the evidence easier to mislabel.
for _tier in ("tiny", "small"):
    _base_name = f"g-pd-{_tier}"
    ARMS[f"{_base_name}-b1c1"] = dict(ARMS[_base_name])
    ARMS[f"{_base_name}-b8c1"] = {
        **ARMS[_base_name],
        "recognitionBatchSize": 8,
    }
    ARMS[f"{_base_name}-b1c8"] = {
        **ARMS[_base_name],
        "pageBatchSize": 8,
        "pageBatchPolicy": "same-shape-no-pad",
    }
    ARMS[f"{_base_name}-b8c8"] = {
        **ARMS[_base_name],
        "recognitionBatchSize": 8,
        "pageBatchSize": 8,
        "pageBatchPolicy": "same-shape-no-pad",
    }


def _installed_versions() -> dict[str, str]:
    import importlib.metadata

    versions = {}
    for package in (
        "paddleocr",
        "paddlepaddle",
        "paddlepaddle-gpu",
        "paddlex",
        "onnxruntime",
        "onnxruntime-gpu",
        "openvino",
        "tensorrt",
    ):
        try:
            versions[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            continue
    return versions


def _jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    if hasattr(value, "tolist"):
        return _jsonable(value.tolist())
    return str(value)


def _walk_interesting_attrs(root: Any) -> dict[str, Any]:
    found: dict[str, Any] = {}
    seen: set[int] = set()

    def walk(obj: Any, path: str, depth: int) -> None:
        if depth > 6 or id(obj) in seen or len(found) >= 100:
            return
        seen.add(id(obj))
        for attr in dir(obj):
            if attr.startswith("__"):
                continue
            try:
                value = getattr(obj, attr)
            except Exception:
                continue
            lowered = attr.lower()
            if any(word in lowered for word in BACKEND_WORDS) or "batch" in lowered:
                if isinstance(value, (str, int, float, bool)):
                    found[f"{path}.{attr}"] = value
                elif isinstance(value, dict):
                    primitives = {
                        str(key): item
                        for key, item in value.items()
                        if isinstance(item, (str, int, float, bool))
                    }
                    if primitives:
                        found[f"{path}.{attr}"] = primitives
            if depth >= 6 or isinstance(
                value, (str, int, float, bool, bytes, dict, list, tuple, set)
            ):
                continue
            module = type(value).__module__
            if module != "builtins" and (
                module.startswith(("paddle", "paddlex"))
                or "pipeline" in attr.lower()
                or "model" in attr.lower()
            ):
                walk(value, f"{path}.{attr}", depth + 1)

    walk(root, "ocr", 0)
    return found


class _BatchSamplerProbe:
    def __init__(self, delegate: Any, path: str, observations: list[dict[str, Any]]):
        self._delegate = delegate
        self._path = path
        self._observations = observations

    @property
    def batch_size(self) -> Any:
        return getattr(self._delegate, "batch_size", None)

    @batch_size.setter
    def batch_size(self, value: Any) -> None:
        setattr(self._delegate, "batch_size", value)

    def __call__(self, inputs: Any) -> Iterable[Any]:
        for batch in self._delegate(inputs):
            instances = getattr(batch, "instances", None)
            try:
                size = len(instances) if instances is not None else len(batch)
            except Exception:
                size = None
            self._observations.append(
                {
                    "path": self._path,
                    "effectiveBatchSize": size,
                    "requestedBatchSize": self.batch_size,
                }
            )
            yield batch

    def __getattr__(self, name: str) -> Any:
        return getattr(self._delegate, name)


def _instrument_batch_samplers(root: Any, page_batch_size: int) -> list[dict[str, Any]]:
    observations: list[dict[str, Any]] = []
    seen: set[int] = set()

    def walk(obj: Any, path: str, depth: int) -> None:
        if depth > 7 or id(obj) in seen:
            return
        seen.add(id(obj))
        for attr in dir(obj):
            if attr.startswith("__"):
                continue
            try:
                value = getattr(obj, attr)
            except Exception:
                continue
            child_path = f"{path}.{attr}"
            if attr == "batch_sampler" and callable(value):
                # The OCR pipeline sampler controls how many prepared page
                # arrays enter one detector call. Recognition model samplers
                # retain the public constructor's requested crop batch size.
                if "text_rec_model" not in path and hasattr(value, "batch_size"):
                    value.batch_size = page_batch_size
                try:
                    setattr(obj, attr, _BatchSamplerProbe(value, child_path, observations))
                except Exception:
                    observations.append(
                        {"path": child_path, "instrumentationError": "assignment-refused"}
                    )
                continue
            if depth >= 7 or isinstance(
                value, (str, int, float, bool, bytes, dict, list, tuple, set)
            ):
                continue
            module = type(value).__module__
            if module.startswith(("paddle", "paddlex")) or "pipeline" in attr.lower():
                walk(value, child_path, depth + 1)

    walk(root, "ocr", 0)
    return observations


@contextlib.contextmanager
def _capture_native_output() -> Iterable[Path]:
    """Capture Python and native/C++ stdout/stderr for backend attestation."""
    path = Path(tempfile.mkstemp(prefix="gpu-spike-backend-", suffix=".log")[1])
    saved_stdout = os.dup(1)
    saved_stderr = os.dup(2)
    with path.open("ab", buffering=0) as target:
        try:
            os.dup2(target.fileno(), 1)
            os.dup2(target.fileno(), 2)
            yield path
        finally:
            try:
                import ctypes

                ctypes.CDLL(None).fflush(None)
            except Exception:
                pass
            os.dup2(saved_stdout, 1)
            os.dup2(saved_stderr, 2)
            os.close(saved_stdout)
            os.close(saved_stderr)


def _backend_lines(text: str) -> list[str]:
    lines = []
    for raw in text.splitlines():
        if any(word in raw.lower() for word in BACKEND_WORDS):
            lines.append(raw[-1000:])
        if len(lines) >= 120:
            break
    return lines


def _nvidia_query(fields: str) -> list[str]:
    try:
        result = subprocess.run(
            [
                "nvidia-smi",
                f"--query-gpu={fields}",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        return [line.strip() for line in result.stdout.splitlines() if line.strip()]
    except Exception:
        return []


class _GpuSampler:
    def __init__(self) -> None:
        self.samples: list[dict[str, Any]] = []
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        def sample() -> None:
            while not self._stop.is_set():
                rows = _nvidia_query(
                    "timestamp,utilization.gpu,utilization.memory,memory.used,power.draw"
                )
                if rows:
                    parts = [part.strip() for part in rows[0].split(",")]
                    if len(parts) >= 5:
                        self.samples.append(
                            {
                                "timestamp": parts[0],
                                "gpuUtilPercent": _number(parts[1]),
                                "memoryUtilPercent": _number(parts[2]),
                                "memoryUsedMiB": _number(parts[3]),
                                "powerW": _number(parts[4]),
                            }
                        )
                self._stop.wait(0.2)

        self._thread = threading.Thread(target=sample, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)


def _number(value: str) -> float | None:
    match = re.search(r"[-+]?\d+(?:\.\d+)?", value)
    return float(match.group(0)) if match else None


def _decode_pages(pages: list[tuple[str, bytes]]) -> tuple[list[tuple[str, Any]], float]:
    import cv2
    import numpy as np

    decoded = []
    started = time.monotonic()
    for name, png_bytes in pages:
        image = cv2.imdecode(np.frombuffer(png_bytes, dtype=np.uint8), cv2.IMREAD_COLOR)
        if image is None:
            raise RuntimeError(f"OpenCV could not decode {name}")
        decoded.append((name, image))
    return decoded, time.monotonic() - started


def _result_rows(results: Iterable[Any], names: list[str]) -> list[dict[str, Any]]:
    rows = []
    for index, result in enumerate(results):
        data = result if isinstance(result, dict) else result.json.get("res", result.json)
        texts = data.get("rec_texts", [])
        scores = data.get("rec_scores", [])
        polys = data.get("rec_polys", data.get("dt_polys", []))
        lines = []
        for line_index, text in enumerate(texts):
            poly = polys[line_index] if line_index < len(polys) else None
            box = None
            if poly is not None and len(poly):
                xs = [float(point[0]) for point in poly]
                ys = [float(point[1]) for point in poly]
                box = [min(xs), min(ys), max(xs), max(ys)]
            lines.append(
                {
                    "text": str(text),
                    "score": (
                        float(scores[line_index]) if line_index < len(scores) else None
                    ),
                    "box": box,
                }
            )
        rows.append(
            {
                "page": names[index] if index < len(names) else f"unknown-{index}",
                "lines": lines,
                "detectedCrops": len(polys),
            }
        )
    if len(rows) != len(names):
        raise RuntimeError(f"expected {len(names)} page results, received {len(rows)}")
    return rows


def _construct_ocr(config: dict[str, Any]) -> Any:
    from paddleocr import PaddleOCR

    tier = config["tier"]
    kwargs = {
        "text_detection_model_name": f"PP-OCRv6_{tier}_det",
        "text_detection_model_dir": str(MODEL_ROOT / tier / "detector"),
        "text_recognition_model_name": f"PP-OCRv6_{tier}_rec",
        "text_recognition_model_dir": str(MODEL_ROOT / tier / "recognizer"),
        "text_recognition_batch_size": config["recognitionBatchSize"],
        "use_doc_orientation_classify": False,
        "use_doc_unwarping": False,
        "use_textline_orientation": False,
        "device": config["device"],
        "enable_hpi": config["enableHpi"],
    }
    if config["runtime"] in {"hpi-ort-trt", "hpi-ort-ort"}:
        # PaddleX documents a split provider configuration for general OCR:
        # ONNX Runtime for detection and TensorRT for recognition. The ORT/ORT
        # variant is the bounded fallback when the compatible TensorRT stack is
        # unavailable. Put the provider choice at the submodule level so a
        # global auto-selection cannot silently replace either half.
        from paddlex.inference import load_pipeline_config

        pipeline_config = load_pipeline_config("OCR")
        pipeline_config["use_doc_preprocessor"] = False
        pipeline_config["use_textline_orientation"] = False
        recognition_backend = (
            "tensorrt" if config["runtime"] == "hpi-ort-trt" else "onnxruntime"
        )
        providers = {
            "TextDetection": {
                "auto_config": False,
                "backend": "onnxruntime",
                "auto_paddle2onnx": True,
            },
            "TextRecognition": {
                "auto_config": False,
                "backend": recognition_backend,
                "auto_paddle2onnx": True,
            },
        }
        if recognition_backend == "tensorrt":
            providers["TextRecognition"]["backend_config"] = {
                "precision": config["precision"]
            }
        elif config.get("providerCpuThreads") is not None:
            for provider in providers.values():
                provider["backend_config"] = {
                    "cpu_num_threads": config["providerCpuThreads"]
                }
        for module_name, hpi_config in providers.items():
            module = pipeline_config["SubModules"][module_name]
            module["use_hpip"] = True
            module["hpi_config"] = hpi_config
        kwargs["paddlex_config"] = pipeline_config
        # Deep submodule settings above are the authority. A global HPI flag
        # would obscure which provider actually owns each model.
        kwargs.pop("enable_hpi")
    if config["runtime"] == "paddle-static":
        kwargs["engine"] = "paddle_static"
        kwargs["precision"] = config["precision"]
    if config["device"] == "cpu":
        kwargs["cpu_threads"] = 4
    return PaddleOCR(**kwargs)


def _device_truth() -> dict[str, Any]:
    import paddle

    truth = {
        "paddleDevice": str(paddle.device.get_device()),
        "cudaCompiled": bool(paddle.device.is_compiled_with_cuda()),
        "cudaVersion": getattr(paddle.version, "cuda", lambda: None)(),
        "cudnnVersion": getattr(paddle.version, "cudnn", lambda: None)(),
        "nvidiaSmiIdentity": _nvidia_query(
            "name,uuid,driver_version,memory.total,compute_cap"
        ),
    }
    try:
        truth["paddleCudaDeviceName"] = paddle.device.cuda.get_device_name()
    except Exception:
        truth["paddleCudaDeviceName"] = None
    return truth


def _attest_backend(
    config: dict[str, Any], device_truth: dict[str, Any], attrs: dict[str, Any], logs: list[str]
) -> dict[str, Any]:
    reasons = []
    combined = json.dumps({"attrs": attrs, "logs": logs}, sort_keys=True).lower()
    if config["device"].startswith("gpu"):
        if not device_truth.get("cudaCompiled"):
            reasons.append("Paddle is not compiled with CUDA")
        if not str(device_truth.get("paddleDevice", "")).startswith("gpu"):
            reasons.append("Paddle active device is not GPU")
        if not device_truth.get("nvidiaSmiIdentity"):
            reasons.append("nvidia-smi did not identify a GPU")
    else:
        if str(device_truth.get("paddleDevice")) != "cpu":
            reasons.append("CPU arm did not report the CPU device")
    if config["enableHpi"]:
        if not any(token in combined for token in ("use_hpip", "enable_hpi", "hpi")):
            reasons.append("HPI requested but no HPI state was observable")
        if config["device"].startswith("gpu") and not any(
            token in combined for token in ("tensorrt", "onnxruntime", "paddle inference")
        ):
            reasons.append("GPU HPI provider could not be identified")
        for token in config.get("requiredBackendTokens", []):
            if token.lower() not in combined:
                reasons.append(f"required backend token was not observed: {token}")
    else:
        if "use_hpip\": true" in combined or "use_hpip': true" in combined:
            reasons.append("HPI was active in a non-HPI arm")
    return {"pass": not reasons, "reasons": reasons}


def _run_arm(config: dict[str, Any], pages: list[tuple[str, bytes]], repeats: int) -> dict:
    import psutil

    verification = json.loads(VERIFICATION_PATH.read_text())
    decoded, decode_s = _decode_pages(pages)
    native_log_path: Path | None = None
    with _capture_native_output() as log_path:
        native_log_path = log_path
        init_started = time.monotonic()
        ocr = _construct_ocr(config)
        init_s = time.monotonic() - init_started
        # Historical arm IDs call this C. In this prepared-image harness it is
        # specifically a same-shape list-input group size, not concurrent
        # producers or unsynchronized calls into one Paddle object. True C
        # requires the A2 owner/queue treatment and is intentionally unbuilt.
        batch_observations = _instrument_batch_samplers(ocr, config["pageBatchSize"])
        # Lazy engine build is not mixed into a warm repetition.
        first_started = time.monotonic()
        first_result = list(ocr.predict(decoded[0][1]))
        first_inference_s = time.monotonic() - first_started
    native_text = native_log_path.read_text(errors="replace") if native_log_path else ""
    if native_log_path:
        native_log_path.unlink(missing_ok=True)

    attrs = _walk_interesting_attrs(ocr)
    device_truth = _device_truth()
    backend_logs = _backend_lines(native_text)
    attestation = _attest_backend(config, device_truth, attrs, backend_logs)
    device_mutation = _attest_backend(
        config,
        {
            **device_truth,
            "paddleDevice": "cpu" if config["device"].startswith("gpu") else "gpu:0",
            "cudaCompiled": False,
            "nvidiaSmiIdentity": [],
        },
        attrs,
        backend_logs,
    )
    mutations = {
        "wrongDevice": {
            "pass": not device_mutation["pass"],
            "reasons": device_mutation["reasons"],
        }
    }
    if device_mutation["pass"]:
        raise RuntimeError("device-attestation mutation unexpectedly passed")
    required_backend_tokens = config.get("requiredBackendTokens", [])
    if required_backend_tokens:
        provider_mutation = _attest_backend(config, device_truth, {}, [])
        mutations["missingProviderEvidence"] = {
            "pass": not provider_mutation["pass"],
            "reasons": provider_mutation["reasons"],
        }
        if provider_mutation["pass"]:
            raise RuntimeError("provider-attestation mutation unexpectedly passed")
    if not attestation["pass"]:
        raise RuntimeError("backend attestation failed: " + "; ".join(attestation["reasons"]))

    process = psutil.Process()
    gpu_sampler = _GpuSampler()
    if config["device"].startswith("gpu"):
        gpu_sampler.start()
    repetitions = []
    try:
        for repeat in range(repeats):
            ordered = list(decoded)
            repeat_rng = random.Random(20260824 + repeat)
            repeat_rng.shuffle(ordered)
            if config["pageBatchSize"] > 1:
                # Paddle's detector stacks page arrays before inference. A
                # heterogeneous list fails rather than resizing. Preserve the
                # exact decoded pixels: bucket by array shape, never pad or
                # resize, then randomize the resulting same-shape groups.
                buckets: dict[tuple[Any, ...], list[tuple[str, Any]]] = {}
                for item in ordered:
                    image = item[1]
                    key = (*image.shape, image.dtype.str)
                    buckets.setdefault(key, []).append(item)
                groups = []
                for bucket in buckets.values():
                    groups.extend(
                        bucket[offset : offset + config["pageBatchSize"]]
                        for offset in range(0, len(bucket), config["pageBatchSize"])
                    )
                repeat_rng.shuffle(groups)
            else:
                groups = [[item] for item in ordered]
            page_rows = []
            started_cpu = time.process_time()
            started = time.monotonic()
            group_timings = []
            for group in groups:
                names = [name for name, _ in group]
                images = [image for _, image in group]
                group_started = time.monotonic()
                result = list(ocr.predict(images if len(images) > 1 else images[0]))
                group_s = time.monotonic() - group_started
                rows = _result_rows(result, names)
                for row in rows:
                    row["groupWallS"] = group_s
                page_rows.extend(rows)
                group_timings.append(
                    {"pages": names, "wallS": group_s, "terminalPages": len(rows)}
                )
            wall_s = time.monotonic() - started
            cpu_s = time.process_time() - started_cpu
            repetitions.append(
                {
                    "repeat": repeat + 1,
                    "orderSeed": 20260824 + repeat,
                    "wallS": wall_s,
                    "cpuS": cpu_s,
                    "pagesPerS": len(page_rows) / wall_s,
                    "rssMiB": process.memory_info().rss / 1048576,
                    "groups": group_timings,
                    "pages": page_rows,
                }
            )
    finally:
        gpu_sampler.stop()

    effective = [
        item["effectiveBatchSize"]
        for item in batch_observations
        if isinstance(item.get("effectiveBatchSize"), int)
    ]
    telemetry = gpu_sampler.samples
    numeric_gpu_util = [
        sample["gpuUtilPercent"]
        for sample in telemetry
        if sample.get("gpuUtilPercent") is not None
    ]
    numeric_gpu_mem = [
        sample["memoryUsedMiB"]
        for sample in telemetry
        if sample.get("memoryUsedMiB") is not None
    ]
    return {
        "schemaVersion": "pagespatial-gpu-spike-arm-v1",
        "arm": config,
        "resources": {
            "physicalCpuCores": CPU_CORES,
            "memoryMiB": MEMORY_MIB,
            "gpu": GPU_TYPE if config["device"].startswith("gpu") else None,
        },
        "modelVerification": verification[config["tier"]],
        "versions": _installed_versions(),
        "deviceTruth": device_truth,
        "backendAttrs": attrs,
        "backendLogLines": backend_logs,
        "backendAttestation": attestation,
        "backendMutationTests": mutations,
        "decodeS": decode_s,
        "initS": init_s,
        "firstInferenceS": first_inference_s,
        "firstInferenceLines": sum(
            len(row["lines"]) for row in _result_rows(first_result, [decoded[0][0]])
        ),
        "batchObservations": batch_observations,
        "effectiveBatchSummary": {
            "observations": len(effective),
            "min": min(effective) if effective else None,
            "max": max(effective) if effective else None,
            "median": statistics.median(effective) if effective else None,
        },
        "gpuTelemetry": {
            "samples": telemetry,
            "maxGpuUtilPercent": max(numeric_gpu_util) if numeric_gpu_util else None,
            "medianGpuUtilPercent": (
                statistics.median(numeric_gpu_util) if numeric_gpu_util else None
            ),
            "maxMemoryUsedMiB": max(numeric_gpu_mem) if numeric_gpu_mem else None,
        },
        "repetitions": repetitions,
    }


@app.function(image=cpu_image, cpu=CPU_CORES, memory=MEMORY_MIB, timeout=3600)
def bench_cpu(config: dict[str, Any], pages: list[tuple[str, bytes]], repeats: int) -> dict:
    return _run_arm(config, pages, repeats)


@app.function(
    image=gpu_image,
    gpu=GPU_TYPE,
    cpu=CPU_CORES,
    memory=MEMORY_MIB,
    timeout=3600,
)
def bench_gpu(config: dict[str, Any], pages: list[tuple[str, bytes]], repeats: int) -> dict:
    return _run_arm(config, pages, repeats)


def _source_state(allow_dirty: bool) -> dict[str, Any]:
    revision = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    status = subprocess.run(
        ["git", "status", "--porcelain", "--untracked-files=all"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    dirty = bool(status.strip())
    if dirty and not allow_dirty:
        raise RuntimeError(
            "source tree is dirty; commit it or pass --allow-dirty to record a diff hash"
        )
    digest = hashlib.sha256()
    if dirty:
        diff = subprocess.run(
            ["git", "diff", "--binary", "HEAD"],
            cwd=REPO_ROOT,
            capture_output=True,
            check=True,
        ).stdout
        digest.update(diff)
        for line in status.splitlines():
            if not line.startswith("?? "):
                continue
            relative = line[3:]
            path = REPO_ROOT / relative
            digest.update(relative.encode())
            if path.is_file():
                digest.update(hashlib.sha256(path.read_bytes()).digest())
    return {
        "gitRevision": revision,
        "dirty": dirty,
        "diffSha256": digest.hexdigest() if dirty else None,
        "status": status.splitlines(),
    }


def _load_pages(pages_dir: Path, limit: int) -> tuple[list[tuple[str, bytes]], str]:
    manifest_path = pages_dir / "manifest.json"
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    entries = manifest["pages"] if isinstance(manifest, dict) else manifest
    if limit > 0:
        entries = entries[:limit]
    pages = []
    for entry in entries:
        path = pages_dir / entry["png"]
        data = path.read_bytes()
        expected = entry.get("pngSha256") or entry.get("sha256")
        actual = hashlib.sha256(data).hexdigest()
        if expected and actual != expected:
            raise RuntimeError(f"page hash mismatch: {entry['png']}")
        pages.append((entry.get("pageId") or entry.get("page") or entry["png"], data))
    return pages, hashlib.sha256(manifest_bytes).hexdigest()


def _runner_for(config: dict[str, Any]) -> Any:
    if config["device"] == "cpu":
        return bench_cpu
    return bench_gpu


@app.local_entrypoint()
def main(
    pages_dir: str,
    out_dir: str,
    arms: str,
    repeats: int = 3,
    page_limit: int = 0,
    recognition_batch_size: int = 0,
    page_batch_size: int = 0,
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
    metadata = {
        "schemaVersion": "pagespatial-gpu-spike-run-v1",
        "runId": run_id,
        "appName": APP_NAME,
        "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": source,
        "inputManifestSha256": manifest_sha,
        "inputPages": len(pages),
        "inputBytes": sum(len(data) for _, data in pages),
        "requestedArms": arms.split(","),
        "repeats": repeats,
    }
    (run_dir / "run.json").write_text(json.dumps(metadata, indent=1) + "\n")
    print(f"run={run_id} pages={len(pages)} bytes={metadata['inputBytes']}")

    for arm_name in arms.split(","):
        if arm_name not in ARMS:
            raise ValueError(f"unknown arm: {arm_name}")
        config = dict(ARMS[arm_name], name=arm_name)
        if recognition_batch_size:
            config["recognitionBatchSize"] = recognition_batch_size
        if page_batch_size:
            config["pageBatchSize"] = page_batch_size
        attempt_started_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        started = time.monotonic()
        try:
            result = _runner_for(config).remote(config, pages, repeats)
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
        out = run_dir / f"{arm_name}.json"
        out.write_text(json.dumps(_jsonable(result), indent=1) + "\n")
        if status == "success":
            rates = [repeat["pagesPerS"] for repeat in result["repetitions"]]
            print(
                f"{arm_name}: {statistics.median(rates):.3f} pages/s median; "
                f"init={result['initS']:.1f}s; effectiveBatchMax="
                f"{result['effectiveBatchSummary']['max']} -> {out}"
            )
        else:
            print(f"{arm_name}: FAILED -> {out}: {result['attempt']['error']}")

    metadata["finishedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    (run_dir / "run.json").write_text(json.dumps(metadata, indent=1) + "\n")
    print(f"evidence={run_dir}")

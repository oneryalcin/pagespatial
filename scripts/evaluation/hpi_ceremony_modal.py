"""Adoption-ceremony run (issue #2): the HPI sidecar candidate — official
PaddleOCR pipeline, OpenVINO CPU, PP-OCRv6 small — over the FULL 90-page
gold∩record sample, at the adopted packing unit (1 vCPU, threads=1).

Differences from hpi_bench_modal.py:
  - full observation dumps (text/box/score) per page, for box-IoU and
    calibration scoring locally;
  - backend evidence capture, two channels with different strength: a
    bounded attribute walk of the pipeline object (genuinely in-band —
    yields use_hpip and thread config), and a logging.Handler attached
    before construction. HONEST LIMIT, as executed: the handler's keyword
    filter matched infra noise (httpcore/filelock/HF URLs) and caught ZERO
    pipeline backend-selection lines — the OpenVINO choice is announced by
    the C++ ultra_infer layer, which bypasses Python logging entirely and
    is only visible in the container's stdout stream. In-band capture of
    the C++ backend choice remains open (PR #64 finding 3, rides the
    integration PR); the ceremony retains the tracked run's stream as the
    evidence artifact instead.

Pages travel as function arguments; nothing persists remotely.

Usage:
  modal run scripts/evaluation/hpi_ceremony_modal.py \
      --pages-dir /abs/path/.evaluation/hpi-ceremony \
      --out /abs/path/.evaluation/hpi-ceremony/candidate-results.json
"""

import json
import time
from pathlib import Path

import modal

app = modal.App("pagespatial-hpi-ceremony")

APT = ["libgl1", "libglib2.0-0", "libgomp1", "ccache"]

cpu_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install(*APT)
    .pip_install("paddlepaddle==3.2.1", "paddleocr==3.7.0", "setuptools")
    .run_commands("paddleocr install_hpi_deps cpu || true")
)

BACKEND_KEYWORDS = ("backend", "hpi", "openvino", "onnxruntime", "paddle_infer", "inference")


def _walk_backend_attrs(root_obj) -> dict:
    """Bounded walk collecting primitive attrs whose name mentions a backend
    keyword — evidence of which engine the pipeline actually configured."""
    found = {}
    seen = set()

    def walk(obj, path, depth):
        if depth > 4 or id(obj) in seen or len(found) > 40:
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
            if any(k in lowered for k in BACKEND_KEYWORDS):
                if isinstance(value, (str, int, float, bool)):
                    found[f"{path}.{attr}"] = value
                elif isinstance(value, dict):
                    primitives = {
                        k: v for k, v in value.items() if isinstance(v, (str, int, float, bool))
                    }
                    if primitives:
                        found[f"{path}.{attr}"] = primitives
            if depth < 4 and not isinstance(value, (str, int, float, bool, bytes, dict, list, tuple, set)):
                if type(value).__module__ not in ("builtins",):
                    walk(value, f"{path}.{attr}", depth + 1)

    walk(root_obj, "pipeline", 0)
    return found


@app.function(image=cpu_image, cpu=1.0, memory=8192, timeout=3600)
def bench(pages: list) -> dict:
    import importlib.metadata
    import logging
    import os

    # In-band log capture: the pipeline announces its backend choice through
    # Python logging; a handler is evidence, container stdout is not.
    captured_logs = []

    class Capture(logging.Handler):
        def emit(self, record):
            try:
                message = record.getMessage()
            except Exception:
                return
            if any(k in message.lower() for k in BACKEND_KEYWORDS):
                if len(captured_logs) < 60:
                    captured_logs.append(f"{record.name}: {message}")

    handler = Capture(level=logging.DEBUG)
    logging.getLogger().addHandler(handler)
    logging.getLogger().setLevel(logging.DEBUG)

    from paddleocr import PaddleOCR

    kwargs = dict(
        text_detection_model_name="PP-OCRv6_small_det",
        text_recognition_model_name="PP-OCRv6_small_rec",
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        device="cpu",
        enable_hpi=True,
    )
    thread_kwarg_applied = True
    t0 = time.monotonic()
    try:
        ocr = PaddleOCR(**kwargs, cpu_threads=1)
    except TypeError:
        try:
            ocr = PaddleOCR(**kwargs, cpu_num_threads=1)
        except TypeError:
            thread_kwarg_applied = False
            ocr = PaddleOCR(**kwargs)
    init_s = time.monotonic() - t0

    import numpy as np

    def decode(png_bytes: bytes):
        import cv2

        return cv2.imdecode(np.frombuffer(png_bytes, dtype=np.uint8), cv2.IMREAD_COLOR)

    def predict(image):
        t = time.monotonic()
        result = ocr.predict(image)
        ms = (time.monotonic() - t) * 1000
        lines = []
        for res in result:
            data = res if isinstance(res, dict) else res.json.get("res", res.json)
            texts = data.get("rec_texts", [])
            scores = data.get("rec_scores", [])
            polys = data.get("rec_polys", data.get("dt_polys", []))
            for i, text in enumerate(texts):
                poly = polys[i] if i < len(polys) else None
                if poly is not None:
                    xs = [float(p[0]) for p in poly]
                    ys = [float(p[1]) for p in poly]
                    box = [min(xs), min(ys), max(xs), max(ys)]
                else:
                    box = None
                lines.append(
                    {
                        "text": str(text),
                        "box": box,
                        "score": float(scores[i]) if i < len(scores) else None,
                    }
                )
        return lines, ms

    per_page = []
    first_page_ms = None
    for index, (name, png_bytes) in enumerate(pages):
        image = decode(png_bytes)
        lines, ms = predict(image)
        if index == 0:
            first_page_ms = ms  # includes the lazy HPI engine build
        per_page.append({"page": name, "ms": ms, "lines": lines})
    if pages:  # re-run page 0 warm so every page has a warm number
        image = decode(pages[0][1])
        lines, ms = predict(image)
        per_page[0] = {"page": pages[0][0], "ms": ms, "lines": lines}

    return {
        "deviceTruth": {
            "osCpuCount": os.cpu_count(),
            "backendAttrs": _walk_backend_attrs(ocr),
            "backendLogLines": captured_logs,
        },
        "config": {
            "name": "cpu_hpi_small_1vcpu_ceremony",
            "cpuNumThreads": 1,
            "threadKwargApplied": thread_kwarg_applied,
        },
        "initS": round(init_s, 2),
        "firstPageMs": round(first_page_ms, 1) if first_page_ms else None,
        "versions": {
            pkg: importlib.metadata.version(pkg) for pkg in ("paddleocr", "paddlepaddle")
        },
        "perPage": per_page,
    }


@app.local_entrypoint()
def main(pages_dir: str, out: str):
    manifest = json.loads((Path(pages_dir) / "manifest.json").read_text())
    payload = []
    for entry in manifest:
        png_path = Path(pages_dir) / entry["png"]
        payload.append((entry["page"], png_path.read_bytes()))
    print(f"{len(payload)} pages")
    result = bench.remote(payload)
    Path(out).write_text(json.dumps(result, indent=1))
    warm = sorted(p["ms"] for p in result["perPage"])
    p50 = warm[len(warm) // 2]
    print(
        f"p50 {p50:.0f} ms/page, init {result['initS']}s, "
        f"threadsApplied={result['config']['threadKwargApplied']}, "
        f"backendAttrs={len(result['deviceTruth']['backendAttrs'])}, "
        f"backendLogLines={len(result['deviceTruth']['backendLogLines'])}"
    )

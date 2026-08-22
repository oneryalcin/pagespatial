"""HPI benchmark, step 2 (issue #2 speed-arm 2): run the official PaddleOCR
pipeline over the rendered sample on modal.com (Linux x86), CPU default vs
enable_hpi=True vs a GPU ceiling arm, each with the v6-small pairing
(apples-to-apples with the service witness) and their default v6-medium.

Pages travel as function arguments (no volumes, nothing persisted remotely);
results come back as JSON only. Orientation/unwarping/textline stages are
disabled — we feed clean rasters, same as the service.

Usage (from the repo root, after hpi-bench-render.mjs):
  modal run scripts/evaluation/hpi_bench_modal.py \
      --pages-dir /abs/path/.evaluation/hpi-bench \
      --out-dir  /abs/path/.evaluation/hpi-bench \
      --configs cpu_default_small,cpu_default_medium,cpu_hpi_small,cpu_hpi_medium,gpu_default_small,gpu_default_medium

Timing per config: constructor (includes model download), first page
(includes any HPI engine build), then warm ms/page — page 0 is re-run at the
end so every page has a warm number.
"""

import json
import time
from pathlib import Path

import modal

app = modal.App("pagespatial-hpi-bench")

CPU_CORES = 4.0
APT = ["libgl1", "libglib2.0-0", "libgomp1", "ccache"]

cpu_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install(*APT)
    .pip_install("paddlepaddle==3.2.1", "paddleocr==3.7.0", "setuptools")
    .run_commands("paddleocr install_hpi_deps cpu || true")
)

gpu_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install(*APT)
    .pip_install(
        "paddlepaddle-gpu==3.2.1",
        extra_index_url="https://www.paddlepaddle.org.cn/packages/stable/cu126/",
    )
    .pip_install("paddleocr==3.7.0", "setuptools")
)


def _run_bench(config: dict, pages: list) -> dict:
    import importlib.metadata

    from paddleocr import PaddleOCR

    variant = config["variant"]
    kwargs = dict(
        text_detection_model_name=f"PP-OCRv6_{variant}_det",
        text_recognition_model_name=f"PP-OCRv6_{variant}_rec",
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        device=config["device"],
    )
    if config.get("hpi"):
        kwargs["enable_hpi"] = True

    t0 = time.monotonic()
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
            first_page_ms = ms  # includes any lazy engine build
        per_page.append({"page": name, "ms": ms, "lines": lines})
    # Re-run page 0 warm so its timing is comparable.
    if pages:
        image = decode(pages[0][1])
        lines, ms = predict(image)
        per_page[0] = {"page": pages[0][0], "ms": ms, "lines": lines}

    versions = {
        pkg: importlib.metadata.version(pkg)
        for pkg in ("paddleocr", "paddlepaddle", "paddlepaddle-gpu")
        if _installed(pkg)
    }
    # Device ground truth: the timing table is only interpretable if we can
    # prove which silicon actually ran (a silent CPU fallback would forge the
    # GPU ceiling).
    import subprocess

    import paddle

    try:
        smi = subprocess.run(
            ["nvidia-smi", "-L"], capture_output=True, text=True, timeout=10
        ).stdout.strip()
    except Exception:
        smi = None
    device_truth = {
        "paddleDevice": str(paddle.device.get_device()),
        "cudaCompiled": bool(paddle.device.is_compiled_with_cuda()),
        "nvidiaSmi": smi,
    }
    return {
        "deviceTruth": device_truth,
        "config": config,
        "initS": round(init_s, 2),
        "firstPageMs": round(first_page_ms, 1) if first_page_ms else None,
        "versions": versions,
        "perPage": per_page,
    }


def _installed(pkg: str) -> bool:
    import importlib.metadata

    try:
        importlib.metadata.version(pkg)
        return True
    except importlib.metadata.PackageNotFoundError:
        return False


@app.function(image=cpu_image, cpu=CPU_CORES, memory=8192, timeout=3600)
def bench_cpu(config: dict, pages: list) -> dict:
    return _run_bench(config, pages)


@app.function(image=gpu_image, gpu="T4", cpu=CPU_CORES, memory=8192, timeout=3600)
def bench_gpu(config: dict, pages: list) -> dict:
    return _run_bench(config, pages)


CONFIGS = {
    "cpu_default_small": {"device": "cpu", "hpi": False, "variant": "small"},
    "cpu_default_medium": {"device": "cpu", "hpi": False, "variant": "medium"},
    "cpu_hpi_small": {"device": "cpu", "hpi": True, "variant": "small"},
    "cpu_hpi_medium": {"device": "cpu", "hpi": True, "variant": "medium"},
    "gpu_default_small": {"device": "gpu", "hpi": False, "variant": "small"},
    "gpu_default_medium": {"device": "gpu", "hpi": False, "variant": "medium"},
}


@app.local_entrypoint()
def main(pages_dir: str, out_dir: str, configs: str):
    manifest = json.loads((Path(pages_dir) / "manifest.json").read_text())
    pages = [(entry["page"], (Path(pages_dir) / entry["png"]).read_bytes()) for entry in manifest]
    print(f"{len(pages)} pages, {sum(len(b) for _, b in pages) / 1e6:.1f} MB")
    for name in configs.split(","):
        config = dict(CONFIGS[name], name=name)
        runner = bench_gpu if config["device"] == "gpu" else bench_cpu
        print(f"=== {name} ===")
        started = time.monotonic()
        result = runner.remote(config, pages)
        wall = time.monotonic() - started
        result["remoteCallWallS"] = round(wall, 1)
        result["resources"] = {
            "cpu": CPU_CORES,
            "memoryMb": 8192,
            "gpu": "T4" if config["device"] == "gpu" else None,
        }
        out = Path(out_dir) / f"results-{name}.json"
        out.write_text(json.dumps(result, indent=1))
        timings = sorted(p["ms"] for p in result["perPage"])
        p50 = timings[len(timings) // 2]
        print(
            f"{name}: init {result['initS']}s, first {result['firstPageMs']}ms, "
            f"warm p50 {p50:.0f}ms/page, wall {wall:.0f}s -> {out}"
        )

"""Per-core scaling curve for the HPI CPU sidecar candidate (issue #2,
adoption-ceremony item): the same 32-page sample and HPI OpenVINO v6-small
config as hpi_bench_modal.py, run at 1 / 2 / 4 / 8 vCPU with
cpu_num_threads matched to the vCPU count (no oversubscription).

The decision it feeds: worker packing density. If core-seconds/page is
~flat across sizes, many 1-vCPU workers maximize throughput per box; if
parallel efficiency dies past N cores, N-vCPU workers are the unit.

Usage (repo root; pages already rendered by hpi-bench-render.mjs):
  modal run scripts/evaluation/hpi_scaling_modal.py \
      --pages-dir /abs/path/.evaluation/hpi-bench \
      --out-dir  /abs/path/.evaluation/hpi-bench

Unlike the main bench, threads and visible cores are captured IN-BAND per
result (deviceTruth.osCpuCount / config.cpuNumThreads), closing the
log-derived-evidence gap the PR #64 review flagged.
"""

import json
import time
from pathlib import Path

import modal

app = modal.App("pagespatial-hpi-scaling")

APT = ["libgl1", "libglib2.0-0", "libgomp1", "ccache"]

cpu_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install(*APT)
    .pip_install("paddlepaddle==3.2.1", "paddleocr==3.7.0", "setuptools")
    .run_commands("paddleocr install_hpi_deps cpu || true")
)


def _run(threads: int, pages: list) -> dict:
    import importlib.metadata
    import os

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
    # Match threads to allotted cores; if the pipeline rejects the kwarg,
    # fall back and record that the setting did not apply.
    thread_kwarg_applied = True
    t0 = time.monotonic()
    try:
        ocr = PaddleOCR(**kwargs, cpu_threads=threads)
    except TypeError:
        try:
            ocr = PaddleOCR(**kwargs, cpu_num_threads=threads)
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
        count = 0
        for res in result:
            data = res if isinstance(res, dict) else res.json.get("res", res.json)
            count += len(data.get("rec_texts", []))
        return count, ms

    per_page = []
    first_page_ms = None
    for index, (name, png_bytes) in enumerate(pages):
        image = decode(png_bytes)
        lines, ms = predict(image)
        if index == 0:
            first_page_ms = ms  # includes the lazy HPI engine build
        per_page.append({"page": name, "ms": ms, "lineCount": lines})
    if pages:  # re-run page 0 warm
        image = decode(pages[0][1])
        lines, ms = predict(image)
        per_page[0] = {"page": pages[0][0], "ms": ms, "lineCount": lines}

    return {
        "deviceTruth": {"osCpuCount": os.cpu_count()},
        "config": {
            "name": f"cpu_hpi_small_{threads}vcpu",
            "cpuNumThreads": threads,
            "threadKwargApplied": thread_kwarg_applied,
        },
        "initS": round(init_s, 2),
        "firstPageMs": round(first_page_ms, 1) if first_page_ms else None,
        "versions": {
            pkg: importlib.metadata.version(pkg)
            for pkg in ("paddleocr", "paddlepaddle")
        },
        "perPage": per_page,
    }


@app.function(image=cpu_image, cpu=1.0, memory=8192, timeout=3600)
def bench_1(pages: list) -> dict:
    return _run(1, pages)


@app.function(image=cpu_image, cpu=2.0, memory=8192, timeout=3600)
def bench_2(pages: list) -> dict:
    return _run(2, pages)


@app.function(image=cpu_image, cpu=4.0, memory=8192, timeout=3600)
def bench_4(pages: list) -> dict:
    return _run(4, pages)


@app.function(image=cpu_image, cpu=8.0, memory=8192, timeout=3600)
def bench_8(pages: list) -> dict:
    return _run(8, pages)


@app.local_entrypoint()
def main(pages_dir: str, out_dir: str):
    pages = sorted(Path(pages_dir).glob("*.png"))
    payload = [(p.name, p.read_bytes()) for p in pages]
    print(f"{len(payload)} pages")
    for vcpu, fn in ((1, bench_1), (2, bench_2), (4, bench_4), (8, bench_8)):
        result = fn.remote(payload)
        out = Path(out_dir) / f"scaling_{vcpu}vcpu.json"
        out.write_text(json.dumps(result, indent=1))
        warm = sorted(p["ms"] for p in result["perPage"])
        p50 = warm[len(warm) // 2]
        print(
            f"{vcpu} vCPU: p50 {p50:.0f} ms/page, core-s/page {p50 * vcpu / 1000:.2f}, "
            f"init {result['initS']}s, threadsApplied={result['config']['threadKwargApplied']}"
        )

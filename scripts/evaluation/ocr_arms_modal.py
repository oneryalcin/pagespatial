"""OCR model-arm comparison on Modal (Linux x86, OpenVINO HPI, 4 cores).

Trial: docs/trials/2026-11-07-ocr-arms-linux.md

Runs every arm in ONE container, interleaved page by page (arm order rotates
per page), so host-to-host variance cannot fake a speed difference. A
--repeat of 2 runs a second container. Output per arm uses the
hpi_ceremony_modal.py result shape, so score-candidate-witness.mjs scores it
unchanged.

Usage (repo root; pages from the adoption ceremony sample):
  uvx modal run scripts/evaluation/ocr_arms_modal.py \
      --pages-dir $PWD/.evaluation/hpi-ceremony --out-dir $PWD/.evaluation/ocr-arms \
      --arms small_small,smalldet_tinyrec,tiny_tiny,smalldet960_tinyrec
"""

import json
import time
from pathlib import Path

import modal

app = modal.App("pagespatial-ocr-arms")

CORES = 4
THREADS = 4  # production: SERVICE_SIDECAR_THREADS=4 (docs/trials/2026-09-02-ocr-sidecar-thread-sweep.md)

cpu_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("libgl1", "libglib2.0-0", "libgomp1", "ccache")
    .pip_install("paddlepaddle==3.2.1", "paddleocr==3.7.0", "setuptools")
    .run_commands("paddleocr install_hpi_deps cpu || true")
)

ARMS = {
    "small_small": {"det": "PP-OCRv6_small_det", "rec": "PP-OCRv6_small_rec"},
    "smalldet_tinyrec": {"det": "PP-OCRv6_small_det", "rec": "PP-OCRv6_tiny_rec"},
    "tiny_tiny": {"det": "PP-OCRv6_tiny_det", "rec": "PP-OCRv6_tiny_rec"},
    "smalldet960_tinyrec": {"det": "PP-OCRv6_small_det", "rec": "PP-OCRv6_tiny_rec",
                            "det_limit": {"text_det_limit_type": "max", "text_det_limit_side_len": 960}},
    "smalldet960_smallrec": {"det": "PP-OCRv6_small_det", "rec": "PP-OCRv6_small_rec",
                             "det_limit": {"text_det_limit_type": "max", "text_det_limit_side_len": 960}},
}


FINETUNED_PREFIX = "smalldet_tinyrec_ft_"  # + run name on the pagespatial-rec-finetune volume
finetune_volume = modal.Volume.from_name("pagespatial-rec-finetune", create_if_missing=True)


def arm_config(name: str) -> dict:
    """ARMS, plus Small det with a fine-tuned Tiny rec (scripts/evaluation/rec_finetune_modal.py)."""
    if name.startswith(FINETUNED_PREFIX):
        return {"det": "PP-OCRv6_small_det", "rec": "PP-OCRv6_tiny_rec",
                "rec_dir": f"/vol/runs/{name.removeprefix(FINETUNED_PREFIX)}/inference"}
    return ARMS[name]


def _lines(result) -> list:
    lines = []
    for res in result:
        data = res if isinstance(res, dict) else res.json.get("res", res.json)
        texts, scores = data.get("rec_texts", []), data.get("rec_scores", [])
        polys = data.get("rec_polys", data.get("dt_polys", []))
        for i, text in enumerate(texts):
            poly = polys[i] if i < len(polys) else None
            box = None
            if poly is not None:
                xs, ys = [float(p[0]) for p in poly], [float(p[1]) for p in poly]
                box = [min(xs), min(ys), max(xs), max(ys)]
            lines.append({"text": str(text), "box": box,
                          "score": float(scores[i]) if i < len(scores) else None})
    return lines


@app.function(image=cpu_image, cpu=float(CORES), memory=8192, timeout=6 * 3600, volumes={"/vol": finetune_volume})
def run_arms(arms: list, pages: list, reverse: bool) -> dict:
    import importlib.metadata
    import logging
    import os

    os.environ["PADDLE_PDX_CPU_NUM_THREADS"] = str(THREADS)  # the knob PaddleX actually reads
    backend_lines = []

    class Capture(logging.Handler):
        def emit(self, record):
            msg = record.getMessage()
            if "backend" in msg.lower() and len(backend_lines) < 40:
                backend_lines.append(f"{record.name}: {msg}")

    logging.getLogger().addHandler(Capture(level=logging.DEBUG))

    import cv2
    import numpy as np
    from paddleocr import PaddleOCR

    engines, init_s = {}, {}
    for name in arms:
        arm = arm_config(name)
        rec_dir = arm.get("rec_dir")
        if rec_dir:
            # HPI's OpenVINO backend needs ONNX next to the Paddle files, as the official models ship it.
            import shutil
            import subprocess

            local = shutil.copytree(rec_dir, f"/tmp/{name}")
            converted = subprocess.run(["paddlex", "--paddle2onnx", "--paddle_model_dir", local,
                                        "--onnx_model_dir", local], capture_output=True, text=True)
            backend_lines.append(f"paddle2onnx {name}: exit {converted.returncode} {converted.stdout[-200:]}{converted.stderr[-200:]}")
            rec_dir = local
        t0 = time.monotonic()
        engines[name] = PaddleOCR(
            text_detection_model_name=arm["det"], text_recognition_model_name=arm["rec"],
            text_recognition_model_dir=rec_dir,
            use_doc_orientation_classify=False, use_doc_unwarping=False,
            use_textline_orientation=False, device="cpu", enable_hpi=True,
            **arm.get("det_limit", {}))
        init_s[name] = round(time.monotonic() - t0, 2)

    images = [(n, cv2.imdecode(np.frombuffer(b, np.uint8), cv2.IMREAD_COLOR)) for n, b in pages]
    for name in arms:  # warm-up: first call builds the HPI engine
        engines[name].predict(images[0][1])

    out = {name: [] for name in arms}
    order = list(reversed(arms)) if reverse else list(arms)
    for k, (page, image) in enumerate(images):
        rot = order[k % len(order):] + order[: k % len(order)]  # rotate arm order per page
        for name in rot:
            t = time.monotonic()
            result = engines[name].predict(image)
            ms = (time.monotonic() - t) * 1000
            out[name].append({"page": page, "ms": ms, "lines": _lines(result)})

    versions = {p: importlib.metadata.version(p) for p in ("paddleocr", "paddlepaddle")}
    return {
        name: {
            "deviceTruth": {"osCpuCount": os.cpu_count(), "backendLogLines": backend_lines,
                            "pdxCpuNumThreads": os.environ["PADDLE_PDX_CPU_NUM_THREADS"]},
            "config": {"name": name, **arm_config(name), "cores": CORES, "threads": THREADS, "reverse": reverse},
            "initS": init_s[name], "firstPageMs": None, "versions": versions,
            "perPage": out[name],
        }
        for name in arms
    }


@app.local_entrypoint()
def main(pages_dir: str, out_dir: str, arms: str, repeat: int = 2):
    arm_list = arms.split(",")
    manifest = json.loads((Path(pages_dir) / "manifest.json").read_text())
    pages = [(e["page"], (Path(pages_dir) / e["png"]).read_bytes()) for e in manifest]
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    print(f"{len(pages)} pages, arms {arm_list}, {repeat} container(s)")
    calls = [run_arms.spawn(arm_list, pages, bool(r % 2)) for r in range(repeat)]
    for r, call in enumerate(calls):
        result = call.get()
        for name, res in result.items():
            (out / f"results-{name}-r{r}.json").write_text(json.dumps(res))
            ms = sorted(p["ms"] for p in res["perPage"])
            print(f"r{r} {name:22} p50 {ms[len(ms) // 2]:7.0f} ms  mean {sum(ms) / len(ms):7.0f} ms  "
                  f"lines {sum(len(p['lines']) for p in res['perPage'])}  init {res['initS']}s")

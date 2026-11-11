"""Can the PaddleX OCR pipeline be split into detect + recognize-some-boxes without changing what it reads?

Design: docs/design/2026-11-07-selective-ocr.md
Trial:  docs/trials/2026-11-11-selective-ocr-build.md

Selective OCR recognizes only some detected boxes. The pipeline recognizes
crops in batches sorted by aspect ratio and pads each batch to its widest
crop, so a line's reading can depend on which other lines are read with it.
On Linux x86 with OpenVINO HPI (production), this measures three ways of
recognizing:

  b6         the pipeline default and production: batches of 6
  b1         one crop per batch
  samewidth  crops no wider than the recognizer's base shape (all padded to
             that same width) in batches of 6, wider crops one at a time

and for each:

  split      the pipeline's own detect/sort/crop/recognize steps, driven
             separately with nothing skipped, against ocr.predict()
             (b6 and b1; samewidth is compared with b1)
  subset     only lines whose full reading holds a digit are recognized;
             how many of those kept lines read differently
  speed      full-page time, variants interleaved page by page in one
             container; detection alone is timed too

Full readings are written per variant in the hpi_ceremony_modal.py result
shape, so score-candidate-witness.mjs scores them unchanged.

  uvx --from modal==1.5.3 modal run scripts/evaluation/selective_ocr_split_modal.py \
      --pages-dir $PWD/.evaluation/hpi-ceremony --out-dir $PWD/.evaluation/ocr-arms/split
"""

import json
import re
import time
from pathlib import Path

import modal

app = modal.App("pagespatial-selective-ocr-split")

CORES = 4
THREADS = 4
BATCHES = (6, 1)  # 6 is the pipeline default and what production runs
VARIANTS = ["b6", "b1", "samewidth"]

cpu_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("libgl1", "libglib2.0-0", "libgomp1", "ccache")
    .pip_install("paddlepaddle==3.2.1", "paddleocr==3.7.0", "setuptools")
    .run_commands("paddleocr install_hpi_deps cpu || true")
)


def pipeline_of(ocr):
    """The PaddleX pipeline object that owns the detector and recognizer."""
    pipe = ocr.paddlex_pipeline
    while not hasattr(pipe, "text_det_model"):
        pipe = pipe._pipeline
    return pipe


def detect(pipe, image):
    """Detector boxes and their crops, exactly as the pipeline's predict() prepares them."""
    det = list(pipe.text_det_model([image], **pipe.get_text_det_params()))[0]
    polys = pipe._sort_boxes(det["dt_polys"])
    crops = list(pipe._crop_by_polys(image, polys))
    kept = [(c, p) for c, p in zip(crops, polys) if c.size > 0 and c.shape[0] > 0 and c.shape[1] > 0]
    return [c for c, _ in kept], [p for _, p in kept]


def recognize(pipe, crops, indices, batch_size=None):
    """Recognize the crops at `indices`, in the pipeline's aspect-ratio order."""
    if not indices:
        return {}
    subs = [crops[i] for i in indices]
    order = sorted(range(len(subs)), key=lambda k: subs[k].shape[1] / float(subs[k].shape[0]))
    out = {}
    kwargs = {} if batch_size is None else {"batch_size": batch_size}
    for k, rec in zip(order, pipe.text_rec_model([subs[k] for k in order], return_word_box=False, **kwargs)):
        out[indices[k]] = (str(rec["rec_text"]), float(rec["rec_score"]))
    return out


def base_ratio(pipe):
    """Width over height of the recognizer's base input shape; narrower crops are all padded to it."""
    shape = next(op["RecResizeImg"]["image_shape"]
                 for op in pipe.text_rec_model.config["PreProcess"]["transform_ops"] if "RecResizeImg" in op)
    return shape[2] / float(shape[1])


def recognize_same_width(pipe, crops, indices):
    """Batch only crops that pad to the same width, so no crop's input depends on its batch-mates."""
    limit = base_ratio(pipe)
    ratio = lambda i: crops[i].shape[1] / float(crops[i].shape[0])
    original = pipe.text_rec_model.batch_sampler.batch_size
    try:
        out = recognize(pipe, crops, [i for i in indices if ratio(i) <= limit], batch_size=6)
        out.update(recognize(pipe, crops, [i for i in indices if ratio(i) > limit], batch_size=1))
    finally:
        pipe.text_rec_model.batch_sampler.batch_size = original
    return out


@app.function(image=cpu_image, cpu=float(CORES), memory=8192, timeout=3 * 3600)
def run(pages: list) -> dict:
    import os

    os.environ["PADDLE_PDX_CPU_NUM_THREADS"] = str(THREADS)
    import cv2
    import numpy as np
    from paddleocr import PaddleOCR

    def full(ocr, image):
        lines = []
        for res in ocr.predict(image):
            data = res if isinstance(res, dict) else res.json.get("res", res.json)
            for text, score, poly in zip(data["rec_texts"], data["rec_scores"], data["rec_polys"]):
                lines.append((str(text), float(score), [[float(x), float(y)] for x, y in poly]))
        return lines

    engines = {}
    for batch in BATCHES:
        engines[batch] = PaddleOCR(
            text_detection_model_name="PP-OCRv6_small_det", text_recognition_model_name="PP-OCRv6_small_rec",
            text_recognition_batch_size=batch, use_doc_orientation_classify=False, use_doc_unwarping=False,
            use_textline_orientation=False, device="cpu", enable_hpi=True)
    images = [(name, cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)) for name, data in pages]
    for ocr in engines.values():
        ocr.predict(images[0][1])  # warm-up: first call builds the HPI engine

    stats = {v: dict(lines=0, splitMismatch=0, kept=0, keptTextChanged=0, keptDigitsChanged=0,
                     maxScoreDelta=0.0, fullMs=0.0, subsetMs=0.0, examples=[]) for v in VARIANTS}
    stats["detectMs"] = 0.0
    per_page = {v: [] for v in VARIANTS}
    digits = lambda text: re.sub(r"\D", "", text)
    box = lambda poly: [min(p[0] for p in poly), min(p[1] for p in poly), max(p[0] for p in poly), max(p[1] for p in poly)]
    for k, (name, image) in enumerate(images):
        rotated = VARIANTS[k % len(VARIANTS):] + VARIANTS[: k % len(VARIANTS)]
        t = time.monotonic()
        detect(pipeline_of(engines[6]), image)
        stats["detectMs"] += (time.monotonic() - t) * 1000
        b1_full = None
        for variant in rotated:
            s = stats[variant]
            ocr = engines[1 if variant == "b1" else 6]
            pipe = pipeline_of(ocr)
            read = recognize_same_width if variant == "samewidth" else recognize
            t = time.monotonic()
            if variant == "samewidth":
                crops, polys = detect(pipe, image)
                rec = read(pipe, crops, list(range(len(crops))))
                ref = [(rec[i][0], rec[i][1], [[float(x), float(y)] for x, y in polys[i]]) for i in range(len(crops))]
            else:
                ref = full(ocr, image)
            ms = (time.monotonic() - t) * 1000
            s["fullMs"] += ms
            per_page[variant].append({"page": name, "ms": ms, "lines": [
                {"text": text, "score": score, "box": box(poly)} for text, score, poly in ref]})
            if variant != "samewidth":
                crops, polys = detect(pipe, image)
                rec = read(pipe, crops, list(range(len(crops))))
                got = [(rec[i][0], rec[i][1], [[float(x), float(y)] for x, y in polys[i]]) for i in range(len(crops))]
                s["splitMismatch"] += (sum(a != b for a, b in zip(ref, got)) if len(ref) == len(got)
                                       else max(len(ref), len(got)))
            if variant == "b1":
                b1_full = ref
            s["lines"] += len(ref)
            keep = [i for i in range(len(crops)) if re.search(r"\d", rec[i][0])]
            t = time.monotonic()
            sub = read(pipe, crops, keep)
            s["subsetMs"] += (time.monotonic() - t) * 1000
            for i in keep:
                s["kept"] += 1
                s["maxScoreDelta"] = max(s["maxScoreDelta"], abs(sub[i][1] - rec[i][1]))
                if sub[i][0] != rec[i][0]:
                    s["keptTextChanged"] += 1
                    s["keptDigitsChanged"] += digits(sub[i][0]) != digits(rec[i][0])
                    if len(s["examples"]) < 40:
                        s["examples"].append({"page": name, "full": rec[i][0], "subset": sub[i][0],
                                              "fullScore": rec[i][1], "subsetScore": sub[i][1]})
        # samewidth against b1: same padding for every crop, so only batched arithmetic can differ.
        same = next(p for p in per_page["samewidth"] if p["page"] == name)["lines"]
        stats["samewidth"]["splitMismatch"] += (
            sum(a[0] != b["text"] for a, b in zip(b1_full, same)) if len(b1_full) == len(same)
            else max(len(b1_full), len(same)))
    return {"stats": stats, "perPage": per_page, "osCpuCount": os.cpu_count()}


@app.local_entrypoint()
def main(pages_dir: str, out_dir: str):
    manifest = json.loads((Path(pages_dir) / "manifest.json").read_text())
    pages = [(e["page"], (Path(pages_dir) / e["png"]).read_bytes()) for e in manifest]
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    result = run.remote(pages)
    for variant, per_page in result["perPage"].items():
        (out / f"results-small_{variant}-r0.json").write_text(json.dumps({
            "config": {"name": f"small_{variant}", "cores": CORES, "threads": THREADS}, "perPage": per_page}))
    (out / "split-summary.json").write_text(json.dumps(result["stats"], indent=1, ensure_ascii=False) + "\n")
    print(f"detect alone: {result['stats']['detectMs'] / len(pages):.0f} ms/page")
    for variant in VARIANTS:
        s = result["stats"][variant]
        print(f"{variant}: full {s['fullMs'] / len(pages):.0f} ms/page, digit-line subset {s['subsetMs'] / len(pages):.0f} ms/page, "
              f"{s['lines']} lines, mismatches {s['splitMismatch']}, kept {s['kept']}, "
              f"kept text changed {s['keptTextChanged']} (digits {s['keptDigitsChanged']}), max score delta {s['maxScoreDelta']:.4f}")

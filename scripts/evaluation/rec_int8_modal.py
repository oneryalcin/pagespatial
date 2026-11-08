"""int8 post-training quantization of the PP-OCRv6 Small recognizer on Modal (x86, OpenVINO).

Trial: docs/trials/2026-11-07-ocr-arms-linux.md

v2. v1 resized crops without PaddleX's padding, and its fp32 baseline decoded
garbage. This version uses PaddleX-exact OCRReisizeNormImg preprocessing:
height 48, aspect ratio kept, right zero-pad to max(320, 48*w/h), cap 3200.
Padded widths are rounded up to a fixed bucket, so every model (fp32 and
int8) is compiled with static shapes per bucket. Validated locally: fp32
decode equals PaddleX's own text on 96% of 400 lines (the rest differ
because these crops are axis-aligned rather than minimum-area rectangles).

Line boxes and PaddleX reference texts come from the adoption-ceremony run
(candidate-results.json). Calibration and evaluation lines are disjoint.

  uvx modal run scripts/evaluation/rec_int8_modal.py \
      --pages-dir $PWD/.evaluation/hpi-ceremony \
      --small-tar $PWD/.evaluation/ocr-assets-small/models/PP-OCRv6_small_rec_onnx_infer.tar \
      --out $PWD/.evaluation/ocr-arms/int8-v2.json [--mode transformer]
"""
import json
from pathlib import Path

import modal

app = modal.App("pagespatial-rec-int8")
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("libgl1", "libglib2.0-0")
    .pip_install("openvino==2026.4.1", "nncf", "opencv-python-headless", "numpy", "pyyaml", "onnx")
)

H, MIN_W, MAX_W = 48, 320, 3200
BUCKETS = (320, 480, 640, 800, 960, 1280, 1600, 2400, 3200)


def prep(c):
    """PaddleX OCRReisizeNormImg.resize, then zero-pad up to the next width bucket."""
    import math

    import cv2
    import numpy as np

    h, w = c.shape[:2]
    img_w = int(H * max(MIN_W / H, w / h))
    if img_w > MAX_W:
        r, rw, img_w = cv2.resize(c, (MAX_W, H)), MAX_W, MAX_W
    else:
        rw = min(img_w, int(math.ceil(H * w / h)))
        r = cv2.resize(c, (rw, H))
    img_w = next(b for b in BUCKETS if b >= img_w)
    x = np.zeros((3, H, img_w), np.float32)
    x[:, :, :rw] = (r.astype(np.float32).transpose(2, 0, 1) / 255 - 0.5) / 0.5
    return x[None]


@app.function(image=image, cpu=4.0, memory=8192, timeout=3 * 3600)
def run(tar_bytes: bytes, pages: list, lines: dict, mode: str = "default") -> dict:
    import difflib
    import io
    import random
    import tarfile
    import time

    import cv2
    import nncf
    import numpy as np
    import openvino as ov
    import yaml

    samples = []  # (input, paddlex text)
    for name, png in pages:
        img = cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_COLOR)
        for box, text in lines.get(name, []):
            x0, y0, x1, y1 = [int(round(v)) for v in box]
            c = img[max(0, y0):y1, max(0, x0):x1]
            if c.size and c.shape[0] >= 2 and c.shape[1] >= 2:
                samples.append((prep(c), text))
    random.Random(0).shuffle(samples)
    calib, evals = samples[:300], samples[300:2300]

    tf = tarfile.open(fileobj=io.BytesIO(tar_bytes))
    onnx_path = "/tmp/rec.onnx"
    Path(onnx_path).write_bytes(tf.extractfile(next(m for m in tf.getmembers() if m.name.endswith(".onnx"))).read())
    yml = yaml.safe_load(tf.extractfile(next(m for m in tf.getmembers() if m.name.endswith(".yml"))))
    chars = ["<blank>"] + yml["PostProcess"]["character_dict"] + [" "]

    core = ov.Core()
    fp32 = core.read_model(onnx_path)
    kw = dict(subset_size=len(calib), preset=nncf.QuantizationPreset.MIXED)
    if mode == "transformer":  # SVTR blocks: keep LayerNorm/Softmax/GELU paths out of int8
        kw["model_type"] = nncf.ModelType.TRANSFORMER
    int8 = nncf.quantize(fp32, nncf.Dataset([x for x, _ in calib]), **kw)

    def compiled_per_bucket(model):
        out = {}
        for b in sorted({x.shape[3] for x, _ in evals}):
            m = model.clone()
            m.reshape({m.inputs[0].any_name: [1, 3, H, b]})
            out[b] = core.compile_model(m, "CPU", {"INFERENCE_NUM_THREADS": 4})
        return out

    def ctc(probs):
        ids, s, prev = probs[0].argmax(-1), [], 0
        for i in ids:
            if i != prev and i != 0:
                s.append(chars[i] if i < len(chars) else "")
            prev = i
        return "".join(s)

    res = {}
    for name, model in (("fp32", fp32), ("int8", int8)):
        comp = compiled_per_bucket(model)
        for x, _ in evals[:30]:
            comp[x.shape[3]](x)
        ts, texts = [], []
        for x, _ in evals:
            t = time.perf_counter(); r = comp[x.shape[3]](x)[0]; ts.append(time.perf_counter() - t)
            texts.append(ctc(r))
        res[name] = (ts, texts)

    def cer(a, b):
        sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
        return sum(max(i2 - i1, j2 - j1) for tag, i1, i2, j1, j2 in sm.get_opcodes() if tag != "equal") / max(1, len(a))

    ref = [t for _, t in evals]
    f, i = res["fp32"][1], res["int8"][1]
    digit = [k for k, t in enumerate(ref) if any(ch.isdigit() for ch in t)]
    out = {
        "eval_lines": len(evals), "calib_lines": len(calib),
        "fp32_ms_mean": round(1000 * float(np.mean(res["fp32"][0])), 2),
        "int8_ms_mean": round(1000 * float(np.mean(res["int8"][0])), 2),
        "speedup": round(float(np.mean(res["fp32"][0]) / np.mean(res["int8"][0])), 2),
        "fp32_exact_vs_paddlex": round(sum(a == b for a, b in zip(f, ref)) / len(ref), 4),
        "int8_exact_vs_paddlex": round(sum(a == b for a, b in zip(i, ref)) / len(ref), 4),
        "int8_exact_vs_fp32": round(sum(a == b for a, b in zip(i, f)) / len(ref), 4),
        "int8_cer_vs_fp32": round(float(np.mean([cer(a, b) for a, b in zip(f, i)])), 5),
        "digit_lines": len(digit),
        "digit_lines_int8_differs_from_fp32": sum(f[k] != i[k] for k in digit),
        "digit_lines_fp32_matches_paddlex": sum(f[k] == ref[k] for k in digit),
        "digit_lines_int8_matches_paddlex": sum(i[k] == ref[k] for k in digit),
    }
    try:
        info = open("/proc/cpuinfo").read()
        out["cpu_model"] = next(l for l in info.splitlines() if l.startswith("model name")).split(":")[1].strip()
        out["avx512_vnni"] = "avx512_vnni" in info
        out["amx"] = "amx_int8" in info
    except Exception:
        pass
    out["examples_int8_vs_fp32"] = [(a, b) for a, b in zip(f, i) if a != b][:20]
    return out


@app.local_entrypoint()
def main(pages_dir: str, small_tar: str, out: str, mode: str = "default"):
    pd = Path(pages_dir)
    manifest = json.loads((pd / "manifest.json").read_text())
    ceremony = json.loads((pd / "candidate-results.json").read_text())
    lines = {p["page"]: [(l["box"], l["text"]) for l in p["lines"] if l.get("box")] for p in ceremony["perPage"]}
    pages = [(e["page"], (pd / e["png"]).read_bytes()) for e in manifest]
    result = run.remote(Path(small_tar).read_bytes(), pages, lines, mode)
    result["mode"] = mode
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    Path(out).write_text(json.dumps(result, indent=1, ensure_ascii=False))
    print({k: v for k, v in result.items() if k != "examples_int8_vs_fp32"})

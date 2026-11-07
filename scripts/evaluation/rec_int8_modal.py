"""int8 post-training quantization of the PP-OCRv6 recognizers on Modal (x86, OpenVINO).

Trial: docs/trials/2026-11-07-ocr-arms-linux.md

Real line crops come from the adoption-ceremony pages and the line boxes the
ceremony run recorded (candidate-results.json). Calibration and evaluation
crops are disjoint. Per recognizer: fp32 vs NNCF int8, ms per crop at 4
threads, and greedy-CTC text agreement (exact-match rate, character error
rate of int8 against fp32).

  uvx modal run scripts/evaluation/rec_int8_modal.py \
      --pages-dir $PWD/.evaluation/hpi-ceremony \
      --small-tar $PWD/.evaluation/ocr-assets-small/models/PP-OCRv6_small_rec_onnx_infer.tar \
      --tiny-tar $PWD/.evaluation/ocr-assets/models/PP-OCRv6_tiny_rec_onnx_infer.tar \
      --out $PWD/.evaluation/ocr-arms/int8.json
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

H = 48


def crop_line(img, box):
    import cv2
    import numpy as np
    x0, y0, x1, y1 = [int(round(v)) for v in box]
    c = img[max(0, y0):y1, max(0, x0):x1]
    if c.size == 0 or c.shape[0] < 4 or c.shape[1] < 4:
        return None
    w = max(8, int(round(c.shape[1] * H / c.shape[0])))
    w = min(w, 3200)
    c = cv2.resize(c, (w, H)).astype(np.float32) / 255.0
    c = (c - 0.5) / 0.5
    return c.transpose(2, 0, 1)[None]  # [1,3,48,W]


@app.function(image=image, cpu=4.0, memory=8192, timeout=3 * 3600)
def run(models: dict, pages: list, boxes: dict) -> dict:
    import io
    import random
    import tarfile
    import time

    import cv2
    import nncf
    import numpy as np
    import openvino as ov
    import yaml

    rng = random.Random(0)
    crops = []
    for name, png in pages:
        img = cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_COLOR)
        for b in boxes.get(name, []):
            c = crop_line(img, b)
            if c is not None:
                crops.append(c)
    rng.shuffle(crops)
    calib, evals = crops[:300], crops[300:1300]
    core = ov.Core()
    out = {"crops": len(crops), "calib": len(calib), "eval": len(evals)}
    for key, tar_bytes in models.items():
        tf = tarfile.open(fileobj=io.BytesIO(tar_bytes))
        onnx_member = next(m for m in tf.getmembers() if m.name.endswith(".onnx"))
        yml_member = next(m for m in tf.getmembers() if m.name.endswith(".yml"))
        onnx_path = f"/tmp/{key}.onnx"
        Path(onnx_path).write_bytes(tf.extractfile(onnx_member).read())
        chars = ["<blank>"] + yaml.safe_load(tf.extractfile(yml_member))["PostProcess"]["character_dict"] + [" "]
        fp32 = core.read_model(onnx_path)
        int8 = nncf.quantize(fp32, nncf.Dataset(calib), subset_size=len(calib),
                             preset=nncf.QuantizationPreset.MIXED)
        compiled = {name: core.compile_model(m, "CPU", {"INFERENCE_NUM_THREADS": 4})
                    for name, m in (("fp32", fp32), ("int8", int8))}

        def decode(probs):
            ids = probs[0].argmax(-1)
            s, prev = [], 0
            for i in ids:
                if i != prev and i != 0:
                    s.append(chars[i] if i < len(chars) else "?")
                prev = i
            return "".join(s)

        texts, times = {}, {}
        for name, c in compiled.items():
            for x in evals[:20]:
                c(x)
            ts, tx = [], []
            for x in evals:
                t = time.perf_counter(); r = c(x)[0]; ts.append(time.perf_counter() - t)
                tx.append(decode(r))
            texts[name], times[name] = tx, ts

        def cer(a, b):
            import difflib
            sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
            edits = sum(max(i2 - i1, j2 - j1) for tag, i1, i2, j1, j2 in sm.get_opcodes() if tag != "equal")
            return edits / max(1, len(a))

        exact = sum(a == b for a, b in zip(texts["fp32"], texts["int8"])) / len(evals)
        digit_lines = [(a, b) for a, b in zip(texts["fp32"], texts["int8"]) if any(ch.isdigit() for ch in a)]
        out[key] = {
            "fp32_ms_mean": round(1000 * float(np.mean(times["fp32"])), 2),
            "int8_ms_mean": round(1000 * float(np.mean(times["int8"])), 2),
            "speedup": round(float(np.mean(times["fp32"]) / np.mean(times["int8"])), 2),
            "exact_match_int8_vs_fp32": round(exact, 4),
            "cer_int8_vs_fp32": round(float(np.mean([cer(a, b) for a, b in zip(texts["fp32"], texts["int8"])])), 5),
            "digit_lines": len(digit_lines),
            "digit_lines_changed": sum(a != b for a, b in digit_lines),
            "examples_changed": [(a, b) for a, b in zip(texts["fp32"], texts["int8"]) if a != b][:15],
        }
    import platform
    out["cpu"] = platform.processor() or platform.machine()
    try:
        out["cpuinfo"] = next(l for l in open("/proc/cpuinfo") if l.startswith("model name")).split(":")[1].strip()
        out["avx512_vnni"] = "avx512_vnni" in open("/proc/cpuinfo").read()
    except Exception:
        pass
    return out


@app.local_entrypoint()
def main(pages_dir: str, small_tar: str, tiny_tar: str, out: str):
    pd = Path(pages_dir)
    manifest = json.loads((pd / "manifest.json").read_text())
    ceremony = json.loads((pd / "candidate-results.json").read_text())
    boxes = {p["page"]: [l["box"] for l in p["lines"] if l.get("box")] for p in ceremony["perPage"]}
    pages = [(e["page"], (pd / e["png"]).read_bytes()) for e in manifest]
    models = {"small": Path(small_tar).read_bytes(), "tiny": Path(tiny_tar).read_bytes()}
    result = run.remote(models, pages, boxes)
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    Path(out).write_text(json.dumps(result, indent=1, ensure_ascii=False))
    for k in ("small", "tiny"):
        r = result[k]
        print(k, {x: r[x] for x in r if x != "examples_changed"})
    print("cpu:", result.get("cpuinfo"), "vnni:", result.get("avx512_vnni"))

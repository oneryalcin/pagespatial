"""Indra OCR vs PP-OCRv6 small: same images, same threads, two accuracy proxies.

Trial: docs/trials/2026-11-07-indra-ocr-evaluation.md

Each engine runs in its own environment (paddle needs Python <= 3.13):

  S=<work dir>
  # 1. images
  uv run --with pypdfium2 --with pillow python scripts/evaluation/indra_vs_ppocr.py render-native $S/native <pdf>...
  python3 scripts/evaluation/indra_vs_ppocr.py collect-gold $S/gold .
  # 2. engines (repeat per image dir)
  uv run --with indra-ocr==1.1.2 python scripts/evaluation/indra_vs_ppocr.py run indra $S/native 4
  MODELS=$PWD/.evaluation/sidecar-models PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True \
    uv run -p 3.11 --with paddleocr==3.7.0 --with paddlepaddle==3.2.1 \
    python scripts/evaluation/indra_vs_ppocr.py run paddle $S/native 4
  # 3. scores (stdlib only)
  python3 scripts/evaluation/indra_vs_ppocr.py score-native $S/native
  python3 scripts/evaluation/indra_vs_ppocr.py score-gold $S/gold [evidence.json]

Accuracy proxies:
  score-native: on pages whose PDF text layer has >= 30 words, bag-of-words
    recall/precision of OCR text against that layer.
  score-gold: share of human-confirmed gold tokens (verdict correct/edited)
    found in the page text, whitespace-insensitive. Gold tokens were PP-OCR
    proposals, so PP's score is a ceiling by construction.
"""
import glob
import json
import os
import re
import shutil
import sys
import time
from collections import Counter
from pathlib import Path

ENGINES = tuple(os.environ.get("ENGINES", "indra,paddle").split(","))
PAGES_PER_PDF = 3
DPI = 200


def render_native(out: Path, pdfs: list[str]) -> None:
    import pypdfium2 as pdfium

    out.mkdir(parents=True, exist_ok=True)
    native = {}
    for pdf in pdfs:
        doc = pdfium.PdfDocument(pdf)
        for i in range(min(PAGES_PER_PDF, len(doc))):
            page = doc[i]
            name = f"{Path(pdf).stem[:40]}_p{i + 1}"
            page.render(scale=DPI / 72).to_pil().convert("RGB").save(out / f"{name}.png")
            native[name] = page.get_textpage().get_text_range()
    (out / "native.json").write_text(json.dumps(native))
    print(len(native), "pages")


def collect_gold(out: Path, repo: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    gold, scans = {}, set()
    for f in sorted(glob.glob(str(repo / ".evaluation/gold/*/gold-verdicts.json"))):
        bdir = Path(f).parent
        if not (bdir / "images").is_dir():
            continue
        labels = {}
        if (bdir / "pilot-sample.json").exists():
            for s in json.load(open(bdir / "pilot-sample.json")):
                labels[(s["objectId"], s["pageNumber"])] = s.get("labels", [])
        for p in json.load(open(f))["pages"]:
            img = bdir / "images" / f"{p['objectId'].replace(':', '_')}-p{p['pageNumber']}.png"
            if not img.exists():
                continue
            name = f"{bdir.name}__{img.stem}"
            shutil.copy(img, out / f"{name}.png")
            gold[name] = [t["text"] for t in p["tokens"] if t["verdict"] in ("correct", "edited")]
            if "image-only" in labels.get((p["objectId"], p["pageNumber"]), []):
                scans.add(name)
    (out / "gold.json").write_text(json.dumps({"gold": gold, "scans": sorted(scans)}))
    print(len(gold), "pages", sum(map(len, gold.values())), "tokens;", len(scans), "image-only")


def make_engine(engine: str, threads: int):
    import cv2

    if engine == "indra":
        import indra_ocr

        conv = indra_ocr.load(threads=threads, mode="ocr")  # never read the text layer
        return lambda p: [l.text for l in conv.ocr(cv2.imread(str(p), cv2.IMREAD_GRAYSCALE)).lines]

    # Same construction as service/sidecar/ppocr_sidecar.py.
    os.environ["PADDLE_PDX_CPU_NUM_THREADS"] = str(threads)
    from paddleocr import PaddleOCR

    m = Path(os.environ["MODELS"])
    # paddle-tinyrec: same Small detector, Tiny recognizer (downloaded by name).
    rec = "PP-OCRv6_tiny_rec" if engine == "paddle-tinyrec" else "PP-OCRv6_small_rec"
    eng = PaddleOCR(
        text_detection_model_name="PP-OCRv6_small_det",
        text_detection_model_dir=str(m / "PP-OCRv6_small_det"),
        text_recognition_model_name=rec,
        text_recognition_model_dir=str(m / rec) if (m / rec).is_dir() else None,
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        device="cpu",
        cpu_threads=threads,
    )

    def ocr(p):
        texts = []
        for r in eng.predict(cv2.imread(str(p), cv2.IMREAD_COLOR)):
            d = r if isinstance(r, dict) else r.json.get("res", r.json)
            texts += list(d.get("rec_texts", []))
        return texts

    return ocr


def run(engine: str, out: Path, threads: int) -> None:
    pngs = sorted(out.glob("*.png"))
    ocr = make_engine(engine, threads)
    ocr(pngs[0])  # warm-up, untimed
    with open(out / f"{engine}.jsonl", "w") as f:
        for p in pngs:
            t = time.perf_counter()
            lines = ocr(p)
            ms = (time.perf_counter() - t) * 1000
            f.write(json.dumps({"page": p.stem, "ms": ms, "text": "\n".join(lines)}) + "\n")
            print(f"{engine} {p.stem} {ms:.0f}ms {len(lines)} lines", flush=True)


def load_results(out: Path) -> dict:
    return {e: {r["page"]: r for r in map(json.loads, open(out / f"{e}.jsonl"))} for e in ENGINES}


def words(s: str) -> Counter:
    return Counter(re.findall(r"\w+", s.lower()))


def score_native(out: Path) -> dict:
    native = json.loads((out / "native.json").read_text())
    res = load_results(out)
    summary = {}
    for e in ENGINES:
        hit = ref = got = 0
        for page, text in native.items():
            nw = words(text)
            if sum(nw.values()) < 30:  # no usable text layer: scan
                continue
            ow = words(res[e][page]["text"])
            hit += sum((nw & ow).values()); ref += sum(nw.values()); got += sum(ow.values())
        ms = [res[e][p]["ms"] for p in native]
        summary[e] = {"pages": len(ms), "mean_ms": round(sum(ms) / len(ms)),
                      "word_recall": round(hit / ref, 3), "word_precision": round(hit / got, 3)}
        print(e, summary[e])
    return summary


def score_gold(out: Path) -> dict:
    g = json.loads((out / "gold.json").read_text())
    gold, scans = g["gold"], set(g["scans"])
    res = load_results(out)
    strict = lambda s: re.sub(r"\s+", "", s).lower()
    loose = lambda s: re.sub(r"[\s$~]", "", s).lower()  # engines split "$" from its number
    summary = {}
    for group in ("image-only", "other"):
        pages = [p for p in gold if (p in scans) == (group == "image-only")]
        for norm_name, norm in (("strict", strict), ("no_currency", loose)):
            for e in ENGINES:
                toks = [(p, t) for p in pages for t in gold[p] if norm(t)]
                found = sum(norm(t) in norm(res[e][p]["text"]) for p, t in toks)
                ms = [res[e][p]["ms"] for p in pages]
                key = f"{group}/{norm_name}/{e}"
                summary[key] = {"pages": len(pages), "tokens": len(toks), "found": found,
                                "rate": round(found / len(toks), 3), "mean_ms": round(sum(ms) / len(ms))}
                print(key, summary[key])
    cand = next(e for e in ENGINES if e != "paddle")  # candidate vs the production witness
    misses = {}
    for p in sorted(gold):
        tc, tp = loose(res[cand][p]["text"]), loose(res["paddle"][p]["text"])
        m = [t for t in gold[p] if loose(t) and loose(t) not in tc and loose(t) in tp]
        if m:
            misses[p] = m
            print(f"{cand}-only miss", p, m[:8], len(m))
    return {"summary": summary, f"{cand}_only_misses": misses}


if __name__ == "__main__":
    cmd, out = sys.argv[1], Path(sys.argv[2]) if len(sys.argv) > 2 else None
    if cmd == "render-native":
        render_native(out, sys.argv[3:])
    elif cmd == "collect-gold":
        collect_gold(out, Path(sys.argv[3]))
    elif cmd == "run":
        run(sys.argv[2], Path(sys.argv[3]), int(sys.argv[4]))
    elif cmd in ("score-native", "score-gold"):
        result = (score_native if cmd == "score-native" else score_gold)(out)
        if len(sys.argv) > 3:
            Path(sys.argv[3]).write_text(json.dumps(result, indent=1) + "\n")
    else:
        sys.exit(__doc__)

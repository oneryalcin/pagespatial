"""Score OneChart readings against the transcribed reference, gold tokens and PageSpatial's OCR.
  score.py RUN_DIR REPO
"""
import glob
import json
import re
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from charts import CHARTS  # noqa: E402

run, repo = Path(sys.argv[1]), Path(sys.argv[2])
NUM = re.compile(r"-?\d[\d,]*\.?\d*")


def nums(text):
    """Numbers as canonical strings: commas dropped, trailing '.0' kept apart from ints."""
    out = []
    for m in NUM.findall(text):
        v = m.replace(",", "").rstrip(".")
        try:
            out.append(float(v))
        except ValueError:
            pass
    return out


def json_values(output):
    """Numbers from OneChart's dict 'values' (the part before the reliability lines)."""
    body = output.split("\n<Chart>")[0].split("\nThis prediction")[0].strip()
    try:
        d = json.loads(body)
    except Exception:
        # Malformed dict (OneChart often emits set-style entries such as "$180.2%" with no
        # key): fall back to every number in the text of the "values" block.
        block = body.split('"values"', 1)[1] if '"values"' in body else ""
        return nums(re.sub(r"\(\d+\)|\[\d+\]", "", block)), "MALFORMED"
    vals = []

    def walk(x):
        if isinstance(x, dict):
            for v in x.values():
                walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)
        elif isinstance(x, (int, float)):
            vals.append(float(x))
        elif isinstance(x, str):
            vals.extend(nums(re.sub(r"\(\d+\)|\[\d+\]", "", x)))

    walk(d.get("values", d))
    return vals, body


def page_ocr_numbers(page):
    """Every number in PageSpatial's OCR observations (first pass + recovery) on that page, dev-v12."""
    f = glob.glob(str(repo / f".evaluation/runs/dev-v12-cross-family-2026-08-20/documents/public-comps_ares_2026-q1_002/pages/{page:06d}.json"))
    if not f:
        return set()
    p = json.load(open(f[0]))["pageSpatial"]
    return {v for o in p["ocrObservations"] for v in nums(o["text"])}


def gold_numbers(page):
    for f in glob.glob(str(repo / ".evaluation/gold/*/gold-verdicts.json")):
        for p in json.load(open(f))["pages"]:
            if p["objectId"] == "public-comps:ares:2026-q1:002" and p["pageNumber"] == page:
                return [v for t in p["tokens"] if t["verdict"] in ("correct", "edited") for v in nums(t["text"])]
    return []


results = {r["chart"]: r for r in map(json.loads, open(run / "onechart.jsonl"))}
tot = Counter()
print(f"{'chart':20} {'s':>5} {'ref':>3} {'out':>3} {'correct':>7} {'recall':>6} {'prec':>5} {'invented':>8} {'ocr-corrob':>10} reliable")
for name, (page, _, ref_s) in CHARTS.items():
    r = results.get(name)
    if not r:
        continue
    ref = Counter(float(x) for x in ref_s)
    vals, body = json_values(r["output"])
    reliable = "reliable" in r["output"] and "may be has error" not in r["output"]
    tot["malformed"] += body == "MALFORMED"
    if vals is None:
        print(f"{name:20} {r['seconds']:5.1f}  unparseable: {body[:80]!r}")
        tot["unparseable"] += 1
        tot["ref"] += sum(ref.values())
        continue
    out = Counter(vals)
    correct = sum((ref & out).values())
    page_text_nums = set(page_ocr_numbers(page)) | set(gold_numbers(page)) | set(ref)
    invented = [v for v in vals if v not in page_text_nums]
    ocr = page_ocr_numbers(page)
    corrob = sum(1 for v in vals if v in ocr)
    tot.update(ref=sum(ref.values()), out=len(vals), correct=correct, invented=len(invented), corrob=corrob,
               seconds=r["seconds"], reliable_flag=reliable, charts=1)
    print(f"{name:20} {r['seconds']:5.1f} {sum(ref.values()):3d} {len(vals):3d} {correct:7d} "
          f"{correct / sum(ref.values()):6.2f} {correct / max(1, len(vals)):5.2f} {len(invented):8d} {corrob:10d} {reliable}"
          + (" MALFORMED" if body == "MALFORMED" else "") + (f"  invented={invented[:6]}" if invented else ""))
print(f"\nTOTAL charts {tot['charts']} (+{tot['unparseable']} unparseable): reference values {tot['ref']}, "
      f"output values {tot['out']}, correct {tot['correct']} (recall {tot['correct'] / tot['ref']:.2f}, "
      f"precision {tot['correct'] / max(1, tot['out']):.2f}), invented {tot['invented']}, "
      f"corroboratable by PageSpatial OCR {tot['corrob']}/{tot['out']}, "
      f"mean {tot['seconds'] / max(1, tot['charts']):.1f}s/chart, self-check 'reliable' on {tot['reliable_flag']}, malformed JSON {tot['malformed']}")

# Reference sanity: gold-confirmed numbers on each page that fall in the chart reference.
for page in (50, 51, 52, 67):
    g = gold_numbers(page)
    refs = Counter(float(x) for n, (p, _, r) in CHARTS.items() if p == page for x in r)
    hits = sum((Counter(g) & refs).values())
    print(f"gold p{page}: {len(g)} confirmed numbers, {hits} coincide with the chart reference")

# What OneChart adds over PageSpatial's own OCR: every OneChart value (consume-once against the
# reference) and every reference value it missed, split by whether OCR also read that number.
split = Counter()
for name, (page, _, ref_s) in CHARTS.items():
    if name not in results:
        continue
    vals, _ = json_values(results[name]["output"])
    ocr, remaining = page_ocr_numbers(page), Counter(float(x) for x in ref_s)
    kind = "donut" if "donut" in name else "bar"
    for v in vals or []:
        ok = remaining[v] > 0
        remaining[v] -= ok
        split[(kind, "correct" if ok else "wrong", "ocr-also-read" if v in ocr else "ocr-missed")] += 1
    for v, c in remaining.items():
        if c > 0:
            split[(kind, "missed-by-onechart", "ocr-also-read" if v in ocr else "ocr-missed")] += c
print("\nOneChart vs PageSpatial OCR (dev-v12, first pass + zoom-retry recovery):")
for k in sorted(split):
    print("  ", k, split[k])

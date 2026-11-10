"""Simulate "fast recognizer first, production recognizer on unsure lines".

Trial: docs/trials/2026-11-10-fast-recognizer-options.md

Takes two ocr_arms_modal.py results that share a detector (identical boxes)
and writes a result where each line is the candidate's reading unless its
confidence is below --min-score or it contains CJK characters (the Tiny
dictionary has no kana); those lines take the reference recognizer's reading.
The output scores unchanged with score-candidate-witness.mjs and
native-token-precision.mjs. Timing fields are the candidate's and mean nothing
for the mix; the share of lines and of line width sent to the reference is
printed instead.

  python3 scripts/evaluation/simulate_recognizer_routing.py \
      --reference results-small_small-r0.json --candidate results-<arm>-r0.json \
      --min-score 0.95 --out results-routed.json
"""
import argparse
import json
import re

CJK = re.compile(r"[぀-ヿ㐀-鿿]")

parser = argparse.ArgumentParser()
parser.add_argument("--reference", required=True)
parser.add_argument("--candidate", required=True)
parser.add_argument("--min-score", type=float, required=True)
parser.add_argument("--out", required=True)
args = parser.parse_args()

reference = json.load(open(args.reference))
candidate = json.load(open(args.candidate))
lines = routed = width = routed_width = 0
for ref_page, page in zip(reference["perPage"], candidate["perPage"]):
    if ref_page["page"] != page["page"] or [l["box"] for l in ref_page["lines"]] != [l["box"] for l in page["lines"]]:
        raise SystemExit(f"{page['page']}: the two results do not share line boxes")
    for index, (ref_line, line) in enumerate(zip(ref_page["lines"], page["lines"])):
        line_width = line["box"][2] - line["box"][0]
        lines += 1
        width += line_width
        if (line["score"] or 0) < args.min_score or CJK.search(line["text"]):
            page["lines"][index] = ref_line
            routed += 1
            routed_width += line_width
candidate["config"]["name"] = f"{candidate['config']['name']}_routed{round(args.min_score * 100)}"
json.dump(candidate, open(args.out, "w"))
print(json.dumps({"name": candidate["config"]["name"], "lines": lines,
                  "linesToReference": round(routed / lines, 4), "widthToReference": round(routed_width / width, 4)}))

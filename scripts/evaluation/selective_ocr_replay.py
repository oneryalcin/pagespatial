"""Replay a full-OCR run under the selective-OCR skip rule and report what would be lost.

Design: docs/design/2026-11-07-selective-ocr.md

For every OCR observation (one detector box) in a run's PageSpatial records,
decide - from native evidence only, as the live mode would before
recognition - whether recognition would be skipped:

  skip  <=> page has a usable native layer (>= MIN_NATIVE_CHARS)
        and native boxes cover >= COVER of the OCR box area
        and no native LINE touching the box contains a numeral (whole line,
        so a digit just outside the detector box still forces recognition)
        or a control/private-use/unassigned/replacement character.

Reports the skipped share of recognizer work (by OCR text length), and every
recorded conflict whose OCR box would have been skipped (each one is a lost
corroboration). The font audit is not simulated (assumed to pass).

  python3 scripts/evaluation/selective_ocr_replay.py .evaluation/runs/<run-id> [--cover 0.6]
"""
import glob
import json
import re
import sys
import unicodedata
from collections import Counter

MIN_NATIVE_CHARS = 200


def numeric(text):
    """Any Unicode numeral (ASCII digits, circled/fullwidth/superscript numbers)."""
    return any(unicodedata.numeric(ch, None) is not None for ch in text)


def suspicious(text):
    """Control, private-use, unassigned or replacement characters: a text layer
    whose font has no faithful Unicode mapping for some glyph."""
    return any(unicodedata.category(ch) in ("Cc", "Co", "Cn") or ch == "\ufffd"
               for ch in text if ch not in "\t\n\r")


def inter(a, b):
    w = min(a[2], b[2]) - max(a[0], b[0])
    h = min(a[3], b[3]) - max(a[1], b[1])
    return w * h if w > 0 and h > 0 else 0.0


def area(a):
    return max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])


def decide(ocr, natives, lines, cover):
    """(skip, reason) for one OCR box. Coverage is the sum of native overlaps, capped at 1."""
    a = area(ocr["box"]) or 1.0
    over = [n for n in natives if inter(ocr["box"], n["box"]) > 0]
    covered = min(1.0, sum(inter(ocr["box"], n["box"]) for n in over) / a)
    if covered < cover:
        return False, "not-native-covered"
    touching = [l for l in lines if inter(ocr["box"], l["box"]) > 0]
    texts = [t["text"] for t in over + touching]
    if any(numeric(t) for t in texts):
        return False, "native-has-digit"
    if any(suspicious(t) for t in texts):
        return False, "native-suspicious"
    return True, "skip"


def main(run_root, cover):
    work = Counter()
    lost = []
    pages = 0
    for f in sorted(glob.glob(f"{run_root}/documents/*/pages/*.json")):
        p = json.load(open(f))["pageSpatial"]
        pages += 1
        natives = p["nativeObservations"]
        usable = sum(len(n["text"]) for n in natives) >= MIN_NATIVE_CHARS
        verdict = {}
        for o in p["ocrObservations"]:
            if o.get("recoveryMethod"):
                verdict[o["id"]] = (False, "recovery-pass")  # second-pass reads always run
            elif not usable:
                verdict[o["id"]] = (False, "no-native-layer")
            else:
                verdict[o["id"]] = decide(o, natives, p["nativeLines"], cover)
            work[verdict[o["id"]][1]] += len(o["text"])
        for c in p["conflicts"]:
            skip, _ = verdict.get(c["ocrId"], (False, ""))
            if skip:
                lost.append((f.split("/documents/")[1], c["reason"], c["nativeText"][:50], c["ocrText"][:50]))
    total = sum(work.values())
    print(f"{pages} pages, cover >= {cover}")
    for k, v in work.most_common():
        print(f"  {k:20} {v / total:6.1%} of OCR text chars")
    n_conf = sum(len(json.load(open(f))["pageSpatial"]["conflicts"])
                 for f in glob.glob(f"{run_root}/documents/*/pages/*.json"))
    print(f"conflicts whose OCR box would be skipped: {len(lost)} of {n_conf}")
    for row in lost:
        print("  ", row)


if __name__ == "__main__":
    args = sys.argv[1:]
    cover = float(args[args.index("--cover") + 1]) if "--cover" in args else 0.6
    main(args[0], cover)


def prose_agreement(run_root, cover=0.6, show=12):
    """For boxes the rule would skip: share of the OCR reading contained in the native text.
    Disagreement here is what the font audit must catch (no conflict is raised for prose)."""
    import difflib
    sims, low = [], []
    for f in sorted(glob.glob(f"{run_root}/documents/*/pages/*.json")):
        p = json.load(open(f))["pageSpatial"]
        natives = p["nativeObservations"]
        if sum(len(n["text"]) for n in natives) < MIN_NATIVE_CHARS:
            continue
        match = {m["ocrId"]: m for m in p["sourceMatches"]}
        for o in p["ocrObservations"]:
            if o.get("recoveryMethod") or not decide(o, natives, p["nativeLines"], cover)[0]:
                continue
            over = [n for n in natives if inter(o["box"], n["box"]) > 0]
            ntext = " ".join(n["text"] for n in sorted(over, key=lambda n: (n["box"][1], n["box"][0])))
            norm = lambda s: re.sub(r"\s+", "", unicodedata.normalize("NFKC", s)).lower()
            a, b = norm(ntext), norm(o["text"])
            # containment: share of the OCR reading found, in order, in the native text
            sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
            sim = sum(m.size for m in sm.get_matching_blocks()) / len(b) if b else 1.0
            sims.append(sim)
            if sim < 0.8:
                low.append((round(sim, 2), f.split("/documents/")[1][:45], ntext[:60], o["text"][:60], o["id"] in match))
    sims.sort()
    q = lambda x: sims[int(x * (len(sims) - 1))]
    print(f"skipped boxes {len(sims)}: OCR-in-native containment p01 {q(0.01):.2f} p05 {q(0.05):.2f} p50 {q(0.5):.2f}; "
          f"<0.8: {len(low)}  <0.5: {sum(s < 0.5 for s in sims)}")
    for row in sorted(low)[:show]:
        print("  ", row)


def font_audit(page_files, fail_below=0.8, cover=0.6):
    """Per document and font: greedily choose native lines covering every letter the
    font uses, compare each with the OCR text over it, and fail the font if any audit
    line's agreement < fail_below. Returns {(doc, font): (passed, n_audit, n_lines, worst)}."""
    import difflib
    from collections import defaultdict
    norm = lambda s: re.sub(r"\s+", "", unicodedata.normalize("NFKC", s)).lower()
    by_font = defaultdict(list)  # (doc, font) -> [(native text, ocr text)]
    for f in page_files:
        rec = json.load(open(f))
        p = rec.get("pageSpatial", rec)
        doc = p["documentId"]
        ocrs = [o for o in p["ocrObservations"] if not o.get("recoveryMethod")]
        for n in p["nativeObservations"]:
            if not n.get("font") or not re.search(r"[^\W\d_]", n["text"]):
                continue
            over = [o for o in ocrs if inter(o["box"], n["box"]) > 0]
            if not over or min(1.0, sum(inter(o["box"], n["box"]) for o in over) / (area(n["box"]) or 1)) < cover:
                continue
            otext = "".join(o["text"] for o in sorted(over, key=lambda o: (o["box"][1], o["box"][0])))
            by_font[(doc, n["font"])].append((n["text"], otext))
    result = {}
    for key, lines in by_font.items():
        letters = lambda t: {c for c in norm(t) if c.isalpha()}
        need, picked = set().union(*(letters(t) for t, _ in lines)), []
        pool = list(lines)
        while need and pool:  # greedy set cover over the font's letters
            best = max(pool, key=lambda l: len(letters(l[0]) & need))
            if not letters(best[0]) & need:
                break
            picked.append(best); need -= letters(best[0]); pool.remove(best)
        scores = []
        for ntext, otext in picked:
            a, b = norm(ntext), norm(otext)
            sm = difflib.SequenceMatcher(None, b, a, autojunk=False)
            scores.append(sum(m.size for m in sm.get_matching_blocks()) / len(a) if a else 1.0)
        worst = min(scores) if scores else 1.0
        result[key] = (worst >= fail_below, len(picked), len(lines), round(worst, 2))
    return result


def glyph_audit(page_files, cover=0.6, k=2, min_rate=0.5):
    """Glyph-level font audit. Per (doc, font): greedy-pick native lines until each
    letter the font uses appears >= k times; align native vs OCR per audit line; a
    letter fails if it is substituted by the SAME OCR character in >= min_rate of its
    >= k aligned occurrences (systematic, as a broken CMap is; OCR noise is not).
    Returns {(doc, font): (passed, n_audit, n_lines, failing letters)}."""
    import difflib
    from collections import defaultdict
    norm = lambda s: re.sub(r"\s+", "", unicodedata.normalize("NFKC", s))
    by_font = defaultdict(list)
    for f in page_files:
        rec = json.load(open(f))
        p = rec.get("pageSpatial", rec)
        ocrs = [o for o in p["ocrObservations"] if not o.get("recoveryMethod")]
        for n in p["nativeObservations"]:
            if not n.get("font") or not re.search(r"[^\W\d_]", n["text"]):
                continue
            over = [o for o in ocrs if inter(o["box"], n["box"]) > 0]
            if not over or min(1.0, sum(inter(o["box"], n["box"]) for o in over) / (area(n["box"]) or 1)) < cover:
                continue
            otext = "".join(o["text"] for o in sorted(over, key=lambda o: (o["box"][1], o["box"][0])))
            by_font[(p["documentId"], n["font"])].append((norm(n["text"]), norm(otext)))
    result = {}
    for key, lines in by_font.items():
        need = Counter()
        for t, _ in lines:
            need.update(c for c in t if c.isalpha())
        need = Counter({c: min(k, v) for c, v in need.items()})
        picked, pool = [], list(lines)
        while +need and pool:
            gain = lambda l: sum(min(need[c], cnt) for c, cnt in Counter(ch for ch in l[0] if ch.isalpha()).items())
            best = max(pool, key=gain)
            if gain(best) == 0:
                break
            picked.append(best); pool.remove(best)
            need -= Counter(ch for ch in best[0] if ch.isalpha())
        seen, subs = Counter(), defaultdict(Counter)
        for a, b in picked:
            for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
                if tag == "equal":
                    seen.update(c for c in a[i1:i2] if c.isalpha())
                elif tag == "replace" and i2 - i1 == j2 - j1:
                    for x, y in zip(a[i1:i2], b[j1:j2]):
                        if x.isalpha():
                            seen[x] += 1
                            if x.lower() != y.lower():
                                subs[x][y] += 1
        bad = {x: (c.most_common(1)[0], seen[x]) for x, c in subs.items()
               if seen[x] >= k and c.most_common(1)[0][1] / seen[x] >= min_rate}
        result[key] = (not bad, len(picked), len(lines), bad)
    return result


def net_skip(run_root, cover=0.6):
    """Skip share after the glyph audit: a box is skipped only if decide() skips it,
    every native font under it passed the audit, and it is not itself an audit line.
    Audit lines are approximated as the OCR boxes over the audit's native lines."""
    files = sorted(glob.glob(f"{run_root}/documents/*/pages/*.json"))
    audit = glyph_audit(files, cover=cover)
    # Re-derive which native lines the audit picked, by text, per (doc, font).
    picked_texts = {}
    norm = lambda s: re.sub(r"\s+", "", unicodedata.normalize("NFKC", s))
    for key in audit:
        picked_texts[key] = set()
    work = Counter()
    for f in files:
        p = json.load(open(f))["pageSpatial"]
        natives = p["nativeObservations"]
        usable = sum(len(n["text"]) for n in natives) >= MIN_NATIVE_CHARS
        for o in p["ocrObservations"]:
            w = len(o["text"])
            if o.get("recoveryMethod") or not usable:
                work["always"] += w; continue
            skip, _ = decide(o, natives, p["nativeLines"], cover)
            if not skip:
                work["rule-keeps"] += w; continue
            fonts = {(p["documentId"], n.get("font")) for n in natives if inter(o["box"], n["box"]) > 0}
            if any(not audit.get(k, (True,))[0] for k in fonts):
                work["font-failed"] += w
            else:
                work["skipped"] += w
    total = sum(work.values())
    audit_lines = sum(v[1] for v in audit.values())
    all_lines = sum(v[2] for v in audit.values())
    print(f"{run_root.split('/')[-1]}: " + ", ".join(f"{k} {v / total:.1%}" for k, v in work.most_common()))
    print(f"  audit reads {audit_lines}/{all_lines} native lines ({audit_lines / all_lines:.0%}); "
          f"net skipped ~ {work['skipped'] / total * (1 - audit_lines / all_lines):.1%} of OCR text "
          f"(skipped share discounted by the audit fraction)")

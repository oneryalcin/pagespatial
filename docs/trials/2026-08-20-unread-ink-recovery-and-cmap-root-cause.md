# Unread-ink recovery and the CMap root cause

**Date:** 2026-08-20 · **Branch:** `region-recovery` · **Issue:** #10 · **PR:** #12

## What was built

Pages sometimes carry content neither witness sees — numbers drawn inside
charts, too small for the first OCR pass and absent from the native text
layer. These evidence deserts previously passed silently. Issue #10 built the
in-pipeline answer:

1. **Find** unread ink (`src/ink.ts`): luminance grid over the first render,
   observation boxes dilated out, connected components with a closing radius,
   kind-aware merge. Deterministic, runtime-agnostic, unit-tested.
2. **Sort** by physics: printed content is bimodal (ink or paper);
   photographs are continuous-tone. `midToneFraction ≥ 0.30` separates
   pictorial (record, don't re-read) from structured (worth a second look)
   with a 3× measured margin.
3. **Re-read** structured residue (`createZoomRetryRecovery`): re-render the
   vector page at up to 4× scale, tile at the detector's input cap (≤900px,
   6% overlap), re-OCR tiles touching structured regions, map boxes back,
   dedupe against first-pass evidence (same place AND same reading).
4. **Record honestly** (schema 0.4.0): `unreadInkRegions` on the page,
   `recoveryMethod: 'zoom-retry-v1'` on second-pass observations, blocking
   `unread-ink-region` escalation for structured residue that recovery could
   not read. Recovered observations are excluded from the
   coverage-starvation denominator — they are deliberately-recovered,
   known-single-witness evidence.

## The hunt: three acceptance rounds, then a renderer confession

Acceptance target: monotaro p61, where 105 of 106 human-verified gold tokens
existed in neither witness (and the standalone pip experiment read 106/106).

| Round | Failure | Root cause |
|---|---|---|
| 1 | 2 recoveries corpus-wide | detector's 960px input cap silently un-zoomed crops; region fragmentation |
| 2 | 16 garbage reads on p61 (`ııl`) | surgical crops centred on ink-dense bars, clipping the faint digits |
| 3 | 30 legible reads, still no digits | see below |

After round 3 a differential chain exonerated the model (pip small tier:
106/106), the render quality (browser-equivalent conditions: 104/106) and
every exposed parameter (js knobs in pip: 106/106) — leaving "paddleocr-js
internals" as the suspect by elimination.

The decisive experiment said otherwise. The harness gained a debug sink
(`dumpRecoveryTiles`) that captures the exact tiles the browser feeds its
OCR; pip read those identical PNGs and scored **1/106 — the same failure**.
paddleocr-js exonerated. The digits were never in the tiles: the render
showed bare chart bars with no numbers painted.

**Root cause:** `openPdfJsSession` called `getDocument` without `cMapUrl`.
The digits' font references the predefined CID CMap **Adobe-Japan1-UCS2**;
pdf.js cannot translate such fonts without its bundled cmap files and
silently paints nothing for those glyphs — in every render, first pass and
recovery alike. Poppler ships its own CMaps, which is why every
pip-rendered experiment saw the digits. Part of the p61 evidence desert was
manufactured by our own renderer.

**Fix:** `cMapUrl`/`standardFontDataUrl` options on `openPdfJsSession`
(passed with `cMapPacked: true`); the evaluation harness serves
`pdfjs-dist/cmaps` and `standard_fonts` locally, preserving the
offline-only constraint.

## Results

p61, actual browser pipeline (small tier, recovery on):

| | before fix | after fix |
|---|---|---|
| page OCR observations | 57 | 292 |
| gold tokens recovered | 1/106 | **98/106** |

The 8 misses are decimal-tail misreads on the smallest labels
(`60.9` read `60.6`, `100.0` read `100`) — an accuracy tail on
honestly-labelled single-witness evidence, not a systemic hole.

Corpus run `exp-cmap-recovery-2026-08-20` (162 pages, small tier,
recovery on), against the round-3 run before the CMap fix:

| | round 3 (`exp-region-recovery-c`) | after CMap fix |
|---|---|---|
| OCR observations | 20,171 | 20,524 |
| recovered (second-pass) observations | 2,461 | 2,642 |
| unread-ink residue pages | 83 | 81 |
| p61 full-pipeline gold recall | 1/106 | **106/106** |
| gold recall, all 28 verified pages | 303/468 (64.7%) | **451/468 (96.4%)** |

No gold page regressed. The corpus-wide observation shift is modest because
only documents whose fonts use predefined CMaps are affected — but on those
documents the change is transformative (monotaro p30: 13/61 → 50/61).

## Blast radius and lineage

The CMap fix changes renders for every document whose fonts use predefined
CID CMaps (common in CJK PDFs). OCR observation counts, conflicts, and
escalations shift corpus-wide as previously-invisible glyphs become
paintable. This is a render-fidelity correction, not a token-definition
change: comparisons against dev-v10 must account for it, and the next
reference baseline starts a new comparable series.

## Lessons

- Four different layers each silently ate the zoom: a detector input cap, a
  cropping strategy, an ink threshold, and a renderer missing its CMaps.
  Only measuring after every change caught them one by one.
- "By elimination" is only as good as the enumeration. The differential
  chain compared pip renders against browser renders and concluded
  "paddleocr-js internals" — but the two render paths were never bitwise
  compared. Dumping the actual intermediate artifact (the tiles) settled in
  one experiment what four inference experiments could not.
- A renderer that fails a font does so *silently*. The unread-ink detector
  built for chart digits is exactly the instrument that catches this class
  of failure: unpainted glyphs leave ink-free zones where the native text
  layer claims content — worth a dedicated diagnostic some day.

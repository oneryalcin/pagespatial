# Cross-family second opinion: the $0 corroborator for scans

**Date:** 2026-08-20 · **Branch:** `cross-family-corroboration` · **Issue:** #17

## The problem

After the escalation ladder, the coverage-starved tier (scans with no
text layer — 27 pages, mostly Seattle municipal records and a PA-SERS
deck) was 40% of remaining model spend: single-witness by fact, so every
page bought a full Flash transcription.

## The idea, and why Tesseract specifically

A page is starved because nothing could catch a confidently-wrong OCR
reading. A **mechanically different OCR family** can: Tesseract's LSTM
lineage, training data, and preprocessing share little with PP-OCR, so
agreement between them is evidence (principles §5: two witnesses that
share failure modes corroborate nothing — two similar vision models would
not qualify).

Measured before building (27 starved pages, 4 with gold):
- Token agreement mean ~72%; 24/27 pages exceed the starvation threshold.
- Agreement precision **71/72 on gold** — the 1 miss is the textbook
  shared failure: a degraded scan glyph read `118835` by PP-OCR where gold
  says `118335`, and Tesseract agreed with the misread. ~1.4% agree-on-
  wrong on a small sample (evaluation-debts ledger row 1); for calibration
  Flash's measured precision is ~98.5% and it read that glyph correctly.

**Path split (adversarial-review correction):** engagement has two paths —
critical-token consumption (numbers) and normalized-containment (prose,
token-free). Recomputed over the shipped run: 967 engagements = 389 token
+ **578 containment**; token-path alone would clear only ~2 of the 23
cleared pages. The 71/72 precision claim covers the TOKEN path only;
containment-path precision is an unmeasured debt (ledger row 1b). The
containment needles are mostly long real prose (median 18 normalized
chars), and containment is now occurrence-consuming with the same
low-confidence floor as the primary side — but the number stays a debt
until gold measures it.

## What shipped (schema 0.6.0)

- `PageSpatial.secondOpinion?: { adapter, readings: [{box, text,
  confidence?}] }` — the second engine's RAW readings on the canonical
  record with adapter provenance. Absent = the pass never ran.
- Engagement is **derived, never stored**: `crossEngineEngagedIds`
  (diagnostics, re-derived by the schema) marks a confident OCR
  observation engaged when the second engine's pool corroborates its text
  under the shared same-ink rules — `src/corroborate.ts`, one
  implementation now shared with escalated enrichment so matching
  semantics cannot drift. Forgery regression: stripping `secondOpinion`
  while keeping the cleared alarm fails validation.
- `ParserAdapters.secondOpinion?: OcrAdapter` — invoked ONLY when the
  page would otherwise escalate as coverage-starved (assemble, check,
  re-assemble); failure degrades to the standing alarm.
- `createTesseractAdapter` (`src/node/tesseract-ocr.ts`): system
  tesseract binary, TSV word boxes, rendered-pixel space.
- Geometry is deliberately unused in matching for now: the engines
  segment differently (line vs word boxes), and page-pool matching is the
  shape the experiment validated.

## Measured (`exp-second-opinion-d-2026-08-20`, 162 pages, 0 failures)

| | before | after |
|---|---|---|
| coverage-starved pages | 27 | **4** |
| blocking pages | 106 | **91** |
| corpus gold | 464/468 | 464/468 |
| ladder spend (Flash) | $0.584 | **$0.497** |
| amortized per corpus page | $0.0036 | **$0.00307** (~$0.0015 with batch) |

All 27 previously-starved pages carry their second-opinion readings
(8,314) on the record; the 4 that stay starved (one badly degraded scan,
dense slides) still route to Flash — honest residual.

## Resource footprint (measured 2026-08-20, Apple M4 Max)

Per would-starve page, at the harness's 300 dpi render (letter-size
2550×3300 px and 3000×2250 px slide pages from the corpus):

| stage | latency | peak RSS | CPU |
|---|---|---|---|
| pdftoppm render (300 dpi) | ~0.5 s | ~66 MB | 1 core |
| tesseract (TSV, psm 3, eng) | 0.5–0.6 s | 137–162 MB | ~1 core (brief OMP ≤4 threads) |
| whole pass, serial | ~1.1 s | ~160 MB transient (subprocess exits per page) | |

Same weight class as the deterministic parse (~1 s/page); replaces a ~7 s
remote call. Fires only on would-starve pages (27/162 = 17% on this
scan-heavy corpus). Scale budgeting (issue #22): ~1 extra core-second and
~160 MB transient per scanned page; embarrassingly parallel subprocesses.
Known headroom at millions of pages: the ~15 MB eng model loads per
invocation (included in the 0.6 s) — a long-lived worker or the library
API would shave that startup cost.

Measurement method (repeat when hardware or settings change):
`pdftoppm -f <p> -l <p> -r 300 -png <pdf> out` then
`/usr/bin/time -l tesseract out-<p>.png stdout --psm 3 tsv` — `real` for
latency, `maximum resident set size` for peak RSS; run on real corpus
scan pages, not synthetic images.

## Economics scoreboard (issue #17, from the $0.0093 start)

$0.0093 → $0.0036 (ladder) → **$0.00307 (cross-family)** — 3.0× measured,
**6.1× with the batch API**. Remaining path to 10×: residue pages still
transcribe full-page instead of their region crops (~$0.15 of remaining
spend), and blocking-rate precision (#5, gold-gated).

## Debts

Ledger rows 1 (agreement precision, 4 gold pages) and 2 (ladder recall
trade) in `docs/evaluation-debts.md` — this trial adds no quotable claim
outside its stated sample sizes.

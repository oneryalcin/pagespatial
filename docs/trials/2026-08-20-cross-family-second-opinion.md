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

## Measured (`exp-second-opinion-2026-08-20`, 162 pages, 0 failures)

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

## Economics scoreboard (issue #17, from the $0.0093 start)

$0.0093 → $0.0036 (ladder) → **$0.00307 (cross-family)** — 3.0× measured,
**6.1× with the batch API**. Remaining path to 10×: residue pages still
transcribe full-page instead of their region crops (~$0.15 of remaining
spend), and blocking-rate precision (#5, gold-gated).

## Debts

Ledger rows 1 (agreement precision, 4 gold pages) and 2 (ladder recall
trade) in `docs/evaluation-debts.md` — this trial adds no quotable claim
outside its stated sample sizes.

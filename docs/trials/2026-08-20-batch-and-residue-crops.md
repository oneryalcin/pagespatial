# Batch API + residue crops: the 10× target falls

**Date:** 2026-08-20 · **Branch:** `enrichment-batch-crops` · **Issue:** #20 (closes the #17 cost arc)

## What shipped

1. **Residue crops.** Pages whose only transcription-worthy reason is
   unread-ink residue no longer send the whole page to Flash: the
   unreadable regions' boxes are already on the record, so only those
   crops (plus an 8pt margin, rendered via `pdftoppm -x/-y/-W/-H`) are
   transcribed, in one call per page. Crop proposals are text-only (crop-
   relative box hints are ambiguous across multiple images; hints are
   UX-only metadata). Prompt revision `transcribe-residue-crops-v1` in
   provenance. Starved pages still get full-page transcription — their
   missing content can be anywhere.
2. **Gemini Batch API** (`--batch`): every request submits as one batch
   job at 50% of interactive pricing. Enrichment is asynchronous by design
   (principles §4), so batch latency costs nothing in UX. Request builders
   and response parsers are shared between the sync and batch paths (one
   source of truth — modes drifting apart would make their outputs
   incomparable). `--batch-resume <operation>` rebuilds requests locally
   and joins an already-submitted batch's results — a crashed client
   collects paid-for work without resubmitting (exercised in anger on this
   very run: the first attempt crashed on the API's nested-at-scale
   response shape, and every result was recovered for $0).

## Measured (dev-v12, 91 blocking pages, one batch, 0 failures)

| | value |
|---|---|
| requests | 103 (81 adjudications, 4 full transcriptions, 14 crop sets, some pages both kinds) |
| total spend (batch pricing) | **$0.134** |
| per blocking page | $0.0015 |
| **per corpus page (162)** | **$0.000825** |
| batch wall-clock | 16 s to results after submission |
| verdicts | 470 — 97 native / 345 ocr / 28 both-wrong / 0 unsure / 0 unanswered |
| gold∩blocking union recall (19 pages, 417 tokens) | 414 → 415 with enrichment |

## The #17 scoreboard, closed

| step | $/corpus page | factor |
|---|---|---|
| full-page ultra_high enrichment (start) | $0.0093 | 1× |
| escalation ladder (adjudicate conflicts, HIGH transcription) | $0.0036 | 2.6× |
| cross-family second opinion (starved 27→4) | $0.00307 | 3.0× |
| **+ residue crops + batch API** | **$0.000825** | **11.3×** |

The owner's 10× production constraint is met on the deliberately hard dev
corpus (65%→56% blocking). On typical born-digital mixes (5–20% blocking)
the same ladder lands at ~$0.0001–0.0003/corpus page. Remaining headroom
(no longer needed for the target, still real): blocking-rate precision
(#5, gold-gated) and the accepted −0.9% recall trade's middle option.

## Caveats (evaluation-debts ledger applies)

Gold∩blocking recall is measured against 19 pages/417 tokens under the
containment caveats of ledger rows 1b/2; denominators differ across runs
as the blocking set changes, so compare mechanisms, not raw counts,
across trials. Batch pricing multiplier (0.5×) is Google's published
rate applied to measured tokens, not an invoiced number.

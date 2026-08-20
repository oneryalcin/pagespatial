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

Final numbers from the THIRD measurement run — the first two were produced
by broken control flow (see the correction below); this one ran under the
committed regression test's verified invariant (zero interactive calls).

| | value |
|---|---|
| requests | 103 (81 adjudications, 4 full transcriptions, **18** crop sets; some pages carry two kinds) |
| total spend (batch pricing, complete ledger) | **$0.1323** |
| per blocking page | $0.0015 |
| **per corpus page (162)** | **$0.000817** |
| batch wall-clock | ~4 min to results after submission |
| verdicts | 470 — 0 unsure / 0 unanswered |
| gold∩blocking recall (19 pages, 417 tokens, committed scorer) | 381 → 382 with enrichment |

Recall is measured by `scripts/evaluation/score-enrichment-recall.mjs`
(committed; consume-once tail-compatible matching via the library's own
`src/corroborate.ts`). Its absolutes are STRICTER than the blob-containment
figures quoted in earlier trials (414→415 by that method) — compare
mechanisms, never raw counts, across scorers. Crops were produced with the
rotation-correct math; this recall is re-measured, not carried over from
the rotation-damaged first artifacts.

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

## Double correction (visible-retraction rule — including of the first correction)

**First correction (Codex review):** the batch branch sat after the
synchronous rungs, so batch mode double-transmitted pages and left
interactive spend off the ledger. Also fixed there: rotation-correct crop
math (`renderedPixelsPerPoint` — the old width/pointWidth mis-scaled 90°
pages by ~30%, visibly clipping Blackstone p12–15 crops), the durable
recovery manifest persisted at submission (`--batch-resume auto`), resume
key-set verification, partial-failure spend retention.

**Second correction (Opus review): the first correction was itself
wrong.** The "fix" widened the brace instead of moving the block — sync
rungs ended up INSIDE the batch branch (still double-billing) and the
non-batch path died on undeclared variables after paying for its calls.
The claimed "static order check" did not exist in the repo. The real fix
is a wholesale rewrite of the worker body plus
`test/enrichment-runner.test.mjs`, which RUNS the runner over a fixture
with a stubbed fetch and asserts zero interactive calls under `--batch` —
mutation-verified by the reviewer (swapping the broken runner back in
fails both tests). Every number above comes from the third run under that
enforced invariant. Also from that review: fail-closed positional joins
(no metadata + count match only; duplicates rejected), crops response
schema forbids `box_2d` with the strip inside the adapter, `transport:
'batch'` in per-record provenance (batch `latencyMs` is shared
wall-clock), per-source pricing, `--batch-resume` fails closed without a
value, terminal poll auth failures, and the committed recall scorer
replacing throwaway measurement code.

## Caveats (evaluation-debts ledger applies)

Gold∩blocking recall is measured against 19 pages/417 tokens under the
containment caveats of ledger rows 1b/2; denominators differ across runs
as the blocking set changes, so compare mechanisms, not raw counts,
across trials. Batch pricing multiplier (0.5×) is Google's published
rate applied to measured tokens, not an invoiced number.

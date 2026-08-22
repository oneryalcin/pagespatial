# The p144 differential: there was never a miss

**Date:** 2026-08-22 · **Issue:** #29 · **Scope:** the two `16` tokens on
`osf:file:64a59e4ea2a2f4140943711a:v1` page 144 — batch 7's only
substantive silent-miss page, and the sole confirmed instance of the
"clean page carrying ink neither engine read" failure class.

## Question as posed

Does the miss follow the rendered picture (rasterizer mechanism) or the
engine/host (runtime mechanism)? Designed as a one-variable-at-a-time
cross-feed (node reader × browser render, browser reader × pdftoppm
render).

## Verdict: neither. The miss does not exist. It is a scorer artifact.

The differential never reached its arms, because the baseline
reproduction dissolved the premise:

1. **Every witness reads the ink.** The dev-v12 record itself contains
   the full line — `nativeObservations` and `ocrObservations` both hold
   `"trials + 16 filler"` twice (OCR confidence 0.98 / 0.97). The server
   witness reproduces the identical segmentation on the pdftoppm raster
   at the equivalence run's dpi (115.2) **and** at 150 dpi. Four
   witness-configurations, zero misses of the ink.
2. **The scorer cannot match what they read.** The tokenizer glues the
   arithmetic `+` across a space onto the number:
   `criticalTokens("trials + 16 filler")` → `["+16|filler"]`. Gold holds
   bare `16`. Sign is never forgiven (correctly — `-150,672` ≠
   `150,672`), so `+16` rejects `16` under strict AND tolerant matching
   — reproduced through the exact scorer path
   (`lib/recall-match.mjs consumeMatch`, both passes false). The
   evaluator therefore counted both tokens "missed by both" on a page
   where both witnesses read them verbatim.
3. **PR #55's incidental ("the server witness reads both 16s") is
   refuted** — by its own committed data
   (`evaluation/witness-equivalence-v2.json`, p144 `goldRecall:
   {browser: 0, node: 0}`) and by direct reproduction at both its
   claimed dpi (150) and the equivalence dpi. The raw OCR text does
   contain `16` — visible text was equated with scorer corroboration,
   which is precisely the artifact in play. The incidental paragraph in
   `2026-08-22-server-native-ocr-witness.md` is corrected in place, and
   the render-sensitivity hypothesis relayed to #29 dies with it.

## What this changes

- **Row 9 / batch 7**: the residual-stratum substantive-miss count is
  not 1/15; the only miss page was a measurement artifact. The gold
  verdicts themselves are correct (the ink shows `16`); the evaluator's
  union-recall counting mislabeled the page. The batch-7 aggregate and
  ledger row 9 need a dated correction — the false-confidence
  *refutation* now rests entirely on the batch-5-era case series, which
  predates this artifact's discovery and should be re-checked for the
  same class before it is quoted again.
- **A third sign/symbol scoring artifact class.** After the
  currency-symbol bug (batch-scoring, PR #35) and the boundary-matcher
  over-strictness (PR #43 v4), this is the third instance of
  punctuation-adjacent tokenization silently corrupting a scored
  number: space-separated arithmetic `+` glued as a sign. Any gold
  text with an `… + N …` construction is exposed. Whether the fix
  belongs in the tokenizer (era-sensitive — changes conflict counts)
  or in the recall matcher (scoring-side, like the currency rule) is a
  design decision deliberately NOT made here.

## Method note

Arms A/B (cross-feeding renders between engines) were rendered moot by
the baseline: there is no witness-level differential to explain. Runs
performed: record inspection (browser witness, dev-v12), server witness
on pdftoppm at 115.2 dpi and 150 dpi (assets `ocr-assets-small`,
byte-identical models, 4 WASM threads), tokenizer and scorer-path
reproduction with the library's own `criticalTokens` /
`buildCorroborationPool` / `consumeMatch`. Counts and single tokens
only; no page text beyond the already-public line fragment.

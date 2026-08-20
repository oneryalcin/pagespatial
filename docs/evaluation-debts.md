# Evaluation debts

Claims this project currently makes on **thin gold** — each shipped
deliberately, each owing a re-measurement as the human-verified gold set
grows (issue #1, the owner's 15-minute batches). This ledger exists so
that when a gold batch lands, re-scoring is a checklist, not an
archaeology dig. Add a row when a new gold-gated claim ships; strike a row
only with the re-measured number and a link to the run.

**Standing rule (principles §8):** none of these claims may be quoted
without their sample-size caveat until re-measured.

| # | Claim | Current evidence | What gold to collect | How to re-score |
|---|---|---|---|---|
| 1 | Cross-family TOKEN-path agreement precision ≈ 98.6%; agree-on-wrong ≈ 1.4% | 72 agreed tokens on **4** gold∩starved pages; 1 shared-failure misread (`118835` for `118335`, degraded glyph). **Gold collected, re-score not yet run:** batch3-v1 added 6 starved scan pages with human gold (416 human-tier tokens across the batch; union recall 86.1%, 58 tokens missed by both engines) — the agreement precision recipe below still needs a script | Verify tokens on 10+ coverage-starved scan pages (legistar + pa-sers docs are the population) | For each gold∩starved page: tokens where PP-OCR ∧ Tesseract agree, checked against verified tokens; count agree-on-wrong. Rules: tail-compatible consume-once (`src/corroborate.ts`) |
| 1b | Containment-path engagement precision (prose corroboration) — **entirely unmeasured**, and it is load-bearing: 578 of 967 engagements in `exp-second-opinion` | None (path discovered load-bearing by PR #19 review). **Structurally uncollectable by the current instrument:** the pre-labeler proposes only digit-bearing tokens and `CRITICAL_TOKEN` (`src/text.ts`) requires a digit, so no number of gold batches will produce a single verified prose line. Retiring this row needs a different collection mode, not more batches | Verify prose lines on starved scan pages | Of containment-engaged observations, fraction whose text matches the printed ink; occurrence-consuming, ≥2-char, low-confidence-floored readings only |
| 2 | Escalation ladder trade: 2.6× cost for −0.9% blocking-page enrichment recall | 429 human-tier tokens on 22 blocking pages (dev-v11) | More blocking-page token verification, esp. conflict-only chart pages | Reviewer method: consume-once union recall base vs ladder vs full-page (scratchpad recall2.mjs shape); decide the #17 middle-option threshold from the measured loss profile |
| 3 | HIGH-resolution transcription matches ultra_high (409/440 vs 402/440) | Same 20 gold blocking pages; known single digit-misread introduced (`7st` for `1st`) | Same as #2 | Per-page recall diff at both resolutions; count introduced misreads, not just net recall |
| 4 | Flash page-batched adjudication: 45/46, zero wrong-side | **46** human-adjudicated conflicts (14 pages). **batch3-v1 adds 184 adjudications (15 pages, run `exp-second-opinion-d-2026-08-20`): 184/184 confirmed, zero wrong-side** — composition 105 ocr-right, 58 native-right, 21 both-wrong. Caveat: the reviewer confirmed every proposal, and the batch-3 spot-check sampled tokens only, so the adjudications carry no independent second read | Adjudicate more conflicts during gold review (dev-v11 has 470) | Accuracy + wrong-side count vs human verdicts; wrong-side is the disqualifying metric |
| 5 | Unread-ink residue survivors (18 pages) are genuinely missing text | Visual inspection of samples only | Label whether each surviving residue region holds real unread text | Residue precision: regions with verified missing text / regions flagged |
| 6 | Pictorial classification threshold (midtone ≥ 0.30) does not swallow dense print | Corpus-sample photographs vs synthetic counterexamples (issue #14) | Label pages carrying pictorial regions: photo or mislabelled content? | Misclassification rate; decides threshold work vs advisory reason vs leave-as-is |
| 7 | Silver-tier auto-accepts (native-corroborated gold) are sound | Never independently spot-checked (issue #8) | Human-verify a random silver sample | Silver error rate; if >0, silver stops being usable as denominator anywhere |
| 8 | Blocking escalation precision at 65% rate on the dev corpus | Reason-level composition known; token-level precision not measured. **batch3-v1 measures conflict-blocking precision at 9/12 pages = 75%** (12 conflict-blocking pages, 9 carrying a human-confirmed error; 2 advisory-only, 1 clean with zero missed-by-both, i.e. no false confidence on the clean page) | Conflict triage labels (#5): real disagreement vs benign segmentation | Escalation precision/recall per reason type; feeds the routing economics directly |

## Batch provenance

- `batch3-v1` (15 pages, run `exp-second-opinion-d-2026-08-20`, aggregate
  `evaluation/gold/batch3-v1.metrics.json`): 416 human-tier gold tokens,
  401 silver, 184 conflict adjudications. One annotator, no second
  annotator yet. The pass returned **zero disagreements** across 400
  scoring rows, so it was audited: a seeded 30-row re-read
  (`build-gold-spotcheck.mjs --seed 1`) returned 29 agree, 0 disagree, 1
  skipped. That rules out gross rubber-stamping — contamination of 10% or
  more would have surfaced ~95% of the time — but a 30-row sample cannot
  distinguish a 0% error rate from ~5%, and does not by itself confirm the
  98.5% pre-labeler precision figure. Quote batch-3 numbers with that
  bound, not as a clean bill of health.
- Batch-3 gold covers 820 proposed tokens on pages where OCR alone reads
  2,215 critical tokens, and no missed tokens were added by hand. Recall
  measured on this gold is recall against **the pre-labeler's proposal
  set**, not against the page's ink. Do not restate it as page coverage.

## Re-scoring hygiene

- Committed summaries: `evaluation/baselines/*.summary.json` including
  `exp-second-opinion-d-2026-08-20` (current era). The dev-v11 summary
  cannot be generated by current code — its records are schema 0.5.0 and
  the generator fail-closes on era mismatch, by design; its numbers live
  in the trial docs and the local run tree.
  Full page records and `enrichment/` dirs live in the local
  `.evaluation/` tree (gitignored — private corpus text); re-scoring
  needs a machine with the materialized corpus. `enrichment-fullpage-v1/`
  is the 0.1.0-era baseline and fails current validation by design —
  score via reproduction scripts, do not load.
- Matching rules are library code, not script-local logic:
  `src/corroborate.ts` (pools), `src/text.ts` (tokens),
  `crossEngineEngagedIds` (engagement). Re-scoring scripts must import
  them, never re-implement.
- A claim's row links forward only: when re-measured, update the row with
  the new number and run id; never overwrite the original claim silently
  (visible-retraction rule).

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
| 1 | Cross-family TOKEN-path agreement precision ≈ 98.6%; agree-on-wrong ≈ 1.4% | 72 agreed tokens on **4** gold∩starved pages; 1 shared-failure misread (`118835` for `118335`, degraded glyph). **Re-measured 2026-08-21** (`rescore-cross-family.mjs`, run `exp-second-opinion-d-2026-08-20`, **18 gold∩starved pages after batch 4, 320 agreed tokens** vs the original 72): TOKEN-path precision is **between 94.4% and 100%** — 302 agreed tokens confirmed against verified gold, 18 with no verdict either way because gold does not cover them. Batch 4 contributed 68 agreed tokens, every one confirmed, which is why the lower bound rose without the unadjudicated count moving. The original 98.6% sits inside that interval and is not refuted, but 92.9% is the only figure currently guaranteed. Closing the interval needs verdicts on 18 specific tokens, concentrated on 3 pages (`2159` p12, `llr-vii:manager-presentation` p7 and p8) — not a general labelling push | Verify tokens on 10+ coverage-starved scan pages (legistar + pa-sers docs are the population) | For each gold∩starved page: tokens where PP-OCR ∧ Tesseract agree, checked against verified tokens; count agree-on-wrong. Rules: tail-compatible consume-once (`src/corroborate.ts`) |
| 1b | Containment-path engagement precision (prose corroboration) — **entirely unmeasured**, and it is load-bearing: 578 of 967 engagements in `exp-second-opinion` | None (path discovered load-bearing by PR #19 review). **Now sized:** the same 18 gold∩starved pages carry **440 containment-path engagements** against 287 token-path ones, so on starved scans the unmeasured path is the *majority* of corroboration, not a minority. **Structurally uncollectable by the current instrument:** the pre-labeler proposes only digit-bearing tokens and `CRITICAL_TOKEN` (`src/text.ts`) requires a digit, so no number of gold batches will produce a single verified prose line. Retiring this row needs a different collection mode, not more batches | Verify prose lines on starved scan pages | Of containment-engaged observations, fraction whose text matches the printed ink; occurrence-consuming, ≥2-char, low-confidence-floored readings only |
| 2 | Escalation ladder trade: 2.6× cost for −0.9% blocking-page enrichment recall | 429 human-tier tokens on 22 blocking pages (dev-v11) | More blocking-page token verification, esp. conflict-only chart pages | **Committed scorer**: `scripts/evaluation/score-enrichment-recall.mjs` (consume-once, library rules); decide the #17 middle-option threshold from the measured loss profile |
| 3 | HIGH-resolution transcription matches ultra_high (409/440 vs 402/440) | Same 20 gold blocking pages; known single digit-misread introduced (`7st` for `1st`) | Same as #2 | Per-page recall diff at both resolutions; count introduced misreads, not just net recall |
| 4 | Flash page-batched adjudication: 45/46, zero wrong-side | **46** human-adjudicated conflicts (14 pages). **batch3-v1 adds 184 adjudications (15 pages, run `exp-second-opinion-d-2026-08-20`): 184/184 confirmed, zero wrong-side** — composition 105 ocr-right, 58 native-right, 21 both-wrong. **batch4-v1 adds 88 more (272 total): 88/88 confirmed, zero wrong-side** — composition 85 ocr-right, 2 native-right, 1 both-wrong. Caveat: the reviewer confirmed every proposal in both batches, and the batch-3 spot-check sampled tokens only, so adjudications still carry no independent second read — 272 consecutive confirmations is the strongest reason to get one, not to stop asking | Adjudicate more conflicts during gold review (dev-v11 has 470) | Accuracy + wrong-side count vs human verdicts; wrong-side is the disqualifying metric |
| 5 | Unread-ink residue survivors (18 pages) are genuinely missing text | Visual inspection of samples only | Label whether each surviving residue region holds real unread text | Residue precision: regions with verified missing text / regions flagged |
| 6 | Pictorial classification threshold (midtone ≥ 0.30) does not swallow dense print | Corpus-sample photographs vs synthetic counterexamples (issue #14) | Label pages carrying pictorial regions: photo or mislabelled content? | Misclassification rate; decides threshold work vs advisory reason vs leave-as-is |
| 7 | Silver-tier auto-accepts (native-corroborated gold) are sound | Never independently spot-checked (issue #8). **Geometry precondition measured 2026-08-21** across 60 gold pages: of 2,504 proposal tokens an engine also read, **99.1% have a box overlapping the matching engine box** (median centre offset 1 unit in 1000); the 22 that match on text but not position lose silver and fall to human review — the safe direction. Drift has a tail (323 tokens >25 units off) concentrated on chart and diagram pages, the same pages where chart-relation recall is 0. This measures the precondition silver relies on, **not** silver's error rate, which is still unmeasured | Human-verify a random silver sample | Silver error rate; if >0, silver stops being usable as denominator anywhere |
| 8 | Blocking escalation precision at 65% rate on the dev corpus | Reason-level composition known; token-level precision not measured. **batch3-v1 measures conflict-blocking precision at 9/12 pages = 75%** (12 conflict-blocking pages, 9 carrying a human-confirmed error; 2 advisory-only, 1 clean with zero missed-by-both). **batch4-v1: 7/8 = 87.5%** (8 conflict-blocking, 7 with a confirmed error). Combined 16/20 = 80% across both batches — but see row 9: precision is the cheap half of this question, and the expensive half now has a number | Conflict triage labels (#5): real disagreement vs benign segmentation | Escalation precision/recall per reason type; feeds the routing economics directly |
| 9 | **A page reporting no escalation has been fully read** — the false-confidence assumption every downstream consumer makes | **Refuted on first measurement.** Across batches 3-4, 7 pages came back clean; **2 of them (osf `607883db` p10, pa-sers `llr-vii:manager-presentation` p1) carry human-verified tokens neither engine read** — `1,000`, `500`, `1,800 analysts`, `17`, `2024`. Both are scans with zero native text. Two distinct mechanisms, neither a tuning accident: (a) osf p10 — starvation *would* have fired on 27 confident observations, but cross-family engagement cleared it, and the region holding the missing figures was classed `pictorial`, which is recorded and never escalated; (b) pa-sers p1 — 7 confident observations against a starvation floor of 8, one short of the alarm, on a page where almost nothing was read | More clean pages with verified gold — clean pages are currently the *least* labelled class because selection targets escalated ones | Rate of clean pages carrying missed-by-both gold. This is escalation **recall**, the metric the ladder's economics assume and none of rows 2/3/8 measure. A false blocking escalation costs a fraction of a cent; a silent miss puts a wrong number in the index |

## Batch provenance

- `batch3-v1` (15 pages, run `exp-second-opinion-d-2026-08-20`, aggregate
  `evaluation/gold/batch3-v1.metrics.json`): 416 human-tier gold tokens,
  401 silver, 184 conflict adjudications. One annotator, no second
  annotator yet. The pass returned **zero disagreements** across 400
  scoring rows, so it was audited: a seeded 30-row re-read
  (`build-gold-spotcheck.mjs --seed 1`) returned **30 agree, 0 disagree**.
  The exported artifact `gold-spotcheck.json` records 29 agree and one
  unreviewed row (`legistar:seattle:2159:v0:attachment:3326` p24 token 75);
  the annotator confirmed that row as agreeing after exporting, so the
  count here is 30 and the file is one click behind. That rules out gross
  rubber-stamping — contamination of 10% or more would have surfaced ~96%
  of the time — but a 30-row sample cannot
  distinguish a 0% error rate from ~5%, and does not by itself confirm the
  98.5% pre-labeler precision figure. Quote batch-3 numbers with that
  bound, not as a clean bill of health.
- `batch4-v1` (15 pages, same run, aggregate
  `evaluation/gold/batch4-v1.metrics.json`): 242 human-tier gold tokens,
  582 silver, 88 adjudications, 1 proposal dropped as non-scoring. Human
  union recall **67.8%** with **78 of 242 tokens missed by both engines** —
  materially worse than batch 3's 86.1%, and the gap is where row 9 came
  from. Chart relations again score 0: 12 gold tuples, 0 detections. Same
  single annotator; this batch has not been spot-checked.
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

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
| 4 | Flash page-batched adjudication: 45/46, zero wrong-side — **"272/272 correct" retracted 2026-08-21; "zero wrong-side" stands** | **46** human-adjudicated conflicts (14 pages). **batch3-v1 adds 184 adjudications (15 pages, run `exp-second-opinion-d-2026-08-20`): 184/184 confirmed, zero wrong-side** — composition 105 ocr-right, 58 native-right, 21 both-wrong. **batch4-v1 adds 88 more (272 total): 88/88 confirmed, zero wrong-side** — composition 85 ocr-right, 2 native-right, 1 both-wrong. Caveat: the reviewer confirmed every proposal in both batches, and the batch-3 spot-check sampled tokens only, so adjudications still carry no independent second read — 272 consecutive confirmations is the strongest reason to get one, not to stop asking. **Composition measured 2026-08-21, and one count was hiding two jobs: 172 of 272 (63%) are conflicts where both readings carry the identical digit sequence** — a currency symbol landing on one side or the other (`1,709,370` vs `1,709,370 $`), where either verdict preserves the number. Only the remaining **100 (37%) differ in digits**, and those are mostly a dropped leading figure (`months of transportation…` vs `5 months of transportation…`). Blended accuracy over both classes flatters the adjudicator in proportion to how many easy conflicts the corpus happens to hold; issue #31's audit therefore samples the two classes half and half and `score-adjudication-audit.mjs` reports them separately. Feeds the #5 taxonomy directly. **Audited blind 2026-08-21 (issue #31, `score-adjudication-audit.mjs`, seed 7, 30 of 272 stratified): 25 of 29 agree, 86.2%.** Per class: **digits differ 11/15 = 73.3%**, symbol-only 14/14. All four disagreements sit in the consequential class, and they have three different causes, only one of which is the adjudicator's: (a) one row was mislabelled on my instruction to prefer `different-regions` where the machine correctly picked the unmerged reading; (b) two are the margin-line-number gap, now closed by the page-furniture test added to the pre-labeler prompt — the machine's behaviour was already right, the instructions were silent; (c) one real catch — on `asseco` p78 the ink has a pipe `\|`, native reads capital `I`, OCR reads `1`, and the adjudicator accepted native, which under a verbatim-glyph standard is leniency. Net substantive disagreement: **1 of 29**. In every one of the four the machine still declined the reading carrying the wrong digits, which is why zero-wrong-side survives and the accuracy claim does not — they were never the same claim | Adjudicate more conflicts during gold review (dev-v11 has 470) | Accuracy + wrong-side count vs human verdicts; wrong-side is the disqualifying metric |
| 5 | Unread-ink residue survivors (18 pages) are genuinely missing text | Visual inspection of samples only | Label whether each surviving residue region holds real unread text | Residue precision: regions with verified missing text / regions flagged |
| 6 | Pictorial classification threshold (midtone ≥ 0.30) does not swallow dense print | Corpus-sample photographs vs synthetic counterexamples (issue #14) | Label pages carrying pictorial regions: photo or mislabelled content? | Misclassification rate; decides threshold work vs advisory reason vs leave-as-is |
| 7 | Silver-tier auto-accepts (native-corroborated gold) are sound | Never independently spot-checked (issue #8). **Geometry precondition measured 2026-08-21** across 60 gold pages: of 2,504 proposal tokens an engine also read, **99.1% have a box overlapping the matching engine box** (median centre offset 1 unit in 1000); the 22 that match on text but not position lose silver and fall to human review — the safe direction. Drift has a tail (323 tokens >25 units off) concentrated on chart and diagram pages, the same pages where chart-relation recall is 0. This measures the precondition silver relies on, **not** silver's error rate. **Silver error rate measured 2026-08-21 (batch 6, seeded 30 of 1,640, human re-read with crops): 0 disagreements — error ≤9.5% at 95% (Clopper-Pearson; quote the bound, never the 0). A second batch of ~60 would tighten to ≈4.9%.** Corroborating signal from the same sitting: 134 previously-auto rows got fresh human reads in the double-label pass with zero disputes (`evaluation/gold/batch6-silver-spotcheck-v1.metrics.json`, `batch6-agreement-v1.metrics.json`) | Larger sample only if a consumer needs a tighter bound | Silver usable as a denominator with the ≤9.5% bound stated |
| 8 | Blocking escalation precision at 65% rate on the dev corpus | Reason-level composition known; token-level precision not measured. **batch3-v1 measures conflict-blocking precision at 9/12 pages = 75%** (12 conflict-blocking pages, 9 carrying a human-confirmed error; 2 advisory-only, 1 clean with zero missed-by-both). **batch4-v1: 7/8 = 87.5%** (8 conflict-blocking, 7 with a confirmed error). Combined 16/20 = 80% across both batches — but see row 9: precision is the cheap half of this question, and the expensive half now has a number | Conflict triage labels (#5): real disagreement vs benign segmentation | Escalation precision/recall per reason type; feeds the routing economics directly |
| 9 | **A page reporting no escalation has been fully read** — the false-confidence assumption every downstream consumer makes | **Refuted as an assumption — but see the 2026-08-22 case-series re-check below: the refutation now rests on ONE substantive page, not three.** The claim "surviving the currency-symbol fix so they are not tokenization artifacts" was wrong: the currency fix screened for one artifact class and two others (sign-glue, unit/date-glue) were live. Post-re-check: pa-sers p1 (`17`/`2024`) and p4 (`-$100 m`) DISSOLVE as glue artifacts (the ink was read); osf `607883db` p10 (`1,000`/`500`/`1,800 analysts`) SURVIVES, reclassified — PP-OCR misread `1,8oo` and never emitted the other two, while the cross-family second opinion read all three correctly but is inadmissible by design. The admissible record lacks the figures and no alarm fired, so the refutation stands, narrower. Bare-digit pages unchanged (furniture-suspect). **Case series, not a rate; no denominator trustworthy yet** | Two distinct mechanisms, neither a tuning accident: (a) osf p10 — starvation *would* have fired on 27 confident observations, but cross-family engagement cleared it, and the region holding the missing figures was classed `pictorial`, which is recorded and never escalated; (b) pa-sers p1 — 7 confident observations against a starvation floor of 8, one short of the alarm, on a page where almost nothing was read | **First admissible measurement, batch7-clean-v1 (2026-08-22)**: 15 pages drawn extractor-blind (seeded) from the residual unlabeled clean pool, each with an explicit page-level verdict — **14 verified no-miss, 1 page (osf p144) with 2 substantive tokens neither engine read** (`16` filler-trial counts inside arithmetic the engines otherwise read completely: 8, 4, 32, 104 all corroborated, both 16s dropped). **CORRECTED 2026-08-22 (see the case-series re-check section): the p144 "miss" was a sign-glue scorer artifact (PR #58) — batch 7's substantive-miss count is 0/15; 95% CP upper bound 18.1% (1−0.05^(1/15)) — quote the bound.** The originally-published 1/15 / 27.9% stands retracted. One no-miss claim on that page was superseded by the computed miss (the fail-closed path working); two bare page-number entries were resolved as furniture during the sitting. This is ONE stratum: the union with prior-labeled clean pages still needs the two preconditions (no-miss re-review of prior strata; same-run-root re-evaluation) before a pooled rate exists | Verify the second miss mechanism on osf p144 (why did both engines drop exactly the 16s); no-miss re-review of the 27 prior-labeled clean pages to complete the union | Escalation **recall**: the residual-stratum bound says up to ~1 in 4 quiet pages could carry silent misses at 95% confidence — the bound is wide because n=15; a second clean batch halves it. A false blocking escalation costs a fraction of a cent; a silent miss puts a wrong number in the index |

## Annotation noise floor (batch 6 double-label, 2026-08-21)

Two annotators independently worked the same 20 stratified pages
(pilot + batches 2–5; presentation-drift check 0; second annotator never
saw the first's verdicts). **Raw agreement 99.5% (392/394 comparable
rows); digit-class and symbol/span disagreements: 0; both disagreements
are acceptance judgment on one pilot page.** Every accuracy figure in
this ledger therefore carries a ~0.5% annotator-noise floor — 0% on the
digits class — and claims above 99.5% agreement-adjusted accuracy are
not distinguishable from annotator noise. Same acceptance-not-digits
disagreement pattern as the row-4 audit (#31). Aggregate:
`evaluation/gold/batch6-agreement-v1.metrics.json`.

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
  union recall **95.9%** with **10 of 242 tokens missed by both engines**.
  Both figures were reported as 67.8% / 78 until the currency-symbol scoring
  bug was fixed on 2026-08-21 (see hygiene note); batch 3's companion figure
  moved 86.1% → 98.8% in the same correction. Chart relations again score 0: 12 gold tuples, 0 detections. Same
  single annotator. Audited like batch 3 (`--seed 1`): **30 agree, 0
  disagree, 0 skipped**, and this was the harder sample — 13 of its 30 rows
  came from the dense `blackstone` p15/p17 tables, against batch 3's
  ordinance line numbers and plain dates.
- **Audit position across both batches: 60 re-read rows, 0 disagreements.**
  That bounds the pre-labeler's error rate on verified rows at **≤4.9% with
  95% confidence**, tightened from ≤9.8% after batch 3 alone. It still does
  not confirm the 98.5% precision figure — under that rate the expected
  number of errors in 60 rows is 0.9, so observing none is unremarkable.
  Two annotator-independent gaps remain: both batches are one annotator, and
  272 conflict adjudications have never been sampled at all.
- Batch-3 gold covers 820 proposed tokens on pages where OCR alone reads
  2,215 critical tokens, and no missed tokens were added by hand. Recall
  measured on this gold is recall against **the pre-labeler's proposal
  set**, not against the page's ink. Do not restate it as page coverage.

- `batch5-clean-v1` (15 pages, same run, aggregate
  `evaluation/gold/batch5-clean-v1.metrics.json`): the first batch selected
  *for* clean pages, to give row 9 a denominator. 70 human-tier gold tokens,
  union recall 95.7%, 3 tokens missed by both across 3 pages.

  **Its selection is circular and it cannot support a rate.** Eligibility and
  ranking both use `criticalCount`, computed from native and OCR observations
  — the output of the very extractors being measured. A clean page whose only
  figures were missed by *both* engines has `criticalCount === 0` and is
  therefore excluded by construction: the profile skips exactly the total
  failures it exists to find, and ranking by the same field favours pages the
  engines already handled well.

  The denominator is broken independently of that. "Pages carrying human-tier
  gold" is not "clean pages": the human tier holds only non-corroborated or
  manually-added proposals, so a clean page whose figures were all
  silver-corroborated — a clean *success* — never enters it. batch5-clean-v1
  has 15 clean pages, 4 with human-tier tokens and 8 silver-only. Any ratio
  over that base measures the sampler, not the pipeline.

  Fixing it needs two things this instrument does not yet have: sampling drawn
  from all non-escalated pages regardless of extractor output, and an explicit
  page-level "no miss found here" verification so confirmed negatives can be
  counted. Until then batch 5's numbers stand as a case series only. Both
  defects were found by adversarial review of PR #35, after I had already
  written a rate into this ledger and onto issue #29.

## Correction, 2026-08-21: the currency-symbol scoring bug

`criticalTokensCompatible('$684,663', '684,663')` is false, and a native
text layer routinely emits the currency symbol as its own observation. Every
recall figure this evaluator produced before 2026-08-21 therefore counted
correctly-read numbers as missed by both engines: **135 of 145 such tokens
across the whole gold set were false misses.** Recall now strips currency
symbols for the recall test only — percent and sign are untouched, because
they change the value — and runs strict-before-tolerant so an exact match is
never displaced. Both figures are reported; `strict` in every aggregate is
what the old comparison would have said.

Tolerance is asymmetric on purpose. A **detached** symbol is a segmentation
artifact and is forgiven; a **contradictory** one is a reading error and is
not — `$100` matches `100`, but never `€100`, because an engine that reads
the wrong currency has misread the value. Regression tests for the missing,
matching, conflicting, signed, percent and consume-once cases live in
`test/gold-recall-match.test.mjs`; the rule itself is
`scripts/evaluation/lib/recall-match.mjs`. Tightening it changed no current
number — the corpus contains no conflicting-symbol pair today — so the guard
is protective, not corrective.

Restated, for the three batches scored against
`exp-second-opinion-d-2026-08-20`: batch 3 86.1% → **98.8%**, batch 4 67.8%
→ **95.9%**, batch 5 87.1% → **95.7%**. Anything quoting the old numbers,
including PR #30's description, is wrong.

**A correction to this correction.** An earlier revision of this note said
the pilot and batch 2 were "unaffected". They were not: they had been
re-scored against `exp-second-opinion-d-2026-08-20` while their committed
aggregates were produced against `dev-v10-coverage-starvation-2026-08-19`,
so their apparent movement (pilot 0.6372 → 0.9823, batch 2 0.45 → 0.85) was
a **run change wearing the currency fix's clothes**. Both files are restored
to their original run-qualified versions. Recall figures are only comparable
within a run; a `strict` block from a different run is not the historical
comparison it appears to be.

## Correction, 2026-08-22: the row-9 case series re-checked for glue artifacts

The p144 differential (PR #58, `docs/trials/2026-08-22-p144-differential.md`)
found that scored "misses" can be tokenizer artifacts even when every
witness read the ink. Every row-9 instance was therefore re-derived
through the actual scorer path (`criticalTokens` pools +
`consumeMatch`, strict and tolerant, against the batch's own run
records — `exp-second-opinion-d` for batches 3–5, dev-v12 for batch 7),
and each unmatched token classified by whether any observation's raw
text contains the ink. Per instance:

| page | token(s) | verdict |
|---|---|---|
| osf `607883db` p10 | `1,800 analysts` / `1,000` / `500` | **SURVIVES, reclassified.** PP-OCR *misread* `1,8oo` (letter o — read, wrong glyph) and never emitted the other two; the Tesseract second opinion read all three correctly (`1,800` @0.96, `1,000+` @0.78, `500` @0.95) but its readings are inadmissible by design. The admissible pools lack the figures and no alarm fired — the refutation stands on this page, with the sharper irony that the cross-family engagement which cleared the starvation alarm HELD the very figures the record cannot serve |
| pa-sers `manager-presentation` p1 | `17` / `2024` | **DISSOLVES — date-glue artifact.** OCR read the ink as `September17,2024` (spacing lost); the tokenizer emits the single pseudo-number `17,2024`, which matches neither `17` nor `2024` |
| pa-sers `manager-presentation` p4 | `-$100 m` | **DISSOLVES — unit-tail glue.** OCR read `$10M-$100Min a large…`; the token's tail becomes `min` (M + glued "in"), incompatible with gold's tail `m` |
| osf p144 (batch 7) | `16` ×2 | **DISSOLVES — sign-glue** (PR #58): `trials + 16 filler` → `+16\|filler`; batch 7 corrected to **0/15 substantive, CP bound 18.1%** |
| osf p143 (batch 5) | `32` (one of two) | **DISSOLVES — same sign-glue** (`+32\|filler`); the page's other `32` matched via prose |
| legistar `3326` p12 | `00100-2 q` | **PARTIAL.** The fund code was read in fragments (`(00100-`, `(00100-P8000)`); the exact compound never assembled in one observation — neither a clean artifact nor a clean silent miss |
| ares p63, pilot legistar p1 | bare `1` each | unchanged — unmatched bare digits, row-4 furniture-suspect |

Also surfaced (never in row 9's list): pa-sers p6's `$76.5 m` /
`$50.3 m` / `$46.0 m` are the same unit-tail glue class (`$76.5Min
January…`) — artifacts, ink read.

Net: **the clean≠fully-read refutation survives on one substantive page**
(osf p10), not three, and the artifact catalogue now has four classes —
currency-symbol (fixed in scoring), sign-glue (`+ N`), date-glue
(`D,YYYY` after spacing loss), unit-tail glue (`M`+word). All four are
tokenizer/matcher-side. **Where the fix belongs (tokenizer — era-sensitive,
changes conflict counts — vs recall matcher, scoring-side like the
currency rule) is an open design decision, deliberately not made in this
correction.** No scorer or tokenizer code was changed.

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
- Before a re-measured number lands in a row, run the **independence
  check** (principles §8): name the denominator's population, and confirm
  that eligibility, ranking, and presentation do not read the system under
  test. Any yes makes the result a case series, and the row says so in the
  same sentence as the number. Row 9 is the worked example of getting this
  wrong — a rate was published, then withdrawn, because the sampler's
  eligibility test read the extractors it was auditing.
- Recall figures are comparable only within one run. A `strict` block
  carried over from a different run is not a historical comparison; it is
  two variables moving at once.

# Batch 6: two re-read protocols in one sitting

**Date:** 2026-08-21 · **Branch:** `gold-batch6-instruments` · **Issues:** #1 (double-label amendment), #8 / ledger row 7 (silver error rate)

Status: **instruments built and batch generated — the human sitting has not
happened yet.** No agreement number and no silver error rate exist; this doc
records the design and will carry the numbers when the sitting is done.

## What this batch measures

Two IOUs, one annotation session:

1. **The annotator-agreement noise floor.** Every accuracy figure in the
   ledger sits on one annotator. The rate at which two careful humans agree
   about the same ink is the ceiling for every one of those figures — until
   it is measured, "94.4%" has an error bar nobody can state. 20 pages,
   seeded and stratified, re-labelled blind by a second annotator.
2. **Silver's own error rate** (row 7). Silver rows were auto-accepted
   because the native text layer corroborated the pre-labeler; no human has
   ever read one. Row 7's 99.1% measured only the geometry precondition.
   30 of 1,640 silver tokens, seeded, put in front of a person for the
   first time.

## Instruments

- `scripts/evaluation/build-gold-doublelabel.mjs` — selects 20 pages
  (seed 6, 4 per batch across pilot + batches 2–5, round-robin across
  derived classes conflict / clean / escalated-other) and regenerates
  review pages through the SAME `build-gold-review.mjs` the first annotator
  used. Groups by run root so silver auto-marking reproduces each batch's
  original presentation (the pilot predates silver and is generated without
  corroboration — detected from its original review.html, which contains no
  auto radio).
- `scripts/evaluation/score-annotator-agreement.mjs` — joins the second
  annotator's exports to the original verdicts; raw percent agreement
  (stated as such — kappa at n≈400 rows/20 pages would claim more precision
  than the sample supports), split digits-differ vs symbol-or-span vs
  acceptance, mirroring the #31 audit's classes. Auto rows are excluded
  from agreement (machine-marked in both sittings) but second-annotator
  overrides of them are reported.
- `scripts/evaluation/build-gold-spotcheck.mjs --tier silver` — extends the
  existing spot-check to the silver population (verdict `auto`), stratified
  proportional to each batch's silver count, magnified crop per token.
- `scripts/evaluation/score-silver-spotcheck.mjs` — error rate from the
  export, per batch and overall, with population and sample size stated;
  unreviewed rows are never counted as agreement.

## The independence check (principles §8), answered per instrument

**Double-label:**
1. *Denominator members?* The 20 selected pages' human-judged token rows
   (~396 by the identity smoke run); membership decided by seeded stratified
   selection over already-labelled batches.
2. *Eligibility reads the system under test?* The system under test here is
   the ANNOTATOR. Selection reads proposals (page class, adjudication
   presence) fixed before either sitting — never any annotator's verdicts.
3. *Ranking reads it?* No — seeded shuffle only.
4. *Presentation reads it?* The generator never opens gold-verdicts.json,
   so annotator 1's answers cannot appear; enforced by a test asserting the
   generated pages carry no verdict content and no pre-checked human radio.
   Corroboration marks are machine state both annotators see identically.
5. *Confirmed negatives recorded?* Yes — "wrong" is an explicit verdict and
   the evaluator rejects unreviewed rows; disagreement is never inferred
   from silence.

**Silver spot-check:**
1. *Denominator members?* All 1,640 verdict-`auto` tokens across the five
   batches; the sample is 30, proportional per batch (largest remainder).
2. *Eligibility reads the system under test?* Membership IS the tier under
   test (that is the population definition, not a conditioning defect); no
   further filter reads pipeline output. Caveat stated: this measures the
   silver tier of the LABELLED batches, whose page selection had its own
   tiers — the rate generalizes to that population, not to the corpus.
3. *Ranking reads it?* No — seeded shuffle within batch, seeded presentation
   order.
4. *Presentation reads it?* The crop is framed on the claimed box, which is
   the question ("does this ink say this text here"), not the answer. The
   page states that engine agreement is not evidence.
5. *Confirmed negatives recorded?* "does NOT match" is an explicit click;
   unreviewed rows are reported and excluded, never counted as agree.

## Generated batch (committed nowhere — lives under `.evaluation/`)

- Double-label: 20 pages, seed 6 → `.evaluation/gold/batch6-doublelabel-v1/`
  (review-1: pilot ×4, no corroboration; review-2: batch2 ×4 vs dev-v8 run;
  review-3: batches 3–5 ×12 vs exp-second-opinion-d). Per-batch classes:
  pilot clean 2 / conflict 1 / other 1; batch2 other 2 / conflict 1 /
  clean 1; batch3 other 2 / conflict 1 / clean 1; batch4 other 2 / clean 1 /
  conflict 1; batch5 clean 4.
- Silver: 30 of 1,640 (batch2 10, batch3 7, batch4 10, batch5 3; pilot has
  no silver) → `.evaluation/gold/batch6-silver-spotcheck-v1.html`, seed 6.

## The human sitting (instructions)

1. **Second annotator** (must not be annotator 1, and must not consult the
   existing verdict files): open the three
   `.evaluation/gold/batch6-doublelabel-v1/review-*.html` pages and work
   them exactly like a normal batch — every unmarked row gets ok / wrong /
   edited, missed tokens go in the textarea, then **Export verdicts** per
   page. Save as `annotator2-group-<n>.json` in the same directory.
2. Score agreement:
   `node scripts/evaluation/score-annotator-agreement.mjs --selection
   .evaluation/gold/batch6-doublelabel-v1/selection.json --gold-root
   .evaluation/gold --second annotator2-group-1.json,annotator2-group-2.json,annotator2-group-3.json`
3. **Silver** (either annotator): open
   `.evaluation/gold/batch6-silver-spotcheck-v1.html`, judge each crop
   against the ink, **Export spot-check**, then
   `node scripts/evaluation/score-silver-spotcheck.mjs --export
   gold-spotcheck.json`.
4. Record both results in `docs/evaluation-debts.md` (rows 1 and 7 — the
   agreement rate is stated as the ceiling on every human-tier figure) and
   update this doc with the numbers. Committed aggregates carry counts only;
   the exports stay under `.evaluation/`.

## Caveats to carry into any quoted number

- Agreement is raw percent, one pair of annotators, 20 pages — a noise
  floor estimate, not a study.
- The silver rate is measured over labelled batches (their sampling tiers
  apply); silver-only clean pages from batch 5 ARE in the population.
- 30 silver tokens bound the error rate usefully only if disagreements are
  few; if several appear, the follow-up is a larger sample, not a rate
  quoted from n=30.

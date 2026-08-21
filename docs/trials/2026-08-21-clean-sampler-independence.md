# Clean-page sampler redesign: the independence check's first worked pass

**Date:** 2026-08-21 · **Branch:** `clean-sampler-29` · **Issue:** #29

The instrument for row 9's denominator, rebuilt to pass the principles §8
independence check — the check this repo adopted after the previous version
of this exact sampler violated it while narrating the violation in a code
comment. No rate is computed here; this ships the instrument only.

## What shipped

1. **Extractor-blind `--profile clean`** in `build-gold-sample.mjs`:
   membership is the `requiresEscalation` flag alone; order is a seeded
   Fisher–Yates permutation (`--seed` required, deterministic reruns). The
   old eligibility (`criticalCount > 0`) and ranking (by the same field) are
   gone. The fill pass reuses the same permutation with relaxed document
   caps — never coverage, which reads the system under test.
2. **Page-level "no miss found" verdict** in the review UI
   (`gold-verdicts-v2`): a reviewer who searched a page for figures neither
   engine read and found none RECORDS that, so verified negatives exist as
   data. Silence exports `null` and is never promoted to a negative.
3. **Verified-negative accounting** in the evaluator
   (`gold-pilot-metrics-v5`): clean pages partition into
   `cleanWithHumanGoldMissedByBoth` / `cleanVerifiedNoMiss` /
   `cleanUnverified` (invariant-checked). A no-miss claim contradicted by
   hand-entered missed tokens fails closed; one contradicted by a
   machine-computed miss is superseded and surfaced
   (`noMissVerdictsSupersededByComputedMiss`), never counted as a negative.
   A future rate's denominator is misses + verified negatives; unverified
   pages may not enter it.

## The five questions, answered in writing

*(Revised after the adversarial review of this PR — the first version of
answers 1, 2 and 4 below described real conditioning as neutral
bookkeeping, which is the noticed-and-named pattern the check exists to
kill.)*

1. **What is the denominator, and how did a member get in?** The clean
   POPULATION is all development pages of the run whose
   `requiresEscalation` flag is false — but this sampler only DRAWS from
   the unlabeled residual of it, and that residual is not neutral: every
   prior batch was selected by extractor output (debt tiers,
   coverage-sorted fill, batch 5's `criticalCount` eligibility), so the
   residual is "clean pages the extractor-conditioned samplers didn't
   want" — it over-represents pages the engines read little on.
   The mitigation is stratum-union, recorded in
   `selection.json.populationPartition`: the residual pages AND every
   previously-labeled clean page with its batch provenance. Prior-labeled
   clean pages already carry gold, so their miss/no-miss outcomes are
   derivable from their own batches' aggregates. **The honest future
   denominator is the union of strata; a rate over the residual alone is
   a case series over a biased pool.** The evaluator embeds this partition
   (and the caveat) in the metrics file where numbers get written. Pages
   with no run record at all — the most total failure mode — are outside
   BOTH populations and now recorded in
   `selection.json.skippedMissingRunRecords`, never just a console line.
2. **Does eligibility read the system under test?** Within the residual
   pool: only the no-escalation flag, which is definitional. Indirectly,
   via prior-batch subtraction: yes — see answer 1; that channel is
   recorded and mitigated by stratum-union, not waved away. Enforced by a
   regression test that permutes figure density, observation counts, AND
   coverage between paired run roots and asserts the selection does not
   move (`test/gold-clean-sampler.test.mjs`); mutation-verified for both
   the population filter (`criticalCount` reintroduction fails it) and the
   fill pass (coverage-sorted fill reintroduction fails it — the original
   test's fixtures varied only figure density and would have let that
   regression through).
3. **Does ranking or ordering read it?** No. One seeded permutation covers
   both the tier pass and the fill pass, so relaxing a cap cannot smuggle
   in an extractor-informed order. The clean dry run also no longer prints
   per-page extractor stats — an operator re-rolling seeds against a
   stats printout is selection conditioned on extractor output with extra
   steps.
4. **Does presentation read it?** Yes, and the verified-negative flow now
   compensates rather than ignores it: the review screen overlays
   machine-proposed boxes, and the pre-labeler shares vision failure modes
   with the OCR engine, so attention anchors on exactly the regions the
   system already read — while a verified negative vouches for the UNBOXED
   ink. The no-miss checkbox therefore stays locked until the reviewer has
   viewed the page with all boxes hidden at least once, and its copy
   directs the search to unboxed regions. (The pre-labeler's own
   presentation biases remain ledger rows 1b and the box-drift note
   on #4.)
5. **Are confirmed negatives recorded rather than inferred from silence?**
   Yes — that is what the verdict exists for. The evaluator counts a
   negative only from an explicit `noMissFound: true`; absent pages are
   `cleanUnverified` and excluded from any future denominator. Missed
   chart VALUES now score through the same pools as missed tokens, so a
   chart figure neither engine read is a computed miss that supersedes a
   no-miss claim instead of vanishing into relation accounting; a no-miss
   claim on an escalated page is counted as an anomaly
   (`noMissVerdictsOnEscalatedPages`), never silently dropped.

**Cost of blindness, accepted:** some sampled pages will carry no figures
at all. Under the old sampler those were "wasted" slots; under this one
they are verified negatives — exactly the data the denominator lacked.

## Verified

- `npm test`: 166 pass (10 new across the PR and its review fixes).
- Mutation checks: reintroducing `criticalCount > 0` into the population
  filter fails the extractor-blind test; reintroducing coverage-sorted
  fill on the clean path fails the fill-pass test. (First mutation attempt
  targeted the tier's `match` predicate, which turned out to be dead code —
  it is now removed so nothing misleading remains.)
- Real-run dry-run against `dev-v12-cross-family-2026-08-20`
  (seed `batch6-clean-v1`, size 15): counts reported in the PR; no page
  content leaves `.evaluation/`.

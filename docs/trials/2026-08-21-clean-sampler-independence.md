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

1. **What is the denominator, and how did a member get in?** Population:
   all unlabeled development pages of the run whose `requiresEscalation`
   flag is false. A member gets in by that flag, prior-batch subtraction
   (gold bookkeeping), and seeded-random order under per-document/family
   diversity caps. Recorded in `selection.json` (`population`, `seed`).
2. **Does eligibility read the system under test?** Only the
   no-escalation flag, which is definitional: escalation recall is a
   property of pages the system called clean. Nothing else — not
   observation counts, token counts, text, or coverage. Enforced by a
   regression test that permutes extractor output between two otherwise
   identical run roots and asserts the selection does not move
   (`test/gold-clean-sampler.test.mjs`); the test was mutation-verified —
   reintroducing the `criticalCount` filter fails it.
3. **Does ranking or ordering read it?** No. One seeded permutation covers
   both the tier pass and the fill pass, so relaxing a cap cannot smuggle
   in an extractor-informed order.
4. **Does presentation read it?** Not newly. The review UI shows the
   pre-labeler's proposals and boxes as before (that instrument's own
   biases are ledger rows 1b and the box-drift note on #4); the no-miss
   control itself presents nothing derived from the engines — it is a bare
   checkbox beside the reviewer's own search.
5. **Are confirmed negatives recorded rather than inferred from silence?**
   Yes — that is what the verdict exists for. The evaluator counts a
   negative only from an explicit `noMissFound: true`; absent pages are
   `cleanUnverified` and excluded from any future denominator.

**Cost of blindness, accepted:** some sampled pages will carry no figures
at all. Under the old sampler those were "wasted" slots; under this one
they are verified negatives — exactly the data the denominator lacked.

## Verified

- `npm test`: 162 pass (6 new).
- Mutation check: reintroducing `criticalCount > 0` into the population
  filter fails the extractor-blind test. (First mutation attempt targeted
  the tier's `match` predicate, which turned out to be dead code — it is
  now removed so nothing misleading remains; the second mutation hit the
  real filter and was caught.)
- Real-run dry-run against `dev-v12-cross-family-2026-08-20`
  (seed `batch6-clean-v1`, size 15): 87 unlabeled candidates, 75 already
  labeled, selected 15 (clean 14, fill 1 under relaxed caps). Counts only;
  no page content leaves `.evaluation/`.

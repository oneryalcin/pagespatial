/**
 * §14.3 stable-result comparator (design doc
 * 2026-08-23-modal-scaling-and-deployment.md). Production bugs these
 * prevent: a comparator that flags every valid reparse because the digest
 * includes runId/createdAt; an OCR tolerance that silently absorbs a
 * NATIVE-field change (the deterministic projection must fail regardless
 * of OCR score); and a hard-coded null tolerance instead of a derived one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createValidDocument } from './fixture.mjs';
import { pageDigest } from '../dist/index.js';
import {
  OCR_DEPENDENT_ROOTS,
  canonicalJson,
  comparePages,
  evaluateComparison,
  ocrDerivedProjection,
  ocrScoreProjection,
  stableDeterministicProjection
} from '../scripts/evaluation/lib/modal-comparator.mjs';

const clone = (value) => structuredClone(value);

test('OCR-dependent roots are exactly the §14.3 list', () => {
  assert.deepEqual([...OCR_DEPENDENT_ROOTS], [
    'ocrObservations', 'sourceMatches', 'conflicts', 'spatialRows',
    'derivedRelations', 'unreadInkRegions', 'secondOpinion', 'diagnostics',
    'projection'
  ]);
});

test('a valid reparse (new runId/createdAt) has a NEW pageDigest but an EXACT deterministic projection', async () => {
  const first = (await createValidDocument()).pages[0];
  const second = clone(first);
  second.provenance.runId = 'another-run';
  second.provenance.createdAt = '2099-01-01T00:00:00.000Z';

  assert.notEqual(await pageDigest(second), await pageDigest(first),
    'digest must differ across runs — which is why it is never compared');
  assert.equal(
    canonicalJson(stableDeterministicProjection(second)),
    canonicalJson(stableDeterministicProjection(first)));

  const comparison = comparePages([first], [second]);
  assert.equal(comparison.deterministic.exact, true);
  assert.equal(comparison.ocrScore.exact, true);
  assert.equal(comparison.ocrDerived.exact, true);
  const verdict = evaluateComparison(comparison, { criticalTokens: 0, rawLines: 0 });
  assert.equal(verdict.pass, true);
});

test('ocrScoreProjection is the EP scorer shape in observation order', async () => {
  const page = (await createValidDocument()).pages[0];
  const projection = ocrScoreProjection([page]);
  assert.deepEqual(projection, {
    perPage: [{
      page: page.pageNumber,
      lines: page.ocrObservations.map((item) => ({
        text: item.text,
        score: item.confidence ?? null
      }))
    }]
  });
});

test('an OCR text/score variation inside the derived null tolerance MAY pass', async () => {
  const first = (await createValidDocument()).pages[0];
  const varied = clone(first);
  varied.provenance.runId = 'another-run';
  // One OCR line reads a different number at a different confidence — the
  // kind of drift the same-configuration double parse measures.
  varied.ocrObservations[0].text = 'Revenue 108';
  varied.ocrObservations[0].confidence = 0.91;

  const comparison = comparePages([first], [varied]);
  assert.equal(comparison.deterministic.exact, true, 'native side untouched');
  assert.equal(comparison.ocrScore.exact, false);
  assert.equal(comparison.ocrScore.criticalTokens.symmetricDifference, 2); // 100 gone, 108 appeared
  assert.equal(comparison.ocrScore.rawLines.differingLines, 1);
  assert.deepEqual(comparison.schemaFailures, [], 'both pages still schema-valid');

  // Within the derived tolerance: passes.
  assert.equal(evaluateComparison(comparison, { criticalTokens: 2, rawLines: 1 }).pass, true);
  // Outside it: fails with the delta named.
  const tight = evaluateComparison(comparison, { criticalTokens: 0, rawLines: 0 });
  assert.equal(tight.pass, false);
  assert.match(tight.reasons.join('; '), /critical-token delta 2 exceeds null tolerance 0/u);
});

test('a NATIVE-field mutation fails regardless of OCR score', async () => {
  const first = (await createValidDocument()).pages[0];
  const mutated = clone(first);
  mutated.provenance.runId = 'another-run';
  mutated.nativeObservations[0].text = 'Revenue 900';

  const comparison = comparePages([first], [mutated]);
  assert.equal(comparison.deterministic.exact, false);
  // OCR projections are untouched: score delta is zero…
  assert.equal(comparison.ocrScore.criticalTokens.symmetricDifference, 0);
  assert.equal(comparison.ocrScore.rawLines.differingLines, 0);
  // …and the verdict still fails, even under an absurdly loose tolerance.
  const verdict = evaluateComparison(comparison, { criticalTokens: 1e9, rawLines: 1e9 });
  assert.equal(verdict.pass, false);
  assert.match(verdict.reasons.join('; '), /deterministic projection differs.*regardless of OCR score/u);
});

test('a font-label-ONLY change passes: nativeObservations[].font is volatile identity (M4 tune-once)', async () => {
  // pdf.js assigns session-local `g_d<N>_f<M>` labels (per-worker-process
  // document counter): the M3 trial's criteria-3/7 failures were 100%
  // this field, present even in the same-config null pair. Excluded
  // field-level per the amended §14.3.
  const first = (await createValidDocument()).pages[0];
  // The synthetic fixture carries no font labels; plant the session-local
  // shape the real pipeline produces, differing across "processes".
  first.nativeObservations.forEach((observation, index) => { observation.font = `g_d0_f${index + 2}`; });
  const relabeled = clone(first);
  relabeled.provenance.runId = 'another-run';
  relabeled.nativeObservations.forEach((observation, index) => { observation.font = `g_d18_f${index + 2}`; });
  assert.ok(first.nativeObservations.length > 0,
    'fixture must carry native observations or this test is vacuous');
  const comparison = comparePages([first], [relabeled]);
  assert.equal(comparison.deterministic.exact, true,
    'font relabeling alone must not fail the deterministic projection');
  // ANY other native change still fails — the exclusion is one field wide.
  const alsoMutated = clone(relabeled);
  alsoMutated.nativeObservations[0].text = 'Revenue 900';
  const failing = comparePages([first], [alsoMutated]);
  assert.equal(failing.deterministic.exact, false,
    'a native text change must still fail with fonts excluded');
});

test('OCR score exact but OCR-derived differing is a failure (derived state must be a function of OCR)', async () => {
  const first = (await createValidDocument()).pages[0];
  const drifted = clone(first);
  drifted.provenance.runId = 'another-run';
  // Same OCR text/scores, but a derived root changed — deterministic
  // pipeline drift the tolerance must NOT absorb.
  drifted.diagnostics = { ...clone(drifted.diagnostics), coverageDelta: 0.123456 };

  const comparison = comparePages([first], [drifted]);
  assert.equal(comparison.ocrScore.exact, true);
  assert.equal(comparison.ocrDerived.exact, false);
  const verdict = evaluateComparison(comparison, { criticalTokens: 0, rawLines: 0 });
  assert.equal(verdict.pass, false);
  assert.match(verdict.reasons.join('; '), /OCR score projection exact but OCR-derived projection differs/u);
});

test('ocrDerivedProjection carries only the OCR-dependent roots', async () => {
  const page = (await createValidDocument()).pages[0];
  const projection = ocrDerivedProjection(page);
  for (const key of Object.keys(projection)) assert.ok(OCR_DEPENDENT_ROOTS.includes(key));
  assert.ok(!('nativeObservations' in projection));
  assert.ok(!('provenance' in projection));
});

test('evaluateComparison refuses to run without a derived null tolerance', async () => {
  const page = (await createValidDocument()).pages[0];
  const comparison = comparePages([page], [clone(page)]);
  assert.throws(() => evaluateComparison(comparison), /derive it from a same-configuration double parse/u);
  assert.throws(() => evaluateComparison(comparison, { criticalTokens: 0 }), /null/u);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  buildSpatialRows,
  inferSimpleYearValueRelations,
  normalizeEvidenceText,
  textSimilarity
} from '../dist/index.js';

function ocr(id, text, box, confidence = 0.9) {
  return { id, pageNumber: 1, text, box, confidence };
}

function scaleBoxes(observations, factor) {
  return observations.map((observation) => ({
    ...observation,
    box: observation.box.map((value) => value * factor)
  }));
}

// Two OCR rows 12px apart at scale 1.6 were previously merged by the fixed 8px
// height floor; doubling the render scale must not change the grouping.
test('spatial row grouping is invariant under render scale', () => {
  const layout = [
    ocr('a', 'Revenue', [10, 100, 80, 106]),
    ocr('b', '1,204', [120, 100, 160, 106]),
    ocr('c', 'Cost', [10, 112, 60, 118]),
    ocr('d', '907', [120, 112, 150, 118])
  ];
  const atReference = buildSpatialRows(layout, 1.6);
  const atDouble = buildSpatialRows(scaleBoxes(layout, 2), 3.2);
  assert.deepEqual(
    atReference.map((row) => row.sourceIds),
    atDouble.map((row) => row.sourceIds)
  );
});

// The year-row clustering and value-window constants were pixel-tuned at scale
// 1.6; the same chart rendered at twice the resolution must produce the same
// category/value pairs.
test('year/value relation inference is invariant under render scale', () => {
  const layout = [
    ocr('v1', '527', [40, 40, 70, 52]),
    ocr('v2', '611', [140, 30, 170, 42]),
    ocr('v3', '698', [240, 20, 270, 32]),
    ocr('y1', 'FY2021', [35, 200, 80, 212]),
    ocr('y2', 'FY2022', [135, 200, 180, 212]),
    ocr('y3', 'FY2023', [235, 200, 280, 212])
  ];
  const atReference = inferSimpleYearValueRelations('page', layout, 1.6);
  const atDouble = inferSimpleYearValueRelations('page', scaleBoxes(layout, 2), 3.2);
  const pairs = (relations) => relations.map((relation) => [relation.attributes.category, relation.attributes.value]);
  assert.ok(atReference.length >= 3);
  assert.deepEqual(pairs(atReference), pairs(atDouble));
});

// toLocaleLowerCase() follows the host locale (Turkish dotless ı), which made
// text normalization differ between machines and thus made conflicts and
// matches nondeterministic across environments.
test('text normalization does not depend on the host locale', () => {
  const script = `
    import { normalizeEvidenceText, textSimilarity } from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)};
    process.stdout.write(JSON.stringify({
      normalized: normalizeEvidenceText('DIŞ TİCARET FY2021 I'),
      similarity: textSimilarity('DIŞ TİCARET', 'dış ticaret')
    }));
  `;
  const foreign = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, LANG: 'tr_TR.UTF-8', LC_ALL: 'tr_TR.UTF-8' },
    encoding: 'utf8'
  }));
  assert.equal(foreign.normalized, normalizeEvidenceText('DIŞ TİCARET FY2021 I'));
  assert.equal(foreign.similarity, textSimilarity('DIŞ TİCARET', 'dış ticaret'));
});

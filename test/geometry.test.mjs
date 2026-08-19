import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPageGeometry, pointBoxToRenderedBox } from '../dist/index.js';
import { pdfJsTextItemPointBox } from '../dist/pdfjs-text.js';

// A zero-length axis vector previously fabricated a 1pt height (or an assumed
// left-to-right direction) instead of failing closed.
test('singular PDF.js text transforms are rejected, not repaired', () => {
  const singular = { transform: [0, 0, 0, 0, 100, 200], width: 40, height: 0 };
  assert.throws(() => pdfJsTextItemPointBox(singular), /singular text transform/);
  const degenerateVertical = { transform: [12, 0, 0, 0, 100, 200], width: 40, height: 0 };
  assert.throws(() => pdfJsTextItemPointBox(degenerateVertical), /singular text transform/);
  const rotated = { transform: [0, 12, -12, 0, 100, 200], width: 40, height: 12 };
  const box = pdfJsTextItemPointBox(rotated);
  assert.ok(box[2] > box[0] && box[3] > box[1]);
});

test('transforms all four point-box corners with the PDF viewport matrix', () => {
  const result = pointBoxToRenderedBox([10, 20, 40, 30], {
    width: 300,
    height: 200,
    pointBounds: [-3.5, -2.5, 96.5, 147.5],
    pointWidth: 100,
    pointHeight: 150,
    viewportTransform: [0, 2, 2, 0, 5, 7]
  });
  assert.deepEqual(result.box, [45, 27, 65, 87]);
  assert.equal(result.method, 'pdfjs-viewport-matrix-v1');
});

test('uses a documented axis-aligned fallback when no matrix exists', () => {
  const result = pointBoxToRenderedBox([10, 20, 40, 30], {
    width: 200,
    height: 300,
    pointWidth: 100,
    pointHeight: 150
  });
  assert.deepEqual(result.box, [20, 240, 80, 260]);
  assert.equal(result.method, 'axis-aligned-fallback-v1');
});

test('accepts all PDF.js quarter-turn viewport matrices', () => {
  const cases = [
    { rotation: 0, width: 100, height: 200, transform: [1, 0, 0, -1, 0, 200] },
    { rotation: 90, width: 200, height: 100, transform: [0, 1, 1, 0, 0, 0] },
    { rotation: 180, width: 100, height: 200, transform: [-1, 0, 0, 1, 100, 0] },
    { rotation: 270, width: 200, height: 100, transform: [0, -1, -1, 0, 200, 100] }
  ];
  for (const candidate of cases) {
    const geometry = {
      width: candidate.width,
      height: candidate.height,
      pointBounds: [0, 0, 100, 200],
      pointWidth: 100,
      pointHeight: 200,
      rotation: candidate.rotation,
      viewportTransform: candidate.transform
    };
    assert.doesNotThrow(() => assertPageGeometry(geometry));
    const result = pointBoxToRenderedBox([10, 20, 40, 40], geometry);
    assert.ok(result.box[0] >= 0 && result.box[1] >= 0);
    assert.ok(result.box[2] <= candidate.width && result.box[3] <= candidate.height);
  }
});

test('handles shifted PDF point bounds only through a verified viewport matrix', () => {
  const geometry = {
    width: 100,
    height: 200,
    pointBounds: [10, 20, 110, 220],
    pointWidth: 100,
    pointHeight: 200,
    viewportTransform: [1, 0, 0, -1, -10, 220]
  };
  assert.deepEqual(pointBoxToRenderedBox([20, 200, 50, 210], geometry).box, [10, 10, 40, 20]);
  assert.throws(() => pointBoxToRenderedBox([20, 200, 50, 210], { ...geometry, viewportTransform: undefined }), /unshifted/);
});

test('rejects non-finite, singular, inconsistent, and out-of-bounds geometry', () => {
  const base = {
    width: 100,
    height: 200,
    pointBounds: [0, 0, 100, 200],
    pointWidth: 100,
    pointHeight: 200
  };
  assert.throws(() => assertPageGeometry({ ...base, viewportTransform: [1, 0, 0, 1, Number.NaN, 0] }), /finite/);
  assert.throws(() => assertPageGeometry({ ...base, viewportTransform: [1, 2, 2, 4, 0, 0] }), /invertible/);
  assert.throws(() => assertPageGeometry({ ...base, viewportTransform: [1, 0, 0, -1, 10, 200] }), /does not map/);
  assert.throws(
    () => pointBoxToRenderedBox([-1, 20, 40, 40], { ...base, viewportTransform: [1, 0, 0, -1, 0, 200] }),
    /outside declared bounds/
  );
});

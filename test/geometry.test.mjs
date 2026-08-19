import test from 'node:test';
import assert from 'node:assert/strict';
import { pointBoxToRenderedBox } from '../dist/index.js';

test('transforms all four point-box corners with the PDF viewport matrix', () => {
  const result = pointBoxToRenderedBox([10, 20, 40, 30], {
    width: 200,
    height: 300,
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


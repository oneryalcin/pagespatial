import assert from 'node:assert/strict';
import test from 'node:test';
import {
  coalesceCriticalFragments,
  compareCriticalTokens,
  extractCriticalTokens,
  normalizeCriticalToken
} from '../scripts/lib/critical-token-evaluation.mjs';

const observation = (text, x1, x2, y1 = 100, y2 = 110) => ({
  pageNumber: 1,
  text,
  pointBox: [x1, y1, x2, y2]
});

test('coalesces PDF text runs that split a financial number', () => {
  const joined = coalesceCriticalFragments([
    observation('27', 0, 12),
    observation(',', 10, 15),
    observation('148,453', 14, 52),
    observation('147', 70, 88),
    observation(',366,013', 86, 130)
  ]);
  assert.deepEqual(joined.map(({ text }) => text), ['27,148,453', '147,366,013']);
  assert.deepEqual(extractCriticalTokens(joined), ['27148453', '147366013']);
});

test('does not join separate cells or different rows', () => {
  const joined = coalesceCriticalFragments([
    observation('2025', 0, 25),
    observation('2024', 100, 125),
    observation(',123', 23, 50, 130, 140)
  ]);
  assert.deepEqual(joined.map(({ text }) => text), ['2025', '2024', ',123']);
});

test('normalizes financial formatting without discarding sign or currency', () => {
  assert.equal(normalizeCriticalToken('(829,726)'), '-829726');
  assert.equal(normalizeCriticalToken('−1,200'), '-1200');
  assert.equal(normalizeCriticalToken('$2,500.00'), '$2500.00');
});

test('scores reconstructed values rather than PDF run fragments', () => {
  const reference = extractCriticalTokens([
    observation('27', 0, 12),
    observation(',', 10, 15),
    observation('148,453', 14, 52)
  ]);
  const candidate = extractCriticalTokens([observation('27,148,453', 0, 52)]);
  assert.deepEqual(compareCriticalTokens(candidate, reference), {
    matched: 1,
    referenceTotal: 1,
    candidateTotal: 1,
    recall: 1,
    precision: 1,
    missing: [],
    unexpected: []
  });
});

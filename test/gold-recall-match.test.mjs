import assert from 'node:assert/strict';
import test from 'node:test';
import { consumeMatch, currencyCompatible, stripCurrency } from '../scripts/evaluation/lib/recall-match.mjs';

test('a detached currency symbol is forgiven — the segmentation case this exists for', () => {
  const pool = ['684,663'];
  assert.equal(consumeMatch(pool, '$684,663'), false, 'strict must not match across the symbol');
  assert.equal(consumeMatch(pool, '$684,663', { tolerant: true }), true);
  assert.deepEqual(pool, [], 'the entry is consumed once');
});

test('a CONTRADICTORY currency symbol is never forgiven', () => {
  // The failure this guard exists for: an engine reading the wrong currency
  // has misread the value, and crediting it would hide a unit error.
  for (const wrong of ['€100', '£100', '¥100']) {
    const pool = [wrong];
    assert.equal(consumeMatch(pool, '$100', { tolerant: true }), false, `${wrong} must not satisfy $100`);
    assert.deepEqual(pool, [wrong], 'a rejected candidate stays in the pool');
  }
});

test('matching currency symbols still match', () => {
  const pool = ['$100'];
  assert.equal(consumeMatch(pool, '$100', { tolerant: true }), true);
});

test('sign is never relaxed', () => {
  const pool = ['150,672'];
  assert.equal(consumeMatch(pool, '$-150,672', { tolerant: true }), false);
});

test('a signed value still matches its detached-symbol twin', () => {
  const pool = ['-150,672'];
  assert.equal(consumeMatch(pool, '$-150,672', { tolerant: true }), true);
});

test('percent is never relaxed', () => {
  const pool = ['28.9'];
  assert.equal(consumeMatch(pool, '28.9%', { tolerant: true }), false);
});

test('tolerance never invents a match out of a symbol-only token', () => {
  // stripCurrency('$') is empty; an empty needle must not match everything.
  const pool = ['100'];
  assert.equal(consumeMatch(pool, '$', { tolerant: true }), false);
  assert.deepEqual(pool, ['100']);
});

test('consume-once holds under tolerance', () => {
  const pool = ['100', '100'];
  assert.equal(consumeMatch(pool, '$100', { tolerant: true }), true);
  assert.equal(consumeMatch(pool, '$100', { tolerant: true }), true);
  assert.equal(consumeMatch(pool, '$100', { tolerant: true }), false, 'pool is exhausted');
});

test('an exact candidate is preferred over a relaxed one', () => {
  const pool = ['100', '$100'];
  assert.equal(consumeMatch(pool, '$100', { tolerant: true }), true);
  assert.deepEqual(pool, ['100'], 'the symbol-bearing entry was taken, not the bare one');
});

test('currencyCompatible states the asymmetry directly', () => {
  assert.equal(currencyCompatible('$100', '100'), true, 'one side detached');
  assert.equal(currencyCompatible('100', '$100'), true, 'order does not matter');
  assert.equal(currencyCompatible('$100', '$100'), true, 'same symbol');
  assert.equal(currencyCompatible('$100', '€100'), false, 'different symbols contradict');
  assert.equal(stripCurrency('$684,663'), '684,663');
});

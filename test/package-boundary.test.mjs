import test from 'node:test';
import assert from 'node:assert/strict';

test('root package import stays runtime-neutral and DOM-free', async () => {
  assert.equal(typeof globalThis.document, 'undefined');
  const root = await import('../dist/index.js');
  assert.equal(typeof root.createParser, 'function');
  assert.equal(typeof globalThis.document, 'undefined');
});

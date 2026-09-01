import assert from 'node:assert/strict';
import test from 'node:test';
import { DEMO_MAX_BYTES, joinPageMarkdown, safeDownloadStem, validateDemoFile } from '../site/demo/contract.mjs';

test('public demo rejects non-PDF and oversized inputs before parsing', () => {
  assert.throws(() => validateDemoFile({ name: 'notes.txt', type: 'text/plain', size: 12 }), /PDF document/);
  assert.throws(() => validateDemoFile({ name: 'large.pdf', type: 'application/pdf', size: DEMO_MAX_BYTES + 1 }), /20 MiB/);
  assert.doesNotThrow(() => validateDemoFile({ name: 'report.pdf', type: '', size: DEMO_MAX_BYTES }));
});

test('public demo creates stable safe download stems', () => {
  assert.equal(safeDownloadStem('Q2 Report (final).PDF'), 'Q2-Report-final');
  assert.equal(safeDownloadStem('../../'), 'pagespatial-result');
});

test('public demo Markdown carries explicit page boundaries', () => {
  const markdown = joinPageMarkdown([
    { pageNumber: 1, projection: { markdown: '# One\n' } },
    { pageNumber: 2, projection: { markdown: 'Two' } }
  ]);
  assert.equal(markdown, '<!-- Page 1 -->\n\n# One\n\n---\n\n<!-- Page 2 -->\n\nTwo');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPageSpatial } from '../dist/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// A minimal one-page PDF pdftoppm can render (blank US-letter page).
const MINIMAL_PDF = Buffer.from(`%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj
xref
0 4
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
trailer << /Size 4 /Root 1 0 R >>
startxref
186
%%EOF
`);

function fixtureRunRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'runner-fixture-'));
  const corpusRoot = join(dir, 'corpus');
  mkdirSync(join(corpusRoot, 'docs'), { recursive: true });
  const pdfPath = join(corpusRoot, 'docs', 'fixture.pdf');
  writeFileSync(pdfPath, MINIMAL_PDF);
  const sha = createHash('sha256').update(MINIMAL_PDF).digest('hex');

  // A page with a critical-token conflict → blocking → adjudication rung.
  const page = buildPageSpatial({
    document: { documentId: 'fixture-doc', revisionId: `sha256:${sha}`, sha256: sha, pageCount: 1 },
    pageNumber: 1,
    geometry: { width: 612, height: 792, pointWidth: 612, pointHeight: 792 },
    nativeObservations: [{ pageNumber: 1, text: 'Revenue 647', box: [20, 20, 200, 40] }],
    ocrObservations: [{ pageNumber: 1, text: 'Revenue 641', box: [20, 20, 200, 40], confidence: 0.99 }],
    provenance: { parserName: 'fixture', parserVersion: '1', runId: 'fixture-run', createdAt: new Date().toISOString() }
  });
  assert.equal(page.diagnostics.escalationReasons.some((r) => r.severity === 'blocking'), true,
    'fixture must escalate or the runner has nothing to do');

  const runRoot = join(dir, 'run');
  mkdirSync(join(runRoot, 'documents', 'fixture', 'pages'), { recursive: true });
  writeFileSync(join(runRoot, 'documents', 'fixture', 'pages', '000001.json'), JSON.stringify({
    pageSpatial: page, objectId: 'fixture-doc', pageNumber: 1, path: 'docs/fixture.pdf'
  }));
  return { dir, runRoot, corpusRoot };
}

// Preload stub: counts every fetch by kind, answers Gemini shapes.
const PRELOAD = `
const countsPath = process.env.STUB_COUNTS_PATH;
const counts = { generateContent: 0, batchSubmit: 0, poll: 0 };
const save = () => require('node:fs').writeFileSync(countsPath, JSON.stringify(counts));
const okJson = (body) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => '' });
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes(':generateContent')) {
    counts.generateContent += 1; save();
    return okJson({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ verdicts: [{ index: 0, verdict: 'native', inkText: 'Revenue 647' }] }) }] } }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 }
    });
  }
  if (u.includes(':batchGenerateContent')) { counts.batchSubmit += 1; save(); return okJson({ name: 'batches/stub-op' }); }
  if (u.includes('batches/stub-op')) {
    counts.poll += 1; save();
    return okJson({
      done: true,
      metadata: { state: 'BATCH_STATE_SUCCEEDED' },
      response: { inlinedResponses: { inlinedResponses: [{
        metadata: { key: process.env.STUB_EXPECT_KEY },
        response: {
          candidates: [{ content: { parts: [{ text: JSON.stringify({ verdicts: [{ index: 0, verdict: 'native', inkText: 'Revenue 647' }] }) }] } }],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 }
        }
      }] } }
    });
  }
  throw new Error('unexpected fetch ' + u);
};
save();
`;

function runRunner(fixture, extraArgs, expectKey) {
  const preloadPath = join(fixture.dir, 'preload.cjs');
  writeFileSync(preloadPath, PRELOAD);
  const countsPath = join(fixture.dir, 'counts.json');
  const output = join(fixture.dir, `out-${extraArgs.join('') || 'sync'}`);
  const stdout = execFileSync(process.execPath, [
    '--require', preloadPath,
    join(root, 'scripts/evaluation/run-flash-enrichment.mjs'),
    '--run-root', fixture.runRoot,
    '--output', output,
    '--corpus-root', fixture.corpusRoot,
    '--concurrency', '1',
    ...extraArgs
  ], {
    env: { ...process.env, GEMINI_API_KEY: 'stub-key', STUB_COUNTS_PATH: countsPath, STUB_EXPECT_KEY: expectKey },
    encoding: 'utf8'
  });
  return { counts: JSON.parse(readFileSync(countsPath, 'utf8')), output, stdout };
}

test('batch mode never fires a synchronous generateContent call', () => {
  const fixture = fixtureRunRoot();
  try {
    const page = JSON.parse(readFileSync(join(fixture.runRoot, 'documents/fixture/pages/000001.json'), 'utf8')).pageSpatial;
    const key = `${page.pageId.replaceAll(':', '_')}.json|adj`;
    const { counts, output, stdout } = runRunner(fixture, ['--batch'], key);
    // THE invariant this file exists for: violated twice before review.
    assert.equal(counts.generateContent, 0, 'no interactive calls under --batch');
    assert.equal(counts.batchSubmit, 1);
    assert.match(stdout, /Batch done/u);
    const record = JSON.parse(readFileSync(join(output, `${page.pageId.replaceAll(':', '_')}.json`), 'utf8'));
    assert.equal(record.adjudications.length, 1);
    assert.equal(record.adjudications[0].verdict, 'native');
    assert.equal(record.provenance.adjudication.transport, 'batch');
    assert.ok(existsSync(join(output, 'batch-manifest.json')), 'recovery manifest persisted');
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('sync mode completes without reference errors and writes a valid record', () => {
  const fixture = fixtureRunRoot();
  try {
    const page = JSON.parse(readFileSync(join(fixture.runRoot, 'documents/fixture/pages/000001.json'), 'utf8')).pageSpatial;
    const { counts, output, stdout } = runRunner(fixture, [], 'unused');
    assert.ok(counts.generateContent >= 1, 'sync mode uses interactive calls');
    assert.equal(counts.batchSubmit, 0);
    assert.doesNotMatch(stdout, /ReferenceError/u);
    const record = JSON.parse(readFileSync(join(output, `${page.pageId.replaceAll(':', '_')}.json`), 'utf8'));
    assert.equal(record.adjudications[0].verdict, 'native');
    assert.equal(record.provenance.adjudication.transport, undefined);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

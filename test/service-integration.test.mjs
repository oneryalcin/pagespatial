/**
 * #22 v1 integration: the canonical PP-OCR witness in the service, the
 * pinned-backend provenance, the SVG endpoint, and the second-opinion rung.
 *
 * The canonical test needs the PP-OCR model assets, which are private-side
 * artifacts (they live under .evaluation/, or wherever PPOCR_ASSETS_DIR
 * points). Without them the test SKIPS LOUDLY — CI without assets stays
 * green, and the skip line names what was not covered.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ParseService } from '../service/lib/queue.mjs';
import { createPpOcrServerAdapter } from '../service/adapters/ppocr-server.mjs';
import { assemblyStage, openDocumentContext } from '../service/lib/stages.mjs';
import { buildPageSpatial } from '../dist/index.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const assetsDir = process.env.PPOCR_ASSETS_DIR ?? join(repoRoot, '.evaluation', 'ocr-assets-small');
const assetsPresent = existsSync(join(assetsDir, 'models'));
if (!assetsPresent) {
  console.warn(`SKIPPING canonical-witness integration tests: PP-OCR assets not found at ${assetsDir} (set PPOCR_ASSETS_DIR).`);
}

// One-page PDF with real Helvetica text, valid xref — pdftoppm renders it,
// pdf-inspector parses it, and both OCR witnesses can read the ink.
function textPdf(lines = ['Revenue 647', 'Total 1,204']) {
  const content = `BT /F1 24 Tf 72 700 Td ${lines.map((line, index) => `${index ? '0 -40 Td ' : ''}(${line}) Tj`).join(' ')} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`
  ];
  let body = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((objectContent, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj ${objectContent} endobj\n`;
  });
  const xrefOffset = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body);
}

async function waitForCompletion(service, jobId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = service.jobStatus(jobId);
    if (status?.status === 'completed') return status;
    if (Date.now() > deadline) throw new Error(`Job ${jobId} did not complete; at ${status?.completedPages}/${status?.pageCount}.`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

test('ppocr-server refuses to exist without an explicit assets dir', () => {
  assert.throws(() => createPpOcrServerAdapter({}), /assetsDir/u);
});

test('canonical witness end to end: schema-valid record with a pinned backend in provenance', { skip: !assetsPresent, timeout: 300_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'svc-int-'));
  const pdfPath = join(dir, 'doc.pdf');
  writeFileSync(pdfPath, textPdf());
  const service = new ParseService({
    dataDir: join(dir, 'data'),
    workers: 1,
    adapterId: 'ppocr-server',
    ocr: { assetsDir, variant: 'small', numThreads: 2 }
  });
  try {
    const { jobId } = await service.submit({ pdfPath });
    const status = await waitForCompletion(service, jobId, 240_000);
    const page = status.pages[0];
    assert.equal(page.ok, true, JSON.stringify(page.failure ?? {}));
    assert.ok(page.pageSpatial, 'canonical adapter must produce a record');
    // The pinned backend: descriptor string in ocrAdapter, machine-readable
    // pin in configuration — and never the word 'auto'.
    const provenance = page.pageSpatial.provenance;
    assert.equal(provenance.ocrAdapter, 'ppocrv6-small-node@0.4.2#ep=wasm;threads=2');
    assert.deepEqual(provenance.configuration.ocrBackend, {
      adapter: 'ppocrv6-small-node',
      version: '0.4.2',
      variant: 'small',
      executionProvider: 'wasm',
      numThreads: 2
    });
    assert.ok(!JSON.stringify(provenance).includes('"auto"'));
    // The witness genuinely read the ink (rendered Helvetica at 24pt).
    const texts = page.pageSpatial.ocrObservations.map((observation) => observation.text).join(' ');
    assert.match(texts, /647/u);
    assert.ok(page.stageTimingsMs.ocr > 0);
    assert.ok(page.stageTimingsMs.ocrColdInit > 0, 'first page reports engine cold init');
  } finally {
    await service.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('second-opinion rung engages on a would-starve page and lands in the record', { timeout: 120_000 }, async () => {
  // Synthetic would-starve inputs over a REAL page render: an empty native
  // witness plus many confident uncorroborated OCR observations trips the
  // uncorroborated-ocr blocking reason, and the Tesseract second opinion
  // then reads the actual ink ("Revenue 647") from the page raster.
  const dir = mkdtempSync(join(tmpdir(), 'svc-int-'));
  const pdfPath = join(dir, 'doc.pdf');
  writeFileSync(pdfPath, textPdf());
  const context = await openDocumentContext(pdfPath);
  try {
    const { renderStage } = await import('../service/lib/stages.mjs');
    const rendered = await renderStage(context, 1);
    const geometry = rendered.value.renderedPage.geometry;
    const ocrPage = {
      pageNumber: 1,
      observations: Array.from({ length: 10 }, (_, index) => ({
        id: `synthetic:${index}`,
        pageNumber: 1,
        text: `ZQX${index}J`,
        box: [10 + index * 30, 100, 35 + index * 30, 120],
        confidence: 0.9
      }))
    };
    const canonicalMarker = { name: 'synthetic-canonical', version: '1', canonical: true };
    const assembled = await assemblyStage(
      context, 1, canonicalMarker,
      { pageNumber: 1, observations: [] },
      rendered.value.renderedPage,
      ocrPage,
      { runId: 'test-so', ocrAdapterId: 'synthetic-canonical@1', configuration: {} }
    );
    const record = assembled.value.pageSpatial;
    assert.ok(
      record.diagnostics.escalationReasons.some((reason) => reason.type === 'uncorroborated-ocr' && reason.severity === 'blocking'),
      'fixture must actually starve or this test proves nothing'
    );
    assert.ok(record.secondOpinion, 'second opinion must engage on a would-starve page');
    assert.match(record.secondOpinion.adapter, /tesseract/u);
    const readings = record.secondOpinion.readings.map((reading) => reading.text).join(' ');
    assert.match(readings, /Revenue|647/u, 'Tesseract reads the real ink from the raster');
    assert.ok(assembled.value.secondOpinionMs > 0);
  } finally {
    await context.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('completed-job endpoints serve SVG and closed public result bytes', { timeout: 60_000 }, async () => {
  const { fork } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'svc-int-'));
  const dataDir = join(dir, 'data');
  // Seed a completed job on disk: resume() loads it at boot, so the route is
  // exercised through the real server with zero workers.
  const record = buildPageSpatial({
    document: { documentId: 'svg-doc', revisionId: 'sha256:ab', sha256: 'ab'.repeat(32), pageCount: 1 },
    pageNumber: 1,
    geometry: { width: 612, height: 792, pointWidth: 612, pointHeight: 792 },
    nativeObservations: [{ pageNumber: 1, text: 'Revenue 647', box: [20, 20, 200, 40] }],
    ocrObservations: [{ pageNumber: 1, text: 'Revenue 647', box: [20, 20, 200, 40], confidence: 0.99 }],
    provenance: { parserName: 'fixture', parserVersion: '1', runId: 'fixture', createdAt: new Date().toISOString() }
  });
  const jobDir = join(dataDir, 'job_svgtest');
  mkdirSync(join(jobDir, 'pages'), { recursive: true });
  writeFileSync(join(jobDir, 'job.json'), JSON.stringify({ jobId: 'job_svgtest', status: 'completed', pageCount: 2, sha256: 'ab'.repeat(32) }));
  writeFileSync(join(jobDir, 'pages', '000001.json'), JSON.stringify({ pageNumber: 1, ok: true, pageSpatial: record }));
  writeFileSync(join(jobDir, 'pages', '000002.json'), JSON.stringify({ pageNumber: 2, ok: false, failure: { message: 'nope' } }));

  const port = 18000 + Math.floor(Math.random() * 2000);
  const child = fork(new URL('../service/server.mjs', import.meta.url), [], {
    env: { ...process.env, PORT: String(port), SERVICE_DATA_DIR: dataDir, SERVICE_WORKERS: '0' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not start')), 10_000);
      child.stdout.on('data', (chunk) => { if (String(chunk).includes('listening')) { clearTimeout(timer); resolve(); } });
      child.on('exit', () => reject(new Error('server exited during startup')));
    });
    const good = await fetch(`http://127.0.0.1:${port}/v1/jobs/job_svgtest/pages/1.svg`);
    assert.equal(good.status, 200);
    assert.equal(good.headers.get('content-type'), 'image/svg+xml');
    const svg = await good.text();
    assert.match(svg, /^<svg/u);
    assert.match(svg, /Revenue 647/u);
    const failed = await fetch(`http://127.0.0.1:${port}/v1/jobs/job_svgtest/pages/2.svg`);
    assert.equal(failed.status, 404);
    const unknown = await fetch(`http://127.0.0.1:${port}/v1/jobs/job_svgtest/pages/9.svg`);
    assert.equal(unknown.status, 404);
    const publication = {
      job_id: '11111111-1111-4111-8111-111111111111',
      attempt_id: '22222222-2222-4222-8222-222222222222',
      execution_id: 'a'.repeat(32),
      input_sha256: 'ab'.repeat(32),
    };
    const publish = (representation) => fetch(
      `http://127.0.0.1:${port}/v1/jobs/job_svgtest/public-result/${representation}`,
      { method: 'POST', body: JSON.stringify(publication) },
    );
    const evidenceResponse = await publish('evidence');
    const compactResponseA = await publish('compact');
    const compactResponseB = await publish('compact');
    assert.equal(evidenceResponse.status, 200);
    assert.equal(compactResponseA.status, 200);
    assert.equal(evidenceResponse.headers.get('cache-control'), 'no-store');
    const evidence = await evidenceResponse.json();
    const compactBytesA = Buffer.from(await compactResponseA.arrayBuffer());
    const compactBytesB = Buffer.from(await compactResponseB.arrayBuffer());
    const compact = JSON.parse(compactBytesA.toString('utf8'));
    assert.equal(evidence.execution_id, publication.execution_id);
    assert.equal(compact.representation, 'compact');
    assert.equal(compact.pages[0].page_compact.projection.markdown,
      record.projection.markdown);
    assert.equal('nativeObservations' in compact.pages[0].page_compact, false);
    assert.deepEqual(compactBytesA, compactBytesB);
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

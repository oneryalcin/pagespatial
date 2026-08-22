import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ParseService } from '../service/lib/queue.mjs';
import { assemblyStage } from '../service/lib/stages.mjs';
import { createStubOcrAdapter } from '../service/adapters/stub-ocr.mjs';

// Minimal N-page PDF with a VALID xref (pdf-inspector's Rust parser rejects
// the sloppy-offset trick the enrichment fixture gets away with).
function minimalPdf(pageCount, mediaBox = '0 0 612 792') {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>'];
  const kids = Array.from({ length: pageCount }, (_, index) => `${index + 3} 0 R`).join(' ');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`);
  for (let index = 0; index < pageCount; index += 1) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [${mediaBox}] >>`);
  }
  let body = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((content, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj ${content} endobj\n`;
  });
  const xrefOffset = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body);
}

function fixture(pageCount) {
  const dir = mkdtempSync(join(tmpdir(), 'svc-test-'));
  const pdfPath = join(dir, 'doc.pdf');
  writeFileSync(pdfPath, minimalPdf(pageCount));
  return { dir, pdfPath, dataDir: join(dir, 'data') };
}

async function waitForCompletion(service, jobId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = service.jobStatus(jobId);
    if (status?.status === 'completed') return status;
    if (Date.now() > deadline) throw new Error(`Job ${jobId} did not complete; at ${status?.completedPages}/${status?.pageCount}.`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test('job lifecycle: submit -> progressive per-page results -> completed', async () => {
  const { dir, pdfPath, dataDir } = fixture(3);
  const service = new ParseService({ dataDir, workers: 1 });
  try {
    const { jobId, pageCount } = await service.submit({ pdfPath });
    assert.equal(pageCount, 3);
    // Progressive: some page result becomes readable before the whole job is done
    // (poll for it; with one worker pages land one at a time).
    let sawPartial = false;
    for (let poll = 0; poll < 600; poll += 1) {
      const status = service.jobStatus(jobId);
      if (status.status !== 'completed' && status.completedPages > 0) { sawPartial = true; break; }
      if (status.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const status = await waitForCompletion(service, jobId);
    assert.equal(sawPartial, true, 'expected at least one page visible before job completion');
    assert.equal(status.completedPages, 3);
    for (const page of status.pages) {
      assert.equal(page.ok, true);
      assert.ok(page.stageTimingsMs.render >= 0);
      assert.ok(page.stageTimingsMs.native >= 0);
      assert.ok(page.stageTimingsMs.ocr >= 0);
    }
    assert.ok(service.page(jobId, 2), 'single-page endpoint data exists');
  } finally {
    await service.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stub witness never emits a canonical record', async () => {
  const { dir, pdfPath, dataDir } = fixture(1);
  const service = new ParseService({ dataDir, workers: 1 });
  try {
    const { jobId } = await service.submit({ pdfPath });
    const status = await waitForCompletion(service, jobId);
    const page = status.pages[0];
    assert.equal(page.nonCanonical, true);
    assert.equal('pageSpatial' in page, false, 'a stub witness must not produce a pageSpatial record');
    const raw = readFileSync(join(dataDir, jobId, 'pages', '000001.json'), 'utf8');
    assert.doesNotMatch(raw, /"pageSpatial"/u);
  } finally {
    await service.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fail-closed page: one failing page does not sink its siblings', async () => {
  const { dir, pdfPath, dataDir } = fixture(2);
  process.env.STUB_FAIL_PAGE = '2';
  const service = new ParseService({ dataDir, workers: 1 });
  try {
    const { jobId } = await service.submit({ pdfPath });
    const status = await waitForCompletion(service, jobId);
    assert.equal(status.status, 'completed');
    const [page1, page2] = status.pages;
    assert.equal(page1.ok, true);
    assert.equal(page2.ok, false);
    assert.match(page2.failure.message, /configured to fail/u);
    assert.equal(page2.attempts, 2, 'failing page exhausts the attempt cap');
  } finally {
    delete process.env.STUB_FAIL_PAGE;
    await service.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('worker crash mid-page requeues the page and a fresh worker completes it', async () => {
  const { dir, pdfPath, dataDir } = fixture(1);
  const crashFile = join(dir, 'crash-once');
  process.env.STUB_CRASH_ONCE_FILE = crashFile;
  const service = new ParseService({ dataDir, workers: 1 });
  try {
    const { jobId } = await service.submit({ pdfPath });
    const status = await waitForCompletion(service, jobId);
    assert.equal(existsSync(crashFile), true, 'the crash hook fired');
    const page = status.pages[0];
    assert.equal(page.ok, true, 'page completed on the retry attempt');
    assert.equal(page.attempts, 2, 'first attempt died with the worker');
  } finally {
    delete process.env.STUB_CRASH_ONCE_FILE;
    await service.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restart resume: a new service instance finishes a half-done job', async () => {
  const { dir, pdfPath, dataDir } = fixture(2);
  const first = new ParseService({ dataDir, workers: 1 });
  let jobId;
  try {
    ({ jobId } = await first.submit({ pdfPath }));
    // Wait for exactly the first page, then kill the service.
    for (let poll = 0; poll < 600; poll += 1) {
      if ((first.jobStatus(jobId)?.completedPages ?? 0) >= 1) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    await first.shutdown();
  }
  const second = new ParseService({ dataDir, workers: 1 });
  try {
    const status = await waitForCompletion(second, jobId);
    assert.equal(status.completedPages, 2);
  } finally {
    await second.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resume requeues a torn page file instead of counting it done', async () => {
  const { dir, pdfPath, dataDir } = fixture(2);
  const first = new ParseService({ dataDir, workers: 1 });
  let jobId;
  try {
    ({ jobId } = await first.submit({ pdfPath }));
    await waitForCompletion(first, jobId);
  } finally {
    await first.shutdown();
  }
  // Simulate a SIGKILL mid-write under the OLD non-atomic scheme: page 2's
  // file exists but is truncated garbage.
  const tornPath = join(dataDir, jobId, 'pages', '000002.json');
  writeFileSync(tornPath, '{"pageNumber": 2, "ok": tr');
  // Job.json still says processing for the resume path to engage.
  const jobJsonPath = join(dataDir, jobId, 'job.json');
  const job = JSON.parse(readFileSync(jobJsonPath, 'utf8'));
  job.status = 'processing';
  writeFileSync(jobJsonPath, JSON.stringify(job));
  const second = new ParseService({ dataDir, workers: 1 });
  try {
    const status = await waitForCompletion(second, jobId);
    assert.equal(status.completedPages, 2);
    const page2 = JSON.parse(readFileSync(tornPath, 'utf8'));
    assert.equal(page2.ok, true, 'torn page was reprocessed, not trusted');
  } finally {
    await second.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('assembly itself refuses a non-canonical witness (defense in depth)', async () => {
  // Bypass the worker-side gate entirely: call assemblyStage directly with
  // the stub adapter. The stage must refuse regardless.
  await assert.rejects(
    assemblyStage({}, 1, createStubOcrAdapter(), {}, {}, {}, {}),
    /not a canonical witness/u
  );
  await assert.rejects(assemblyStage({}, 1, undefined, {}, {}, {}, {}), /not a canonical witness/u);
});

test('a document mutated after submission fails its pages closed', async () => {
  const { dir, pdfPath, dataDir } = fixture(1);
  // workers: 0 so nothing processes until the file has been swapped.
  const service = new ParseService({ dataDir, workers: 0 });
  try {
    const { jobId, sha256 } = await service.submit({ pdfPath });
    writeFileSync(pdfPath, minimalPdf(2));
    service.spawnWorker();
    const status = await waitForCompletion(service, jobId);
    const page = status.pages[0];
    assert.equal(page.ok, false);
    assert.match(page.failure.message, /changed since submission/u);
    assert.match(page.failure.message, new RegExp(sha256.slice(0, 12), 'u'));
  } finally {
    await service.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('render reads the context-private byte snapshot, never the live path', async () => {
  const { openDocumentContext, renderStage } = await import('../service/lib/stages.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'svc-test-'));
  const pdfPath = join(dir, 'doc.pdf');
  writeFileSync(pdfPath, minimalPdf(2)); // doc A: 612x792pt -> 980x1268 at 1.6
  const context = await openDocumentContext(pdfPath);
  try {
    // Swap the live file for a visibly different document (300x300pt).
    writeFileSync(pdfPath, minimalPdf(2, '0 0 300 300'));
    const rendered = await renderStage(context, 2);
    assert.equal(rendered.value.raster.width, 980, 'raster comes from doc A bytes, not the swapped file');
    assert.equal(rendered.value.raster.height, 1268);
  } finally {
    await context.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('over-cap POST receives an actual 413 response', async () => {
  const { fork } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'svc-test-'));
  const port = 18000 + Math.floor(Math.random() * 2000);
  const child = fork(new URL('../service/server.mjs', import.meta.url), [], {
    env: { ...process.env, PORT: String(port), SERVICE_DATA_DIR: join(dir, 'data'), SERVICE_WORKERS: '0' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not start')), 10_000);
      child.stdout.on('data', (chunk) => { if (String(chunk).includes('listening')) { clearTimeout(timer); resolve(); } });
      child.on('exit', () => reject(new Error('server exited during startup')));
    });
    const response = await fetch(`http://127.0.0.1:${port}/v1/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/pdf' },
      body: Buffer.alloc(101 * 1024 * 1024)
    });
    assert.equal(response.status, 413);
    const body = await response.json();
    assert.match(body.error, /exceeds/u);
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('degraded pool: queued pages fail closed and new submissions get 503', async () => {
  const { dir, pdfPath, dataDir } = fixture(1);
  const crashFile = join(dir, 'crash-once');
  process.env.STUB_CRASH_ONCE_FILE = crashFile;
  // Threshold 1: the first worker death degrades the pool immediately.
  const service = new ParseService({ dataDir, workers: 1, maxConsecutiveWorkerDeaths: 1 });
  try {
    const { jobId } = await service.submit({ pdfPath });
    // Pre-degrade job must COMPLETE (failed-closed), not hang.
    const status = await waitForCompletion(service, jobId);
    assert.equal(service.degraded, true);
    assert.equal(status.pages[0].ok, false);
    assert.equal(status.pages[0].failure.errorClass, 'WorkerPoolDegraded');
    // New submissions are refused loudly, not accepted into a silent hang.
    await assert.rejects(service.submit({ pdfPath }), (error) => error.statusCode === 503);
  } finally {
    delete process.env.STUB_CRASH_ONCE_FILE;
    await service.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('submit rejects a non-PDF before any worker touches it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'svc-test-'));
  const notPdf = join(dir, 'nope.pdf');
  writeFileSync(notPdf, 'this is not a pdf');
  const service = new ParseService({ dataDir: join(dir, 'data'), workers: 1 });
  try {
    await assert.rejects(service.submit({ pdfPath: notPdf }));
  } finally {
    await service.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Service enrichment phase (M3) — the design's test plan items 1–11
 * (docs/design/2026-08-23-service-deployment-and-enrichment.md; item 12,
 * routing parity, landed in M2). The Gemini boundary is stubbed via the
 * phase's injectable fetchImpl — no real calls, ever.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildPageSpatial } from '../dist/index.js';
import { ParseService } from '../service/lib/queue.mjs';

// Minimal N-page PDF with a valid xref (pdftoppm renders it).
function minimalPdf(pageCount) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>'];
  const kids = Array.from({ length: pageCount }, (_, index) => `${index + 3} 0 R`).join(' ');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`);
  for (let index = 0; index < pageCount; index += 1) {
    objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>');
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

/** A page carrying a critical-token conflict -> blocking -> adjudication rung. */
function blockingPage(sha, pageNumber, pageCount, ocrText = 'Revenue 641') {
  const page = buildPageSpatial({
    document: { documentId: 'fixture-doc', revisionId: `sha256:${sha}`, sha256: sha, pageCount },
    pageNumber,
    geometry: { width: 612, height: 792, pointWidth: 612, pointHeight: 792 },
    nativeObservations: [{ pageNumber, text: 'Revenue 647', box: [20, 20, 200, 40] }],
    ocrObservations: [{ pageNumber, text: ocrText, box: [20, 20, 200, 40], confidence: 0.99 }],
    provenance: { parserName: 'fixture', parserVersion: '1', runId: 'fixture-run', createdAt: new Date().toISOString() }
  });
  assert.equal(page.diagnostics.escalationReasons.some((reason) => reason.severity === 'blocking'), true,
    'fixture must escalate or the phase has nothing to do');
  return page;
}

/** A completed job directory the boot sweep will pick up. */
function fixtureJob({ pageCount = 1, pageEntries, enrichment = 'batch', jobId = 'job_fixture0' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'svc-enrich-'));
  const dataDir = join(dir, 'data');
  const pdf = minimalPdf(pageCount);
  const pdfPath = join(dir, 'doc.pdf');
  writeFileSync(pdfPath, pdf);
  const sha = createHash('sha256').update(pdf).digest('hex');
  const jobDir = join(dataDir, jobId);
  mkdirSync(join(jobDir, 'pages'), { recursive: true });
  const entries = pageEntries?.(sha) ?? [{ pageNumber: 1, ok: true, attempts: 1, wallMs: 5, stageTimingsMs: {}, pageSpatial: blockingPage(sha, 1, pageCount) }];
  for (const entry of entries) {
    writeFileSync(join(jobDir, 'pages', `${String(entry.pageNumber).padStart(6, '0')}.json`), JSON.stringify(entry, null, 1));
  }
  const job = {
    jobId, status: 'completed', pdfPath, sha256: sha, pageCount,
    identityOptions: {}, adapterId: 'stub-ocr', ocr: {}, enrichment,
    runId: `svc:${jobId}`, submittedAt: new Date().toISOString(), completedAt: new Date().toISOString()
  };
  writeFileSync(join(jobDir, 'job.json'), JSON.stringify(job, null, 1));
  return { dir, dataDir, jobId, jobDir, pdfPath, sha };
}

const okJson = (body) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => '' });

function payloadFor(key) {
  const kind = key.split('|')[1];
  const text = kind === 'adj'
    ? JSON.stringify({ verdicts: [{ index: 0, verdict: 'native', inkText: 'Revenue 647' }] })
    : JSON.stringify({ tokens: [{ text: '647' }] });
  return {
    candidates: [{ content: { parts: [{ text }] } }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 }
  };
}

/** Stubbed Gemini boundary: counts calls by kind, answers batch shapes. */
function makeGemini(overrides = {}) {
  const state = {
    generateContent: 0, batchSubmit: 0, poll: 0,
    bodies: [], ops: {}, doneOps: new Set(), inflight: 0, maxInflight: 0,
    neverDone: false, submitStatus: undefined, release: true,
    pollFailures: 0, pollBroken: false,
    ...overrides
  };
  state.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes(':generateContent')) {
      state.generateContent += 1;
      throw new Error('interactive generateContent fired in batch mode');
    }
    if (u.includes(':batchGenerateContent')) {
      state.batchSubmit += 1;
      if (state.submitStatus) {
        return { ok: false, status: state.submitStatus, headers: { get: () => null }, text: async () => 'refused by stub', json: async () => ({}) };
      }
      state.inflight += 1;
      state.maxInflight = Math.max(state.maxInflight, state.inflight);
      const body = JSON.parse(init.body);
      state.bodies.push(body);
      const op = `batches/op-${state.batchSubmit}`;
      state.ops[op] = body.batch.input_config.requests.requests.map((item) => item.metadata.key);
      return okJson({ name: op });
    }
    const match = u.match(/\/(batches\/op-[\w-]+)$/u);
    if (match) {
      state.poll += 1;
      const op = match[1];
      if (state.pollFailures > 0) {
        // Transport-level rejection, the reviewer's repro: ECONNRESET-class.
        state.pollFailures -= 1;
        throw new TypeError('fetch failed');
      }
      if (state.pollBroken) {
        // Response arrives but its body does not parse.
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => { throw new SyntaxError('Unexpected token < in JSON'); }, text: async () => '' };
      }
      if (state.neverDone || !state.release) return okJson({ done: false });
      const keys = state.ops[op];
      if (!keys) throw new Error(`stub has no keys for ${op}`);
      if (!state.doneOps.has(op)) { state.doneOps.add(op); state.inflight = Math.max(0, state.inflight - 1); }
      return okJson({
        done: true,
        metadata: { state: 'BATCH_STATE_SUCCEEDED' },
        response: { inlinedResponses: keys.map((key) => ({ metadata: { key }, response: payloadFor(key) })) }
      });
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  return state;
}

function makeService(dataDir, gemini, enrichmentOverrides = {}) {
  return new ParseService({
    dataDir, workers: 0,
    enrichment: {
      apiKey: 'stub-key', fetchImpl: gemini.fetch,
      pollIntervalMs: 5, batchTimeoutMs: 10_000,
      ...enrichmentOverrides
    }
  });
}

const manifestOf = (jobDir) => {
  try { return JSON.parse(readFileSync(join(jobDir, 'enrichment', 'manifest.json'), 'utf8')); } catch { return undefined; }
};

async function waitFor(predicate, what, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// ---- test plan item 1 (+ decision 7) ---------------------------------------

test('canonical page records are byte-identical after enrichment lands', async () => {
  const fixture = fixtureJob();
  const before = readFileSync(join(fixture.jobDir, 'pages', '000001.json'));
  const gemini = makeGemini();
  const service = makeService(fixture.dataDir, gemini);
  try {
    await waitFor(() => manifestOf(fixture.jobDir)?.status === 'complete', 'enrichment complete');
    const after = readFileSync(join(fixture.jobDir, 'pages', '000001.json'));
    assert.equal(before.equals(after), true, 'canonical record bytes must be untouched');
    assert.ok(existsSync(join(fixture.jobDir, 'enrichment', '000001.json')), 'record lands under enrichment/');
    assert.deepEqual(readdirSync(join(fixture.jobDir, 'pages')), ['000001.json'], 'nothing new in pages/');
  } finally {
    await service.shutdown();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

// ---- test plan item 2 (+ decision 2: own 150 dpi raster) -------------------

test('batch mode fires zero interactive Gemini calls', async () => {
  const fixture = fixtureJob();
  const gemini = makeGemini();
  const service = makeService(fixture.dataDir, gemini);
  try {
    await waitFor(() => manifestOf(fixture.jobDir)?.status === 'complete', 'enrichment complete');
    // THE invariant (ported from the runner; it broke twice there).
    assert.equal(gemini.generateContent, 0, 'no interactive calls in batch mode');
    assert.equal(gemini.batchSubmit, 1);
    const record = JSON.parse(readFileSync(join(fixture.jobDir, 'enrichment', '000001.json'), 'utf8'));
    assert.equal(record.adjudications[0].verdict, 'native');
    assert.equal(record.provenance.adjudication.transport, 'batch');
  } finally {
    await service.shutdown();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('enrichment renders its own raster at 150 dpi, not the parse raster', async () => {
  const fixture = fixtureJob();
  const gemini = makeGemini();
  const service = makeService(fixture.dataDir, gemini);
  try {
    await waitFor(() => manifestOf(fixture.jobDir)?.status === 'complete', 'enrichment complete');
    assert.equal(manifestOf(fixture.jobDir).renderDpi, 150);
    // The transmitted page image must be a 150 dpi render of 612x792pt:
    // 1275x1650 px — not the parse raster's 980x1268 (115.2 dpi).
    const parts = gemini.bodies[0].batch.input_config.requests.requests[0].request.contents[0].parts;
    const inline = parts.find((part) => part.inline_data);
    const png = Buffer.from(inline.inline_data.data, 'base64');
    assert.equal(png.readUInt32BE(16), 1275, 'PNG width is the 150 dpi render');
    assert.equal(png.readUInt32BE(20), 1650, 'PNG height is the 150 dpi render');
  } finally {
    await service.shutdown();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

// ---- test plan item 3 (decision 6, fail-open) ------------------------------

test('Gemini terminally unavailable: job stays completed, enrichment unavailable, no forged records', async () => {
  const fixture = fixtureJob();
  const gemini = makeGemini({ submitStatus: 401 });
  const service = makeService(fixture.dataDir, gemini);
  try {
    await waitFor(() => manifestOf(fixture.jobDir)?.status === 'unavailable', 'enrichment unavailable');
    const status = service.jobStatus(fixture.jobId);
    assert.equal(status.status, 'completed');
    assert.equal(status.completedPages, 1);
    assert.equal(status.enrichmentStatus, 'unavailable');
    assert.equal(status.pages[0].enrichmentState, 'unavailable');
    assert.equal(existsSync(join(fixture.jobDir, 'enrichment', '000001.json')), false, 'no partial/forged record');
    assert.equal(await service.enrichmentRecord(fixture.jobId, 1), undefined);
  } finally {
    await service.shutdown();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

// ---- test plan item 4 (fail-closed digest binding) -------------------------

test('basePageDigest mismatch at join: page refused as stale, results never attached', async () => {
  const fixture = fixtureJob();
  // A persisted manifest from "before the restart", pinned to a digest that
  // no longer matches the (since re-parsed) page record.
  mkdirSync(join(fixture.jobDir, 'enrichment'), { recursive: true });
  writeFileSync(join(fixture.jobDir, 'enrichment', 'manifest.json'), JSON.stringify({
    version: 1, jobId: fixture.jobId, renderDpi: 150, status: 'submitted',
    pages: { 1: { state: 'submitted', digest: '0'.repeat(64) } },
    chunks: [{ index: 0, state: 'submitted', operationName: 'batches/op-preexisting', keys: ['000001|adj'], pages: [1] }],
    spend: { promptTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }
  }, null, 1));
  const gemini = makeGemini({ ops: { 'batches/op-preexisting': ['000001|adj'] } });
  const service = makeService(fixture.dataDir, gemini);
  try {
    const manifest = await waitFor(() => {
      const current = manifestOf(fixture.jobDir);
      return current?.pages['1']?.state === 'stale' ? current : undefined;
    }, 'stale page state');
    assert.equal(gemini.batchSubmit, 0, 'rejoin never resubmits');
    assert.match(manifest.pages['1'].reason, /basePageDigest mismatch/u);
    assert.equal(existsSync(join(fixture.jobDir, 'enrichment', '000001.json')), false);
    assert.equal(await service.enrichmentRecord(fixture.jobId, 1), undefined);
  } finally {
    await service.shutdown();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

// ---- test plan item 5 (decision 5: boot sweep, never resubmit) -------------

test('restart mid-batch: boot sweep rejoins the persisted operation, one submission total', async () => {
  const fixture = fixtureJob();
  const gemini1 = makeGemini({ neverDone: true });
  const first = makeService(fixture.dataDir, gemini1);
  let manifest;
  try {
    manifest = await waitFor(() => {
      const current = manifestOf(fixture.jobDir);
      return current?.chunks[0]?.operationName ? current : undefined;
    }, 'operation persisted');
  } finally {
    await first.shutdown();
  }
  assert.equal(gemini1.batchSubmit, 1);
  assert.equal(manifestOf(fixture.jobDir).chunks[0].state, 'submitted', 'chunk stays live across shutdown');
  assert.equal(existsSync(join(fixture.jobDir, 'enrichment', '000001.json')), false);
  const gemini2 = makeGemini({ ops: { [manifest.chunks[0].operationName]: manifest.chunks[0].keys } });
  const second = makeService(fixture.dataDir, gemini2);
  try {
    await waitFor(() => manifestOf(fixture.jobDir)?.status === 'complete', 'rejoined completion');
    assert.equal(gemini2.batchSubmit, 0, 'no double spend across the restart');
    const record = JSON.parse(readFileSync(join(fixture.jobDir, 'enrichment', '000001.json'), 'utf8'));
    assert.equal(record.adjudications[0].verdict, 'native');
  } finally {
    await second.shutdown();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

// ---- test plan item 6 (decision 6: deadline is not terminal) ---------------

test('deadline reached while the batch still runs: chunk stays live, not closed out', async () => {
  const fixture = fixtureJob();
  const gemini = makeGemini({ neverDone: true });
  const service = makeService(fixture.dataDir, gemini, { batchTimeoutMs: 80 });
  try {
    const manifest = await waitFor(() => {
      const current = manifestOf(fixture.jobDir);
      return current?.chunks[0]?.lastError ? current : undefined;
    }, 'deadline recorded');
    assert.equal(manifest.chunks[0].state, 'submitted', 'chunk stays live for the sweep');
    assert.match(manifest.chunks[0].lastError, /deadline/u);
    assert.equal(manifest.status, 'submitted', 'job-level status reflects live work');
    assert.equal(manifest.pages['1'].state, 'submitted', 'page not marked unavailable');
  } finally {
    await service.shutdown();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

// ---- decision 6 regressions: transient errors never discard paid work ------

test('a transient poll failure retries and the batch still completes (no paid work discarded)', async () => {
  const fixture = fixtureJob();
  const gemini = makeGemini({ pollFailures: 1 }); // poll #1 throws 'fetch failed', poll #2 succeeds
  const service = makeService(fixture.dataDir, gemini);
  try {
    await waitFor(() => manifestOf(fixture.jobDir)?.status === 'complete', 'enrichment complete despite the blip');
    assert.equal(gemini.batchSubmit, 1, 'single submission');
    assert.ok(gemini.poll >= 2, 'polling continued past the failed attempt');
    const record = JSON.parse(readFileSync(join(fixture.jobDir, 'enrichment', '000001.json'), 'utf8'));
    assert.equal(record.adjudications[0].verdict, 'native');
  } finally {
    await service.shutdown();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('an unclassified poll error leaves the chunk live and a restart sweep recovers it', async () => {
  const fixture = fixtureJob();
  // Poll responses arrive but their bodies do not parse: the error escapes
  // awaitFlashBatch un-labelled. With an operation name persisted this must
  // NOT close the chunk out — the batch is paid for and still running.
  const gemini1 = makeGemini({ pollBroken: true });
  const first = makeService(fixture.dataDir, gemini1);
  let manifest;
  try {
    manifest = await waitFor(() => {
      const current = manifestOf(fixture.jobDir);
      return current?.chunks[0]?.lastError ? current : undefined;
    }, 'unclassified error recorded');
  } finally {
    await first.shutdown();
  }
  assert.equal(manifest.chunks[0].state, 'submitted', 'chunk stays live, never failed');
  assert.notEqual(manifest.pages['1'].state, 'unavailable', 'page not written off');
  const gemini2 = makeGemini({ ops: { [manifest.chunks[0].operationName]: manifest.chunks[0].keys } });
  const second = makeService(fixture.dataDir, gemini2);
  try {
    await waitFor(() => manifestOf(fixture.jobDir)?.status === 'complete', 'sweep recovered the paid batch');
    assert.equal(gemini2.batchSubmit, 0, 'recovered, not repurchased');
    assert.ok(existsSync(join(fixture.jobDir, 'enrichment', '000001.json')));
  } finally {
    await second.shutdown();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

// ---- test plan item 7 (cost caps) ------------------------------------------

test('per-job page cap exceeded: parse-only with a stated reason, nothing submitted', async () => {
  const fixture = fixtureJob();
  const gemini = makeGemini();
  const service = makeService(fixture.dataDir, gemini, { maxPagesPerJob: 0 });
  try {
    const manifest = await waitFor(() => {
      const current = manifestOf(fixture.jobDir);
      return current?.status === 'unavailable' ? current : undefined;
    }, 'cap refusal');
    assert.match(manifest.reason, /ENRICH_MAX_PAGES_PER_JOB/u);
    assert.equal(gemini.batchSubmit, 0);
    assert.equal(service.jobStatus(fixture.jobId).status, 'completed');
    // A cap-refused job must not inflate the rung counters: nothing was
    // actually submitted.
    assert.equal(service.metrics.snapshot().enrichment.pagesPerRung.adjudication, 0);
  } finally {
    await service.shutdown();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('service spend ceiling reached: parse-only with a stated reason, nothing submitted', async () => {
  const fixture = fixtureJob();
  const gemini = makeGemini();
  const service = makeService(fixture.dataDir, gemini, { spendCeilingUsd: 0 });
  try {
    const manifest = await waitFor(() => {
      const current = manifestOf(fixture.jobDir);
      return current?.status === 'unavailable' ? current : undefined;
    }, 'ceiling refusal');
    assert.match(manifest.reason, /ENRICH_SPEND_CEILING_USD/u);
    assert.equal(gemini.batchSubmit, 0);
  } finally {
    await service.shutdown();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('concurrent-chunk limit: chunks queue, at most the cap in flight', async () => {
  // Two jobs, one chunk each, limit 1: the second submit must wait for the
  // first chunk to resolve.
  const dir = mkdtempSync(join(tmpdir(), 'svc-enrich-'));
  const dataDir = join(dir, 'data');
  const pdf = minimalPdf(1);
  const sha = createHash('sha256').update(pdf).digest('hex');
  for (const jobId of ['job_chunk_a', 'job_chunk_b']) {
    const jobDir = join(dataDir, jobId);
    mkdirSync(join(jobDir, 'pages'), { recursive: true });
    const pdfPath = join(dir, `${jobId}.pdf`);
    writeFileSync(pdfPath, pdf);
    writeFileSync(join(jobDir, 'pages', '000001.json'), JSON.stringify({
      pageNumber: 1, ok: true, attempts: 1, wallMs: 5, stageTimingsMs: {}, pageSpatial: blockingPage(sha, 1, 1)
    }));
    writeFileSync(join(jobDir, 'job.json'), JSON.stringify({
      jobId, status: 'completed', pdfPath, sha256: sha, pageCount: 1, identityOptions: {},
      adapterId: 'stub-ocr', ocr: {}, enrichment: 'batch', runId: `svc:${jobId}`,
      submittedAt: new Date().toISOString(), completedAt: new Date().toISOString()
    }));
  }
  const gemini = makeGemini();
  const service = makeService(dataDir, gemini, { maxConcurrentChunks: 1 });
  try {
    await waitFor(() => manifestOf(join(dataDir, 'job_chunk_a'))?.status === 'complete'
      && manifestOf(join(dataDir, 'job_chunk_b'))?.status === 'complete', 'both jobs enriched');
    assert.equal(gemini.batchSubmit, 2);
    assert.equal(gemini.maxInflight, 1, 'never more than the chunk cap in flight');
  } finally {
    await service.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- test plan item 8 (decision 4: storage cannot corrupt completion) ------

test('a job carrying enrichment records still reports correct completedPages', async () => {
  const fixture = fixtureJob();
  const gemini = makeGemini();
  const service = makeService(fixture.dataDir, gemini);
  try {
    await waitFor(() => manifestOf(fixture.jobDir)?.status === 'complete', 'enrichment complete');
    const status = service.jobStatus(fixture.jobId);
    assert.equal(status.completedPages, 1);
    assert.equal(status.pages.length, 1);
    assert.equal(status.pages[0].pageNumber, 1);
    assert.equal(status.enrichmentStatus, 'complete');
    assert.equal(status.pages[0].enrichmentState, 'complete');
  } finally {
    await service.shutdown();
  }
  // A restarted service must count the same: resume() and checkCompletion()
  // stay scoped to pages/ with enrichment artifacts on disk.
  const second = new ParseService({ dataDir: fixture.dataDir, workers: 0, enrichment: { apiKey: 'stub-key', fetchImpl: makeGemini().fetch } });
  try {
    const status = second.jobStatus(fixture.jobId);
    assert.equal(status.status, 'completed');
    assert.equal(status.completedPages, 1);
  } finally {
    await second.shutdown();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

// ---- test plan item 9 (decision 7: failed pages) ---------------------------

test('a failed page is never routed to any rung, even with a smuggled pageSpatial', async () => {
  const fixture = fixtureJob({
    pageCount: 2,
    pageEntries: (sha) => [
      { pageNumber: 1, ok: true, attempts: 1, wallMs: 5, stageTimingsMs: {}, pageSpatial: blockingPage(sha, 1, 2) },
      // Adversarial wrapper: ok:false but a blocking pageSpatial attached.
      // Routing keys off the WHOLE stored record, so this must not route.
      { pageNumber: 2, ok: false, attempts: 2, failure: { message: 'boom', errorClass: 'Error' }, pageSpatial: blockingPage(sha, 2, 2) }
    ]
  });
  const gemini = makeGemini();
  const service = makeService(fixture.dataDir, gemini);
  try {
    const manifest = await waitFor(() => {
      const current = manifestOf(fixture.jobDir);
      return current && current.status !== 'pending' && current.status !== 'submitted' ? current : undefined;
    }, 'enrichment settled');
    assert.equal(manifest.pages['2'].state, 'not-qualified');
    const submittedKeys = gemini.bodies.flatMap((body) => body.batch.input_config.requests.requests.map((item) => item.metadata.key));
    assert.deepEqual(submittedKeys, ['000001|adj'], 'only the ok page was routed');
    assert.equal(existsSync(join(fixture.jobDir, 'enrichment', '000002.json')), false);
  } finally {
    await service.shutdown();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

// ---- test plan item 10 (decision 7: re-parse invalidates) ------------------

test('a re-parsed page marks its stored enrichment stale and it is never served', async () => {
  const fixture = fixtureJob();
  const gemini = makeGemini();
  const service = makeService(fixture.dataDir, gemini);
  try {
    await waitFor(() => manifestOf(fixture.jobDir)?.status === 'complete', 'enrichment complete');
    assert.ok(await service.enrichmentRecord(fixture.jobId, 1), 'served while fresh');
    // Re-parse: a requeued page produces a new record with a new digest.
    writeFileSync(join(fixture.jobDir, 'pages', '000001.json'), JSON.stringify({
      pageNumber: 1, ok: true, attempts: 1, wallMs: 5, stageTimingsMs: {},
      pageSpatial: blockingPage(fixture.sha, 1, 1, 'Revenue 649')
    }, null, 1));
    assert.equal(await service.enrichmentRecord(fixture.jobId, 1), undefined, 'stale enrichment never served');
    assert.equal(manifestOf(fixture.jobDir).pages['1'].state, 'stale');
  } finally {
    await service.shutdown();
  }
  // The boot sweep detects the same mismatch independently.
  const manifest = manifestOf(fixture.jobDir);
  manifest.pages['1'].state = 'complete'; // pretend nobody noticed yet
  writeFileSync(join(fixture.jobDir, 'enrichment', 'manifest.json'), JSON.stringify(manifest, null, 1));
  const second = new ParseService({ dataDir: fixture.dataDir, workers: 0, enrichment: { apiKey: 'stub-key', fetchImpl: makeGemini().fetch } });
  try {
    await waitFor(() => manifestOf(fixture.jobDir)?.pages['1'].state === 'stale', 'sweep marks stale');
  } finally {
    await second.shutdown();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

// ---- test plan item 11 (egress) --------------------------------------------

test('a pdfPath-submitted job refuses enrichment with a 400-class error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'svc-enrich-'));
  writeFileSync(join(dir, 'doc.pdf'), minimalPdf(1));
  const service = new ParseService({ dataDir: join(dir, 'data'), workers: 0 });
  try {
    await assert.rejects(
      service.submit({ pdfPath: join(dir, 'doc.pdf'), enrichment: 'batch', source: 'path' }),
      (error) => error.statusCode === 400 && /pdfPath/u.test(error.message)
    );
    await assert.rejects(
      service.submit({ pdfPath: join(dir, 'doc.pdf'), enrichment: 'nonsense', source: 'upload' }),
      (error) => error.statusCode === 400
    );
  } finally {
    await service.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('egress: PDF bytes that no longer match the job sha are never transmitted', async () => {
  const fixture = fixtureJob();
  writeFileSync(fixture.pdfPath, minimalPdf(2)); // swap the bytes post-submission
  const gemini = makeGemini();
  const service = makeService(fixture.dataDir, gemini);
  try {
    const manifest = await waitFor(() => {
      const current = manifestOf(fixture.jobDir);
      return current?.status === 'unavailable' ? current : undefined;
    }, 'egress refusal');
    assert.match(manifest.reason, /documentSha256/u);
    assert.equal(gemini.batchSubmit, 0, 'nothing transmitted');
  } finally {
    await service.shutdown();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('a builder-rejected page pulls the job to partial, never a silent complete', async () => {
  const fixture = fixtureJob({
    pageCount: 2,
    pageEntries: (sha) => {
      const broken = blockingPage(sha, 2, 2);
      // A conflict referencing an unknown OCR observation: the plan builder
      // fails this page closed (M2), and the job must say so.
      broken.conflicts[0].ocrId = 'obs:bogus';
      return [
        { pageNumber: 1, ok: true, attempts: 1, wallMs: 5, stageTimingsMs: {}, pageSpatial: blockingPage(sha, 1, 2) },
        { pageNumber: 2, ok: true, attempts: 1, wallMs: 5, stageTimingsMs: {}, pageSpatial: broken }
      ];
    }
  });
  const gemini = makeGemini();
  const service = makeService(fixture.dataDir, gemini);
  try {
    const manifest = await waitFor(() => {
      const current = manifestOf(fixture.jobDir);
      return current?.status && !['pending', 'submitted'].includes(current.status) ? current : undefined;
    }, 'settled');
    assert.equal(manifest.pages['1'].state, 'complete');
    assert.equal(manifest.pages['2'].state, 'unavailable');
    assert.match(manifest.pages['2'].reason, /unknown OCR observation/u);
    assert.equal(manifest.status, 'partial', 'a page-level refusal must not read as complete');
  } finally {
    await service.shutdown();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

// ---- live production path (upload -> parse -> completion -> phase B) -------

test('an uploaded job triggers phase B through real parse completion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'svc-enrich-live-'));
  const pdfPath = join(dir, 'doc.pdf');
  writeFileSync(pdfPath, minimalPdf(1));
  const gemini = makeGemini();
  // Real workers (stub witness), real submit: this drives the
  // checkCompletion -> enrichmentPhase.start trigger, not the boot sweep.
  const service = new ParseService({
    dataDir: join(dir, 'data'), workers: 1,
    enrichment: { apiKey: 'stub-key', fetchImpl: gemini.fetch, pollIntervalMs: 5, batchTimeoutMs: 10_000 }
  });
  try {
    const { jobId } = await service.submit({ pdfPath, enrichment: 'batch', source: 'upload' });
    const jobDir = join(dir, 'data', jobId);
    await waitFor(() => service.jobStatus(jobId)?.status === 'completed', 'parse completed', 60_000);
    await waitFor(() => manifestOf(jobDir)?.status === 'complete', 'phase B ran after completion');
    const status = service.jobStatus(jobId);
    assert.equal(status.enrichmentStatus, 'complete');
    // Stub witness pages are non-canonical: nothing qualifies, nothing is
    // transmitted — but the phase demonstrably ran on the live path.
    assert.equal(status.pages[0].enrichmentState, 'not-qualified');
    assert.equal(gemini.batchSubmit, 0);
  } finally {
    await service.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- API surface + metrics -------------------------------------------------

test('per-page states distinguish no-eligible-region from not-qualified', async () => {
  const fixture = fixtureJob({
    pageCount: 2,
    pageEntries: (sha) => [
      // Residue alarm fired but nothing crop-eligible.
      {
        pageNumber: 1, ok: true, attempts: 1, wallMs: 5, stageTimingsMs: {},
        pageSpatial: {
          geometry: { width: 979, height: 1267, pointWidth: 612, pointHeight: 792 },
          diagnostics: { escalationReasons: [{ type: 'unread-ink-region', severity: 'blocking' }] },
          unreadInkRegions: [], conflicts: [], ocrObservations: [], nativeObservations: []
        }
      },
      // Clean page: no blocking reasons at all.
      {
        pageNumber: 2, ok: true, attempts: 1, wallMs: 5, stageTimingsMs: {},
        pageSpatial: {
          geometry: { width: 979, height: 1267, pointWidth: 612, pointHeight: 792 },
          diagnostics: { escalationReasons: [] },
          unreadInkRegions: [], conflicts: [], ocrObservations: [], nativeObservations: []
        }
      }
    ]
  });
  const gemini = makeGemini();
  const service = makeService(fixture.dataDir, gemini);
  try {
    const manifest = await waitFor(() => {
      const current = manifestOf(fixture.jobDir);
      return current?.status === 'complete' ? current : undefined;
    }, 'settled');
    assert.equal(manifest.pages['1'].state, 'no-eligible-region');
    assert.equal(manifest.pages['2'].state, 'not-qualified');
    assert.equal(gemini.batchSubmit, 0);
    assert.equal(service.metrics.snapshot().enrichment.noEligibleRegionPages, 1);
  } finally {
    await service.shutdown();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('/v1/metrics counters: rungs, tokens, spend, batch wall time reconcile with the job', async () => {
  const fixture = fixtureJob();
  const gemini = makeGemini();
  const service = makeService(fixture.dataDir, gemini);
  try {
    await waitFor(() => manifestOf(fixture.jobDir)?.status === 'complete', 'enrichment complete');
    const snapshot = service.metrics.snapshot().enrichment;
    assert.equal(snapshot.pagesPerRung.adjudication, 1);
    assert.equal(snapshot.pagesPerRung.fullTranscription, 0);
    assert.equal(snapshot.pagesComplete, 1);
    assert.equal(snapshot.chunksCompleted, 1);
    assert.equal(snapshot.promptTokens, 100);
    assert.equal(snapshot.outputTokens, 10);
    // The runner's per-source accounting: batch tokens at 0.5x.
    const expected = ((100 * 0.75 + 10 * 3.75) / 1e6) * 0.5;
    // Ledgers round to microdollars; assert within that granularity.
    assert.ok(Math.abs(snapshot.estimatedSpendUsd - expected) <= 1e-6,
      `spend ${snapshot.estimatedSpendUsd} != ${expected}`);
    assert.equal(snapshot.spendCeilingUsd, 10);
    // Reconciles with the job's own ledger.
    const manifest = manifestOf(fixture.jobDir);
    assert.equal(manifest.spend.promptTokens, snapshot.promptTokens);
    assert.equal(manifest.spend.outputTokens, snapshot.outputTokens);
  } finally {
    await service.shutdown();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('HTTP surface: enrichment field validated, endpoint 404s when no record exists', async () => {
  const { fork } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'svc-enrich-http-'));
  const port = 18000 + Math.floor(Math.random() * 2000);
  const child = fork(new URL('../service/server.mjs', import.meta.url), [], {
    env: { ...process.env, PORT: String(port), SERVICE_DATA_DIR: join(dir, 'data'), SERVICE_WORKERS: '0', GEMINI_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not start')), 10_000);
      child.stdout.on('data', (chunk) => { if (String(chunk).includes('listening')) { clearTimeout(timer); resolve(); } });
      child.on('exit', () => reject(new Error('server exited during startup')));
    });
    const base = `http://127.0.0.1:${port}`;
    // pdfPath mode + enrichment: refused with the egress reason (item 11).
    const refused = await fetch(`${base}/v1/jobs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pdfPath: join(dir, 'nope.pdf'), enrichment: 'batch' })
    });
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error, /pdfPath/u);
    // Invalid vocabulary: 400, not silently off.
    const invalid = await fetch(`${base}/v1/jobs?enrichment=sync`, {
      method: 'POST', headers: { 'content-type': 'application/pdf' }, body: minimalPdf(1)
    });
    assert.equal(invalid.status, 400);
    // Uploaded bytes + batch: accepted; status carries enrichmentStatus;
    // the per-page enrichment endpoint 404s while no record exists.
    const accepted = await fetch(`${base}/v1/jobs?enrichment=batch`, {
      method: 'POST', headers: { 'content-type': 'application/pdf' }, body: minimalPdf(1)
    });
    assert.equal(accepted.status, 202);
    const { jobId } = await accepted.json();
    const status = await (await fetch(`${base}/v1/jobs/${jobId}`)).json();
    assert.ok(['pending', 'unavailable'].includes(status.enrichmentStatus), `enrichmentStatus present, got ${status.enrichmentStatus}`);
    const none = await fetch(`${base}/v1/jobs/${jobId}/pages/1/enrichment`);
    assert.equal(none.status, 404);
    // Jobs without enrichment report it disabled (additive, non-breaking).
    const off = await fetch(`${base}/v1/jobs`, {
      method: 'POST', headers: { 'content-type': 'application/pdf' }, body: minimalPdf(1)
    });
    const offStatus = await (await fetch(`${base}/v1/jobs/${(await off.json()).jobId}`)).json();
    assert.equal(offStatus.enrichmentStatus, 'disabled');
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

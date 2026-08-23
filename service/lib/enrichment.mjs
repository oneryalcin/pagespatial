/**
 * Service enrichment phase (design 2026-08-23, workstream 2, M3).
 *
 * Phase B after parse: when a job requested enrichment: "batch", collect
 * qualifying pages, build request plans via the shared library builder
 * (src/enrichment-plan.ts — the same routing the evaluation runner uses,
 * so the measured cost ladder describes production), submit chunked Gemini
 * batches, poll, and land enrichment records as separate artifacts:
 *
 *   <jobDir>/enrichment/NNNNNN.json     enrichment records
 *   <jobDir>/enrichment/manifest.json   chunk list, operation names, state
 *
 * NOTHING is ever written into <jobDir>/pages/ — checkCompletion, resume
 * and jobStatus stay scoped there (decision 4), and canonical records are
 * never touched (decision 7).
 *
 * Failure asymmetry (decision 6): fail-OPEN on enrichment — Gemini down,
 * over budget, malformed responses all leave the job completed with
 * enrichment 'unavailable'. Fail-CLOSED inside it — a basePageDigest
 * mismatch refuses the page ('stale'), a malformed adjudication verdict
 * defaults to 'unsure' in the parser, and schema-invalid records are
 * refused by buildEscalatedOcrEnrichment.
 *
 * Zero interactive Gemini calls, structurally: this module imports only
 * the request BUILDERS and the batch executor — the interactive adapters
 * (transcribePageImage, adjudicatePageConflicts, transcribeResidueCrops)
 * are never imported, and the runner's invariant test is ported to the
 * service (test/service-enrichment.test.mjs).
 *
 * Enrichment renders its OWN raster at 150 dpi (decision 2) — the plan's
 * renderDpi is the contract; the parse raster (115.2 dpi) is never reused.
 * Renders go through async execFile so they never block the server's
 * event loop (the server owns polling, decision 5).
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

import { writeFileAtomic } from './atomic.mjs';
import { buildEnrichmentRequestPlan, buildEscalatedOcrEnrichment, pageDigest } from '../../dist/index.js';
import {
  awaitFlashBatch,
  runFlashBatch,
  buildAdjudicationRequest,
  buildResidueCropsRequest,
  buildTranscriptionRequest,
  parseAdjudicationPayload,
  parseTranscriptionPayload,
  adjudicationProvenance,
  transcriptionProvenance,
  RESIDUE_CROPS_PROMPT_REVISION
} from '../../dist/node/flash-ocr.js';

const execFileAsync = promisify(execFile);

/**
 * Decision 2: the dpi every measured enrichment number was produced at.
 * Not configurable — changing it re-prices the whole ladder.
 */
export const ENRICH_RENDER_DPI = 150;

/**
 * Owner-decided caps (design "Open questions — ANSWERED"), env-overridable.
 * Entries-per-chunk keeps one submit body bounded (requests inline base64
 * PNGs; decision 3 makes chunking mandatory, not an optimisation).
 */
const DEFAULT_MAX_PAGES_PER_JOB = 200; // ENRICH_MAX_PAGES_PER_JOB
const DEFAULT_MAX_CONCURRENT_CHUNKS = 4; // ENRICH_MAX_CONCURRENT_CHUNKS
const DEFAULT_SPEND_CEILING_USD = 10; // ENRICH_SPEND_CEILING_USD
const DEFAULT_MAX_ENTRIES_PER_CHUNK = 24; // ENRICH_MAX_ENTRIES_PER_CHUNK

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number, got '${raw}'.`);
  }
  return value;
}

/**
 * The runner's per-source accounting: batch tokens bill at 0.5x of the
 * interactive price (scripts/evaluation/run-flash-enrichment.mjs). The
 * service submits everything through the batch API, so every token here
 * rides the discount.
 */
export function estimateBatchCostUsd(promptTokens, outputTokens) {
  return ((promptTokens * 0.75 + outputTokens * 3.75) / 1e6) * 0.5;
}

const padded = (pageNumber) => String(pageNumber).padStart(6, '0');

function safeReaddir(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}

/** Render one whole page at `dpi` (a second pdftoppm pass — decision 2). */
async function renderPagePng(pdfPath, pageNumber, dpi) {
  const dir = mkdtempSync(join(tmpdir(), 'psvc-enrich-'));
  try {
    await execFileAsync('pdftoppm', ['-f', String(pageNumber), '-l', String(pageNumber), '-r', String(dpi), '-png', pdfPath, join(dir, 'p')]);
    const file = readdirSync(dir).find((name) => name.endsWith('.png'));
    if (!file) throw new Error(`pdftoppm produced no output for page ${pageNumber}.`);
    return readFileSync(join(dir, file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Render one residue crop; the window comes pre-computed on the plan. */
async function renderCropPng(pdfPath, pageNumber, dpi, crop) {
  const dir = mkdtempSync(join(tmpdir(), 'psvc-crop-'));
  try {
    await execFileAsync('pdftoppm', ['-f', String(pageNumber), '-l', String(pageNumber), '-r', String(dpi),
      '-x', String(crop.x), '-y', String(crop.y), '-W', String(crop.w), '-H', String(crop.h), '-png', pdfPath, join(dir, 'c')]);
    const file = readdirSync(dir).find((name) => name.endsWith('.png'));
    if (!file) throw new Error('pdftoppm produced no crop output.');
    return readFileSync(join(dir, file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export class EnrichmentPhase {
  constructor({ dataDir, metrics, options = {} }) {
    this.dataDir = dataDir;
    this.metrics = metrics;
    // API key from environment only (per-request keys are multi-tenancy, #76).
    this.apiKey = options.apiKey ?? process.env.GEMINI_API_KEY;
    this.fetchImpl = options.fetchImpl; // tests stub the Gemini boundary here
    this.maxPagesPerJob = options.maxPagesPerJob ?? envNumber('ENRICH_MAX_PAGES_PER_JOB', DEFAULT_MAX_PAGES_PER_JOB);
    this.maxConcurrentChunks = Math.max(1, options.maxConcurrentChunks ?? envNumber('ENRICH_MAX_CONCURRENT_CHUNKS', DEFAULT_MAX_CONCURRENT_CHUNKS));
    this.spendCeilingUsd = options.spendCeilingUsd ?? envNumber('ENRICH_SPEND_CEILING_USD', DEFAULT_SPEND_CEILING_USD);
    this.maxEntriesPerChunk = Math.max(1, options.maxEntriesPerChunk ?? envNumber('ENRICH_MAX_ENTRIES_PER_CHUNK', DEFAULT_MAX_ENTRIES_PER_CHUNK));
    this.pollIntervalMs = options.pollIntervalMs ?? 15_000;
    this.batchTimeoutMs = options.batchTimeoutMs ?? 60 * 60 * 1000;
    // Service-lifetime spend ledger (the ceiling is per process lifetime).
    this.spentUsd = 0;
    this.metrics?.setEnrichmentCeiling?.(this.spendCeilingUsd);
    // Service-wide concurrent-CHUNK semaphore (chunks, not jobs — chunks
    // are what consume API concurrency and memory). Parse capacity is
    // workers; enrichment capacity is remote — disjoint by construction,
    // so phase A of new jobs proceeds while phase B queues here.
    this.activeChunks = 0;
    this.chunkWaiters = [];
    this.tasks = new Set();
    this.abortController = new AbortController();
  }

  get aborted() { return this.abortController.signal.aborted; }

  jobDir(jobId) { return join(this.dataDir, jobId); }
  enrichmentDir(jobId) { return join(this.jobDir(jobId), 'enrichment'); }
  manifestPath(jobId) { return join(this.enrichmentDir(jobId), 'manifest.json'); }
  recordPath(jobId, pageNumber) { return join(this.enrichmentDir(jobId), `${padded(pageNumber)}.json`); }

  readManifest(jobId) { return readJson(this.manifestPath(jobId)); }

  writeManifest(jobId, manifest) {
    mkdirSync(this.enrichmentDir(jobId), { recursive: true });
    writeFileAtomic(this.manifestPath(jobId), JSON.stringify(manifest, null, 1));
  }

  async readPageRecord(jobId, pageNumber) {
    try {
      return JSON.parse(await readFile(join(this.jobDir(jobId), 'pages', `${padded(pageNumber)}.json`), 'utf8'));
    } catch {
      return undefined;
    }
  }

  /**
   * The runner's egress check, carried over: the bytes about to be rendered
   * and transmitted must hash to the job's pinned documentSha256. Hashed
   * FRESH before every chunk transmission — no memoization, so "re-verified
   * immediately before transmission" holds for every chunk, not just the
   * first — and streamed so a large PDF never blocks the event loop.
   */
  async assertPdfMatchesJob(pdfPath, expectedSha) {
    const hash = createHash('sha256');
    await pipeline(createReadStream(pdfPath), hash);
    const actual = hash.digest('hex');
    if (actual !== expectedSha) {
      throw new Error(`PDF bytes at ${pdfPath} (${actual.slice(0, 12)}…) do not match the job's documentSha256; refusing to transmit.`);
    }
  }

  async acquireChunkSlot() {
    if (this.activeChunks < this.maxConcurrentChunks) { this.activeChunks += 1; return; }
    await new Promise((resolve) => this.chunkWaiters.push(resolve));
    this.activeChunks += 1;
  }

  releaseChunkSlot() {
    this.activeChunks -= 1;
    const waiter = this.chunkWaiters.shift();
    if (waiter) waiter();
  }

  /**
   * Fire-and-forget entry point; every failure inside is fail-open.
   * Per-job in-flight guard: checkCompletion and the boot sweep can both
   * reach a job — a second concurrent run would rebuild the manifest and
   * resubmit, which is exactly the double spend the manifest exists to
   * prevent.
   */
  start(job) {
    this.activeJobs ??= new Set();
    if (this.activeJobs.has(job.jobId)) return;
    this.activeJobs.add(job.jobId);
    const task = this.runJob(job).finally(() => this.activeJobs.delete(job.jobId)).catch((error) => {
      console.error(`enrichment ${job.jobId}: ${String(error?.message ?? error)}`);
      try { this.markUnavailable(job.jobId, String(error?.message ?? error).slice(0, 300)); } catch { /* fail-open */ }
    });
    this.tasks.add(task);
    task.finally(() => this.tasks.delete(task));
    return task;
  }

  /** Await in-flight phase work (tests; shutdown). */
  async idle() { await Promise.allSettled([...this.tasks]); }

  async shutdown() {
    this.abortController.abort();
    await this.idle();
  }

  markUnavailable(jobId, reason) {
    const manifest = this.readManifest(jobId) ?? {
      version: 1, jobId, renderDpi: ENRICH_RENDER_DPI, status: 'pending', pages: {}, chunks: [],
      spend: { promptTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }
    };
    manifest.status = 'unavailable';
    manifest.reason = reason;
    for (const entry of Object.values(manifest.pages)) {
      if (entry.state === 'pending' || entry.state === 'submitted') entry.state = 'unavailable';
    }
    this.writeManifest(jobId, manifest);
  }

  /**
   * Boot sweep (decision 5): scans job dirs for enrichment work to rejoin,
   * INDEPENDENT of job.status — resume() short-circuits on completed jobs,
   * and a job whose parse finished is exactly such a job. Also discards
   * partial enrichment artifacts and marks records stale when their page
   * was re-parsed (decision 7).
   */
  async sweep(jobs) {
    for (const [jobId, job] of jobs) {
      if (job.enrichment !== 'batch') continue;
      try {
        await this.sweepJob(jobId, job);
      } catch (error) {
        console.error(`enrichment sweep ${jobId}: ${String(error?.message ?? error)}`);
      }
    }
  }

  async sweepJob(jobId, job) {
    const dir = this.enrichmentDir(jobId);
    // Partial records are discarded on resume, never trusted (decision 4).
    for (const name of safeReaddir(dir)) {
      if (name === 'manifest.json') continue;
      if (name.includes('.tmp-') || readJson(join(dir, name)) === undefined) {
        rmSync(join(dir, name), { force: true });
      }
    }
    const manifest = this.readManifest(jobId);
    if (!manifest) {
      // Crashed between parse completion and phase B start: nothing was
      // ever submitted, so starting fresh cannot double-spend.
      if (job.status === 'completed') this.start(job);
      return;
    }
    // Re-parsed pages invalidate stored enrichment: mark stale, never serve.
    let changed = false;
    for (const [pageNumber, entry] of Object.entries(manifest.pages)) {
      if (entry.state !== 'complete') continue;
      const record = await this.readPageRecord(jobId, Number(pageNumber));
      const page = record?.ok === false ? undefined : record?.pageSpatial;
      const digest = page ? await pageDigest(page) : undefined;
      if (digest !== entry.digest) {
        entry.state = 'stale';
        entry.reason = 'page re-parsed since enrichment (basePageDigest mismatch)';
        changed = true;
      }
    }
    const unresolved = manifest.chunks.some((chunk) => chunk.state === 'pending' || chunk.state === 'submitted');
    if (unresolved) {
      if (changed) this.writeManifest(jobId, manifest);
      this.start(job); // rejoins persisted operations; never resubmits paid work
    } else if (changed) {
      this.finalizeStatus(manifest);
      this.writeManifest(jobId, manifest);
    }
  }

  /** jobStatus() composition — never touches stored page records. */
  view(job) {
    if (job.enrichment !== 'batch') return { status: 'disabled', pageState: () => undefined };
    const manifest = this.readManifest(job.jobId);
    if (!manifest) return { status: 'pending', pageState: () => 'pending' };
    return {
      status: manifest.status,
      ...(manifest.reason ? { reason: manifest.reason } : {}),
      pageState: (pageNumber) => manifest.pages[String(pageNumber)]?.state ?? 'pending'
    };
  }

  /**
   * The record for GET /v1/jobs/:id/pages/:n/enrichment. Serving-time
   * staleness gate: a stored enrichment whose basePageDigest no longer
   * matches the current canonical page is marked stale and NEVER served.
   */
  async record(jobId, pageNumber) {
    const stored = readJson(this.recordPath(jobId, pageNumber));
    if (!stored) return undefined;
    const pageRecord = await this.readPageRecord(jobId, pageNumber);
    const page = pageRecord?.ok === false ? undefined : pageRecord?.pageSpatial;
    if (!page || stored.basePageDigest !== await pageDigest(page)) {
      const manifest = this.readManifest(jobId);
      const entry = manifest?.pages?.[String(pageNumber)];
      if (entry && entry.state !== 'stale') {
        entry.state = 'stale';
        entry.reason = 'page re-parsed since enrichment (basePageDigest mismatch)';
        this.writeManifest(jobId, manifest);
      }
      return undefined;
    }
    return stored;
  }

  async runJob(job) {
    let manifest = this.readManifest(job.jobId);
    if (!manifest) {
      manifest = await this.buildManifest(job);
      if (!manifest) return; // terminal decision already persisted (caps, no key, …)
    }
    for (const chunk of manifest.chunks) {
      if (this.aborted) break;
      if (chunk.state !== 'pending' && chunk.state !== 'submitted') continue;
      await this.processChunk(job, manifest, chunk);
    }
    this.finalizeStatus(manifest);
    this.writeManifest(job.jobId, manifest);
  }

  /**
   * Routing: build the request plan for EVERY stored page record — the
   * WHOLE wrapper, `ok` included, goes to the builder, which returns an
   * empty plan for a failed page. A failed page is never routed to any
   * rung (decision 7: enrichment must not substitute model output for
   * missing evidence).
   */
  async buildManifest(job) {
    const jobId = job.jobId;
    const manifest = {
      version: 1,
      jobId,
      renderDpi: ENRICH_RENDER_DPI,
      status: 'pending',
      createdAt: new Date().toISOString(),
      pages: {},
      chunks: [],
      spend: { promptTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }
    };
    const targets = [];
    let noEligibleRegionPages = 0;
    for (let pageNumber = 1; pageNumber <= job.pageCount; pageNumber += 1) {
      const record = await this.readPageRecord(jobId, pageNumber);
      if (!record) { manifest.pages[String(pageNumber)] = { state: 'not-qualified' }; continue; }
      let plan;
      try {
        plan = buildEnrichmentRequestPlan(record, { renderDpi: ENRICH_RENDER_DPI });
      } catch (error) {
        // A record the builder rejects fails that one page, never the job.
        manifest.pages[String(pageNumber)] = { state: 'unavailable', reason: String(error?.message ?? error).slice(0, 200) };
        continue;
      }
      const rungs = [];
      if (plan.fullTranscription) rungs.push('full');
      else if (plan.residueCrops) rungs.push('crops');
      if (plan.adjudication) rungs.push('adj');
      if (plan.residueUnanswered) noEligibleRegionPages += 1;
      if (!rungs.length) {
        manifest.pages[String(pageNumber)] = { state: plan.residueUnanswered ? 'no-eligible-region' : 'not-qualified' };
        continue;
      }
      const digest = await pageDigest(record.pageSpatial);
      manifest.pages[String(pageNumber)] = { state: 'pending', digest };
      targets.push({ pageNumber, rungs });
    }
    if (!this.apiKey) {
      manifest.status = 'unavailable';
      manifest.reason = 'GEMINI_API_KEY is not set; enrichment unavailable.';
    } else if (targets.length > this.maxPagesPerJob) {
      manifest.status = 'unavailable';
      manifest.reason = `${targets.length} qualifying pages exceed ENRICH_MAX_PAGES_PER_JOB=${this.maxPagesPerJob}; parse-only.`;
    } else if (this.spentUsd >= this.spendCeilingUsd) {
      manifest.status = 'unavailable';
      manifest.reason = `service spend ceiling ENRICH_SPEND_CEILING_USD=${this.spendCeilingUsd} reached; parse-only.`;
    }
    if (manifest.status === 'unavailable') {
      for (const entry of Object.values(manifest.pages)) {
        if (entry.state === 'pending') entry.state = 'unavailable';
      }
      this.writeManifest(jobId, manifest);
      return undefined;
    }
    // Metrics land only for work that will actually be submitted — a job
    // refused by the caps must not inflate the rung counters.
    for (let i = 0; i < noEligibleRegionPages; i += 1) this.metrics?.recordEnrichmentNoEligibleRegion?.();
    for (const target of targets) this.metrics?.recordEnrichmentRouting?.(target.rungs);
    if (!targets.length) {
      // Not hard-coded 'complete': a builder-rejected page ('unavailable')
      // must surface as partial/unavailable, not vanish behind a green job.
      this.finalizeStatus(manifest);
      this.writeManifest(jobId, manifest);
      return undefined;
    }
    // Chunking (decision 3): bounded entries per submit body; a page's
    // rungs never split across chunks, so joining a page needs one chunk.
    let current;
    for (const target of targets) {
      if (!current || current.entryCount + target.rungs.length > this.maxEntriesPerChunk) {
        current = { index: manifest.chunks.length, state: 'pending', keys: [], pages: [], entryCount: 0 };
        manifest.chunks.push(current);
      }
      current.pages.push(target.pageNumber);
      for (const rung of target.rungs) current.keys.push(`${padded(target.pageNumber)}|${rung}`);
      current.entryCount += target.rungs.length;
    }
    for (const chunk of manifest.chunks) delete chunk.entryCount;
    // Persist BEFORE any submission: the manifest is the recovery handle.
    this.writeManifest(jobId, manifest);
    return manifest;
  }

  /**
   * Rebuild the raw requests for one never-submitted chunk. Renders the
   * enrichment raster at manifest.renderDpi via async execFile (never on
   * the event loop synchronously). Free of API spend, so it is safe to run
   * again after a crash.
   */
  async buildChunkRequests(job, manifest, chunk) {
    // Egress: verify bytes immediately before transmission.
    await this.assertPdfMatchesJob(job.pdfPath, job.sha256);
    const requests = new Map();
    for (const pageNumber of chunk.pages) {
      const record = await this.readPageRecord(job.jobId, pageNumber);
      const page = record?.ok === false ? undefined : record?.pageSpatial;
      const entry = manifest.pages[String(pageNumber)];
      if (!page) throw new Error(`Page ${pageNumber} has no canonical record; cannot build enrichment requests.`);
      const digest = await pageDigest(page);
      if (digest !== entry.digest) {
        // Never-submitted chunk: re-pin to the current record (no paid work
        // is at stake; the plan below is built from the same record).
        entry.digest = digest;
      }
      const plan = buildEnrichmentRequestPlan(record, { renderDpi: manifest.renderDpi });
      const kinds = new Set(chunk.keys.filter((key) => key.startsWith(`${padded(pageNumber)}|`)).map((key) => key.split('|')[1]));
      const needsPagePng = kinds.has('full') || kinds.has('adj');
      const png = needsPagePng ? await renderPagePng(job.pdfPath, pageNumber, manifest.renderDpi) : undefined;
      if (kinds.has('full')) {
        if (!plan.fullTranscription) throw new Error(`Page ${pageNumber} no longer plans full transcription; refusing to submit.`);
        requests.set(`${padded(pageNumber)}|full`, buildTranscriptionRequest([new Uint8Array(png)]));
      }
      if (kinds.has('crops')) {
        if (!plan.residueCrops) throw new Error(`Page ${pageNumber} no longer plans residue crops; refusing to submit.`);
        const pngs = [];
        for (const item of plan.residueCrops.crops) {
          pngs.push(new Uint8Array(await renderCropPng(job.pdfPath, pageNumber, manifest.renderDpi, item.crop)));
        }
        requests.set(`${padded(pageNumber)}|crops`, buildResidueCropsRequest(pngs));
      }
      if (kinds.has('adj')) {
        if (!plan.adjudication) throw new Error(`Page ${pageNumber} no longer plans adjudication; refusing to submit.`);
        requests.set(`${padded(pageNumber)}|adj`, buildAdjudicationRequest(new Uint8Array(png), plan.adjudication.conflicts));
      }
    }
    return requests;
  }

  async processChunk(job, manifest, chunk) {
    await this.acquireChunkSlot();
    try {
      const common = {
        apiKey: this.apiKey,
        pollIntervalMs: this.pollIntervalMs,
        timeoutMs: this.batchTimeoutMs,
        signal: this.abortController.signal,
        ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {})
      };
      let result;
      if (chunk.operationName) {
        // Rejoin: paid work is recovered, never repurchased. awaitFlashBatch
        // only reads entry keys (join + positional guard), so no re-render.
        result = await awaitFlashBatch({
          ...common,
          entries: chunk.keys.map((key) => ({ key, request: {} })),
          operationName: chunk.operationName
        });
      } else {
        if (this.aborted) return;
        if (this.spentUsd >= this.spendCeilingUsd) {
          throw new Error(`service spend ceiling ENRICH_SPEND_CEILING_USD=${this.spendCeilingUsd} reached; chunk not submitted.`);
        }
        const requests = await this.buildChunkRequests(job, manifest, chunk);
        result = await runFlashBatch({
          ...common,
          entries: chunk.keys.map((key) => ({ key, request: requests.get(key) })),
          onSubmitted: (operationName) => {
            // Persist the recovery handle BEFORE polling: a crash after
            // submission must never orphan paid work.
            chunk.operationName = operationName;
            chunk.state = 'submitted';
            chunk.submittedAt = new Date().toISOString();
            for (const pageNumber of chunk.pages) {
              const entry = manifest.pages[String(pageNumber)];
              if (entry.state === 'pending') entry.state = 'submitted';
            }
            if (manifest.status === 'pending') manifest.status = 'submitted';
            this.writeManifest(job.jobId, manifest);
          }
        });
      }
      chunk.state = 'done';
      chunk.wallMs = result.wallMs;
      this.metrics?.recordEnrichmentChunk?.(result.wallMs);
      await this.joinChunk(job, manifest, chunk, result);
    } catch (error) {
      const message = String(error?.message ?? error);
      const aborted = error?.name === 'AbortError' || this.aborted;
      // Decision 6: once an operation name exists, the batch is PAID and
      // running remotely. Only explicitly terminal evidence may close it
      // out — a terminal poll status (401/403/404) or an explicit batch
      // error. Everything else (deadline, abort, transport blips, a
      // malformed poll body) leaves the chunk live for the boot sweep:
      // treating an unclassified error as terminal would pay for work and
      // discard it.
      const terminal = /Batch poll failed terminally/u.test(message) || /^Batch failed:/u.test(message);
      if (chunk.operationName && !terminal) {
        chunk.state = 'submitted';
        chunk.lastError = message.slice(0, 300);
      } else if (!chunk.operationName && aborted) {
        chunk.state = 'pending'; // aborted before submission; sweep resubmits (unpaid)
      } else {
        // Terminal (auth failure, explicit batch error): close the chunk
        // out and mark its pages unavailable (fail-open at the job level).
        chunk.state = 'failed';
        chunk.error = message.slice(0, 300);
        for (const pageNumber of chunk.pages) {
          const entry = manifest.pages[String(pageNumber)];
          if (entry.state === 'pending' || entry.state === 'submitted') {
            entry.state = 'unavailable';
            entry.reason = message.slice(0, 200);
          }
        }
        if (!manifest.reason) manifest.reason = message.slice(0, 300);
      }
    } finally {
      this.releaseChunkSlot();
      this.writeManifest(job.jobId, manifest);
    }
  }

  async joinChunk(job, manifest, chunk, result) {
    for (const pageNumber of chunk.pages) {
      const entry = manifest.pages[String(pageNumber)];
      const telemetry = { promptTokens: 0, outputTokens: 0, latencyMs: chunk.wallMs ?? 0 };
      try {
        const record = await this.readPageRecord(job.jobId, pageNumber);
        const page = record?.ok === false ? undefined : record?.pageSpatial;
        if (!page) throw new Error('canonical page record is missing or failed');
        // Fail closed on staleness: a page re-parsed since submission has a
        // different digest — its paid results are refused, never joined.
        const digest = await pageDigest(page);
        if (digest !== entry.digest) {
          entry.state = 'stale';
          entry.reason = 'page re-parsed since submission (basePageDigest mismatch)';
          continue;
        }
        const plan = buildEnrichmentRequestPlan(record, { renderDpi: manifest.renderDpi });
        const kinds = new Set(chunk.keys.filter((key) => key.startsWith(`${padded(pageNumber)}|`)).map((key) => key.split('|')[1]));
        const take = (kind) => {
          const key = `${padded(pageNumber)}|${kind}`;
          if (result.errors.has(key)) throw new Error(`batch item ${kind}: ${result.errors.get(key)}`);
          const payload = result.payloads.get(key);
          // Usage lands the moment the payload is taken — a sibling rung
          // failing later must not erase this rung's billed spend.
          telemetry.promptTokens += payload?.usageMetadata?.promptTokenCount ?? 0;
          telemetry.outputTokens += payload?.usageMetadata?.candidatesTokenCount ?? 0;
          return payload;
        };
        let proposals = [];
        let adjudications = [];
        const provenance = {};
        if (kinds.has('full')) {
          const parsed = parseTranscriptionPayload(take('full'));
          proposals = parsed.proposals;
          provenance.transcription = { ...transcriptionProvenance(), transport: 'batch' };
        } else if (kinds.has('crops')) {
          const parsed = parseTranscriptionPayload(take('crops'));
          // Crops are text-only by schema; strip any hint defensively.
          proposals = parsed.proposals.map(({ text }) => ({ text }));
          provenance.transcription = { ...transcriptionProvenance(undefined, RESIDUE_CROPS_PROMPT_REVISION), transport: 'batch' };
        }
        if (kinds.has('adj')) {
          if (!plan.adjudication) throw new Error('page no longer plans adjudication');
          const parsed = parseAdjudicationPayload(take('adj'), plan.adjudication.conflicts);
          adjudications = parsed.verdicts;
          provenance.adjudication = { ...adjudicationProvenance(), transport: 'batch' };
        }
        const enrichment = await buildEscalatedOcrEnrichment({ page, proposals, adjudications, provenance, telemetry });
        writeFileAtomic(this.recordPath(job.jobId, pageNumber), JSON.stringify(enrichment, null, 1));
        entry.state = 'complete';
        this.metrics?.recordEnrichmentPage?.('complete');
      } catch (error) {
        entry.state = 'unavailable';
        entry.reason = String(error?.message ?? error).slice(0, 200);
        this.metrics?.recordEnrichmentPage?.('unavailable');
      } finally {
        // Spend honesty: tokens taken stay on the ledger even when the
        // page's record could not be built.
        const cost = estimateBatchCostUsd(telemetry.promptTokens, telemetry.outputTokens);
        manifest.spend.promptTokens += telemetry.promptTokens;
        manifest.spend.outputTokens += telemetry.outputTokens;
        manifest.spend.estimatedCostUsd = Math.round((manifest.spend.estimatedCostUsd + cost) * 1e6) / 1e6;
        this.spentUsd += cost;
        this.metrics?.recordEnrichmentSpend?.(telemetry.promptTokens, telemetry.outputTokens, cost, this.spentUsd);
      }
    }
    this.writeManifest(job.jobId, manifest);
  }

  finalizeStatus(manifest) {
    if (manifest.chunks.some((chunk) => chunk.state === 'submitted')) { manifest.status = 'submitted'; return; }
    if (manifest.chunks.some((chunk) => chunk.state === 'pending')) { manifest.status = 'pending'; return; }
    // "Routed" is every page with an OUTCOME — not just digest-bearing
    // ones: a page the builder rejected carries 'unavailable' and no
    // digest, and must still pull the job off 'complete'.
    const routed = Object.values(manifest.pages)
      .filter((entry) => entry.state !== 'not-qualified' && entry.state !== 'no-eligible-region');
    if (!routed.length || routed.every((entry) => entry.state === 'complete')) { manifest.status = 'complete'; return; }
    manifest.status = routed.some((entry) => entry.state === 'complete') ? 'partial' : 'unavailable';
  }
}

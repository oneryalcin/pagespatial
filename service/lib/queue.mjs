/**
 * Job store + in-process page queue + child-process worker pool.
 *
 * Job state lives on disk (dataDir/<jobId>/job.json + pages/NNNNNN.json) so
 * a restarted service resumes: on boot, jobs with missing pages requeue just
 * those pages. Per-page failure is fail-closed (#37): the page gets a failed
 * entry after the attempt cap, siblings are untouched, the job completes.
 */
import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { openDocumentContext } from './stages.mjs';
import { Metrics } from './metrics.mjs';
import { writeFileAtomic } from './atomic.mjs';
import { EnrichmentPhase } from './enrichment.mjs';

const WORKER_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'worker.mjs');
const MAX_ATTEMPTS = 2;
// Consecutive worker deaths with no completed result in between: after this
// many, the pool stops respawning and everything queued fails closed —
// a worker that dies at import would otherwise fork-loop forever.
const MAX_CONSECUTIVE_WORKER_DEATHS = 5;

const pageFile = (dir, pageNumber) => join(dir, 'pages', `${String(pageNumber).padStart(6, '0')}.json`);

export class ParseService {
  constructor({ dataDir, workers = 2, adapterId = 'stub-ocr', ocr = {}, maxConsecutiveWorkerDeaths = MAX_CONSECUTIVE_WORKER_DEATHS, enrichment = {}, maxPagesPerJob = 0 }) {
    this.dataDir = dataDir;
    this.adapterId = adapterId;
    // Per-job page cap (deployment neutral): 0/unset = unlimited (the
    // historical local default). A deployment that must bound one job's
    // work (e.g. a per-document execution queue) sets it; over-limit
    // submissions are refused with a 4xx, never accepted.
    this.maxPagesPerJob = maxPagesPerJob;
    // Adapter-specific config (ppocr-server: assetsDir/variant/numThreads).
    // Travels with every task and is persisted per job, so resumed pages run
    // under the same pinned backend the job started with.
    this.ocr = ocr;
    this.maxConsecutiveWorkerDeaths = maxConsecutiveWorkerDeaths;
    this.jobs = new Map();
    this.pending = [];
    this.metrics = new Metrics();
    this.workers = [];
    this.consecutiveWorkerDeaths = 0;
    this.degraded = false;
    mkdirSync(dataDir, { recursive: true });
    // Phase B executor (design 2026-08-23 workstream 2). The SERVER process
    // owns batch polling — workers are per-page children that die and
    // respawn; this is the only long-lived process.
    this.enrichmentPhase = new EnrichmentPhase({ dataDir, metrics: this.metrics, options: enrichment });
    this.resume();
    // Boot sweep, deliberately separate from resume(): resume short-circuits
    // on completed jobs, and a job whose parse finished is exactly the job
    // whose enrichment may still be in flight. Fire-and-forget; fail-open.
    this.enrichmentSweep = this.enrichmentPhase.sweep(this.jobs)
      .catch((error) => console.error(`enrichment boot sweep: ${String(error?.message ?? error)}`));
    for (let index = 0; index < workers; index += 1) this.spawnWorker();
  }

  spawnWorker() {
    if (this.degraded) return;
    const child = fork(WORKER_PATH, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const slot = { child, busy: undefined, ready: false };
    child.on('message', (message) => {
      if (message?.kind === 'ready') {
        slot.ready = true;
        this.drain();
        return;
      }
      if (message?.kind !== 'result') return;
      this.consecutiveWorkerDeaths = 0;
      const task = slot.busy;
      slot.busy = undefined;
      if (task) this.finishTask(task, message);
      this.drain();
    });
    child.on('exit', (code) => {
      const task = slot.busy;
      this.workers = this.workers.filter((entry) => entry !== slot);
      if (task) {
        // Worker died mid-page: a crashed attempt, requeued under the cap.
        this.requeueOrFail(task, { message: `worker exited with code ${code} while processing the page`, errorClass: 'WorkerCrash' });
      }
      this.consecutiveWorkerDeaths += 1;
      if (this.consecutiveWorkerDeaths >= this.maxConsecutiveWorkerDeaths) {
        // A worker that dies at import would fork-loop forever. Stop
        // respawning and fail everything queued closed instead of hanging.
        this.degraded = true;
        console.error(`parse-service: ${this.consecutiveWorkerDeaths} consecutive worker deaths — pool degraded, failing queued pages closed.`);
        const queued = this.pending.splice(0);
        for (const pendingTask of queued) {
          pendingTask.attempts = MAX_ATTEMPTS;
          this.requeueOrFail(pendingTask, { message: 'worker pool degraded: consecutive worker deaths exceeded the cap', errorClass: 'WorkerPoolDegraded' });
        }
        return;
      }
      // Exponential backoff so a fast-dying child cannot hot-loop forks.
      const delayMs = Math.min(5000, 100 * 2 ** (this.consecutiveWorkerDeaths - 1));
      const timer = setTimeout(() => this.spawnWorker(), delayMs);
      timer.unref?.();
    });
    this.workers.push(slot);
  }

  resume() {
    for (const jobId of safeReaddir(this.dataDir)) {
      const jobDir = join(this.dataDir, jobId);
      let job;
      try { job = JSON.parse(readFileSync(join(jobDir, 'job.json'), 'utf8')); } catch { continue; }
      if (job.status === 'completed' || job.status === 'failed') { this.jobs.set(jobId, job); continue; }
      // Presence is only trustworthy for files that PARSE. Writes are atomic
      // from this version on, but a file torn by an older version or a full
      // disk must be requeued, never counted as done (§7: reject, don't repair).
      const done = new Set();
      for (const name of safeReaddir(join(jobDir, 'pages'))) {
        // Stray temp files from an interrupted atomic write are dead weight.
        if (name.includes('.tmp-')) { rmSync(join(jobDir, 'pages', name), { force: true }); continue; }
        try {
          JSON.parse(readFileSync(join(jobDir, 'pages', name), 'utf8'));
          done.add(Number.parseInt(name, 10));
        } catch {
          rmSync(join(jobDir, 'pages', name), { force: true });
        }
      }
      this.jobs.set(jobId, job);
      for (let pageNumber = 1; pageNumber <= job.pageCount; pageNumber += 1) {
        if (!done.has(pageNumber)) this.enqueue({ jobId, pdfPath: job.pdfPath, sha256: job.sha256, identity: job.identityOptions, pageNumber, runId: job.runId, adapterId: job.adapterId, ocr: job.ocr ?? {}, attempts: 0 });
      }
      this.checkCompletion(jobId);
    }
  }

  async submit({ pdfPath, sourceUri, enrichment = 'off', source = 'path' }) {
    if (enrichment !== 'off' && enrichment !== 'batch') {
      const error = new Error(`enrichment must be "off" or "batch", got '${enrichment}'.`);
      error.statusCode = 400;
      throw error;
    }
    // Egress (design): with enrichment on, pdfPath mode stops being an
    // access-control gap and becomes a data-egress primitive — name a local
    // file and the service ships it to Google. Refused outright.
    if (enrichment === 'batch' && source !== 'upload') {
      const error = new Error('enrichment: "batch" is refused for jobs submitted via pdfPath — upload the PDF bytes instead (remote transmission of arbitrary local paths is a data-egress primitive).');
      error.statusCode = 400;
      throw error;
    }
    if (this.degraded) {
      // A degraded pool has no workers and never will: accepting the job
      // would 202 into a silent forever-hang.
      const error = new Error('Service degraded: worker pool stopped after repeated worker deaths; not accepting jobs.');
      error.statusCode = 503;
      throw error;
    }
    // Open once up front: rejects non-PDFs immediately and pins identity
    // (sha256, pageCount) at submission, before any worker touches it.
    const probe = await openDocumentContext(pdfPath, sourceUri ? { sourceUri } : {});
    const identity = probe.identity;
    await probe.dispose();
    // Page cap check sits immediately after the probe, before any job
    // state or page enqueue exists: a refused document leaves nothing
    // behind (Modal design 2026-08-23 §7.1).
    if (this.maxPagesPerJob > 0 && identity.pageCount > this.maxPagesPerJob) {
      const error = new Error(`Document has ${identity.pageCount} pages; this service accepts at most ${this.maxPagesPerJob} pages per job (SERVICE_MAX_PAGES_PER_JOB).`);
      error.statusCode = 400;
      throw error;
    }
    const jobId = `job_${randomBytes(6).toString('hex')}`;
    const runId = `svc:${jobId}`;
    const jobDir = join(this.dataDir, jobId);
    mkdirSync(join(jobDir, 'pages'), { recursive: true });
    const job = {
      jobId,
      status: 'processing',
      pdfPath,
      sha256: identity.sha256,
      pageCount: identity.pageCount,
      identityOptions: sourceUri ? { sourceUri } : {},
      adapterId: this.adapterId,
      ocr: this.ocr,
      enrichment,
      runId,
      submittedAt: new Date().toISOString(),
      startedMs: performance.now()
    };
    writeFileAtomic(join(jobDir, 'job.json'), JSON.stringify(job, null, 1));
    this.jobs.set(jobId, job);
    for (let pageNumber = 1; pageNumber <= identity.pageCount; pageNumber += 1) {
      this.enqueue({ jobId, pdfPath, sha256: identity.sha256, identity: job.identityOptions, pageNumber, runId, adapterId: this.adapterId, ocr: this.ocr, attempts: 0 });
    }
    this.drain();
    return { jobId, pageCount: identity.pageCount, sha256: identity.sha256 };
  }

  enqueue(task) {
    if (this.degraded) {
      // Nothing will ever drain a degraded pool: fail closed now.
      task.attempts = MAX_ATTEMPTS;
      this.requeueOrFail(task, { message: 'worker pool degraded: consecutive worker deaths exceeded the cap', errorClass: 'WorkerPoolDegraded' });
      return;
    }
    this.pending.push(task);
    this.drain();
  }

  drain() {
    for (const slot of this.workers) {
      if (!slot.ready || slot.busy) continue;
      const task = this.pending.shift();
      if (!task) return;
      task.attempts += 1;
      task.startedMs = performance.now();
      slot.busy = task;
      slot.child.send({ kind: 'page', task });
    }
  }

  requeueOrFail(task, failure) {
    if (task.attempts < MAX_ATTEMPTS) {
      this.pending.push(task);
      this.drain();
      return;
    }
    this.writePage(task, { ok: false, failure, attempts: task.attempts });
    this.checkCompletion(task.jobId);
  }

  finishTask(task, message) {
    const wallMs = Math.round(performance.now() - task.startedMs);
    if (!message.ok) {
      this.requeueOrFail(task, message.failure);
      return;
    }
    const entry = {
      ok: true,
      attempts: task.attempts,
      wallMs,
      stageTimingsMs: message.stageTimingsMs,
      rssBytes: message.rssBytes,
      ...(message.nonCanonical
        ? { nonCanonical: true, ocrAdapter: message.ocrAdapter, rasterSize: message.rasterSize, counts: message.counts }
        : { pageSpatial: message.pageSpatial })
    };
    this.writePage(task, entry);
    this.metrics.record(task.jobId, message.stageTimingsMs, wallMs, message.rssBytes);
    this.checkCompletion(task.jobId);
  }

  writePage(task, entry) {
    writeFileAtomic(pageFile(join(this.dataDir, task.jobId), task.pageNumber), JSON.stringify({ pageNumber: task.pageNumber, ...entry }, null, 1));
  }

  checkCompletion(jobId) {
    const job = this.jobs.get(jobId);
    if (!job || job.status === 'completed') return;
    const done = safeReaddir(join(this.dataDir, jobId, 'pages')).filter((name) => !name.includes('.tmp-')).length;
    if (done >= job.pageCount) {
      job.status = 'completed';
      job.completedAt = new Date().toISOString();
      writeFileAtomic(join(this.dataDir, jobId, 'job.json'), JSON.stringify(job, null, 1));
      // Phase B (design decision 3): only when the job asked for it, only
      // after parse completion. Fire-and-forget: enrichment failures never
      // touch the parse result (fail-open, decision 6).
      if (job.enrichment === 'batch') this.enrichmentPhase.start(job);
    }
  }

  jobStatus(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return undefined;
    const jobDir = join(this.dataDir, jobId);
    const pages = safeReaddir(join(jobDir, 'pages'))
      .filter((name) => !name.includes('.tmp-'))
      .sort()
      .flatMap((name) => {
        // Belt and braces: writes are atomic, but a status read must never
        // 500 the whole job over one unreadable file.
        try { return [JSON.parse(readFileSync(join(jobDir, 'pages', name), 'utf8'))]; } catch { return []; }
      });
    // Enrichment state is COMPOSED into the response at read time — stored
    // canonical page records are never touched (design decision 7), and the
    // completedPages count above stays scoped to pages/ (decision 4).
    const enrichment = this.enrichmentPhase.view(job);
    return {
      jobId,
      status: job.status,
      sha256: job.sha256,
      pageCount: job.pageCount,
      completedPages: pages.length,
      enrichmentStatus: enrichment.status,
      ...(enrichment.reason ? { enrichmentReason: enrichment.reason } : {}),
      pages: job.enrichment === 'batch'
        ? pages.map((page) => ({ ...page, enrichmentState: enrichment.pageState(page.pageNumber) }))
        : pages
    };
  }

  /** Enrichment record for one page (undefined = none/stale -> 404). */
  async enrichmentRecord(jobId, pageNumber) {
    if (!this.jobs.has(jobId)) return undefined;
    return this.enrichmentPhase.record(jobId, pageNumber);
  }

  page(jobId, pageNumber) {
    // Membership check first: jobId lands in a filesystem path, and only
    // ids this service minted may resolve (no path-shaped probing).
    if (!this.jobs.has(jobId)) return undefined;
    try {
      return JSON.parse(readFileSync(pageFile(join(this.dataDir, jobId), pageNumber), 'utf8'));
    } catch {
      return undefined;
    }
  }

  /**
   * Health warm-up (GET /health readiness): ask every current worker to
   * construct its OCR adapter and run ONE real inference on a tiny blank
   * raster. For the sidecar adapter that means: child spawned, meta line
   * received (in-band useHpip and versions), one predict round-tripped.
   * Resolves with per-worker results — the caller decides readiness; this
   * method never throws. Budget honestly: a sidecar warm-up includes engine
   * construction (ensureChild's meta timeout is 300 s), hence the default.
   */
  async warmup({ timeoutMs = 330_000 } = {}) {
    const slots = this.workers.slice();
    return Promise.all(slots.map((slot) => new Promise((resolve) => {
      const timer = setTimeout(() => { cleanup(); resolve({ ok: false, error: `warm-up timed out after ${timeoutMs}ms` }); }, timeoutMs);
      timer.unref?.();
      const onMessage = (message) => {
        if (message?.kind !== 'warmup-result') return;
        cleanup();
        resolve(message);
      };
      const onExit = () => { cleanup(); resolve({ ok: false, error: 'worker exited during warm-up' }); };
      const cleanup = () => {
        clearTimeout(timer);
        slot.child.removeListener('message', onMessage);
        slot.child.removeListener('exit', onExit);
      };
      slot.child.on('message', onMessage);
      slot.child.on('exit', onExit);
      try {
        slot.child.send({ kind: 'warmup', task: { adapterId: this.adapterId, ocr: this.ocr } });
      } catch (error) {
        cleanup();
        resolve({ ok: false, error: `could not reach worker: ${error.message}` });
      }
    })));
  }

  /**
   * Drain the pool and AWAIT each child's exit. Returning before the workers
   * die (the pre-M1 behaviour) let server.mjs call process.exit(0) while
   * children were still alive — a worker must reach its own exit handler for
   * the sidecar adapter's 'exit' hook to group-kill its Python engine, and a
   * parent that exits first hands the orphan to PID 1 (which, in a container
   * without an init that reaps, is this very Node process — hence the
   * README's --init/tini requirement). Bounded: a worker that ignores
   * SIGTERM past the timeout is SIGKILLed; its sidecar then exits via the
   * stdin-EOF fallback documented in the adapter.
   */
  async shutdown({ timeoutMs = 15_000 } = {}) {
    // Abort batch polling first (M3): in-flight chunks persist as
    // 'submitted' in their manifests and the next boot's sweep rejoins them
    // (never resubmits). The remote batch keeps running; paid work is not
    // lost.
    await this.enrichmentPhase.shutdown();
    const slots = this.workers;
    this.workers = [];
    await Promise.all(slots.map(({ child }) => new Promise((resolve) => {
      child.removeAllListeners('exit');
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = setTimeout(() => {
        // Escalation, not success: SIGKILL still produces an 'exit' event,
        // which is what resolves this slot.
        child.kill('SIGKILL');
      }, timeoutMs);
      timer.unref?.();
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill();
    })));
  }
}

function safeReaddir(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

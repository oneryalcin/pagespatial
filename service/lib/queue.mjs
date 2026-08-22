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
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { openDocumentContext } from './stages.mjs';
import { Metrics } from './metrics.mjs';

const WORKER_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'worker.mjs');
const MAX_ATTEMPTS = 2;
// Consecutive worker deaths with no completed result in between: after this
// many, the pool stops respawning and everything queued fails closed —
// a worker that dies at import would otherwise fork-loop forever.
const MAX_CONSECUTIVE_WORKER_DEATHS = 5;

const pageFile = (dir, pageNumber) => join(dir, 'pages', `${String(pageNumber).padStart(6, '0')}.json`);

// State files are completion markers: resume() and checkCompletion() treat
// their PRESENCE as truth, so a torn write must never leave a partial file
// behind. Write-to-temp + rename is atomic on the same filesystem.
function writeFileAtomic(path, contents) {
  const temp = `${path}.tmp-${randomBytes(4).toString('hex')}`;
  writeFileSync(temp, contents);
  renameSync(temp, path);
}

export class ParseService {
  constructor({ dataDir, workers = 2, adapterId = 'stub-ocr' }) {
    this.dataDir = dataDir;
    this.adapterId = adapterId;
    this.jobs = new Map();
    this.pending = [];
    this.metrics = new Metrics();
    this.workers = [];
    this.consecutiveWorkerDeaths = 0;
    this.degraded = false;
    mkdirSync(dataDir, { recursive: true });
    this.resume();
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
      if (this.consecutiveWorkerDeaths >= MAX_CONSECUTIVE_WORKER_DEATHS) {
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
        if (!done.has(pageNumber)) this.enqueue({ jobId, pdfPath: job.pdfPath, sha256: job.sha256, identity: job.identityOptions, pageNumber, runId: job.runId, adapterId: job.adapterId, attempts: 0 });
      }
      this.checkCompletion(jobId);
    }
  }

  async submit({ pdfPath, sourceUri }) {
    // Open once up front: rejects non-PDFs immediately and pins identity
    // (sha256, pageCount) at submission, before any worker touches it.
    const probe = await openDocumentContext(pdfPath, sourceUri ? { sourceUri } : {});
    const identity = probe.identity;
    await probe.dispose();
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
      runId,
      submittedAt: new Date().toISOString(),
      startedMs: performance.now()
    };
    writeFileAtomic(join(jobDir, 'job.json'), JSON.stringify(job, null, 1));
    this.jobs.set(jobId, job);
    for (let pageNumber = 1; pageNumber <= identity.pageCount; pageNumber += 1) {
      this.enqueue({ jobId, pdfPath, sha256: identity.sha256, identity: job.identityOptions, pageNumber, runId, adapterId: this.adapterId, attempts: 0 });
    }
    this.drain();
    return { jobId, pageCount: identity.pageCount, sha256: identity.sha256 };
  }

  enqueue(task) {
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
    return {
      jobId,
      status: job.status,
      sha256: job.sha256,
      pageCount: job.pageCount,
      completedPages: pages.length,
      pages
    };
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

  async shutdown() {
    for (const slot of this.workers) {
      slot.child.removeAllListeners('exit');
      slot.child.kill();
    }
    this.workers = [];
  }
}

function safeReaddir(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

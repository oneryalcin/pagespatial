/**
 * Parse service HTTP API (issue #22, v1). node:http, no framework — five
 * routes and zero middleware needs do not justify a dependency.
 *
 *   POST /v1/jobs                 PDF bytes (application/pdf), or JSON
 *                                 {"pdfPath": "..."} for local testing
 *                              -> {jobId, pageCount, sha256}
 *                                 ?enrichment=batch (or JSON field) opts in
 *                                 to the escalated tier — default off;
 *                                 refused (400) for pdfPath submissions.
 *   GET  /v1/jobs/:id             status + per-page results AS THEY COMPLETE
 *                                 (+ enrichmentStatus / per-page enrichmentState)
 *   GET  /v1/jobs/:id/pages/:n    one page result
 *   GET  /v1/jobs/:id/pages/:n.svg  deterministic reconstruction (#51) —
 *                                 canonical records only, image/svg+xml
 *   GET  /v1/jobs/:id/pages/:n/enrichment  enrichment revision record (404 when none)
 *   GET  /v1/metrics              per-stage aggregate since boot + enrichment counters
 *   GET  /health                  readiness: 200 only after model pins
 *                                 verified, a sidecar child reported meta,
 *                                 and one warm-up inference completed
 *                                 (503 again if the pool degrades)
 *
 * Env: PORT (default 8571), SERVICE_DATA_DIR (default service/data),
 * SERVICE_WORKERS (default 2), SERVICE_OCR_ADAPTER (default stub-ocr),
 * SERVICE_MAX_PAGES_PER_JOB (default 0 = unlimited; a submission whose
 * probed page count exceeds the cap is refused 400 before job creation).
 * Enrichment (design 2026-08-23): GEMINI_API_KEY (environment only — no
 * per-request keys), ENRICH_MAX_PAGES_PER_JOB (default 200),
 * ENRICH_MAX_CONCURRENT_CHUNKS (default 4), ENRICH_SPEND_CEILING_USD
 * (default 10, per process lifetime), ENRICH_MAX_ENTRIES_PER_CHUNK
 * (default 24).
 * For the canonical adapter (SERVICE_OCR_ADAPTER=ppocr-server):
 *   SERVICE_OCR_ASSETS_DIR  required — model assets dir (explicit, no magic)
 *   SERVICE_OCR_VARIANT     default 'small' (the evaluation-parity tier)
 *   SERVICE_OCR_THREADS     default 4 (ORT WASM threads)
 * The backend is PINNED from these at boot — never 'auto' — and the full
 * descriptor lands in every record's provenance.
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { ParseService } from './lib/queue.mjs';
import { reconstructSvg } from '../dist/index.js';
import { DEFAULT_PYTHON_CMD, verifyModelPins } from './adapters/ppocr-sidecar.mjs';
import { spawn } from 'node:child_process';

/**
 * Boot-time sidecar health: run the real child with --check (imports,
 * child-side pin verification, pipeline construction) so a misconfigured
 * host refuses jobs instead of failing every page. First run on a cold uv
 * cache downloads paddle (~1 GB) — generous timeout, and the README tells
 * operators to pre-warm.
 */
function sidecarBootCheck(pythonCmd, modelsDir, threads, timeoutMs = 600_000) {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = pythonCmd;
    const script = join(root, 'sidecar', 'ppocr_sidecar.py');
    const child = spawn(cmd, [...args, script, '--check'], {
      env: { ...process.env, SIDECAR_MODELS_DIR: modelsDir, SIDECAR_THREADS: String(threads) }
    });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`--check timed out after ${timeoutMs}ms`)); }, timeoutMs);
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0 && out.includes('"kind": "meta"')) resolve(out);
      else reject(new Error(`sidecar --check exited ${code}: ${(out + err).slice(-400)}`));
    });
  });
}

const root = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.SERVICE_DATA_DIR ?? join(root, 'data');
const uploadsDir = join(dataDir, 'uploads');
mkdirSync(uploadsDir, { recursive: true });

const adapterId = process.env.SERVICE_OCR_ADAPTER ?? 'stub-ocr';

/**
 * Readiness state for GET /health (workstream 1). Ready ONLY after:
 *  1. model hashes verified (sidecar adapters; boot exits on mismatch, so a
 *     running sidecar process implies true — surfaced here for the probe),
 *  2. every worker's OCR adapter constructed — for the sidecar that means a
 *     Python child spawned and its meta line received (in-band useHpip),
 *  3. one warm-up inference round-tripped per worker.
 * Readiness must gate traffic: point the orchestrator's readiness probe at
 * /health so a container with a broken engine never receives work.
 */
const health = {
  ready: false,
  adapter: adapterId,
  checks: {
    modelPinsVerified: adapterId === 'ppocr-sidecar' ? false : null,
    workersWarmedUp: false,
    warmupInference: false
  },
  workers: [],
  error: null
};

let ocr = {};
if (adapterId === 'ppocr-sidecar') {
  // The adopted witness (issue #2). Fail closed at boot, before any job is
  // accepted: pinned-model hash verification (Node side) plus a real child
  // --check (imports, child-side pin verification, pipeline construction).
  // There is NO silent fallback from a configured sidecar to anything else.
  const modelsDir = process.env.SERVICE_SIDECAR_MODELS_DIR;
  if (!modelsDir || !existsSync(modelsDir)) {
    console.error('SERVICE_SIDECAR_MODELS_DIR must point at the pinned models dir (see service/sidecar/fetch_models.py) when SERVICE_OCR_ADAPTER=ppocr-sidecar.');
    process.exit(1);
  }
  const threads = Number(process.env.SERVICE_SIDECAR_THREADS ?? 1);
  if (!Number.isInteger(threads) || threads < 1) {
    console.error(`SERVICE_SIDECAR_THREADS must be a positive integer, got '${process.env.SERVICE_SIDECAR_THREADS}'.`);
    process.exit(1);
  }
  // JSON-array form survives paths with spaces: '["/opt/my venv/bin/python"]'.
  // The bare form is split on spaces and documented as such.
  const rawPython = process.env.SERVICE_SIDECAR_PYTHON;
  let pythonCmd = DEFAULT_PYTHON_CMD;
  if (rawPython) {
    if (rawPython.trim().startsWith('[')) {
      try {
        pythonCmd = JSON.parse(rawPython);
      } catch {
        console.error('SERVICE_SIDECAR_PYTHON looks like JSON but does not parse; fix it or use the space-separated form.');
        process.exit(1);
      }
      if (!Array.isArray(pythonCmd) || !pythonCmd.every((part) => typeof part === 'string') || !pythonCmd.length) {
        console.error('SERVICE_SIDECAR_PYTHON JSON form must be a non-empty array of strings.');
        process.exit(1);
      }
    } else {
      pythonCmd = rawPython.split(' ').filter(Boolean);
    }
  }
  try {
    verifyModelPins(modelsDir);
    health.checks.modelPinsVerified = true;
    if (process.env.SERVICE_SIDECAR_SKIP_BOOT_CHECK !== '1') {
      await sidecarBootCheck(pythonCmd, modelsDir, threads);
    }
  } catch (error) {
    console.error(`Sidecar boot check failed — refusing to start: ${error.message}`);
    process.exit(1);
  }
  ocr = { modelsDir, threads, pythonCmd };
} else if (adapterId === 'ppocr-server') {
  const assetsDir = process.env.SERVICE_OCR_ASSETS_DIR;
  if (!assetsDir || !existsSync(assetsDir)) {
    console.error('SERVICE_OCR_ASSETS_DIR must point at an existing PP-OCR assets dir when SERVICE_OCR_ADAPTER=ppocr-server.');
    process.exit(1);
  }
  ocr = {
    assetsDir,
    variant: process.env.SERVICE_OCR_VARIANT ?? 'small',
    numThreads: Number(process.env.SERVICE_OCR_THREADS ?? 4)
  };
}

// Per-job page cap: 0/unset = unlimited (historical default). A garbage
// value must not silently mean "unlimited" — refuse to boot instead.
// Digits-only parse: Number('') is 0 and Number('1e2') is 100, both of
// which would boot on a value the operator plainly mistyped (cold review
// PR #89, finding 3).
const rawMaxPages = process.env.SERVICE_MAX_PAGES_PER_JOB;
if (rawMaxPages !== undefined && !/^\d+$/u.test(rawMaxPages)) {
  console.error(`SERVICE_MAX_PAGES_PER_JOB must be a non-negative integer in digits (0 = unlimited), got '${rawMaxPages}'.`);
  process.exit(1);
}
const maxPagesPerJob = Number(rawMaxPages ?? 0);

const service = new ParseService({
  dataDir,
  workers: Number(process.env.SERVICE_WORKERS ?? 2),
  adapterId,
  ocr,
  maxPagesPerJob,
  // Operational + test knob: how many consecutive worker deaths degrade
  // the pool (default lives in queue.mjs).
  ...(process.env.SERVICE_MAX_WORKER_DEATHS
    ? { maxConsecutiveWorkerDeaths: Number(process.env.SERVICE_MAX_WORKER_DEATHS) }
    : {})
});

const json = (res, status, body) => {
  const payload = JSON.stringify(body, null, 1);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
};

const MAX_BODY_BYTES = 100 * 1024 * 1024;

// Over-cap bodies: reject WITHOUT destroying the socket — the handler must
// send the 413 first, or the client sees a reset instead of the status.
// The request stream is destroyed by the handler after the response flushes.
const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  let total = 0;
  let exceeded = false;
  req.on('data', (chunk) => {
    if (exceeded) return; // stop buffering; bytes drain to nowhere
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      exceeded = true;
      chunks.length = 0;
      const error = new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes.`);
      error.statusCode = 413;
      reject(error);
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => { if (!exceeded) resolve(Buffer.concat(chunks)); });
  req.on('error', (error) => { if (!exceeded) reject(error); });
});

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);

    if (req.method === 'POST' && url.pathname === '/v1/jobs') {
      let body;
      try {
        body = await readBody(req);
      } catch (error) {
        json(res, error.statusCode ?? 500, { error: error.message });
        if (error.statusCode === 413) res.once('finish', () => req.destroy());
        return;
      }
      let pdfPath;
      let sourceUri;
      let uploaded = false;
      // enrichment: "off" | "batch" (default off — paid feature, explicit
      // opt-in). Bytes mode reads the query string (the body is the PDF);
      // JSON mode reads the field. Batch is refused for pdfPath jobs in
      // ParseService.submit (egress: a local path must never be shipped to
      // a remote model).
      let enrichment = url.searchParams.get('enrichment') ?? 'off';
      if ((req.headers['content-type'] ?? '').includes('application/json')) {
        let parsed;
        try {
          parsed = JSON.parse(body.toString('utf8'));
        } catch {
          return json(res, 400, { error: 'Request body is not valid JSON.' });
        }
        // pdfPath is an arbitrary server-file read plus a file-existence
        // oracle: OFF unless explicitly enabled for local development.
        // (Cold review, 2026-08-23: the port was never localhost-only —
        // see the listen() note below — so this cannot default open.)
        if (process.env.SERVICE_ALLOW_PDF_PATH !== '1') {
          return json(res, 403, { error: 'pdfPath mode is disabled. Set SERVICE_ALLOW_PDF_PATH=1 to enable it for local development, or submit PDF bytes.' });
        }
        pdfPath = parsed.pdfPath;
        sourceUri = parsed.sourceUri;
        enrichment = parsed.enrichment ?? enrichment;
        if (typeof pdfPath !== 'string' || !pdfPath) return json(res, 400, { error: 'pdfPath (string) is required in JSON mode.' });
      } else {
        if (!body.length) return json(res, 400, { error: 'Send PDF bytes, or JSON {"pdfPath": "..."}.' });
        pdfPath = join(uploadsDir, `upload_${randomBytes(6).toString('hex')}.pdf`);
        writeFileSync(pdfPath, body);
        uploaded = true;
      }
      try {
        const pageLimitText = url.searchParams.get('page_limit');
        if (pageLimitText != null && !/^[1-9][0-9]*$/u.test(pageLimitText)) {
          if (uploaded) rmSync(pdfPath, { force: true });
          return json(res, 400, { code: 'invalid_request', error: 'page_limit must be a positive integer.' });
        }
        const pageLimit = pageLimitText == null ? null : Number(pageLimitText);
        if (pageLimit != null && !Number.isSafeInteger(pageLimit)) {
          if (uploaded) rmSync(pdfPath, { force: true });
          return json(res, 400, { code: 'invalid_request', error: 'page_limit must be a positive integer.' });
        }
        const submitted = await service.submit({
          pdfPath, sourceUri, enrichment, source: uploaded ? 'upload' : 'path',
          maxPages: pageLimit,
        });
        return json(res, 202, submitted);
      } catch (error) {
        // A rejected upload is dead weight (and its bytes may be sensitive).
        if (uploaded) rmSync(pdfPath, { force: true });
        if (error.statusCode === 400) {
          return json(res, 400, { code: error.code ?? 'invalid_pdf', error: error.message });
        }
        if (error.statusCode === 503) {
          return json(res, 503, { code: 'processing_failed', error: error.message });
        }
        return json(res, 422, {
          code: 'invalid_pdf', error: `Could not open PDF: ${error.message}`,
        });
      }
    }

    if (req.method === 'GET' && parts[0] === 'v1' && parts[1] === 'jobs' && parts.length === 3) {
      const status = service.jobStatus(parts[2]);
      return status ? json(res, 200, status) : json(res, 404, { error: 'Unknown job.' });
    }

    if (req.method === 'GET' && parts[0] === 'v1' && parts[1] === 'jobs' && parts[3] === 'pages' && parts[5] === 'enrichment' && parts.length === 6) {
      // Deliberately its own endpoint, never folded into the page endpoint:
      // enrichment is a separate digest-bound revision artifact (decision 7)
      // and the client composes. 404 when none (not qualified, not landed,
      // stale, or unavailable).
      const record = await service.enrichmentRecord(parts[2], Number(parts[4]));
      return record ? json(res, 200, record) : json(res, 404, { error: 'No enrichment record for that page.' });
    }

    if (req.method === 'GET' && parts[0] === 'v1' && parts[1] === 'jobs' && parts[3] === 'pages' && parts.length === 5) {
      if (parts[4].endsWith('.svg')) {
        // Deterministic reconstruction (#51): drawn purely from the record,
        // so it exists only for canonical pages that produced one.
        const entry = service.page(parts[2], Number(parts[4].slice(0, -4)));
        if (!entry?.ok || !entry.pageSpatial) return json(res, 404, { error: 'No canonical record for that page.' });
        const svg = reconstructSvg(entry.pageSpatial);
        res.writeHead(200, { 'content-type': 'image/svg+xml', 'content-length': Buffer.byteLength(svg) });
        return res.end(svg);
      }
      const page = service.page(parts[2], Number(parts[4]));
      return page ? json(res, 200, page) : json(res, 404, { error: 'Page not ready or unknown.' });
    }

    if (req.method === 'GET' && url.pathname === '/v1/metrics') {
      return json(res, 200, service.metrics.snapshot());
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      // Readiness, not liveness: 503 until the warm-up sequence completed —
      // AND 503 again if the pool has since degraded (consecutive worker
      // deaths stop respawning and POST /v1/jobs already 503s; an
      // orchestrator must stop routing here too, cold-review PR #82).
      // Related edge, intended: a worker dying DURING warm-up leaves the
      // service not-ready until restart — fail-closed, since a pool that
      // cannot warm up must never advertise itself ready.
      const ready = health.ready && !service.degraded;
      return json(res, ready ? 200 : 503, { ...health, ready, degraded: service.degraded });
    }

    return json(res, 404, { error: 'Unknown route.' });
  } catch (error) {
    return json(res, 500, { error: String(error?.message ?? error) });
  }
});

const port = Number(process.env.PORT ?? 8571);
// Default to loopback: the README's trust model ("localhost, trusted
// caller") was previously a false claim — listen(port) binds every
// interface. Wider binding (e.g. inside a container, where loopback
// would make the published port unreachable) is an explicit opt-in.
const host = process.env.HOST ?? '127.0.0.1';
server.listen(port, host, () => {
  console.log(`parse-service listening on ${host}:${port} (adapter=${process.env.SERVICE_OCR_ADAPTER ?? 'stub-ocr'}, workers=${process.env.SERVICE_WORKERS ?? 2}, data=${dataDir})`);
});

// Warm-up runs AFTER listen so /health can answer 503 during it (a probe
// that connection-refuses is indistinguishable from a dead container).
// A failed warm-up leaves the service not-ready — the probe keeps traffic
// away — rather than exiting: the failure detail stays inspectable.
(async () => {
  const results = await service.warmup();
  health.workers = results.map((result) => result.ok
    ? { ok: true, descriptor: result.descriptor, executionProvider: result.backend?.executionProvider ?? null }
    : { ok: false, error: result.error });
  const failures = results.filter((result) => !result.ok);
  if (!results.length) {
    health.error = 'no workers to warm up (SERVICE_WORKERS=0?)';
  } else if (failures.length) {
    health.error = `warm-up failed on ${failures.length}/${results.length} workers: ${failures[0].error}`;
    console.error(`parse-service: ${health.error}`);
  } else {
    health.checks.workersWarmedUp = true;
    health.checks.warmupInference = true;
    health.ready = true;
    console.log(`parse-service ready: ${results.length} workers warmed up (${health.workers[0].descriptor})`);
  }
})();

// SIGTERM too: `kill <pid>` (and any supervisor) sends SIGTERM, and an
// unhandled one terminates this process WITHOUT the pool shutdown — leaking
// workers, each now holding a ~1.5 GB Python sidecar. Observed live during
// the sidecar loadtest teardown; both signals now drain the pool.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    // Force-exit deadline: if a keep-alive connection stalls the graceful
    // path, exiting OURSELVES beats the supervisor escalating to SIGKILL.
    // Sized ABOVE shutdown()'s own 15 s per-worker SIGKILL escalation so the
    // normal path — shutdown awaiting every child's exit — always wins;
    // this deadline only fires if the exit-await itself wedges.
    setTimeout(() => process.exit(0), 25_000).unref();
    // shutdown() resolves only after every worker child has EXITED (bounded
    // by its own timeout): each worker's exit hook group-kills its Python
    // sidecar, so no engine can outlive this process on the graceful path.
    // The container must still run under an init that reaps (docker --init
    // or tini): PID 1 changes signal defaults and orphan reaping, and a
    // non-reaping Node PID 1 would accumulate zombies on the SIGKILL path.
    await service.shutdown();
    server.closeIdleConnections?.();
    server.close(() => process.exit(0));
  });
}

/**
 * Parse service HTTP API (issue #22, v1). node:http, no framework — five
 * routes and zero middleware needs do not justify a dependency.
 *
 *   POST /v1/jobs                 PDF bytes (application/pdf), or JSON
 *                                 {"pdfPath": "..."} for local testing
 *                              -> {jobId, pageCount, sha256}
 *   GET  /v1/jobs/:id             status + per-page results AS THEY COMPLETE
 *   GET  /v1/jobs/:id/pages/:n    one page result
 *   GET  /v1/jobs/:id/pages/:n.svg  deterministic reconstruction (#51) —
 *                                 canonical records only, image/svg+xml
 *   GET  /v1/metrics              per-stage aggregate since boot
 *
 * Env: PORT (default 8571), SERVICE_DATA_DIR (default service/data),
 * SERVICE_WORKERS (default 2), SERVICE_OCR_ADAPTER (default stub-ocr).
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

const root = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.SERVICE_DATA_DIR ?? join(root, 'data');
const uploadsDir = join(dataDir, 'uploads');
mkdirSync(uploadsDir, { recursive: true });

const adapterId = process.env.SERVICE_OCR_ADAPTER ?? 'stub-ocr';
let ocr = {};
if (adapterId === 'ppocr-server') {
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

const service = new ParseService({
  dataDir,
  workers: Number(process.env.SERVICE_WORKERS ?? 2),
  adapterId,
  ocr
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
      if ((req.headers['content-type'] ?? '').includes('application/json')) {
        let parsed;
        try {
          parsed = JSON.parse(body.toString('utf8'));
        } catch {
          return json(res, 400, { error: 'Request body is not valid JSON.' });
        }
        pdfPath = parsed.pdfPath;
        sourceUri = parsed.sourceUri;
        if (typeof pdfPath !== 'string' || !pdfPath) return json(res, 400, { error: 'pdfPath (string) is required in JSON mode.' });
      } else {
        if (!body.length) return json(res, 400, { error: 'Send PDF bytes, or JSON {"pdfPath": "..."}.' });
        pdfPath = join(uploadsDir, `upload_${randomBytes(6).toString('hex')}.pdf`);
        writeFileSync(pdfPath, body);
        uploaded = true;
      }
      try {
        const submitted = await service.submit({ pdfPath, sourceUri });
        return json(res, 202, submitted);
      } catch (error) {
        // A rejected upload is dead weight (and its bytes may be sensitive).
        if (uploaded) rmSync(pdfPath, { force: true });
        if (error.statusCode === 503) return json(res, 503, { error: error.message });
        return json(res, 422, { error: `Could not open PDF: ${error.message}` });
      }
    }

    if (req.method === 'GET' && parts[0] === 'v1' && parts[1] === 'jobs' && parts.length === 3) {
      const status = service.jobStatus(parts[2]);
      return status ? json(res, 200, status) : json(res, 404, { error: 'Unknown job.' });
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

    return json(res, 404, { error: 'Unknown route.' });
  } catch (error) {
    return json(res, 500, { error: String(error?.message ?? error) });
  }
});

const port = Number(process.env.PORT ?? 8571);
server.listen(port, () => {
  console.log(`parse-service listening on :${port} (adapter=${process.env.SERVICE_OCR_ADAPTER ?? 'stub-ocr'}, workers=${process.env.SERVICE_WORKERS ?? 2}, data=${dataDir})`);
});

process.on('SIGINT', async () => {
  await service.shutdown();
  server.close(() => process.exit(0));
});

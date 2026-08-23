import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ParseService } from '../service/lib/queue.mjs';

/**
 * M1 (container + Linux verification) regressions:
 *  - shutdown() must AWAIT worker exit — the pre-M1 version returned with
 *    children alive, so server.mjs's process.exit(0) raced the workers'
 *    exit hooks and could orphan ~2 GB Python sidecars (leak observed live
 *    during the sidecar loadtest teardown).
 *  - GET /health readiness must gate on a real warm-up inference, and a
 *    failed warm-up must never report ready.
 */

test('shutdown awaits every worker child exit (no orphaned children)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'svc-health-'));
  const service = new ParseService({ dataDir: join(dir, 'data'), workers: 2 });
  try {
    // Let the pool spawn and report ready.
    await waitFor(() => service.workers.length === 2 && service.workers.every((slot) => slot.ready));
    const children = service.workers.map((slot) => slot.child);
    await service.shutdown();
    for (const child of children) {
      // Resolved shutdown == exited children, synchronously observable.
      assert.ok(
        child.exitCode !== null || child.signalCode !== null,
        `worker pid ${child.pid} still alive after shutdown() resolved`
      );
    }
    assert.equal(service.workers.length, 0);
  } finally {
    await service.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('warmup runs one real inference per worker through the stub adapter', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'svc-health-'));
  const service = new ParseService({ dataDir: join(dir, 'data'), workers: 2 });
  try {
    await waitFor(() => service.workers.every((slot) => slot.ready));
    const results = await service.warmup({ timeoutMs: 30_000 });
    assert.equal(results.length, 2);
    for (const result of results) {
      assert.equal(result.ok, true, result.error);
      assert.equal(result.descriptor, 'stub-ocr@0');
    }
  } finally {
    await service.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('warmup through the sidecar path reports in-band meta and EP', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'svc-health-'));
  // Mock sidecar child: pin fixture + a protocol-honoring node script (same
  // shape as test/service-sidecar.test.mjs's mock, minimal here).
  const modelsDir = join(dir, 'models');
  mkdirSync(join(modelsDir, 'PP-OCRv6_small_det'), { recursive: true });
  const payload = Buffer.from('weights');
  writeFileSync(join(modelsDir, 'PP-OCRv6_small_det', 'inference.pdiparams'), payload);
  const pinsPath = join(dir, 'model-pins.json');
  writeFileSync(pinsPath, JSON.stringify({
    repos: {
      'PaddlePaddle/PP-OCRv6_small_det': {
        revision: 'rev-abc',
        files: { 'inference.pdiparams': createHash('sha256').update(payload).digest('hex') }
      }
    }
  }));
  const mockPath = join(dir, 'mock-child.cjs');
  writeFileSync(mockPath, `
    const readline = require('node:readline');
    console.log(JSON.stringify({ kind: 'meta', versions: { paddleocr: 'mock-1' }, platform: 'MockOS', threads: 1, hpiRequested: false, useHpip: false, modelPins: {}, initS: 0 }));
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const request = JSON.parse(line);
      console.log(JSON.stringify({ id: request.id, ms: 1, lines: [] }));
    });
  `);
  const service = new ParseService({
    dataDir: join(dir, 'data'),
    workers: 1,
    adapterId: 'ppocr-sidecar',
    ocr: { modelsDir, pinsPath, threads: 1, pythonCmd: [process.execPath, mockPath] }
  });
  try {
    await waitFor(() => service.workers.every((slot) => slot.ready));
    const [result] = await service.warmup({ timeoutMs: 30_000 });
    assert.equal(result.ok, true, result.error);
    // In-band evidence flows: child meta reached the parent via warm-up.
    assert.equal(result.sidecarMeta.versions.paddleocr, 'mock-1');
    assert.equal(result.backend.executionProvider, 'paddle-default');
    assert.match(result.descriptor, /#ep=paddle-default;threads=1$/u);
  } finally {
    await service.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

function forkServer(env) {
  const port = 18000 + Math.floor(Math.random() * 2000);
  const child = fork(new URL('../service/server.mjs', import.meta.url), [], {
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  const listening = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), 15_000);
    child.stdout.on('data', (chunk) => { if (String(chunk).includes('listening')) { clearTimeout(timer); resolve(); } });
    child.on('exit', () => { clearTimeout(timer); reject(new Error('server exited during startup')); });
  });
  return { child, port, listening };
}

test('GET /health becomes ready only after warm-up completes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'svc-health-'));
  const { child, port, listening } = forkServer({ SERVICE_DATA_DIR: join(dir, 'data'), SERVICE_WORKERS: '1' });
  try {
    await listening;
    let body;
    await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      body = await response.json();
      return response.status === 200;
    }, 30_000);
    assert.equal(body.ready, true);
    assert.equal(body.checks.warmupInference, true);
    assert.equal(body.checks.workersWarmedUp, true);
    assert.equal(body.checks.modelPinsVerified, null, 'stub adapter has no pins; null means n/a, never a false claim');
    assert.equal(body.workers.length, 1);
    assert.equal(body.workers[0].ok, true);
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /health stays 503 when warm-up fails (broken engine never reports ready)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'svc-health-'));
  // The warm-up raster is page 0; failing it breaks the warm-up inference
  // while leaving everything else healthy.
  const { child, port, listening } = forkServer({ SERVICE_DATA_DIR: join(dir, 'data'), SERVICE_WORKERS: '1', STUB_FAIL_PAGE: '0' });
  try {
    await listening;
    let body;
    await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      body = await response.json();
      return body.error !== null; // warm-up outcome recorded
    }, 30_000);
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(response.status, 503);
    body = await response.json();
    assert.equal(body.ready, false);
    assert.match(body.error, /warm-up failed/u);
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function waitFor(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

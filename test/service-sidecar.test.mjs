import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPpOcrSidecarAdapter, verifyModelPins } from '../service/adapters/ppocr-sidecar.mjs';

/**
 * Protocol/gate tests run against a MOCK child (deterministic, no Python):
 * they pin the framing, id matching, crash containment, respawn, pin
 * verification, and provenance truthfulness. The real sidecar is covered by
 * the loud-skip test at the bottom plus service/sidecar/sanity-check.mjs.
 */

function fixturePins() {
  const dir = mkdtempSync(join(tmpdir(), 'sidecar-pins-'));
  const modelsDir = join(dir, 'models');
  const repoDir = join(modelsDir, 'PP-OCRv6_small_det');
  mkdirSync(repoDir, { recursive: true });
  const payload = Buffer.from('weights');
  writeFileSync(join(repoDir, 'inference.pdiparams'), payload);
  const pinsPath = join(dir, 'model-pins.json');
  writeFileSync(pinsPath, JSON.stringify({
    repos: {
      'PaddlePaddle/PP-OCRv6_small_det': {
        revision: 'rev-abc',
        files: { 'inference.pdiparams': createHash('sha256').update(payload).digest('hex') }
      }
    }
  }));
  return { dir, modelsDir, pinsPath };
}

// A mock child honoring the sidecar protocol. Behaviors trigger on the
// CONTENT of the request's tmpfile (the bytes recognize() wrote):
//   CRASH  → exit(7) without replying          (crash containment)
//   SILENT → never reply to this request        (recognize deadline)
// Replies ENCODE THE REQUEST ID in their text ('Revenue <id>') so a
// misattached reply is detectable — a FIFO-attachment bug would hand page
// A page B's text, and the assertions below would catch it. Pairs of
// in-flight requests are answered in REVERSE order to force the id path.
// MOCK_SLOW_META (env): skip the meta line and idle (meta-timeout repro),
// unless MOCK_STATE_FILE exists — the second spawn is healthy. The mock
// writes its own pid into meta so tests can probe process death.
const MOCK_CHILD = `
const fs = require('node:fs');
const readline = require('node:readline');
if (process.env.MOCK_SLOW_META === '1' && !fs.existsSync(process.env.MOCK_STATE_FILE)) {
  fs.writeFileSync(process.env.MOCK_STATE_FILE, String(process.pid));
  setInterval(() => {}, 1000); // never send meta; stay alive until killed
} else {
  console.log(JSON.stringify({ kind: 'meta', pid: process.pid, versions: { paddleocr: 'mock-1' }, platform: 'MockOS', osCpuCount: 1, threads: 1, threadKwargApplied: true, hpiRequested: false, useHpip: false, modelPins: {}, initS: 0 }));
  console.error('mock: Backend::MOCKENGINE in Device::CPU');
  console.error('mock: Inference backend config: cpu_num_threads=1');
  const held = [];
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const request = JSON.parse(line);
    const content = fs.readFileSync(request.path, 'utf8');
    if (content === 'CRASH') process.exit(7);
    if (content === 'SILENT') return;
    const reply = { id: request.id, ms: 1.0, lines: [
      { text: 'Revenue ' + request.id, poly: [[10, 10], [110, 10], [110, 30], [10, 30]], score: 0.97 },
      { text: '   ', poly: [[0, 0], [1, 0], [1, 1], [0, 1]], score: 0.9 }
    ] };
    held.push(reply);
    if (held.length === 2) { // answer the pair in reverse order
      console.log(JSON.stringify(held[1]));
      console.log(JSON.stringify(held[0]));
      held.length = 0;
    } else {
      setTimeout(() => {
        if (held.length === 1) { console.log(JSON.stringify(held.shift())); }
      }, 30);
    }
  });
}
`;

// Simulates the uv launcher: a wrapper that SPAWNS the mock rather than
// exec'ing it — killing only the wrapper must not orphan the grandchild.
const MOCK_WRAPPER = `
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, [process.env.MOCK_REAL_CHILD], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
`;

function mockAdapter(fixture, overrides = {}) {
  const mockPath = join(fixture.dir, 'mock-child.cjs');
  writeFileSync(mockPath, MOCK_CHILD);
  // pythonCmd is just an argv prefix; pointing it at node + the mock swaps
  // the implementation without touching the protocol under test. The mock
  // ignores the trailing real-script argument.
  return createPpOcrSidecarAdapter({
    modelsDir: fixture.modelsDir,
    pinsPath: fixture.pinsPath,
    threads: 1,
    pythonCmd: [process.execPath, mockPath],
    metaTimeoutMs: 5000,
    ...overrides
  });
}

test('sidecar protocol: round-trip maps lines to observations, drops empty text', async () => {
  const fixture = fixturePins();
  const adapter = mockAdapter(fixture);
  try {
    await adapter.warmup();
    const result = await adapter.recognize({ pageNumber: 3, data: Buffer.from('png-bytes') });
    assert.equal(result.observations.length, 1);
    const [observation] = result.observations;
    assert.equal(observation.text, 'Revenue 1'); // mock encodes the request id
    assert.deepEqual(observation.box, [10, 10, 110, 30]);
    assert.equal(observation.confidence, 0.97);
    assert.equal(observation.pageNumber, 3);
    assert.ok(Number.isFinite(adapter.coldInitMs()));
  } finally {
    await adapter.dispose();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('sidecar protocol: out-of-order replies land on the right requests', async () => {
  const fixture = fixturePins();
  const adapter = mockAdapter(fixture);
  try {
    await adapter.warmup();
    const [a, b] = await Promise.all([
      adapter.recognize({ pageNumber: 1, data: Buffer.from('a') }),
      adapter.recognize({ pageNumber: 2, data: Buffer.from('b') })
    ]);
    assert.equal(a.pageNumber, 1);
    assert.equal(b.pageNumber, 2);
    // The mock encodes each request's id in its reply text and answers the
    // pair in REVERSE order: a FIFO reply-attachment bug would hand page 1
    // page 2's reading. Request ids are sequential from 1.
    assert.equal(a.observations[0].text, 'Revenue 1');
    assert.equal(b.observations[0].text, 'Revenue 2');
  } finally {
    await adapter.dispose();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('sidecar crash: pending page fails closed; next recognize respawns', async () => {
  const fixture = fixturePins();
  const adapter = mockAdapter(fixture);
  let again = null;
  try {
    await adapter.warmup();
    // Content trigger: a request whose tmpfile says CRASH makes the mock
    // exit(7) without replying — the in-flight page must fail closed...
    await assert.rejects(
      adapter.recognize({ pageNumber: 2, data: Buffer.from('CRASH') }),
      /exited|killed/u
    );
    // ...and the SAME adapter respawns on the next page (worker keeps its
    // adapter instance; the child is the disposable part).
    const result = await adapter.recognize({ pageNumber: 4, data: Buffer.from('ok') });
    assert.equal(result.observations.length, 1);
    // Explicit dispose still rejects anything in flight.
    const pendingReject = adapter.recognize({ pageNumber: 5, data: Buffer.from('SILENT') });
    await adapter.dispose();
    await assert.rejects(pendingReject, /disposed|exited|killed/u);
  } finally {
    await adapter.dispose().catch(() => undefined);
    if (again) await again.dispose().catch(() => undefined);
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('meta timeout kills the slow child and does not poison the respawn', async () => {
  const fixture = fixturePins();
  const stateFile = join(fixture.dir, 'slow-meta-state');
  process.env.MOCK_SLOW_META = '1';
  process.env.MOCK_STATE_FILE = stateFile;
  const adapter = mockAdapter(fixture, { metaTimeoutMs: 500 });
  try {
    // First spawn: the mock never sends meta. The timeout must BOTH reject
    // and kill the stale child (an unkilled one is a leaked ~2 GB engine in
    // production, and its late exit used to null the NEW child's state).
    await assert.rejects(adapter.warmup(), /meta line not received/u);
    const stalePid = Number(readFileSync(stateFile, 'utf8'));
    await waitForDeath(stalePid);
    // Second spawn (state file now exists → mock is healthy): recognize
    // must succeed with correctly-attributed output — the stale child's
    // exit must not have rejected or nulled the live instance.
    const result = await adapter.recognize({ pageNumber: 1, data: Buffer.from('ok') });
    assert.equal(result.observations[0].text, 'Revenue 1');
  } finally {
    delete process.env.MOCK_SLOW_META;
    delete process.env.MOCK_STATE_FILE;
    await adapter.dispose().catch(() => undefined);
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('group kill reaps the interpreter behind a wrapper launcher (uv shape)', async () => {
  const fixture = fixturePins();
  const wrapperPath = join(fixture.dir, 'mock-wrapper.cjs');
  const mockPath = join(fixture.dir, 'mock-child.cjs');
  writeFileSync(mockPath, MOCK_CHILD);
  writeFileSync(wrapperPath, MOCK_WRAPPER);
  process.env.MOCK_REAL_CHILD = mockPath;
  const adapter = createPpOcrSidecarAdapter({
    modelsDir: fixture.modelsDir,
    pinsPath: fixture.pinsPath,
    threads: 1,
    pythonCmd: [process.execPath, wrapperPath],
    metaTimeoutMs: 5000
  });
  try {
    await adapter.warmup();
    // The GRANDCHILD (the real engine, behind the uv-shaped wrapper)
    // reports its own pid in meta. Killing only the wrapper would leave it
    // alive — the process-group kill must reap it.
    const grandchildPid = adapter.sidecarMeta.pid;
    assert.ok(Number.isInteger(grandchildPid));
    await adapter.dispose();
    await waitForDeath(grandchildPid);
  } finally {
    delete process.env.MOCK_REAL_CHILD;
    await adapter.dispose().catch(() => undefined);
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('recognize deadline: a silent child is killed and the page fails closed', async () => {
  const fixture = fixturePins();
  const adapter = mockAdapter(fixture, { recognizeTimeoutMs: 400 });
  try {
    await assert.rejects(
      adapter.recognize({ pageNumber: 1, data: Buffer.from('SILENT') }),
      /timed out .* fails closed/u
    );
    // The child was killed on deadline (unknowable protocol state); the
    // next page respawns and succeeds.
    const result = await adapter.recognize({ pageNumber: 2, data: Buffer.from('ok') });
    assert.equal(result.observations.length, 1);
  } finally {
    await adapter.dispose().catch(() => undefined);
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

async function waitForDeath(pid, timeoutMs = 4000) {
  const start = Date.now();
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return; // ESRCH: dead
    }
    if (Date.now() - start > timeoutMs) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* cleanup attempt */ }
      throw new Error(`process ${pid} still alive after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test('model pin mismatch refuses at construction (boot fails closed)', () => {
  const fixture = fixturePins();
  try {
    writeFileSync(join(fixture.modelsDir, 'PP-OCRv6_small_det', 'inference.pdiparams'), 'tampered');
    assert.throws(
      () => createPpOcrSidecarAdapter({ modelsDir: fixture.modelsDir, pinsPath: fixture.pinsPath }),
      /pin mismatch/iu
    );
    // Missing file is the same refusal.
    rmSync(join(fixture.modelsDir, 'PP-OCRv6_small_det', 'inference.pdiparams'));
    assert.throws(() => verifyModelPins(fixture.modelsDir, fixture.pinsPath), /missing/u);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('provenance is truthful: ep derives from child meta, pins ride along', async () => {
  const fixture = fixturePins();
  const adapter = mockAdapter(fixture);
  try {
    await adapter.warmup();
    // stderr flows through a separate pipe; give readline one macrotask to
    // deliver the mock's engine line before asserting on the ring buffer.
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Mock meta says useHpip:false → the descriptor may not claim hpi.
    assert.match(adapter.descriptor, /#ep=paddle-default;threads=1$/u);
    assert.equal(adapter.backend.executionProvider, 'paddle-default');
    assert.equal(adapter.backend.useHpip, false);
    assert.deepEqual(adapter.backend.modelPins, { 'PaddlePaddle/PP-OCRv6_small_det': 'rev-abc' });
    // Engine evidence is log-derived and labeled as such.
    assert.equal(adapter.backend.engineEvidence.source, 'log-derived (child stderr)');
    assert.match(adapter.backend.engineEvidence.line, /Backend::MOCKENGINE/u);
    assert.doesNotMatch(adapter.backend.engineEvidence.line, /backend config/u);
    assert.equal(adapter.canonical, true);
  } finally {
    // dispose in finally: a failed assertion must not leak a live child
    // (that leak is exactly what hangs a test runner).
    await adapter.dispose();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('real sidecar smoke (loud-skip without local python env + pinned models)', { skip: !process.env.SERVICE_SIDECAR_MODELS_DIR || !existsSync(process.env.SERVICE_SIDECAR_MODELS_DIR ?? '') ? 'set SERVICE_SIDECAR_MODELS_DIR (see service/README.md) to run the real-sidecar smoke' : false }, async () => {
  const adapter = createPpOcrSidecarAdapter({
    modelsDir: process.env.SERVICE_SIDECAR_MODELS_DIR,
    threads: 1
  });
  await adapter.warmup();
  assert.equal(typeof adapter.sidecarMeta.versions.paddleocr, 'string');
  // One tiny render: a 60x30 white PNG with no ink — zero observations is
  // the correct, honest result; the assertion is protocol + shape, not OCR.
  const { PNG } = await import('pngjs');
  const png = new PNG({ width: 60, height: 30, fill: true });
  png.data.fill(255);
  const result = await adapter.recognize({ pageNumber: 1, data: PNG.sync.write(png) });
  assert.ok(Array.isArray(result.observations));
  await adapter.dispose();
});

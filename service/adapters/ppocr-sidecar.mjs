/**
 * Adopted canonical OCR witness (issue #2, PR #67 ceremony): the official
 * PaddleOCR pipeline as a subprocess-per-worker Python sidecar.
 *
 * Protocol: JSONL over stdin/stdout — {id, path} in, {id, lines, ms} out;
 * the child's FIRST line is a meta record (versions, platform, thread
 * setting, model pins, in-band `useHpip`). Pages travel as tmpfiles, not
 * base64. A child crash rejects every pending request (the page fails
 * closed and the queue requeues it); the next recognize() respawns the
 * child. The child never outlives this process (killed on exit/dispose).
 *
 * Provenance is truthful per host: the descriptor's `ep=` is derived from
 * the child's own meta (hpi on Linux, paddle-default elsewhere) — never a
 * claim the process could not verify. The engine-selection line the C++
 * layer prints (e.g. "Backend::OPENVINO") bypasses Python logging, so this
 * adapter retains the child's recent stderr and exposes the first matching
 * line as LOG-DERIVED evidence (`backend.engineEvidence`), labeled as such.
 *
 * Models are pinned (service/sidecar/model-pins.json): the child verifies
 * every file hash before loading and refuses to serve on mismatch — and
 * `verifyModelPins()` lets the server fail closed at boot, before any job
 * is accepted.
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIDECAR_DIR = dirname(fileURLToPath(import.meta.url)).replace(/adapters$/u, 'sidecar');
const SIDECAR_SCRIPT = join(SIDECAR_DIR, 'ppocr_sidecar.py');
const PINS_PATH = join(SIDECAR_DIR, 'model-pins.json');
export const DEFAULT_PYTHON_CMD = ['uv', 'run', '--with', 'paddleocr==3.7.0', '--with', 'paddlepaddle==3.2.1', 'python'];

/**
 * Node-side pin verification for boot-time fail-closed (the child verifies
 * again before loading — refusal lives on both sides of the process
 * boundary, same doctrine as the canonical gate).
 */
export function verifyModelPins(modelsDir, pinsPath = PINS_PATH) {
  const manifest = JSON.parse(readFileSync(pinsPath, 'utf8'));
  const failures = [];
  for (const [repo, pin] of Object.entries(manifest.repos)) {
    const base = join(modelsDir, repo.split('/').pop());
    for (const [rel, expected] of Object.entries(pin.files)) {
      const path = join(base, rel);
      if (!existsSync(path)) { failures.push(`${repo}/${rel}: missing`); continue; }
      const got = createHash('sha256').update(readFileSync(path)).digest('hex');
      if (got !== expected) failures.push(`${repo}/${rel}: expected ${expected.slice(0, 12)}, got ${got.slice(0, 12)}`);
    }
  }
  if (failures.length) {
    throw new Error(`Model pin mismatch — refusing to serve unvalidated weights:\n${failures.join('\n')}`);
  }
  return Object.fromEntries(Object.entries(manifest.repos).map(([repo, pin]) => [repo, pin.revision]));
}

const STDERR_RING = 200;

export function createPpOcrSidecarAdapter(config = {}) {
  const { modelsDir, threads = 1, pythonCmd = DEFAULT_PYTHON_CMD, pinsPath = PINS_PATH, metaTimeoutMs = 300_000 } = config;
  if (!modelsDir) {
    throw new Error('ppocr-sidecar requires an explicit modelsDir (SERVICE_SIDECAR_MODELS_DIR) — pinned models are configuration, not magic.');
  }
  const pins = verifyModelPins(modelsDir, pinsPath);
  const tmpRoot = mkdtempSync(join(tmpdir(), 'psvc-sidecar-'));

  let child = null;
  let meta = null;
  let coldInitMs = null;
  let disposed = false;
  const pending = new Map();
  const stderrRing = [];
  let nextId = 1;

  function killChild() {
    if (child) { child.kill('SIGKILL'); child = null; }
  }
  const onExit = () => { killChild(); rmSync(tmpRoot, { recursive: true, force: true }); };
  process.once('exit', onExit);

  function rejectPending(reason) {
    for (const [, entry] of pending) entry.reject(new Error(reason));
    pending.clear();
  }

  async function ensureChild() {
    if (child && meta) return;
    const started = performanceNow();
    const [cmd, ...args] = pythonCmd;
    child = spawn(cmd, [...args, SIDECAR_SCRIPT], {
      env: { ...process.env, SIDECAR_MODELS_DIR: modelsDir, SIDECAR_THREADS: String(threads) },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    child.on('exit', () => {
      // Any pending page fails closed; the next recognize() respawns.
      child = null;
      meta = null;
      rejectPending('OCR sidecar exited.');
    });
    createInterface({ input: child.stderr }).on('line', (line) => {
      stderrRing.push(line);
      if (stderrRing.length > STDERR_RING) stderrRing.shift();
    });
    const lines = createInterface({ input: child.stdout });
    meta = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Sidecar meta line not received within ${metaTimeoutMs}ms.`)), metaTimeoutMs);
      lines.on('line', (line) => {
        let message;
        try { message = JSON.parse(line); } catch { return; }
        if (message.kind === 'meta') {
          clearTimeout(timer);
          resolve(message);
          return;
        }
        if (message.kind === 'fatal') {
          clearTimeout(timer);
          reject(new Error(`Sidecar refused to start: ${message.error}`));
          return;
        }
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        if (message.error) entry.reject(new Error(`Sidecar page error: ${message.error}`));
        else entry.resolve(message);
      });
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
    });
    coldInitMs = Math.round(performanceNow() - started);
  }

  function performanceNow() { return Number(process.hrtime.bigint() / 1_000_000n); }

  function descriptorFor(currentMeta) {
    // ep is derived from the child's own testimony, never asserted: hpi is
    // only claimable where the pipeline itself reports it engaged.
    const ep = currentMeta.useHpip === true ? 'hpi' : 'paddle-default';
    const version = currentMeta.versions?.paddleocr ?? 'unknown';
    return { ep, version, descriptor: `ppocrv6-small-sidecar@${version}#ep=${ep};threads=${threads}` };
  }

  return {
    name: 'ppocrv6-small-sidecar',
    get version() { return meta?.versions?.paddleocr ?? 'unpinned'; },
    canonical: true,
    get descriptor() { return meta ? descriptorFor(meta).descriptor : `ppocrv6-small-sidecar@unstarted#ep=unknown;threads=${threads}`; },
    get backend() {
      if (!meta) return null;
      const { ep, version } = descriptorFor(meta);
      return {
        adapter: 'ppocrv6-small-sidecar',
        version,
        variant: 'small',
        executionProvider: ep,
        numThreads: threads,
        platform: meta.platform,
        hpiRequested: meta.hpiRequested,
        useHpip: meta.useHpip,
        modelPins: pins,
        // The C++ engine line bypasses Python logging entirely; this is the
        // best available evidence and is labeled for what it is.
        engineEvidence: {
          source: 'log-derived (child stderr)',
          line: stderrRing.find((line) => /Backend::|backend config/u.test(line)) ?? null
        }
      };
    },
    get sidecarMeta() { return meta; },
    async warmup() {
      await ensureChild();
    },
    coldInitMs: () => coldInitMs,
    async dispose() {
      disposed = true;
      rejectPending('OCR sidecar disposed.');
      killChild();
      process.removeListener('exit', onExit);
      rmSync(tmpRoot, { recursive: true, force: true });
    },
    async recognize(page) {
      if (disposed) throw new Error('OCR sidecar disposed.');
      await ensureChild();
      if (disposed) throw new Error('OCR sidecar disposed.');
      const id = nextId++;
      const path = join(tmpRoot, `${randomUUID()}.png`);
      writeFileSync(path, Buffer.from(page.data));
      try {
        const response = await new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          child.stdin.write(`${JSON.stringify({ id, path })}\n`);
        });
        const observations = (response.lines ?? [])
          .filter((line) => typeof line.text === 'string' && line.text.trim())
          .map((line, index) => {
            const score = line.score;
            if (!Number.isFinite(score) || score < 0 || score > 1) {
              throw new Error(`Sidecar line ${index} has invalid confidence ${score}.`);
            }
            const polygon = Array.isArray(line.poly) ? line.poly.map((point) => [point[0], point[1]]) : null;
            if (!polygon || polygon.length < 3) {
              throw new Error(`Sidecar line ${index} is missing its polygon.`);
            }
            const xs = polygon.map((point) => point[0]);
            const ys = polygon.map((point) => point[1]);
            return {
              id: `ppocr-sidecar:${page.pageNumber}:${index}`,
              pageNumber: page.pageNumber,
              text: line.text,
              box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
              polygon,
              confidence: score,
              model: 'PP-OCRv6_small'
            };
          });
        return { pageNumber: page.pageNumber, observations, backend: descriptorFor(meta).ep };
      } finally {
        try { unlinkSync(path); } catch { /* tmpfile already gone */ }
      }
    }
  };
}

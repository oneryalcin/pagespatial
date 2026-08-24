/**
 * Adopted canonical OCR witness (issue #2, PR #67 ceremony): the official
 * PaddleOCR pipeline as a subprocess-per-worker Python sidecar.
 *
 * Protocol: JSONL over stdin/stdout — {id, path} in, {id, lines, ms} out;
 * the child's FIRST line is a meta record (versions, platform, thread
 * setting, model pins, in-band `useHpip`). Pages travel as tmpfiles, not
 * base64. A child crash rejects every pending request (the page fails
 * closed and the queue requeues it); the next recognize() respawns the
 * child. Reaping is by PROCESS-GROUP kill (children spawn detached in
 * their own group) on dispose, worker exit hooks, and worker signals —
 * necessary because a wrapper launcher like uv spawns python rather than
 * exec'ing it, so killing only the direct child would orphan the engine.
 * If the worker itself dies un-hooked (SIGKILL), the fallback is the
 * child's stdin-EOF exit, which waits out any in-flight predict.
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
  const { modelsDir, threads = 1, pythonCmd = DEFAULT_PYTHON_CMD, pinsPath = PINS_PATH, metaTimeoutMs = 300_000, recognizeTimeoutMs = 120_000 } = config;
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

  /**
   * Kill an instance's WHOLE process group. The default launcher is a uv
   * wrapper that spawns python rather than exec'ing it, so killing only
   * the direct child leaves a ~2 GB python grandchild alive (it then exits
   * only on stdin EOF — never, if it is wedged mid-predict). Children are
   * spawned detached so pgid === child.pid and the group kill reaps the
   * wrapper AND the interpreter.
   */
  function killInstance(instance) {
    if (!instance) return;
    try { process.kill(-instance.pid, 'SIGKILL'); } catch { /* group already gone */ }
    try { instance.kill('SIGKILL'); } catch { /* already dead */ }
  }
  function killChild() {
    const current = child;
    child = null;
    meta = null;
    // Deliberate kills must reject the remaining in-flight pages here: the
    // instance's own exit handler is guarded on `child === self` and child
    // was just nulled, so it will (correctly) not touch shared state.
    rejectPending('OCR sidecar killed.');
    killInstance(current);
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
    // detached: the child leads its own process group, so killInstance can
    // reap wrapper + interpreter together (see above).
    const self = spawn(cmd, [...args, SIDECAR_SCRIPT], {
      env: { ...process.env, SIDECAR_MODELS_DIR: modelsDir, SIDECAR_THREADS: String(threads) },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true
    });
    child = self;
    // Fresh evidence per child: a respawned engine must not inherit the
    // previous instance's stderr (stale backend lines would lie).
    stderrRing.length = 0;
    // EPIPE window: a write racing child death must reject the page (via
    // the exit handler), never crash the worker.
    self.stdin.on('error', () => { /* pending rejected by exit handler */ });
    // Every handler below is INSTANCE-scoped: a stale child (e.g. one that
    // timed out on meta and died later) must not null the live child's
    // reference or reject the live child's pages.
    self.on('exit', () => {
      if (child !== self) return;
      child = null;
      meta = null;
      rejectPending('OCR sidecar exited.');
    });
    createInterface({ input: self.stderr }).on('line', (line) => {
      if (child !== self) return;
      stderrRing.push(line);
      if (stderrRing.length > STDERR_RING) stderrRing.shift();
    });
    const lines = createInterface({ input: self.stdout });
    meta = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // The slow starter is dead weight AND a hazard: kill its whole
        // group now, or a ~2 GB engine survives unreferenced.
        if (child === self) { child = null; }
        killInstance(self);
        reject(new Error(`Sidecar meta line not received within ${metaTimeoutMs}ms.`));
      }, metaTimeoutMs);
      lines.on('line', (line) => {
        // Stale-instance output is dropped wholesale. (A late meta line
        // after the timeout would hit an already-rejected promise anyway —
        // resolve() there is a no-op.)
        if (child !== self) return;
        let message;
        try { message = JSON.parse(line); } catch { return; }
        if (message.kind === 'meta') {
          clearTimeout(timer);
          resolve(message);
          return;
        }
        if (message.kind === 'fatal') {
          clearTimeout(timer);
          child = null;
          killInstance(self);
          reject(new Error(`Sidecar refused to start: ${message.error}`));
          return;
        }
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        if (message.error) entry.reject(new Error(`Sidecar page error: ${message.error}`));
        else entry.resolve(message);
      });
      self.on('error', (error) => { clearTimeout(timer); if (child === self) { child = null; } reject(error); });
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
          // Prefer the latest concrete C++ engine selection. A later generic
          // "backend config" line may carry thread settings but cannot prove
          // OpenVINO rather than Paddle served the request.
          line: stderrRing.filter((line) => /Backend::/u.test(line)).at(-1)
            ?? stderrRing.filter((line) => /backend config/u.test(line)).at(-1)
            ?? null
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
          // A torn or dropped response line (the C++ layer writes to the raw
          // fds; unparseable lines are skipped) must not park this promise
          // forever — that is silent pool starvation. On deadline: fail the
          // page closed (queue requeues) and kill the child, whose protocol
          // state is now unknowable.
          const deadline = setTimeout(() => {
            pending.delete(id);
            killChild();
            reject(new Error(`Sidecar page timed out after ${recognizeTimeoutMs}ms; child killed, page fails closed.`));
          }, recognizeTimeoutMs);
          pending.set(id, {
            resolve: (value) => { clearTimeout(deadline); resolve(value); },
            reject: (error) => { clearTimeout(deadline); reject(error); }
          });
          try {
            child.stdin.write(`${JSON.stringify({ id, path })}\n`);
          } catch (error) {
            clearTimeout(deadline);
            pending.delete(id);
            reject(error);
          }
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

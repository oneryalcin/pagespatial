/**
 * Page worker — a child process that executes one page task at a time.
 *
 * Child processes over worker_threads, deliberately: the pipeline leans on
 * native code (pdf-inspector napi, pdf.js) where a hard crash in a thread
 * would take the whole pool down; a child crash is contained, the queue
 * requeues the page, and per-process RSS is honestly attributable.
 *
 * Protocol (IPC): parent sends {kind:'page', task}, child replies
 * {kind:'result', ...} or dies (parent treats death as a crashed attempt).
 */
import { createStubOcrAdapter } from './adapters/stub-ocr.mjs';
import { createPpOcrServerAdapter } from './adapters/ppocr-server.mjs';
import { createPpOcrSidecarAdapter } from './adapters/ppocr-sidecar.mjs';
import { assemblyStage, nativeStage, ocrStage, openDocumentContext, renderStage, RENDER_SCALE } from './lib/stages.mjs';
import { performance } from 'node:perf_hooks';

const ADAPTERS = {
  'stub-ocr': createStubOcrAdapter,
  // Canonical since the witness-equivalence run (PR #55/#59): node-worse
  // bounded at 0.5% of gold at 95%. Retained as the validated fallback.
  'ppocr-server': createPpOcrServerAdapter,
  // ADOPTED canonical witness (PR #67 ceremony; owner decision on #2):
  // candidate-worse vs browser bounded at 0.74% of gold at 95%, 2/1,223
  // discordant vs ppocr-server. Pinned models, truthful per-host EP.
  'ppocr-sidecar': createPpOcrSidecarAdapter
};

// The PP-OCR engine costs ~1s of init plus model load: create ONCE per
// worker process, reuse across every page. Keyed by config so a worker can
// never silently serve a different backend than the task pinned.
const adapterInstances = new Map();
let adapterColdInitMs;
async function adapterFor(task) {
  const factory = ADAPTERS[task.adapterId];
  if (!factory) throw new Error(`Unknown OCR adapter '${task.adapterId}'.`);
  const key = `${task.adapterId}|${JSON.stringify(task.ocr ?? {})}`;
  if (adapterInstances.has(key)) return adapterInstances.get(key);
  const adapter = factory(task.ocr ?? {});
  if (typeof adapter.warmup === 'function') {
    const start = performance.now();
    await adapter.warmup();
    adapterColdInitMs = Math.round(performance.now() - start);
  }
  adapterInstances.set(key, adapter);
  return adapter;
}

// A worker mostly serves one job at a time; two slots absorb interleaving.
// Keyed by (pdfPath, sha256): two jobs over one path with different pinned
// identities must never share a context.
const contexts = new Map();
async function contextFor(task) {
  const key = `${task.pdfPath}|${task.sha256 ?? ''}`;
  if (contexts.has(key)) return contexts.get(key);
  const context = await openDocumentContext(task.pdfPath, task.identity);
  contexts.set(key, context);
  while (contexts.size > 2) {
    const [oldestKey, oldest] = contexts.entries().next().value;
    contexts.delete(oldestKey);
    await oldest.dispose().catch(() => undefined);
  }
  return context;
}

async function runPage(task) {
  const adapter = await adapterFor(task);
  const context = await contextFor(task);
  // The submission probe pinned the document identity; the bytes on disk
  // must still be that document at work time. Fail the page closed on drift.
  if (task.sha256 && context.identity.sha256 !== task.sha256) {
    contexts.forEach((value, key) => { if (value === context) contexts.delete(key); });
    await context.dispose().catch(() => undefined);
    throw new Error(`Document changed since submission: pinned sha256 ${task.sha256}, on disk ${context.identity.sha256}.`);
  }
  const stageTimingsMs = {};

  const rendered = await renderStage(context, task.pageNumber, task.renderScale ?? RENDER_SCALE);
  stageTimingsMs.render = rendered.ms;

  const native = await nativeStage(context, task.pageNumber);
  stageTimingsMs.native = native.ms;

  const ocr = await ocrStage(adapter, rendered.value, task.pageNumber);
  stageTimingsMs.ocr = ocr.ms;
  if (adapterColdInitMs !== undefined) {
    // Engine init happens once per worker process; reported once so the
    // aggregate can amortize it honestly instead of hiding it in page 1.
    stageTimingsMs.ocrColdInit = adapterColdInitMs;
    adapterColdInitMs = undefined;
  }

  if (adapter.canonical !== true) {
    // A stub witness must never yield a schema-valid record: no assembly,
    // no pageSpatial key anywhere in the result — timings only.
    return {
      nonCanonical: true,
      ocrAdapter: `${adapter.name}@${adapter.version}`,
      stageTimingsMs,
      rasterSize: { width: rendered.value.raster.width, height: rendered.value.raster.height },
      counts: { nativeObservations: native.value.observations.length, ocrObservations: ocr.value.observations.length }
    };
  }

  const assembled = await assemblyStage(context, task.pageNumber, adapter, native.value, rendered.value.renderedPage, ocr.value, {
    runId: task.runId,
    // The pinned backend descriptor, not just name@version: the owner's
    // witness-swap condition is that no record can be ambiguous about which
    // engine/EP/threading produced its OCR witness.
    ocrAdapterId: adapter.descriptor ?? `${adapter.name}@${adapter.version}`,
    configuration: {
      renderScale: task.renderScale ?? RENDER_SCALE,
      ...(adapter.backend ? { ocrBackend: adapter.backend } : {})
    }
  });
  stageTimingsMs.assembly = assembled.ms;
  if (assembled.value.secondOpinionMs !== undefined) stageTimingsMs.secondOpinion = assembled.value.secondOpinionMs;
  return { pageSpatial: assembled.value.pageSpatial, stageTimingsMs };
}

// 80x40 all-white grayscale PNG (generated with node:zlib, embedded so the
// runtime image needs no image library). The health warm-up runs a REAL
// inference through the configured adapter on this raster: for the sidecar
// that spawns the Python child, waits for its meta line, and round-trips one
// predict — zero observations on blank ink is the honest, correct result.
const WARMUP_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAFAAAAAoCAAAAABMCyLdAAAAJUlEQVR4nO3MMQEAAAwCIPuX1hDbCQFIn0UoFAqFQqFQKBQKbwaQyXQ1muFazgAAAABJRU5ErkJggg==',
  'base64'
);

async function runWarmup(task) {
  const adapter = await adapterFor(task);
  const result = await adapter.recognize({
    pageNumber: 0,
    geometry: { width: 80, height: 40 },
    data: WARMUP_PNG,
    mimeType: 'image/png'
  });
  return {
    observations: result.observations.length,
    descriptor: adapter.descriptor ?? `${adapter.name}@${adapter.version}`,
    backend: adapter.backend ?? null,
    sidecarMeta: adapter.sidecarMeta ?? null
  };
}

process.on('message', async (message) => {
  if (message?.kind === 'warmup') {
    try {
      const outcome = await runWarmup(message.task);
      process.send({ kind: 'warmup-result', ok: true, ...outcome });
    } catch (error) {
      process.send({ kind: 'warmup-result', ok: false, error: String(error?.message ?? error) });
    }
    return;
  }
  if (message?.kind !== 'page') return;
  const { task } = message;
  try {
    const result = await runPage(task);
    process.send({ kind: 'result', jobId: task.jobId, pageNumber: task.pageNumber, ok: true, ...result, rssBytes: process.memoryUsage().rss });
  } catch (error) {
    process.send({
      kind: 'result',
      jobId: task.jobId,
      pageNumber: task.pageNumber,
      ok: false,
      failure: { message: String(error?.message ?? error), errorClass: error?.name ?? 'Error' },
      rssBytes: process.memoryUsage().rss
    });
  }
});

// A SIGTERM'd worker must exit THROUGH process.exit so 'exit' hooks run —
// the sidecar adapter's hook kills its child's WHOLE process group from
// one (a signal's default termination skips hooks and would orphan a
// ~1.5 GB engine per worker). A hard SIGKILL of this worker bypasses
// this path too: the sidecar then exits via stdin EOF after finishing
// any in-flight predict — best-effort, documented in the adapter.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => process.exit(0));
}

process.send({ kind: 'ready' });

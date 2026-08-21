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
import { assemblyStage, nativeStage, ocrStage, openDocumentContext, renderStage, RENDER_SCALE } from './lib/stages.mjs';

const ADAPTERS = {
  'stub-ocr': createStubOcrAdapter
  // 'ppocr-server' arrives with issue #2 (canonical: true after equivalence).
};

// A worker mostly serves one job at a time; two slots absorb interleaving.
const contexts = new Map();
async function contextFor(task) {
  const key = task.pdfPath;
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
  const adapterFactory = ADAPTERS[task.adapterId];
  if (!adapterFactory) throw new Error(`Unknown OCR adapter '${task.adapterId}'.`);
  const adapter = adapterFactory();
  const context = await contextFor(task);
  const stageTimingsMs = {};

  const rendered = await renderStage(context, task.pageNumber, task.renderScale ?? RENDER_SCALE);
  stageTimingsMs.render = rendered.ms;

  const native = await nativeStage(context, task.pageNumber);
  stageTimingsMs.native = native.ms;

  const ocr = await ocrStage(adapter, rendered.value, task.pageNumber);
  stageTimingsMs.ocr = ocr.ms;

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

  const assembled = await assemblyStage(context, task.pageNumber, native.value, rendered.value.renderedPage, ocr.value, {
    runId: task.runId,
    ocrAdapterId: `${adapter.name}@${adapter.version}`,
    configuration: { renderScale: task.renderScale ?? RENDER_SCALE }
  });
  stageTimingsMs.assembly = assembled.ms;
  if (assembled.value.secondOpinionMs !== undefined) stageTimingsMs.secondOpinion = assembled.value.secondOpinionMs;
  return { pageSpatial: assembled.value.pageSpatial, stageTimingsMs };
}

process.on('message', async (message) => {
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

process.send({ kind: 'ready' });

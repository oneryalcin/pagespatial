import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  createPdfJsCanvasRenderer,
  createPpOcrV6BrowserAdapter,
  openPdfJsSession
} from '../../dist/browser/index.js';

let session;
let ocr;
let renderer;
let backendEvents = [];

function memorySample() {
  const memory = performance.memory;
  return memory && Number.isFinite(memory.usedJSHeapSize)
    ? { usedJsHeapBytes: memory.usedJSHeapSize, totalJsHeapBytes: memory.totalJSHeapSize, scope: 'sampled-after-page' }
    : { usedJsHeapBytes: null, totalJsHeapBytes: null, scope: 'not_evaluated' };
}

async function runtimeInfo() {
  let gpu = null;
  if (navigator.gpu) {
    const adapter = await navigator.gpu.requestAdapter().catch(() => null);
    if (adapter) {
      const info = adapter.info ?? {};
      gpu = {
        vendor: info.vendor || null,
        architecture: info.architecture || null,
        device: info.device || null,
        description: info.description || null
      };
    }
  }
  return { userAgent: navigator.userAgent, gpu };
}

async function closeDocument() {
  const previous = session;
  session = undefined;
  if (previous) await previous.dispose();
}

globalThis.pagespatialCorpus = {
  async initialize(options) {
    if (ocr) throw new Error('Corpus OCR bridge was already initialized.');
    backendEvents = [];
    renderer = createPdfJsCanvasRenderer({
      maxCanvasSide: options.maxCanvasSide,
      maxCanvasPixels: options.maxCanvasPixels
    });
    ocr = createPpOcrV6BrowserAdapter({
      detectionModelUrl: '/ocr/models/PP-OCRv6_tiny_det_onnx_infer.tar',
      recognitionModelUrl: '/ocr/models/PP-OCRv6_tiny_rec_onnx_infer.tar',
      wasmPaths: '/ocr/ort/',
      backend: options.backend,
      localOnly: true,
      detectorLimit: options.detectorLimit,
      recognitionThreshold: options.recognitionThreshold,
      recognitionBatchSize: options.recognitionBatchSize,
      onBackend(event) { backendEvents.push(event); }
    });
    const started = performance.now();
    await ocr.warmup();
    return {
      warmupMs: performance.now() - started,
      backend: ocr.getBackend(),
      backendEvents: [...backendEvents],
      runtime: await runtimeInfo()
    };
  },
  async openDocument(routeToken, identity, limits) {
    await closeDocument();
    const response = await fetch(`/pdf/${encodeURIComponent(routeToken)}`);
    if (!response.ok) throw new Error(`PDF request failed: HTTP ${response.status}.`);
    const started = performance.now();
    session = await openPdfJsSession(await response.arrayBuffer(), {
      documentId: identity.documentId,
      revisionId: identity.revisionId,
      sourceUri: identity.sourceUri,
      workerSrc: pdfWorkerUrl,
      maxBytes: limits.maxBytes,
      maxPages: limits.maxPages
    });
    if (session.source.identity.sha256 !== identity.sha256) throw new Error('Browser PDF SHA-256 differs from the verified source.');
    if (session.source.identity.pageCount !== identity.pageCount) throw new Error('Browser PDF page count differs from the verified source.');
    return { openMs: performance.now() - started, identity: session.source.identity };
  },
  async ocrPage(pageNumber, scale) {
    if (!session || !ocr || !renderer) throw new Error('Corpus OCR bridge is not ready.');
    const started = performance.now();
    const renderStarted = performance.now();
    const rendered = await renderer.render(session.source, pageNumber, { scale });
    const renderMs = performance.now() - renderStarted;
    try {
      const ocrStarted = performance.now();
      const result = await ocr.recognize(rendered);
      const ocrMs = performance.now() - ocrStarted;
      return {
        pageNumber,
        renderedPageNumber: rendered.pageNumber,
        geometry: rendered.geometry,
        ocr: result,
        backend: ocr.getBackend(),
        backendEvents: [...backendEvents],
        timings: { renderMs, ocrMs, totalMs: performance.now() - started },
        memory: memorySample()
      };
    } finally {
      await rendered.release?.();
    }
  },
  closeDocument,
  async dispose() {
    await closeDocument();
    const previous = ocr;
    ocr = undefined;
    renderer = undefined;
    if (previous) await previous.dispose();
  }
};

document.querySelector('#status').textContent = 'ready';

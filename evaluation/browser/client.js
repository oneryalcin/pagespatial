import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  createPdfJsCanvasRenderer,
  createPpOcrV6BrowserAdapter,
  createZoomRetryRecovery,
  openPdfJsSession
} from '../../dist/browser/index.js';

let session;
let ocr;
let renderer;
let regionRecovery;
let backendEvents = [];
let recoveryTiles = [];

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
    const variant = options.ocrVariant ?? 'tiny';
    ocr = createPpOcrV6BrowserAdapter({
      variant,
      detectionModelUrl: `/ocr/models/PP-OCRv6_${variant}_det_onnx_infer.tar`,
      recognitionModelUrl: `/ocr/models/PP-OCRv6_${variant}_rec_onnx_infer.tar`,
      wasmPaths: '/ocr/ort/',
      backend: options.backend,
      localOnly: true,
      detectorLimit: options.detectorLimit,
      recognitionThreshold: options.recognitionThreshold,
      recognitionBatchSize: options.recognitionBatchSize,
      onBackend(event) { backendEvents.push(event); }
    });
    regionRecovery = options.regionRecovery
      ? createZoomRetryRecovery({
          renderer,
          ocr,
          maxCanvasSide: options.maxCanvasSide,
          maxCanvasPixels: options.maxCanvasPixels,
          // Debug: capture the exact OCR input tiles for differential
          // experiments (issue #10). toDataURL must happen synchronously —
          // the recovery pass zeroes each tile canvas after use.
          onTile: options.dumpRecoveryTiles
            ? (tile) => {
                recoveryTiles.push({
                  box: tile.box,
                  dataUrl: tile.canvas.toDataURL('image/png'),
                  observations: tile.observations.map((observation) => ({
                    text: observation.text,
                    box: observation.box,
                    confidence: observation.confidence
                  }))
                });
              }
            : undefined
        })
      : undefined;
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
      cMapUrl: '/pdfjs-assets/cmaps/',
      standardFontDataUrl: '/pdfjs-assets/standard_fonts/',
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
      // Harness recovery approximates read boxes with the OCR set only (the
      // native set lives on the Node side); native-read areas that get
      // re-read produce corroborating duplicates that associate normally.
      let unreadInkRegions = [];
      let observations = result.observations;
      let recoveryMs = 0;
      if (regionRecovery) {
        const recoveryStarted = performance.now();
        const readEvidence = result.observations.map((observation) => ({ box: observation.box, text: observation.text }));
        unreadInkRegions = await regionRecovery.analyze(rendered, readEvidence.map((item) => item.box));
        const structured = unreadInkRegions.filter((region) => region.kind === 'structured');
        if (structured.length) {
          const recovered = await regionRecovery.recoverPage(
            session.source, pageNumber, structured, rendered.geometry, readEvidence);
          // Attribute by overlap, not center containment: page-level tiles
          // recover observations that straddle region edges, and a center
          // just outside the box must still count as that region's recovery.
          for (const observation of recovered) {
            let home;
            let best = 0;
            for (const region of structured) {
              const w = Math.min(observation.box[2], region.box[2]) - Math.max(observation.box[0], region.box[0]);
              const h = Math.min(observation.box[3], region.box[3]) - Math.max(observation.box[1], region.box[1]);
              const area = w > 0 && h > 0 ? w * h : 0;
              if (area > best) { best = area; home = region; }
            }
            if (home) home.recoveredObservationCount += 1;
          }
          observations = [...observations, ...recovered];
        }
        recoveryMs = performance.now() - recoveryStarted;
      }
      return {
        pageNumber,
        renderedPageNumber: rendered.pageNumber,
        geometry: rendered.geometry,
        unreadInkRegions,
        recoveryMs,
        ocr: { ...result, observations },
        backend: ocr.getBackend(),
        backendEvents: [...backendEvents],
        timings: { renderMs, ocrMs, totalMs: performance.now() - started },
        memory: memorySample()
      };
    } finally {
      await rendered.release?.();
    }
  },
  drainRecoveryTiles() {
    const tiles = recoveryTiles;
    recoveryTiles = [];
    return tiles;
  },
  closeDocument,
  async dispose() {
    await closeDocument();
    const previous = ocr;
    ocr = undefined;
    renderer = undefined;
    regionRecovery = undefined;
    if (previous) await previous.dispose();
  }
};

document.querySelector('#status').textContent = 'ready';

import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  createPdfJsCanvasRenderer,
  createPpOcrV6BrowserAdapter,
  createZoomRetryRecovery,
  openPdfJsSession
} from '../../dist/browser/index.js';
import { attributeConfirmations, countRecoveredObservations, pointBoxToRenderedBox, pruneConfirmations } from '../../dist/index.js';

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
  async ocrPage(pageNumber, scale, nativeEvidence = []) {
    if (!session || !ocr || !renderer) throw new Error('Corpus OCR bridge is not ready.');
    const started = performance.now();
    const renderStarted = performance.now();
    const rendered = await renderer.render(session.source, pageNumber, { scale });
    const renderMs = performance.now() - renderStarted;
    try {
      const ocrStarted = performance.now();
      const result = await ocr.recognize(rendered);
      const ocrMs = performance.now() - ocrStarted;
      // undefined = analysis never ran (recovery disabled); an empty array
      // is a positive claim that the page was analyzed and clean.
      let unreadInkRegions;
      let observations = result.observations;
      let recoveryMs = 0;
      if (regionRecovery) {
        const recoveryStarted = performance.now();
        // Both witnesses, like createParser: native point boxes are mapped
        // into rendered pixels so native-read areas never count as unread.
        const readEvidence = [
          ...nativeEvidence.map((observation) => ({
            box: pointBoxToRenderedBox(observation.pointBox, rendered.geometry).box,
            text: observation.text
          })),
          ...result.observations.map((observation) => ({ box: observation.box, text: observation.text }))
        ];
        unreadInkRegions = await regionRecovery.analyze(rendered, readEvidence.map((item) => item.box));
        const structured = unreadInkRegions.filter((region) => region.kind === 'structured');
        if (structured.length) {
          const result2 = await regionRecovery.recoverPage(
            session.source, pageNumber, structured, rendered.geometry, readEvidence);
          const recovered = result2.observations.filter((observation) => observation.text.trim().length > 0);
          observations = [...observations, ...recovered];
          // Attach confirmation receipts to the region each overlaps most,
          // mirroring createParser.
          const confirmations = result2.confirmations.filter((confirmation) => confirmation.text.trim().length > 0);
          attributeConfirmations(unreadInkRegions, confirmations).forEach((regionIndex, index) => {
            if (regionIndex >= 0) unreadInkRegions[regionIndex].confirmations.push(confirmations[index]);
          });
          pruneConfirmations(unreadInkRegions, readEvidence);
        }
        // Stamp counts with the schema's own derivation (largest overlap,
        // non-blank recoveryMethod observations) so validation reconciles.
        const counts = countRecoveredObservations(unreadInkRegions, observations);
        unreadInkRegions.forEach((region, index) => {
          region.recoveredObservationCount = counts[index];
        });
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

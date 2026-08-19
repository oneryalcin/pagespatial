import type {
  InitializationSummary,
  OcrResult,
  PaddleOCRCreateOptions
} from '@paddleocr/paddleocr-js';
import type { OcrAdapter } from '../adapters.js';
import type { OcrObservationInput, OcrPageResult, RenderedPage } from '../types.js';
import type { PdfJsCanvas } from './pdfjs.js';

export interface PpOcrBackendEvent {
  backend: 'webgpu' | 'wasm';
  threads: number;
  degraded: boolean;
  fallbackReason?: string;
}

export interface PpOcrBrowserOptions {
  detectionModelUrl: string;
  recognitionModelUrl: string;
  wasmPaths: string;
  backend?: 'auto' | 'webgpu' | 'wasm';
  localOnly?: boolean;
  detectorLimit?: number;
  recognitionThreshold?: number;
  recognitionBatchSize?: number;
  onBackend?: (event: PpOcrBackendEvent) => void;
  createEngine?: (options: PaddleOCRCreateOptions) => Promise<PpOcrEngine>;
}

export interface PpOcrEngine {
  initialize(): Promise<InitializationSummary>;
  predict(input: unknown, options?: Record<string, unknown>): Promise<OcrResult[]>;
  dispose(): Promise<void>;
}

export interface PpOcrBrowserAdapter extends OcrAdapter<PdfJsCanvas> {
  warmup(signal?: AbortSignal): Promise<void>;
  dispose(): Promise<void>;
  getBackend(): 'webgpu' | 'wasm' | null;
}

const DEFAULT_DETECTOR_LIMIT = 960;
const DEFAULT_RECOGNITION_THRESHOLD = 0.25;
const DEFAULT_RECOGNITION_BATCH = 6;

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertLocalAsset(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} is required.`);
  if (typeof location === 'undefined') {
    if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) throw new Error(`${label} must be a same-origin path in local-only mode.`);
    return;
  }
  const url = new URL(value, location.href);
  if (url.origin !== location.origin) throw new Error(`${label} must be served from ${location.origin}.`);
}

function runtimeSummary(value: InitializationSummary | OcrResult): { detProvider?: string; recProvider?: string } {
  return 'runtime' in value ? value.runtime : value;
}

function assertProviders(value: InitializationSummary | OcrResult, expected: 'webgpu' | 'wasm'): void {
  const actual = runtimeSummary(value);
  if (actual.detProvider !== expected || actual.recProvider !== expected) {
    throw new Error(`OCR requested ${expected}, but detection used ${actual.detProvider ?? 'unknown'} and recognition used ${actual.recProvider ?? 'unknown'}.`);
  }
}

async function defaultCreateEngine(options: PaddleOCRCreateOptions): Promise<PpOcrEngine> {
  const { PaddleOCR } = await import('@paddleocr/paddleocr-js');
  return PaddleOCR.create(options);
}

function boxFromPolygon(poly: ReadonlyArray<readonly [number, number]>): readonly [number, number, number, number] {
  if (poly.length < 4) throw new Error('OCR returned a polygon with fewer than four points.');
  const values = poly.flat();
  if (values.some((value) => !Number.isFinite(value))) throw new Error('OCR returned a non-finite polygon coordinate.');
  const xs = poly.map((point) => point[0]);
  const ys = poly.map((point) => point[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function createPpOcrV6BrowserAdapter(options: PpOcrBrowserOptions): PpOcrBrowserAdapter {
  const localOnly = options.localOnly ?? true;
  if (localOnly) {
    assertLocalAsset(options.detectionModelUrl, 'detectionModelUrl');
    assertLocalAsset(options.recognitionModelUrl, 'recognitionModelUrl');
    assertLocalAsset(options.wasmPaths, 'wasmPaths');
  }
  const detectorLimit = options.detectorLimit ?? DEFAULT_DETECTOR_LIMIT;
  const recognitionThreshold = options.recognitionThreshold ?? DEFAULT_RECOGNITION_THRESHOLD;
  const recognitionBatchSize = options.recognitionBatchSize ?? DEFAULT_RECOGNITION_BATCH;
  if (!Number.isFinite(detectorLimit) || detectorLimit < 32) throw new Error('detectorLimit must be at least 32.');
  if (!Number.isFinite(recognitionThreshold) || recognitionThreshold < 0 || recognitionThreshold > 1) {
    throw new Error('recognitionThreshold must be between 0 and 1.');
  }
  if (!Number.isSafeInteger(recognitionBatchSize) || recognitionBatchSize < 1) {
    throw new Error('recognitionBatchSize must be a positive safe integer.');
  }

  const createEngine = options.createEngine ?? defaultCreateEngine;
  let engine: PpOcrEngine | null = null;
  let backend: 'webgpu' | 'wasm' | null = null;
  let stickyWasm = options.backend === 'wasm';
  let disposed = false;
  let disposePromise: Promise<void> | undefined;
  let tail: Promise<unknown> = Promise.resolve();

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation);
    tail = result.catch(() => undefined);
    return result;
  };

  const engineOptions = (selected: 'webgpu' | 'wasm'): PaddleOCRCreateOptions => {
    const threads = selected === 'wasm' && globalThis.crossOriginIsolated ? 2 : 1;
    return {
      initialize: false,
      worker: true,
      textDetectionModelName: 'PP-OCRv6_tiny_det',
      textRecognitionModelName: 'PP-OCRv6_tiny_rec',
      textDetectionModelAsset: { url: options.detectionModelUrl },
      textRecognitionModelAsset: { url: options.recognitionModelUrl },
      batch_size: 1,
      textDetectionBatchSize: 1,
      textRecognitionBatchSize: recognitionBatchSize,
      textDetLimitSideLen: detectorLimit,
      textRecScoreThresh: recognitionThreshold,
      ortOptions: {
        backend: selected,
        wasmPaths: options.wasmPaths,
        numThreads: threads,
        simd: true,
        proxy: false,
        disableWasmProxy: true
      }
    };
  };

  const disposeEngine = async (): Promise<void> => {
    const previous = engine;
    engine = null;
    backend = null;
    if (previous) await previous.dispose().catch(() => undefined);
  };

  const replaceEngine = async (selected: 'webgpu' | 'wasm', fallbackReason?: string): Promise<PpOcrEngine> => {
    await disposeEngine();
    if (disposed) throw new Error('PP-OCR adapter was disposed.');
    const candidate = await createEngine(engineOptions(selected));
    try {
      const summary = await candidate.initialize();
      assertProviders(summary, selected);
      if (disposed) throw new Error('PP-OCR adapter was disposed.');
      engine = candidate;
      backend = selected;
      const threads = selected === 'wasm' && globalThis.crossOriginIsolated ? 2 : 1;
      try {
        options.onBackend?.({
          backend: selected,
          threads,
          degraded: selected === 'wasm' && threads === 1,
          ...(fallbackReason ? { fallbackReason } : {})
        });
      } catch {
        // Observability must not corrupt or dispose a successfully initialized engine.
      }
      return candidate;
    } catch (error) {
      await candidate.dispose().catch(() => undefined);
      throw error;
    }
  };

  const ensureEngine = async (): Promise<PpOcrEngine> => {
    if (disposed) throw new Error('PP-OCR adapter was disposed.');
    if (engine) return engine;
    if (stickyWasm) return replaceEngine('wasm');
    try {
      return await replaceEngine('webgpu');
    } catch (error) {
      if (options.backend === 'webgpu') throw error;
      stickyWasm = true;
      return replaceEngine('wasm', errorMessage(error));
    }
  };

  const predict = async (page: RenderedPage<PdfJsCanvas>, signal?: AbortSignal): Promise<OcrPageResult> => {
    abortIfNeeded(signal);
    let current = await ensureEngine();
    let result: OcrResult;
    try {
      const results = await current.predict(page.data, {
        textDetLimitSideLen: detectorLimit,
        textRecScoreThresh: recognitionThreshold
      });
      result = results[0]!;
      if (!result) throw new Error('PP-OCR returned no page result.');
      if (!backend) throw new Error('PP-OCR returned a result without an active backend.');
      assertProviders(result, backend);
    } catch (error) {
      abortIfNeeded(signal);
      if (backend !== 'webgpu' || stickyWasm || options.backend === 'webgpu') throw error;
      stickyWasm = true;
      current = await replaceEngine('wasm', errorMessage(error));
      const results = await current.predict(page.data, {
        textDetLimitSideLen: detectorLimit,
        textRecScoreThresh: recognitionThreshold
      });
      result = results[0]!;
      if (!result) throw new Error('PP-OCR returned no page result after WASM fallback.');
      assertProviders(result, 'wasm');
    }
    abortIfNeeded(signal);
    const items = result.items as Array<{ poly: Array<[number, number]>; text: string; score: number }>;
    const observations: OcrObservationInput[] = items.filter((item) => item.text.trim()).map((item, index) => {
      if (!Number.isFinite(item.score) || item.score < 0 || item.score > 1) {
        throw new Error(`OCR item ${index} has invalid confidence ${item.score}.`);
      }
      const polygon = item.poly.map((point) => [point[0], point[1]] as const);
      return {
        id: `ppocr:${page.pageNumber}:${index}`,
        pageNumber: page.pageNumber,
        text: item.text,
        box: boxFromPolygon(polygon),
        polygon,
        confidence: item.score,
        model: 'PP-OCRv6_tiny'
      };
    });
    return { pageNumber: page.pageNumber, observations, backend: backend ?? undefined };
  };

  return {
    name: 'ppocrv6-tiny-browser',
    version: '0.4.2',
    recognize(page, recognizeOptions) {
      return enqueue(() => predict(page, recognizeOptions?.signal));
    },
    warmup(signal) {
      return enqueue(async () => {
        abortIfNeeded(signal);
        await ensureEngine();
        abortIfNeeded(signal);
      });
    },
    dispose() {
      if (disposePromise) return disposePromise;
      disposed = true;
      disposePromise = (async () => {
        await tail.catch(() => undefined);
        await disposeEngine();
      })();
      return disposePromise;
    },
    getBackend() {
      return backend;
    }
  };
}

export { assertProviders as assertPpOcrProviders };

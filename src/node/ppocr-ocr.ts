import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { InitializationSummary, OcrResult, PaddleOCRCreateOptions } from '@paddleocr/paddleocr-js';
import type { OcrAdapter } from '../adapters.js';
import type { OcrObservationInput, OcrPageResult, RenderedPage } from '../types.js';

/**
 * PP-OCRv6 as a server-native witness (issue #2, now-half; #22 dependency).
 *
 * Same engine, same model bytes, no browser: this adapter runs the exact
 * `@paddleocr/paddleocr-js` pipeline the browser witness uses — identical
 * preprocessing, DB postprocess, and CTC decode — under Node on the ONNX
 * Runtime WASM execution provider. Model tars are the sha256-pinned assets
 * `scripts/prepare-ppocr-assets.mjs` materializes; reusing them keeps the
 * server witness byte-identical to the browser witness at the model level.
 * What CAN still differ from a browser run and is therefore covered by the
 * witness-equivalence measurement (docs/trials):
 *  - execution provider (browser prod path is WebGPU; here it is WASM —
 *    the browser's own fallback EP);
 *  - the rendered input (pdf.js canvas vs pdftoppm), which is the caller's
 *    responsibility to keep at matching pixel dimensions;
 *  - WASM thread count (numerics are EP-deterministic, throughput is not).
 *
 * Environment notes, deliberate and narrow:
 *  - The engine's serving guard reads `location.protocol`; Node has no
 *    `location`, so a minimal inert one is installed if (and only if) the
 *    global is undefined.
 *  - The engine's default image path needs DOM canvas. Its first-class
 *    escape hatch is accepting a `cv.Mat` directly, so pixels are converted
 *    via opencv.js `matFromImageData` (pure WASM, no DOM).
 */

export type PpOcrNodeVariant = 'tiny' | 'small';

/** RGBA pixels of a rendered page (e.g. a decoded PNG from pdftoppm). */
export interface PpOcrNodeRaster {
  /** RGBA bytes, row-major, 4 bytes per pixel. */
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}

export interface PpOcrNodeOptions {
  /**
   * Directory produced by `npm run prepare:ocr-assets -- --manifest
   * assets/ppocrv6-<variant>.manifest.json --output <dir>`; must contain
   * `models/PP-OCRv6_<variant>_{det,rec}_onnx_infer.tar`.
   */
  assetsDir: string;
  /**
   * PP-OCRv6 tier. Defaults to 'small' — the evaluation-parity tier
   * (dev-v12 era runs use small for Japanese coverage); servers have no
   * download-size pressure justifying tiny.
   */
  variant?: PpOcrNodeVariant;
  /** ORT WASM threads. Default 4. Numerics are unaffected; speed is. */
  numThreads?: number;
  detectorLimit?: number;
  recognitionThreshold?: number;
  recognitionBatchSize?: number;
  createEngine?: (options: PaddleOCRCreateOptions) => Promise<PpOcrNodeEngine>;
}

export interface PpOcrNodeEngine {
  initialize(): Promise<InitializationSummary>;
  predict(input: unknown, options?: Record<string, unknown>): Promise<OcrResult[]>;
  dispose(): Promise<void>;
}

export interface PpOcrNodeAdapter extends OcrAdapter<PpOcrNodeRaster> {
  warmup(signal?: AbortSignal): Promise<void>;
  dispose(): Promise<void>;
}

const DEFAULT_DETECTOR_LIMIT = 960;
const DEFAULT_RECOGNITION_THRESHOLD = 0.25;
const DEFAULT_RECOGNITION_BATCH = 6;
const DEFAULT_THREADS = 4;

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('The operation was aborted.');
}

function assertWasmProviders(value: InitializationSummary | OcrResult): void {
  const runtime = 'runtime' in value ? value.runtime : value;
  if (runtime.detProvider !== 'wasm' || runtime.recProvider !== 'wasm') {
    throw new Error(`Node OCR expected the wasm provider, but detection used ${runtime.detProvider ?? 'unknown'} and recognition used ${runtime.recProvider ?? 'unknown'}.`);
  }
}

function boxFromPolygon(poly: ReadonlyArray<readonly [number, number]>): readonly [number, number, number, number] {
  if (poly.length < 4) throw new Error('OCR returned a polygon with fewer than four points.');
  if (poly.flat().some((value) => !Number.isFinite(value))) throw new Error('OCR returned a non-finite polygon coordinate.');
  const xs = poly.map((point) => point[0]);
  const ys = poly.map((point) => point[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function installLocationShim(): void {
  if (typeof (globalThis as { location?: unknown }).location !== 'undefined') return;
  (globalThis as { location?: unknown }).location = Object.freeze({
    protocol: 'https:',
    origin: 'https://pagespatial.invalid',
    href: 'https://pagespatial.invalid/'
  });
}

interface OpenCvRuntime {
  Mat: new () => unknown;
  matFromImageData(image: { data: Uint8ClampedArray; width: number; height: number }): { delete(): void };
  onRuntimeInitialized?: () => void;
}

// opencv.js is an emscripten module whose object carries a legacy `then`
// property, so it must NEVER be the resolution value of any promise — an
// `await` anywhere in the chain would adopt the thenable, which does not
// settle once the runtime is already initialized (it is after the engine
// loads it), and that await hangs forever. The { cv } wrapper therefore
// travels all the way to the call site, which destructures it.
let opencvPromise: Promise<{ cv: OpenCvRuntime }> | undefined;

function loadOpenCv(): Promise<{ cv: OpenCvRuntime }> {
  opencvPromise ??= (async () => {
    const module = await import('@techstark/opencv-js');
    const cv = (module as { default?: OpenCvRuntime }).default ?? (module as unknown as OpenCvRuntime);
    if (!cv.Mat) await new Promise<void>((resolveInit) => { cv.onRuntimeInitialized = resolveInit; });
    return { cv };
  })();
  return opencvPromise;
}

async function defaultCreateEngine(options: PaddleOCRCreateOptions): Promise<PpOcrNodeEngine> {
  installLocationShim();
  const { PaddleOCR } = await import('@paddleocr/paddleocr-js');
  return PaddleOCR.create(options) as Promise<PpOcrNodeEngine>;
}

/** Serves the pinned local model tars to the engine's asset loader. */
function localAssetFetch(assetsDir: string): typeof fetch {
  const root = resolve(assetsDir);
  return async (input) => {
    const url = String(input);
    if (!url.startsWith('local-asset://')) {
      throw new Error(`Node OCR adapter refuses non-local asset URL: ${url}`);
    }
    const relative = url.slice('local-asset://'.length);
    if (isAbsolute(relative) || relative.split(/[\\/]/u).includes('..')) {
      throw new Error(`Node OCR asset path escapes the assets directory: ${relative}`);
    }
    const bytes = await readFile(join(root, relative));
    return new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'application/octet-stream' } });
  };
}

export function createPpOcrV6NodeAdapter(options: PpOcrNodeOptions): PpOcrNodeAdapter {
  if (!options.assetsDir?.trim()) throw new Error('assetsDir is required.');
  const variant: PpOcrNodeVariant = options.variant ?? 'small';
  if (!['tiny', 'small'].includes(variant)) throw new Error(`Unsupported PP-OCRv6 variant: ${variant}`);
  const detectorLimit = options.detectorLimit ?? DEFAULT_DETECTOR_LIMIT;
  const recognitionThreshold = options.recognitionThreshold ?? DEFAULT_RECOGNITION_THRESHOLD;
  const recognitionBatchSize = options.recognitionBatchSize ?? DEFAULT_RECOGNITION_BATCH;
  const numThreads = options.numThreads ?? DEFAULT_THREADS;
  if (!Number.isFinite(detectorLimit) || detectorLimit < 32) throw new Error('detectorLimit must be at least 32.');
  if (!Number.isFinite(recognitionThreshold) || recognitionThreshold < 0 || recognitionThreshold > 1) {
    throw new Error('recognitionThreshold must be between 0 and 1.');
  }
  if (!Number.isSafeInteger(recognitionBatchSize) || recognitionBatchSize < 1) {
    throw new Error('recognitionBatchSize must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(numThreads) || numThreads < 1) throw new Error('numThreads must be a positive safe integer.');

  const createEngine = options.createEngine ?? defaultCreateEngine;
  let engine: PpOcrNodeEngine | null = null;
  let disposed = false;
  let disposePromise: Promise<void> | undefined;
  let tail: Promise<unknown> = Promise.resolve();

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation);
    tail = result.catch(() => undefined);
    return result;
  };

  const ensureEngine = async (): Promise<PpOcrNodeEngine> => {
    if (disposed) throw new Error('PP-OCR node adapter was disposed.');
    if (engine) return engine;
    const candidate = await createEngine({
      worker: false,
      initialize: false,
      fetch: localAssetFetch(options.assetsDir),
      textDetectionModelName: `PP-OCRv6_${variant}_det`,
      textRecognitionModelName: `PP-OCRv6_${variant}_rec`,
      textDetectionModelAsset: { url: `local-asset://models/PP-OCRv6_${variant}_det_onnx_infer.tar` },
      textRecognitionModelAsset: { url: `local-asset://models/PP-OCRv6_${variant}_rec_onnx_infer.tar` },
      batch_size: 1,
      textDetectionBatchSize: 1,
      textRecognitionBatchSize: recognitionBatchSize,
      textDetLimitSideLen: detectorLimit,
      textRecScoreThresh: recognitionThreshold,
      ortOptions: { backend: 'wasm', numThreads, simd: true, proxy: false, disableWasmProxy: true }
    });
    try {
      const summary = await candidate.initialize();
      assertWasmProviders(summary);
      if (disposed) throw new Error('PP-OCR node adapter was disposed.');
      engine = candidate;
      return candidate;
    } catch (error) {
      await candidate.dispose().catch(() => undefined);
      throw error;
    }
  };

  const predict = async (page: RenderedPage<PpOcrNodeRaster>, signal?: AbortSignal): Promise<OcrPageResult> => {
    abortIfNeeded(signal);
    const raster = page.data;
    if (!raster || !(raster.data instanceof Uint8Array || raster.data instanceof Uint8ClampedArray)) {
      throw new Error('PP-OCR node adapter needs RGBA pixels ({ data, width, height }).');
    }
    if (!Number.isSafeInteger(raster.width) || !Number.isSafeInteger(raster.height) || raster.width < 1 || raster.height < 1) {
      throw new Error(`PP-OCR node adapter got invalid raster dimensions ${raster.width}x${raster.height}.`);
    }
    if (raster.data.length !== raster.width * raster.height * 4) {
      throw new Error(`PP-OCR node adapter expected ${raster.width * raster.height * 4} RGBA bytes, got ${raster.data.length}.`);
    }
    const current = await ensureEngine();
    const { cv } = await loadOpenCv();
    abortIfNeeded(signal);
    const pixels = raster.data instanceof Uint8ClampedArray ? raster.data : new Uint8ClampedArray(raster.data.buffer, raster.data.byteOffset, raster.data.byteLength);
    const mat = cv.matFromImageData({ data: pixels, width: raster.width, height: raster.height });
    let result: OcrResult;
    try {
      const results = await current.predict(mat, {
        textDetLimitSideLen: detectorLimit,
        textRecScoreThresh: recognitionThreshold
      });
      result = results[0]!;
    } finally {
      mat.delete();
    }
    abortIfNeeded(signal);
    if (!result) throw new Error('PP-OCR returned no page result.');
    assertWasmProviders(result);
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
        model: `PP-OCRv6_${variant}`
      };
    });
    return { pageNumber: page.pageNumber, observations, backend: 'wasm-node' };
  };

  return {
    name: `ppocrv6-${variant}-node`,
    version: '0.4.2',
    configuration: {
      variant,
      backend: 'wasm-node',
      numThreads,
      recognitionThreshold,
      detectorLimit,
      recognitionBatchSize
    },
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
        const previous = engine;
        engine = null;
        if (previous) await previous.dispose().catch(() => undefined);
      })();
      return disposePromise;
    }
  };
}

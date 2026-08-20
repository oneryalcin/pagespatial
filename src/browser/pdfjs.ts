import {
  GlobalWorkerOptions,
  Util,
  getDocument,
  type PDFDocumentProxy,
  type PDFPageProxy
} from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api.js';
import type { NativePageAdapter, PageRenderer } from '../adapters.js';
import { pdfJsPageMarkdown, pdfJsTextItemPointBox as sharedTextItemPointBox, pdfJsTextObservations } from '../pdfjs-text.js';
import type {
  Box,
  DocumentIdentity,
  DocumentSource,
  PageGeometry,
  RenderedPage,
  ViewportTransform
} from '../types.js';

export interface PdfJsSessionOptions {
  documentId?: string;
  revisionId?: string;
  sourceUri?: string;
  workerSrc?: string;
  /**
   * Base URL of pdf.js's bundled CID CMaps (the pdfjs-dist `cmaps/`
   * directory). Required to paint text whose font references a predefined
   * CMap (e.g. Adobe-Japan1, common in CJK documents); without it pdf.js
   * fails font translation and silently renders nothing for those glyphs.
   */
  cMapUrl?: string;
  /** Base URL of pdf.js's bundled standard fonts (`standard_fonts/`). */
  standardFontDataUrl?: string;
  maxBytes?: number;
  maxPages?: number;
}

export type PdfInput = Uint8Array | ArrayBuffer | Blob;

export interface PdfJsSession {
  readonly bytes: Uint8Array;
  readonly document: PDFDocumentProxy;
  source: DocumentSource<PdfJsSession>;
  getPage(pageNumber: number, signal?: AbortSignal): Promise<PDFPageProxy>;
  dispose(): Promise<void>;
}

export type PdfJsCanvas = HTMLCanvasElement;

const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_PAGES = 2_000;
const DEFAULT_MAX_CANVAS_SIDE = 16_384;
const DEFAULT_MAX_CANVAS_PIXELS = 40_000_000;

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

async function inputBytes(input: PdfInput, maxBytes: number): Promise<Uint8Array> {
  const knownSize = input instanceof Blob ? input.size : input.byteLength;
  if (knownSize > maxBytes) throw new Error(`PDF is ${knownSize} bytes; limit is ${maxBytes}.`);
  if (input instanceof Uint8Array) return input.slice();
  if (input instanceof ArrayBuffer) return new Uint8Array(input.slice(0));
  return new Uint8Array(await input.arrayBuffer());
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export async function openPdfJsSession(input: PdfInput, options: PdfJsSessionOptions = {}): Promise<PdfJsSession> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('maxBytes must be a positive safe integer.');
  const bytes = await inputBytes(input, maxBytes);
  if (bytes.byteLength > maxBytes) throw new Error(`PDF is ${bytes.byteLength} bytes; limit is ${maxBytes}.`);
  if (options.workerSrc) GlobalWorkerOptions.workerSrc = options.workerSrc;

  const hash = await sha256Hex(bytes);
  const loadingTask = getDocument({
    data: bytes.slice(),
    ...(options.cMapUrl ? { cMapUrl: options.cMapUrl, cMapPacked: true } : {}),
    ...(options.standardFontDataUrl ? { standardFontDataUrl: options.standardFontDataUrl } : {})
  });
  let pdf: PDFDocumentProxy;
  try {
    pdf = await loadingTask.promise;
  } catch (error) {
    await loadingTask.destroy().catch(() => undefined);
    throw error;
  }

  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
    await pdf.destroy();
    throw new Error('maxPages must be a positive safe integer.');
  }
  if (pdf.numPages > maxPages) {
    await pdf.destroy();
    throw new Error(`PDF has ${pdf.numPages} pages; limit is ${maxPages}.`);
  }

  const identity: DocumentIdentity = {
    documentId: options.documentId ?? `sha256:${hash}`,
    revisionId: options.revisionId ?? `sha256:${hash}`,
    sha256: hash,
    pageCount: pdf.numPages,
    ...(options.sourceUri ? { sourceUri: options.sourceUri } : {})
  };
  const pagePromises = new Map<number, Promise<PDFPageProxy>>();
  let disposed = false;
  let disposePromise: Promise<void> | undefined;
  let session!: PdfJsSession;

  session = {
    bytes,
    document: pdf,
    source: undefined as unknown as DocumentSource<PdfJsSession>,
    async getPage(pageNumber, signal) {
      abortIfNeeded(signal);
      if (disposed) throw new Error('PDF.js session was disposed.');
      if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pdf.numPages) {
        throw new Error(`Page ${pageNumber} is outside document page count ${pdf.numPages}.`);
      }
      let pending = pagePromises.get(pageNumber);
      if (!pending) {
        pending = pdf.getPage(pageNumber).catch((error: unknown) => {
          pagePromises.delete(pageNumber);
          throw error;
        });
        pagePromises.set(pageNumber, pending);
      }
      const page = await pending;
      abortIfNeeded(signal);
      if (disposed) throw new Error('PDF.js session was disposed.');
      return page;
    },
    async dispose() {
      if (disposePromise) return disposePromise;
      disposed = true;
      pagePromises.clear();
      disposePromise = pdf.destroy();
      return disposePromise;
    }
  };
  session.source = { identity, data: session, mimeType: 'application/pdf' };
  return session;
}

export const pdfJsNativeAdapter: NativePageAdapter<PdfJsSession> = {
  name: 'pdfjs-native',
  version: '5.5.207',
  async extractPage(source, pageNumber, options) {
    abortIfNeeded(options?.signal);
    const page = await source.data.getPage(pageNumber, options?.signal);
    const content = await page.getTextContent();
    abortIfNeeded(options?.signal);
    const viewport = page.getViewport({ scale: 1 });
    const items = content.items.filter((item): item is TextItem => 'str' in item && Boolean(item.str.trim()));
    const [viewX0, viewY0, viewX1, viewY1] = page.view;
    if (![viewX0, viewY0, viewX1, viewY1].every(Number.isFinite) || viewX1! <= viewX0! || viewY1! <= viewY0!) {
      throw new Error('PDF.js returned invalid page bounds.');
    }
    const observations = pdfJsTextObservations(items, pageNumber);
    return {
      pageNumber,
      geometry: {
        pointBounds: [viewX0!, viewY0!, viewX1!, viewY1!],
        pointWidth: viewX1! - viewX0!,
        pointHeight: viewY1! - viewY0!,
        rotation: viewport.rotation
      },
      observations,
      markdown: pdfJsPageMarkdown(items),
      markdownSource: 'pdfjs-deduplicated'
    };
  }
};

function defaultCanvas(width: number, height: number): HTMLCanvasElement {
  if (typeof document === 'undefined') throw new Error('PDF.js canvas rendering requires a browser document or a custom canvasFactory.');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export function createPdfJsCanvasRenderer(options: {
  canvasFactory?: (width: number, height: number) => HTMLCanvasElement;
  maxCanvasSide?: number;
  maxCanvasPixels?: number;
} = {}): PageRenderer<PdfJsSession, PdfJsCanvas> {
  const canvasFactory = options.canvasFactory ?? defaultCanvas;
  const maxCanvasSide = options.maxCanvasSide ?? DEFAULT_MAX_CANVAS_SIDE;
  const maxCanvasPixels = options.maxCanvasPixels ?? DEFAULT_MAX_CANVAS_PIXELS;
  if (!Number.isSafeInteger(maxCanvasSide) || maxCanvasSide < 1) throw new Error('maxCanvasSide must be a positive safe integer.');
  if (!Number.isSafeInteger(maxCanvasPixels) || maxCanvasPixels < 1) throw new Error('maxCanvasPixels must be a positive safe integer.');
  return {
    name: 'pdfjs-canvas',
    version: '5.5.207',
    async render(source, pageNumber, renderOptions): Promise<RenderedPage<PdfJsCanvas>> {
      abortIfNeeded(renderOptions?.signal);
      const page = await source.data.getPage(pageNumber, renderOptions?.signal);
      const scale = renderOptions?.scale ?? 1.6;
      if (!Number.isFinite(scale) || scale <= 0) throw new Error('Render scale must be a positive finite number.');
      const viewport = page.getViewport({ scale });
      const width = Math.ceil(viewport.width);
      const height = Math.ceil(viewport.height);
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
        throw new Error('PDF.js returned invalid rendered page dimensions.');
      }
      if (width > maxCanvasSide || height > maxCanvasSide || width * height > maxCanvasPixels) {
        throw new Error(`Rendered page ${width}x${height} exceeds the canvas safety limit.`);
      }
      const canvas = canvasFactory(width, height);
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        canvas.width = 0;
        canvas.height = 0;
      };
      try {
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('Could not create a 2D canvas context.');
        const renderTask = page.render({ canvas, canvasContext: context, viewport });
        const signal = renderOptions?.signal;
        let removeAbortListener = (): void => undefined;
        const rendered = signal
          ? Promise.race([
              renderTask.promise,
              new Promise<never>((_resolve, reject) => {
                const onAbort = (): void => {
                  renderTask.cancel();
                  reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
                };
                signal.addEventListener('abort', onAbort, { once: true });
                removeAbortListener = () => signal.removeEventListener('abort', onAbort);
                if (signal.aborted) onAbort();
              })
            ])
          : renderTask.promise;
        try {
          await rendered;
        } finally {
          removeAbortListener();
        }
        abortIfNeeded(renderOptions?.signal);
        const transform = viewport.transform;
        if (transform.length !== 6 || transform.some((value) => !Number.isFinite(value))) {
          throw new Error('PDF.js returned an invalid viewport transform.');
        }
        const [viewX0, viewY0, viewX1, viewY1] = page.view;
        if (![viewX0, viewY0, viewX1, viewY1].every(Number.isFinite)) throw new Error('PDF.js returned invalid page bounds.');
        const geometry: PageGeometry = {
          width,
          height,
          pointBounds: [viewX0!, viewY0!, viewX1!, viewY1!],
          pointWidth: viewX1! - viewX0!,
          pointHeight: viewY1! - viewY0!,
          rotation: viewport.rotation,
          viewportTransform: [...transform] as unknown as ViewportTransform
        };
        return { pageNumber, geometry, data: canvas, mimeType: 'image/x-canvas', release };
      } catch (error) {
        release();
        throw error;
      }
    }
  };
}

/** Exposed for geometry conformance tests; application code should use the adapter. */
export function pdfJsTextItemPointBox(item: TextItem): Box {
  return sharedTextItemPointBox(item);
}

/** Exposed for consumers that need PDF.js's exact matrix composition semantics. */
export const pdfJsTransform = Util.transform;

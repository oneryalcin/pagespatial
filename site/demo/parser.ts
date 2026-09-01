import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { NativePageAdapter } from '../../src/adapters.ts';
import { createBrowserParser, openPdfJsSession, pdfJsNativeAdapter, type PdfJsSession } from '../../src/browser/index.ts';
import { reconstructSvg } from '../../src/index.ts';
import type { PageSpatialDocument } from '../../src/types.ts';
import { DEMO_MAX_BYTES, DEMO_MAX_PAGES, joinPageMarkdown } from './contract.mjs';

export interface DemoOutput {
  document: PageSpatialDocument;
  markdown: string;
  json: string;
  reconstructions: string[];
  backend: 'webgpu' | 'wasm';
  inspectorFallback: boolean;
}

interface ParseCallbacks {
  signal?: AbortSignal;
  onStage(stage: string): void;
  onPage(completed: number, total: number): void;
  onBackend(backend: 'webgpu' | 'wasm', fallbackReason?: string): void;
}

function inspectMarkdown(bytes: Uint8Array, pageCount: number, signal?: AbortSignal): Promise<Map<number, string>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./pdf-inspector.worker.ts', import.meta.url), { type: 'module' });
    const id = crypto.randomUUID();
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      worker.terminate();
      operation();
    };
    const onAbort = (): void => finish(() => reject(signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError')));
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.addEventListener('error', (event) => finish(() => reject(new Error(event.message || 'PDF Inspector worker failed.'))));
    worker.addEventListener('message', (event: MessageEvent<{ id: string; pages?: Array<{ pageNumber: number; markdown: string }>; error?: string }>) => {
      if (event.data.id !== id) return;
      if (event.data.error) return finish(() => reject(new Error(event.data.error)));
      const pages = new Map((event.data.pages ?? []).map((page) => [page.pageNumber, page.markdown]));
      finish(() => resolve(pages));
    });
    if (signal?.aborted) return onAbort();
    const transferable = bytes.slice().buffer;
    worker.postMessage({ id, bytes: transferable, pageCount }, [transferable]);
  });
}

export async function parseDemoPdf(file: File, callbacks: ParseCallbacks): Promise<DemoOutput> {
  callbacks.onStage('Checking PDF');
  const session = await openPdfJsSession(file, {
    workerSrc: pdfWorkerUrl,
    cMapUrl: '/pdfjs-assets/cmaps/',
    standardFontDataUrl: '/pdfjs-assets/standard_fonts/',
    maxBytes: DEMO_MAX_BYTES,
    maxPages: DEMO_MAX_PAGES
  });
  let browser: ReturnType<typeof createBrowserParser> | undefined;
  try {
    let markdownByPage = new Map<number, string>();
    let inspectorFallback = false;
    const native: NativePageAdapter<PdfJsSession> = {
      name: 'pdfjs-geometry+pdf-inspector-wasm',
      version: '5.5.207+1.17.0',
      async extractPage(source, pageNumber, options) {
        const result = await pdfJsNativeAdapter.extractPage(source, pageNumber, options);
        const markdown = markdownByPage.get(pageNumber);
        return markdown
          ? { ...result, markdown, markdownSource: 'pdf-inspector-wasm@1.17.0' }
          : result;
      }
    };

    browser = createBrowserParser({
      native,
      ocr: {
        detectionModelUrl: '/ocr-assets/models/PP-OCRv6_tiny_det_onnx_infer.tar',
        recognitionModelUrl: '/ocr-assets/models/PP-OCRv6_tiny_rec_onnx_infer.tar',
        wasmPaths: '/ocr-assets/ort/',
        backend: 'auto',
        localOnly: true,
        onBackend: (event) => callbacks.onBackend(event.backend, event.fallbackReason)
      }
    });

    callbacks.onStage('Preparing local OCR and structured PDF extraction');
    const [inspector, ocrWarmup] = await Promise.allSettled([
      inspectMarkdown(session.bytes, session.document.numPages, callbacks.signal),
      browser.ocr.warmup(callbacks.signal)
    ]);

    if (ocrWarmup.status === "rejected") {
      throw ocrWarmup.reason;
    }
    if (inspector.status === 'fulfilled') markdownByPage = inspector.value;
    else inspectorFallback = true;

    let completed = 0;
    callbacks.onStage(`Parsing ${session.document.numPages} ${session.document.numPages === 1 ? 'page' : 'pages'}`);
    const document = await browser.parser.parse(session.source, {
      signal: callbacks.signal,
      concurrency: Math.min(2, session.document.numPages),
      renderScale: 1.6,
      runId: `browser-demo:${crypto.randomUUID()}`,
      onPage: () => {
        completed += 1;
        callbacks.onPage(completed, session.document.numPages);
      }
    });
    const backend = browser.ocr.getBackend();
    if (!backend) throw new Error('Local OCR completed without reporting its backend.');
    return {
      document,
      markdown: joinPageMarkdown(document.pages),
      json: JSON.stringify(document, null, 2),
      reconstructions: document.pages.map((page) => reconstructSvg(page)),
      backend,
      inspectorFallback
    };
  } finally {
    await browser?.dispose();
    await session.dispose();
  }
}

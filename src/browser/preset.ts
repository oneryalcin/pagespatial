import type { NativePageAdapter } from '../adapters.js';
import { createParser } from '../parser.js';
import { createPdfJsCanvasRenderer, pdfJsNativeAdapter, type PdfJsCanvas, type PdfJsSession } from './pdfjs.js';
import { createPpOcrV6BrowserAdapter, type PpOcrBrowserOptions } from './ppocr.js';

export interface BrowserParserOptions {
  ocr: PpOcrBrowserOptions;
  native?: NativePageAdapter<PdfJsSession>;
  canvasFactory?: (width: number, height: number) => HTMLCanvasElement;
  maxCanvasSide?: number;
  maxCanvasPixels?: number;
}

/**
 * The supported browser preset. It is explicit composition, not plugin discovery.
 * The caller owns PDF sessions; this bundle owns only the OCR runtime.
 */
export function createBrowserParser(options: BrowserParserOptions) {
  const ocr = createPpOcrV6BrowserAdapter(options.ocr);
  const parser = createParser<PdfJsSession, PdfJsCanvas>({
    native: options.native ?? pdfJsNativeAdapter,
    renderer: createPdfJsCanvasRenderer({
      canvasFactory: options.canvasFactory,
      maxCanvasSide: options.maxCanvasSide,
      maxCanvasPixels: options.maxCanvasPixels
    }),
    ocr
  });
  return {
    parser,
    ocr,
    dispose: () => ocr.dispose()
  };
}

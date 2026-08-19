import type { DocumentSource, NativeDocumentResult, OcrPageResult, RenderedPage } from './types.js';

export interface NativeAdapter<TSource = unknown> {
  readonly name: string;
  readonly version: string;
  extract(source: DocumentSource<TSource>, options?: { signal?: AbortSignal }): Promise<NativeDocumentResult>;
}

export interface PageRenderer<TSource = unknown, TRaster = unknown> {
  readonly name: string;
  readonly version: string;
  render(source: DocumentSource<TSource>, pageNumber: number, options?: {
    signal?: AbortSignal;
    scale?: number;
  }): Promise<RenderedPage<TRaster>>;
}

export interface OcrAdapter<TRaster = unknown> {
  readonly name: string;
  readonly version: string;
  recognize(page: RenderedPage<TRaster>, options?: { signal?: AbortSignal }): Promise<OcrPageResult>;
}

export interface ParserAdapters<TSource = unknown, TRaster = unknown> {
  native: NativeAdapter<TSource>;
  renderer: PageRenderer<TSource, TRaster>;
  ocr: OcrAdapter<TRaster>;
}

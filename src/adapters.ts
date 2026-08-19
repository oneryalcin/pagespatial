import type { DocumentSource, NativePageResult, OcrPageResult, RenderedPage } from './types.js';

export interface NativePageAdapter<TSource = unknown> {
  readonly name: string;
  readonly version: string;
  extractPage(source: DocumentSource<TSource>, pageNumber: number, options?: { signal?: AbortSignal }): Promise<NativePageResult>;
}

/** @deprecated Use NativePageAdapter. Kept as a source-compatible type alias for 0.1 adopters. */
export type NativeAdapter<TSource = unknown> = NativePageAdapter<TSource>;

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
  /**
   * Resolved admission policy and runtime settings (e.g. recognition threshold,
   * detector limit). Recorded in provenance so downstream evaluation can
   * account for what the adapter admitted, not just what it produced.
   */
  readonly configuration?: Record<string, unknown>;
  recognize(page: RenderedPage<TRaster>, options?: { signal?: AbortSignal }): Promise<OcrPageResult>;
}

export interface ParserAdapters<TSource = unknown, TRaster = unknown> {
  native: NativePageAdapter<TSource>;
  renderer: PageRenderer<TSource, TRaster>;
  ocr: OcrAdapter<TRaster>;
}

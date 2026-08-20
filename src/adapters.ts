import type { Box, DocumentSource, NativePageResult, OcrObservationInput, OcrPageResult, PageGeometry, RecoveryConfirmation, RenderedPage, UnreadInkRegion } from './types.js';

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

/**
 * Optional second-pass recovery over unread-ink regions (issue #10).
 * analyze() finds evidence deserts on the rendered page; recover() re-reads
 * one structured region (e.g. re-render at higher scale, crop, re-run OCR)
 * and returns observations in FIRST-render pixel coordinates with
 * recoveryMethod set. Both are adapter concerns because they need raster
 * access; the region math itself lives in core (src/ink.ts).
 */
export interface RegionRecoveryAdapter<TSource = unknown, TRaster = unknown> {
  readonly name: string;
  readonly version: string;
  analyze(rendered: RenderedPage<TRaster>, readBoxes: readonly Box[], options?: { signal?: AbortSignal }): Promise<UnreadInkRegion[]>;
  /**
   * One tiled second pass over the page (executed only when structured
   * regions exist). Page-level rather than per-region: surgical region crops
   * proved brittle — faint digits neighbouring dense ink fall outside
   * detected regions, and the validated experiment shape is a page grid.
   * Returns new observations in first-render pixels with recoveryMethod
   * set, plus confirmation receipts for readings that duplicated
   * readEvidence (same place, same text): those are dropped as
   * observations but prove the region is corroborated, not unread.
   */
  recoverPage(source: DocumentSource<TSource>, pageNumber: number, regions: readonly UnreadInkRegion[], firstGeometry: PageGeometry, readEvidence: readonly { box: Box; text: string }[], options?: { signal?: AbortSignal }): Promise<RegionRecoveryResult>;
}

export interface RegionRecoveryResult {
  observations: OcrObservationInput[];
  confirmations: RecoveryConfirmation[];
}

export interface ParserAdapters<TSource = unknown, TRaster = unknown> {
  native: NativePageAdapter<TSource>;
  renderer: PageRenderer<TSource, TRaster>;
  ocr: OcrAdapter<TRaster>;
  regionRecovery?: RegionRecoveryAdapter<TSource, TRaster>;
  /**
   * Cross-family second-opinion engine (issue #17): a MECHANICALLY
   * DIFFERENT OCR family (different architecture and training — two
   * similar vision models corroborate nothing, principles §5). Invoked
   * only when a page would otherwise escalate as coverage-starved; its
   * raw readings land on the record and engagement is derived from them.
   */
  secondOpinion?: OcrAdapter<TRaster>;
}

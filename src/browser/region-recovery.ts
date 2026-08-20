import type { OcrAdapter, PageRenderer, RegionRecoveryAdapter } from '../adapters.js';
import { renderedPixelsPerPoint } from '../geometry.js';
import { duplicatesFirstPass, findUnreadInkRegions, mapRecoveredBox } from '../ink.js';
import { RECOVERY_REGION_MARGIN_PT, RECOVERY_TILE_MAX_PX, RECOVERY_ZOOM_FACTOR } from '../tuning.js';
import type { Box, OcrObservationInput, PageGeometry, RenderedPage, UnreadInkRegion } from '../types.js';
import type { PdfJsCanvas, PdfJsSession } from './pdfjs.js';

export interface ZoomRetryRecoveryOptions {
  renderer: PageRenderer<PdfJsSession, PdfJsCanvas>;
  ocr: OcrAdapter<PdfJsCanvas>;
  /** Mirror the renderer's canvas limits so the zoom clamp matches reality. */
  maxCanvasSide?: number;
  maxCanvasPixels?: number;
  zoomFactor?: number;
  /**
   * Debug sink: called with every tile actually fed to the OCR adapter and
   * the raw observations it returned, before mapping/dedup. Lets a harness
   * dump the exact OCR inputs for differential experiments (issue #10).
   */
  onTile?: (tile: { canvas: PdfJsCanvas; box: Box; observations: readonly OcrObservationInput[] }) => void;
}

const METHOD = 'zoom-retry-v1';

function canvasRaster(canvas: PdfJsCanvas): { width: number; height: number; data: Uint8ClampedArray } {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not read back the rendered canvas for ink analysis.');
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  return { width: image.width, height: image.height, data: image.data };
}

/**
 * Browser implementation of the issue #10 recovery loop: analyze the first
 * render for unread-ink regions, then re-read structured regions by
 * re-rendering the PDF vector at higher scale (sharper than pixel upscaling),
 * cropping the region, and running the existing OCR adapter on the crop.
 * Recovered observations are mapped back to first-render pixels and tagged
 * recoveryMethod so they remain honestly-labelled second-pass evidence.
 */
export function createZoomRetryRecovery(options: ZoomRetryRecoveryOptions): RegionRecoveryAdapter<PdfJsSession, PdfJsCanvas> {
  const maxSide = options.maxCanvasSide ?? 16_384;
  const maxPixels = options.maxCanvasPixels ?? 40_000_000;
  const zoomFactor = options.zoomFactor ?? RECOVERY_ZOOM_FACTOR;
  if (!Number.isFinite(zoomFactor) || zoomFactor <= 1) throw new Error('zoomFactor must exceed 1.');

  return {
    name: 'zoom-retry-recovery',
    version: '1',
    async analyze(rendered, readBoxes) {
      return findUnreadInkRegions(canvasRaster(rendered.data), readBoxes, renderedPixelsPerPoint(rendered.geometry));
    },
    async recoverPage(source, pageNumber, regions, firstGeometry, readEvidence, recoverOptions) {
      const firstScale = renderedPixelsPerPoint(firstGeometry);
      const pointWidth = firstGeometry.width / firstScale;
      const pointHeight = firstGeometry.height / firstScale;
      // Clamp the zoom so the full-page re-render stays inside canvas limits.
      // The renderer measures ceil(width) * ceil(height); budgeting for one
      // extra pixel per side keeps the exact-budget clamp from tripping the
      // renderer's own safety check (A3-and-larger pages bind this clamp).
      const zoomScale = Math.min(
        firstScale * zoomFactor,
        maxSide / (Math.max(pointWidth, pointHeight) + 1),
        Math.sqrt(maxPixels / ((pointWidth + 1) * (pointHeight + 1)))
      );
      if (zoomScale <= firstScale) return [];
      const zoomRatio = zoomScale / firstScale;
      const margin = RECOVERY_REGION_MARGIN_PT * firstScale;

      const zoomed: RenderedPage<PdfJsCanvas> = await options.renderer.render(source, pageNumber, {
        scale: zoomScale,
        signal: recoverOptions?.signal
      });
      try {
        // Page grid under the detector's input cap (with overlap), the shape
        // the standalone experiment validated. Core size leaves room for the
        // overlap on both sides so the FINAL crop never exceeds the cap —
        // an oversized crop would be silently downscaled by the detector,
        // recreating the exact failure this pass exists to fix. Tiles that
        // touch no structured region (expanded by the margin) are skipped.
        const overlap = Math.round(0.06 * RECOVERY_TILE_MAX_PX);
        const core = RECOVERY_TILE_MAX_PX - 2 * overlap;
        const tileCols = Math.max(1, Math.ceil(zoomed.data.width / core));
        const tileRows = Math.max(1, Math.ceil(zoomed.data.height / core));
        const targets = regions.map((region) => [
          (region.box[0] - margin) * zoomRatio,
          (region.box[1] - margin) * zoomRatio,
          (region.box[2] + margin) * zoomRatio,
          (region.box[3] + margin) * zoomRatio
        ] as Box);
        const recovered: OcrObservationInput[] = [];
        let sequence = 0;
        for (let tileRow = 0; tileRow < tileRows; tileRow += 1) {
          for (let tileCol = 0; tileCol < tileCols; tileCol += 1) {
            const tx = Math.max(0, tileCol * core - overlap);
            const ty = Math.max(0, tileRow * core - overlap);
            const tw = Math.min(zoomed.data.width - tx, core + overlap * 2);
            const th = Math.min(zoomed.data.height - ty, core + overlap * 2);
            if (tw < 8 || th < 8) continue;
            const tile: Box = [tx, ty, tx + tw, ty + th];
            if (!targets.some((target) =>
              tile[0] < target[2] && target[0] < tile[2] && tile[1] < target[3] && target[1] < tile[3])) continue;
            const crop = document.createElement('canvas');
            crop.width = tw;
            crop.height = th;
            const context = crop.getContext('2d');
            if (!context) throw new Error('Could not create a crop canvas for recovery.');
            context.drawImage(zoomed.data, tx, ty, tw, th, 0, 0, tw, th);
            try {
              const cropPage: RenderedPage<PdfJsCanvas> = {
                pageNumber,
                geometry: { width: tw, height: th },
                data: crop,
                mimeType: 'image/x-canvas'
              };
              const result = await options.ocr.recognize(cropPage, { signal: recoverOptions?.signal });
              options.onTile?.({ canvas: crop, box: tile, observations: result.observations });
              const origin: readonly [number, number] = [tx / zoomRatio, ty / zoomRatio];
              for (const observation of result.observations) {
                const box = mapRecoveredBox(observation.box, origin, zoomRatio) as Box;
                if (duplicatesFirstPass(box, observation.text, readEvidence)) continue;
                // Tile overlaps re-read boundary text: dedupe against what
                // this pass already produced, same-text same-place.
                if (duplicatesFirstPass(box, observation.text, recovered)) continue;
                recovered.push({
                  ...observation,
                  id: `${METHOD}:${pageNumber}:${sequence++}`,
                  pageNumber,
                  box,
                  polygon: observation.polygon?.map((point) =>
                    [origin[0] + point[0] / zoomRatio, origin[1] + point[1] / zoomRatio] as const),
                  recoveryMethod: METHOD
                });
              }
            } finally {
              crop.width = 0;
              crop.height = 0;
            }
          }
        }
        return recovered;
      } finally {
        await zoomed.release?.();
      }
    }
  };
}

export type { UnreadInkRegion };

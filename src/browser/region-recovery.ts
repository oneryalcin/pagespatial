import type { OcrAdapter, PageRenderer, RegionRecoveryAdapter } from '../adapters.js';
import { renderedPixelsPerPoint } from '../geometry.js';
import { duplicatesFirstPass, findUnreadInkRegions, mapRecoveredBox } from '../ink.js';
import { RECOVERY_ZOOM_FACTOR } from '../tuning.js';
import type { Box, OcrObservationInput, PageGeometry, RenderedPage, UnreadInkRegion } from '../types.js';
import type { PdfJsCanvas, PdfJsSession } from './pdfjs.js';

export interface ZoomRetryRecoveryOptions {
  renderer: PageRenderer<PdfJsSession, PdfJsCanvas>;
  ocr: OcrAdapter<PdfJsCanvas>;
  /** Mirror the renderer's canvas limits so the zoom clamp matches reality. */
  maxCanvasSide?: number;
  maxCanvasPixels?: number;
  zoomFactor?: number;
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
    async recover(source, pageNumber, region, firstGeometry, readBoxes, recoverOptions) {
      const firstScale = renderedPixelsPerPoint(firstGeometry);
      const pointWidth = firstGeometry.width / firstScale;
      const pointHeight = firstGeometry.height / firstScale;
      // Clamp the zoom so the full-page re-render stays inside canvas limits.
      const zoomScale = Math.min(
        firstScale * zoomFactor,
        maxSide / Math.max(pointWidth, pointHeight),
        Math.sqrt(maxPixels / (pointWidth * pointHeight))
      );
      if (zoomScale <= firstScale) return [];
      const zoomRatio = zoomScale / firstScale;

      const zoomed: RenderedPage<PdfJsCanvas> = await options.renderer.render(source, pageNumber, {
        scale: zoomScale,
        signal: recoverOptions?.signal
      });
      try {
        const sx = Math.max(0, Math.floor(region.box[0] * zoomRatio));
        const sy = Math.max(0, Math.floor(region.box[1] * zoomRatio));
        const sw = Math.min(zoomed.data.width - sx, Math.ceil((region.box[2] - region.box[0]) * zoomRatio));
        const sh = Math.min(zoomed.data.height - sy, Math.ceil((region.box[3] - region.box[1]) * zoomRatio));
        if (sw < 8 || sh < 8) return [];
        const crop = document.createElement('canvas');
        crop.width = sw;
        crop.height = sh;
        const context = crop.getContext('2d');
        if (!context) throw new Error('Could not create a crop canvas for recovery.');
        context.drawImage(zoomed.data, sx, sy, sw, sh, 0, 0, sw, sh);
        try {
          const cropPage: RenderedPage<PdfJsCanvas> = {
            pageNumber,
            geometry: { width: sw, height: sh },
            data: crop,
            mimeType: 'image/x-canvas'
          };
          const result = await options.ocr.recognize(cropPage, { signal: recoverOptions?.signal });
          const origin: readonly [number, number] = [sx / zoomRatio, sy / zoomRatio];
          const recovered: OcrObservationInput[] = [];
          for (const [index, observation] of result.observations.entries()) {
            const box = mapRecoveredBox(observation.box, origin, zoomRatio) as Box;
            if (duplicatesFirstPass(box, readBoxes)) continue;
            recovered.push({
              ...observation,
              id: `${METHOD}:${pageNumber}:${Math.round(region.box[0])}x${Math.round(region.box[1])}:${index}`,
              pageNumber,
              box,
              polygon: observation.polygon?.map((point) =>
                [origin[0] + point[0] / zoomRatio, origin[1] + point[1] / zoomRatio] as const),
              recoveryMethod: METHOD
            });
          }
          return recovered;
        } finally {
          crop.width = 0;
          crop.height = 0;
        }
      } finally {
        await zoomed.release?.();
      }
    }
  };
}

export type { UnreadInkRegion };

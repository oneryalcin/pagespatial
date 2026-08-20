import { boxArea, intersectionArea } from './geometry.js';
import {
  INK_CELL_MIN_FRACTION,
  INK_GRID_CELL_PT,
  INK_LUMINANCE_MAX,
  INK_PICTORIAL_MIDTONE_MIN,
  INK_READ_DILATE_PT,
  INK_REGION_MIN_AREA_PT2,
  RECOVERY_DUPLICATE_OVERLAP,
  REFERENCE_RENDER_SCALE
} from './tuning.js';
import type { Box, UnreadInkRegion } from './types.js';

/**
 * Unread-ink region analysis (issue #10): find page areas that carry ink but
 * no observations from either extraction engine. Such areas are evidence
 * deserts — content neither witness saw — and previously passed silently.
 *
 * Pure math over an RGBA raster; runtime-specific code (canvas, GPU) supplies
 * the pixels. Classification is deterministic and physical: printed content
 * is bimodal (ink or paper) while photographs are continuous-tone, so the
 * midtone fraction separates "structured, worth re-reading" from "pictorial,
 * record but do not re-read".
 */

/** Minimal ImageData-compatible shape so core stays runtime-agnostic. */
export interface RasterData {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row-major — the ImageData layout. */
  data: Uint8ClampedArray;
}

export type { UnreadInkRegion } from './types.js';

interface CellStats {
  ink: number;
  mid: number;
}

function luminance(data: Uint8ClampedArray, offset: number): number {
  return (0.299 * data[offset]! + 0.587 * data[offset + 1]! + 0.114 * data[offset + 2]!) / 255;
}

export function findUnreadInkRegions(
  raster: RasterData,
  readBoxes: readonly Box[],
  pixelsPerPoint: number = REFERENCE_RENDER_SCALE
): UnreadInkRegion[] {
  const cellPx = Math.max(2, Math.round(INK_GRID_CELL_PT * pixelsPerPoint));
  const cols = Math.max(1, Math.ceil(raster.width / cellPx));
  const rows = Math.max(1, Math.ceil(raster.height / cellPx));

  const cells: CellStats[] = new Array(cols * rows);
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      let ink = 0;
      let mid = 0;
      let total = 0;
      const yEnd = Math.min(raster.height, (row + 1) * cellPx);
      const xEnd = Math.min(raster.width, (col + 1) * cellPx);
      for (let y = row * cellPx; y < yEnd; y += 1) {
        for (let x = col * cellPx; x < xEnd; x += 1) {
          const lum = luminance(raster.data, (y * raster.width + x) * 4);
          if (lum <= INK_LUMINANCE_MAX) ink += 1;
          if (lum > 0.25 && lum < 0.75) mid += 1;
          total += 1;
        }
      }
      cells[row * cols + col] = { ink: total ? ink / total : 0, mid: total ? mid / total : 0 };
    }
  }

  // Mark cells covered by dilated read boxes: anti-aliased halos around read
  // text must not masquerade as unread ink.
  const dilate = INK_READ_DILATE_PT * pixelsPerPoint;
  const read = new Uint8Array(cols * rows);
  for (const box of readBoxes) {
    const colStart = Math.max(0, Math.floor((box[0] - dilate) / cellPx));
    const colEnd = Math.min(cols - 1, Math.floor((box[2] + dilate) / cellPx));
    const rowStart = Math.max(0, Math.floor((box[1] - dilate) / cellPx));
    const rowEnd = Math.min(rows - 1, Math.floor((box[3] + dilate) / cellPx));
    for (let row = rowStart; row <= rowEnd; row += 1) {
      for (let col = colStart; col <= colEnd; col += 1) read[row * cols + col] = 1;
    }
  }

  // Connected components (4-neighbour) over unread inked cells.
  const label = new Int32Array(cols * rows).fill(-1);
  const regions: UnreadInkRegion[] = [];
  const minAreaPx = INK_REGION_MIN_AREA_PT2 * pixelsPerPoint * pixelsPerPoint;
  for (let start = 0; start < cols * rows; start += 1) {
    if (label[start] !== -1 || read[start] || cells[start]!.ink < INK_CELL_MIN_FRACTION) continue;
    const queue = [start];
    label[start] = regions.length;
    const member: number[] = [];
    while (queue.length) {
      const index = queue.pop()!;
      member.push(index);
      const col = index % cols;
      const row = (index - col) / cols;
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nc = col + dc;
        const nr = row + dr;
        if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
        const neighbour = nr * cols + nc;
        if (label[neighbour] !== -1 || read[neighbour] || cells[neighbour]!.ink < INK_CELL_MIN_FRACTION) continue;
        label[neighbour] = regions.length;
        queue.push(neighbour);
      }
    }
    let colMin = cols;
    let colMax = -1;
    let rowMin = rows;
    let rowMax = -1;
    let ink = 0;
    let mid = 0;
    for (const index of member) {
      const col = index % cols;
      const row = (index - col) / cols;
      colMin = Math.min(colMin, col);
      colMax = Math.max(colMax, col);
      rowMin = Math.min(rowMin, row);
      rowMax = Math.max(rowMax, row);
      ink += cells[index]!.ink;
      mid += cells[index]!.mid;
    }
    const box: Box = [
      colMin * cellPx,
      rowMin * cellPx,
      Math.min(raster.width, (colMax + 1) * cellPx),
      Math.min(raster.height, (rowMax + 1) * cellPx)
    ];
    if (boxArea(box) < minAreaPx) continue;
    const inkDensity = ink / member.length;
    const midToneFraction = mid / member.length;
    regions.push({
      box,
      kind: midToneFraction >= INK_PICTORIAL_MIDTONE_MIN ? 'pictorial' : 'structured',
      inkDensity: Math.round(inkDensity * 1000) / 1000,
      midToneFraction: Math.round(midToneFraction * 1000) / 1000,
      recoveredObservationCount: 0
    });
  }
  return regions;
}

/** Map a box from recovery-crop pixel space back onto the first render. */
export function mapRecoveredBox(box: Box, regionOrigin: readonly [number, number], zoomRatio: number): Box {
  return [
    regionOrigin[0] + box[0] / zoomRatio,
    regionOrigin[1] + box[1] / zoomRatio,
    regionOrigin[0] + box[2] / zoomRatio,
    regionOrigin[1] + box[3] / zoomRatio
  ];
}

/** True when a recovered box mostly re-reads something a first-pass box already covered. */
export function duplicatesFirstPass(box: Box, readBoxes: readonly Box[]): boolean {
  const area = boxArea(box);
  if (area <= 0) return true;
  return readBoxes.some((read) => intersectionArea(box, read) / area >= RECOVERY_DUPLICATE_OVERLAP);
}

import { boxArea, intersectionArea, unionBoxes } from './geometry.js';
import { textSimilarity } from './text.js';
import {
  INK_CELL_MIN_FRACTION,
  INK_CLOSE_RADIUS_CELLS,
  INK_REGION_MERGE_GAP_PT,
  INK_GRID_CELL_PT,
  INK_LUMINANCE_MAX,
  INK_PICTORIAL_MIDTONE_MIN,
  INK_READ_DILATE_PT,
  INK_REGION_MIN_AREA_PT2,
  RECOVERY_DUPLICATE_OVERLAP,
  REFERENCE_RENDER_SCALE
} from './tuning.js';
import type { Box, RecoveryConfirmation, UnreadInkRegion } from './types.js';

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

  // Core cells: unread ink. Support mask: core cells dilated by a closing
  // radius so slivers separated by read text (chart labels the first pass DID
  // read, or garbage boxes sitting on the chart) still form one region.
  const core = new Uint8Array(cols * rows);
  for (let index = 0; index < cols * rows; index += 1) {
    if (!read[index] && cells[index]!.ink >= INK_CELL_MIN_FRACTION) core[index] = 1;
  }
  const support = new Uint8Array(cols * rows);
  const radius = INK_CLOSE_RADIUS_CELLS;
  for (let index = 0; index < cols * rows; index += 1) {
    if (!core[index]) continue;
    const col = index % cols;
    const row = (index - col) / cols;
    for (let dr = -radius; dr <= radius; dr += 1) {
      for (let dc = -radius; dc <= radius; dc += 1) {
        const nc = col + dc;
        const nr = row + dr;
        if (nc >= 0 && nc < cols && nr >= 0 && nr < rows) support[nr * cols + nc] = 1;
      }
    }
  }
  const label = new Int32Array(cols * rows).fill(-1);
  const regions: UnreadInkRegion[] = [];
  const minAreaPx = INK_REGION_MIN_AREA_PT2 * pixelsPerPoint * pixelsPerPoint;
  let componentCount = 0;
  for (let start = 0; start < cols * rows; start += 1) {
    if (label[start] !== -1 || !core[start]) continue;
    const queue = [start];
    label[start] = componentCount;
    const member: number[] = [];
    while (queue.length) {
      const index = queue.pop()!;
      if (core[index]) member.push(index);
      const col = index % cols;
      const row = (index - col) / cols;
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nc = col + dc;
        const nr = row + dr;
        if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
        const neighbour = nr * cols + nc;
        if (label[neighbour] !== -1 || !support[neighbour]) continue;
        label[neighbour] = componentCount;
        queue.push(neighbour);
      }
    }
    componentCount += 1;
    if (!member.length) continue;
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
    const inkDensity = ink / member.length;
    const midToneFraction = mid / member.length;
    regions.push({
      box,
      kind: midToneFraction >= INK_PICTORIAL_MIDTONE_MIN ? 'pictorial' : 'structured',
      inkDensity: Math.round(inkDensity * 1000) / 1000,
      midToneFraction: Math.round(midToneFraction * 1000) / 1000,
      recoveredObservationCount: 0,
      confirmations: []
    });
  }

  // Merge nearby fragments of the same kind into one block, then apply the
  // minimum-area filter to the merged result.
  const gap = INK_REGION_MERGE_GAP_PT * pixelsPerPoint;
  const near = (a: Box, b: Box): boolean =>
    a[0] - gap <= b[2] && b[0] - gap <= a[2] && a[1] - gap <= b[3] && b[1] - gap <= a[3];
  let merged = regions;
  for (let changed = true; changed;) {
    changed = false;
    const next: UnreadInkRegion[] = [];
    for (const region of merged) {
      const partner = next.find((candidate) => candidate.kind === region.kind && near(candidate.box, region.box));
      if (!partner) {
        next.push({ ...region });
        continue;
      }
      const areaA = boxArea(partner.box);
      const areaB = boxArea(region.box);
      partner.box = unionBoxes([partner.box, region.box])!;
      partner.inkDensity = Math.round(((partner.inkDensity * areaA + region.inkDensity * areaB) / (areaA + areaB)) * 1000) / 1000;
      partner.midToneFraction = Math.round(((partner.midToneFraction * areaA + region.midToneFraction * areaB) / (areaA + areaB)) * 1000) / 1000;
      changed = true;
    }
    merged = next;
  }
  return merged.filter((region) => boxArea(region.box) >= minAreaPx);
}

/**
 * Derive per-region recovered counts from retained observations: each
 * non-blank recovered observation (recoveryMethod set) is attributed to the
 * structured region it overlaps most. This is the single source of truth —
 * the parser stamps `recoveredObservationCount` with it and the schema
 * re-derives it from the record, so the stored count can never silently
 * disagree with the evidence (a self-declared count could otherwise clear a
 * blocking unread-ink-region escalation).
 */
export function countRecoveredObservations(
  regions: readonly UnreadInkRegion[],
  observations: readonly { box: Box; text: string; recoveryMethod?: string }[]
): number[] {
  const counts = regions.map(() => 0);
  for (const observation of observations) {
    if (!observation.recoveryMethod || !observation.text.trim()) continue;
    let home = -1;
    let best = 0;
    regions.forEach((region, index) => {
      if (region.kind !== 'structured') return;
      const overlap = intersectionArea(observation.box, region.box);
      if (overlap > best) {
        best = overlap;
        home = index;
      }
    });
    if (home >= 0) counts[home]! += 1;
  }
  return counts;
}

/**
 * Attribute recovery confirmations to the structured region each overlaps
 * most (same rule as recoveries). Returns the region index per confirmation,
 * -1 for confirmations that land on no structured region.
 */
export function attributeConfirmations(
  regions: readonly UnreadInkRegion[],
  confirmations: readonly RecoveryConfirmation[]
): number[] {
  return confirmations.map((confirmation) => {
    let home = -1;
    let best = 0;
    regions.forEach((region, index) => {
      if (region.kind !== 'structured') return;
      const overlap = intersectionArea(confirmation.box, region.box);
      if (overlap > best) {
        best = overlap;
        home = index;
      }
    });
    return home;
  });
}

/**
 * Count VALID confirmations per region: a confirmation only counts when it
 * genuinely duplicates retained evidence (same place AND same reading, the
 * duplicatesFirstPass rule) — the property that makes the receipt
 * self-verifying and the residue escalation forgery-proof. Blank readings
 * never count. Used identically by the parser, diagnostics, and the schema.
 */
export function countConfirmedRegions(
  regions: readonly UnreadInkRegion[],
  retainedEvidence: readonly { box: Box; text: string }[]
): number[] {
  const counts = regions.map(() => 0);
  regions.forEach((region, index) => {
    if (region.kind !== 'structured') return;
    for (const confirmation of region.confirmations) {
      if (!confirmation.text.trim()) continue;
      if (duplicatesFirstPass(confirmation.box, confirmation.text, retainedEvidence)) counts[index]! += 1;
    }
  });
  return counts;
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

/**
 * True when a recovered observation mostly re-reads something a first-pass
 * observation already covered WITH the same reading. Overlapping a different
 * reading is not a duplicate: recovery may legitimately re-read an area a
 * garbage first pass claimed, and both observations stay on the record.
 */
export function duplicatesFirstPass(
  box: Box,
  text: string,
  readEvidence: readonly { box: Box; text: string }[]
): boolean {
  const area = boxArea(box);
  if (area <= 0) return true;
  return readEvidence.some((read) =>
    intersectionArea(box, read.box) / area >= RECOVERY_DUPLICATE_OVERLAP
    && textSimilarity(text, read.text) >= 0.72);
}

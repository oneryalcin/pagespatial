import { REFERENCE_RENDER_SCALE } from './tuning.js';
import type { Box, PageGeometry, Point, ViewportTransform } from './types.js';

export function assertBox(box: readonly number[]): asserts box is Box {
  if (box.length !== 4 || !box.every(Number.isFinite) || box[2]! < box[0]! || box[3]! < box[1]!) {
    throw new Error(`Invalid box: ${JSON.stringify(box)}`);
  }
}

export function roundBox(box: readonly number[]): Box {
  assertBox(box);
  return box.map((value) => Math.round(value * 100) / 100) as unknown as Box;
}

export function unionBoxes(boxes: readonly Box[]): Box | null {
  if (!boxes.length) return null;
  return roundBox([
    Math.min(...boxes.map((box) => box[0])),
    Math.min(...boxes.map((box) => box[1])),
    Math.max(...boxes.map((box) => box[2])),
    Math.max(...boxes.map((box) => box[3]))
  ]);
}

export function boxArea(box: Box): number {
  return Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);
}

export function intersectionArea(left: Box, right: Box): number {
  return Math.max(0, Math.min(left[2], right[2]) - Math.max(left[0], right[0])) *
    Math.max(0, Math.min(left[3], right[3]) - Math.max(left[1], right[1]));
}

export function overlapOverSmaller(left: Box, right: Box): number {
  const denominator = Math.min(boxArea(left), boxArea(right));
  return denominator > 0 ? intersectionArea(left, right) / denominator : 0;
}

export function transformPoint(point: Point, transform: ViewportTransform): Point {
  const [a, b, c, d, e, f] = transform;
  return [a * point[0] + c * point[1] + e, b * point[0] + d * point[1] + f];
}

export function pointBounds(geometry: Pick<PageGeometry, 'pointBounds' | 'pointWidth' | 'pointHeight'>): Box | null {
  if (geometry.pointBounds) return geometry.pointBounds;
  if (geometry.pointWidth && geometry.pointHeight) return [0, 0, geometry.pointWidth, geometry.pointHeight];
  return null;
}

export function assertPageGeometry(geometry: PageGeometry): void {
  const { width, height, viewportTransform } = geometry;
  if (![width, height].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error('Rendered page dimensions must be positive finite numbers.');
  }
  if (geometry.rotation !== undefined && !Number.isFinite(geometry.rotation)) {
    throw new Error('Page rotation must be finite when declared.');
  }
  if (viewportTransform) {
    // Every point-denominated heuristic in tuning.ts assumes one scalar
    // pixels-per-point. An anisotropic or sheared transform would make
    // that scalar wrong on one axis and silently skew physical-size gates
    // (e.g. residue eligibility), so it is rejected, not approximated.
    const xScale = Math.hypot(viewportTransform[0], viewportTransform[1]);
    const yScale = Math.hypot(viewportTransform[2], viewportTransform[3]);
    const shear = viewportTransform[0] * viewportTransform[2] + viewportTransform[1] * viewportTransform[3];
    if (!Number.isFinite(xScale) || !Number.isFinite(yScale) || xScale <= 0 || yScale <= 0) {
      throw new Error('Viewport transform must have positive finite axis scales.');
    }
    if (Math.abs(xScale - yScale) > 1e-6 * Math.max(xScale, yScale) || Math.abs(shear) > 1e-6 * xScale * yScale) {
      throw new Error('Viewport transform must be conformal (uniform scale, no shear): point-denominated heuristics assume one pixels-per-point scalar.');
    }
  }
  const bounds = pointBounds(geometry);
  if (bounds) {
    assertBox(bounds);
    if (bounds[2] <= bounds[0] || bounds[3] <= bounds[1]) throw new Error('PDF point bounds must have positive area.');
    if (geometry.pointWidth !== undefined && Math.abs((bounds[2] - bounds[0]) - geometry.pointWidth) > 1e-6) {
      throw new Error('PDF point width does not match point bounds.');
    }
    if (geometry.pointHeight !== undefined && Math.abs((bounds[3] - bounds[1]) - geometry.pointHeight) > 1e-6) {
      throw new Error('PDF point height does not match point bounds.');
    }
  }
  if (!viewportTransform) return;
  if (!bounds) throw new Error('A viewport transform requires declared PDF point bounds.');
  if (!viewportTransform.every(Number.isFinite)) throw new Error('Viewport transform must contain only finite numbers.');
  const [a, b, c, d] = viewportTransform;
  const determinant = a * d - b * c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) {
    throw new Error('Viewport transform must be finite and invertible.');
  }
  const sourceCorners: Point[] = [
    [bounds[0], bounds[1]],
    [bounds[2], bounds[1]],
    [bounds[0], bounds[3]],
    [bounds[2], bounds[3]]
  ];
  const corners = sourceCorners.map((point) => transformPoint(point, viewportTransform));
  const envelope: Box = [
    Math.min(...corners.map((point) => point[0])),
    Math.min(...corners.map((point) => point[1])),
    Math.max(...corners.map((point) => point[0])),
    Math.max(...corners.map((point) => point[1]))
  ];
  // Renderers ceil viewport dimensions to whole pixels, so the transformed
  // bounds may fall short of the rendered size by up to one pixel per edge.
  const tolerance = 1.01;
  if (Math.abs(envelope[0]) > tolerance || Math.abs(envelope[1]) > tolerance
    || Math.abs(envelope[2] - width) > tolerance || Math.abs(envelope[3] - height) > tolerance) {
    throw new Error('Viewport transform does not map PDF point bounds to the rendered page.');
  }
}

/**
 * Rendered pixels per PDF point, derived from the page geometry so spatial
 * heuristics scale with the actual render resolution. The viewport transform
 * magnitude is authoritative (correct under rotation); axis bounds are the
 * fallback. Geometry without point information reports the reference scale
 * the heuristics were tuned at.
 */
export function renderedPixelsPerPoint(geometry: PageGeometry): number {
  const { viewportTransform } = geometry;
  if (viewportTransform) {
    const magnitude = Math.hypot(viewportTransform[0], viewportTransform[1]);
    if (Number.isFinite(magnitude) && magnitude > 0) return magnitude;
  }
  const bounds = pointBounds(geometry);
  if (bounds && (geometry.rotation ?? 0) % 180 === 0) return geometry.width / (bounds[2] - bounds[0]);
  if (bounds) return geometry.width / (bounds[3] - bounds[1]);
  return REFERENCE_RENDER_SCALE;
}

export function assertBoxWithin(box: Box, bounds: Box, label: string): void {
  assertBox(box);
  if (box[2] <= box[0] || box[3] <= box[1]) throw new Error(`${label} must have positive area.`);
  if (box[0] < bounds[0] || box[1] < bounds[1] || box[2] > bounds[2] || box[3] > bounds[3]) {
    throw new Error(`${label} is outside declared bounds.`);
  }
}

export function pointBoxToRenderedBox(pointBox: Box, geometry: PageGeometry): {
  box: Box;
  method: 'pdfjs-viewport-matrix-v1' | 'axis-aligned-fallback-v1';
} {
  const { width, height, pointWidth, pointHeight, viewportTransform } = geometry;
  assertPageGeometry(geometry);
  const sourceBounds = pointBounds(geometry);
  assertBox(pointBox);
  if (sourceBounds) assertBoxWithin(pointBox, sourceBounds, 'Native point box');

  if (viewportTransform) {
    const sourceCorners: Point[] = [
      [pointBox[0], pointBox[1]],
      [pointBox[2], pointBox[1]],
      [pointBox[0], pointBox[3]],
      [pointBox[2], pointBox[3]]
    ];
    const corners = sourceCorners.map((point) => transformPoint(point, viewportTransform));
    const box = roundBox([
        Math.min(...corners.map((point) => point[0])),
        Math.min(...corners.map((point) => point[1])),
        Math.max(...corners.map((point) => point[0])),
        Math.max(...corners.map((point) => point[1]))
      ]);
    assertBoxWithin(box, [0, 0, width, height], 'Transformed native box');
    return { box, method: 'pdfjs-viewport-matrix-v1' };
  }

  if (!pointWidth || !pointHeight) {
    throw new Error('Point dimensions or a viewport transform are required for native point geometry.');
  }
  if (sourceBounds && (sourceBounds[0] !== 0 || sourceBounds[1] !== 0 || (geometry.rotation ?? 0) % 360 !== 0)) {
    throw new Error('Axis-aligned fallback supports only unshifted, unrotated PDF point bounds.');
  }
  const scaleX = width / pointWidth;
  const scaleY = height / pointHeight;
  const box = roundBox([
      pointBox[0] * scaleX,
      height - pointBox[3] * scaleY,
      pointBox[2] * scaleX,
      height - pointBox[1] * scaleY
    ]);
  assertBoxWithin(box, [0, 0, width, height], 'Transformed native box');
  return { box, method: 'axis-aligned-fallback-v1' };
}

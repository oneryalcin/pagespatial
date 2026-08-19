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

export function pointBoxToRenderedBox(pointBox: Box, geometry: PageGeometry): {
  box: Box;
  method: 'pdfjs-viewport-matrix-v1' | 'axis-aligned-fallback-v1';
} {
  const { width, height, pointWidth, pointHeight, viewportTransform } = geometry;
  if (![width, height].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error('Rendered page dimensions must be positive.');
  }

  if (viewportTransform) {
    const sourceCorners: Point[] = [
      [pointBox[0], pointBox[1]],
      [pointBox[2], pointBox[1]],
      [pointBox[0], pointBox[3]],
      [pointBox[2], pointBox[3]]
    ];
    const corners = sourceCorners.map((point) => transformPoint(point, viewportTransform));
    return {
      box: roundBox([
        Math.min(...corners.map((point) => point[0])),
        Math.min(...corners.map((point) => point[1])),
        Math.max(...corners.map((point) => point[0])),
        Math.max(...corners.map((point) => point[1]))
      ]),
      method: 'pdfjs-viewport-matrix-v1'
    };
  }

  if (!pointWidth || !pointHeight) {
    throw new Error('Point dimensions or a viewport transform are required for native point geometry.');
  }
  const scaleX = width / pointWidth;
  const scaleY = height / pointHeight;
  return {
    box: roundBox([
      pointBox[0] * scaleX,
      height - pointBox[3] * scaleY,
      pointBox[2] * scaleX,
      height - pointBox[1] * scaleY
    ]),
    method: 'axis-aligned-fallback-v1'
  };
}

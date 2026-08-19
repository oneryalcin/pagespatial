import { unionBoxes } from './geometry.js';
import type { NativeLine, NativeObservation, OcrObservation, SpatialRow } from './types.js';

function average(values: readonly number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

export function readingOrder<T extends { box: readonly [number, number, number, number] }>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => {
    const leftHeight = Math.max(1, left.box[3] - left.box[1]);
    const rightHeight = Math.max(1, right.box[3] - right.box[1]);
    const tolerance = Math.max(8, Math.min(leftHeight, rightHeight) * 0.65);
    return Math.abs(left.box[1] - right.box[1]) > tolerance
      ? left.box[1] - right.box[1]
      : left.box[0] - right.box[0];
  });
}

export function buildNativeLines(observations: readonly NativeObservation[]): NativeLine[] {
  const groups: Array<{ centerY: number; height: number; items: NativeObservation[] }> = [];
  for (const observation of readingOrder(observations.filter((item) => item.text.trim()))) {
    const height = Math.max(1, observation.box[3] - observation.box[1]);
    const centerY = (observation.box[1] + observation.box[3]) / 2;
    const group = groups.findLast((candidate) => Math.abs(candidate.centerY - centerY) <= Math.max(candidate.height, height) * 0.55);
    if (group) {
      group.items.push(observation);
      group.centerY = average(group.items.map((item) => (item.box[1] + item.box[3]) / 2)) ?? centerY;
      group.height = Math.max(group.height, height);
    } else {
      groups.push({ centerY, height, items: [observation] });
    }
  }

  return groups.map((group, index) => {
    const items = group.items.sort((left, right) => left.box[0] - right.box[0]);
    const visualItems: NativeObservation[] = [];
    const seenVisuals = new Set<string>();
    for (const item of items) {
      const key = `${item.text.normalize('NFKC')}|${item.box.join(',')}`;
      if (seenVisuals.has(key)) continue;
      seenVisuals.add(key);
      visualItems.push(item);
    }
    const box = unionBoxes(items.map((item) => item.box));
    if (!box) throw new Error('Native line has no geometry.');
    return {
      id: `${items[0]!.id}:line:${index}`,
      pageNumber: items[0]!.pageNumber,
      text: visualItems.map((item) => item.text).join(' ').replace(/\s+/g, ' ').trim(),
      sourceIds: items.map((item) => item.id),
      box
    };
  });
}

export function buildSpatialRows(observations: readonly OcrObservation[]): SpatialRow[] {
  const groups: Array<{ centerY: number; height: number; items: OcrObservation[] }> = [];
  for (const observation of readingOrder(observations.filter((item) => item.text.trim()))) {
    const height = Math.max(8, observation.box[3] - observation.box[1]);
    const centerY = (observation.box[1] + observation.box[3]) / 2;
    const group = groups.findLast((candidate) => Math.abs(candidate.centerY - centerY) <= Math.max(candidate.height, height) * 0.55);
    if (group) {
      group.items.push(observation);
      group.centerY = average(group.items.map((item) => (item.box[1] + item.box[3]) / 2)) ?? centerY;
      group.height = Math.max(group.height, height);
    } else {
      groups.push({ centerY, height, items: [observation] });
    }
  }

  return groups
    .sort((left, right) => left.centerY - right.centerY)
    .map((group, index) => {
      const items = group.items.sort((left, right) => left.box[0] - right.box[0]);
      const box = unionBoxes(items.map((item) => item.box));
      if (!box) throw new Error('Spatial row has no geometry.');
      return {
        id: `${items[0]!.id}:row:${index}`,
        pageNumber: items[0]!.pageNumber,
        text: items.map((item) => item.text.trim()).join(' '),
        sourceIds: items.map((item) => item.id),
        box,
        confidence: average(items.map((item) => item.confidence))
      };
    });
}

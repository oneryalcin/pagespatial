import { createDerivedId } from './ids.js';
import { unionBoxes } from './geometry.js';
import type { Box, DerivedRelation, OcrObservation, RelationComponent } from './types.js';

const YEAR_PATTERN = /(?:FY\s*)?(20\d{2})(?:[AEF])?(?=(?:FY)|[^A-Z0-9]|$)/giu;
const NUMBER_PATTERN = /(?<![\p{L}\p{N}])[-+]?[$£€]?\d[\d,.]*(?:\.\d+)?%?(?![\p{L}\p{N}])/gu;

interface LocatedToken {
  text: string;
  normalized?: string;
  sourceId: string;
  confidence: number;
  box: Box;
  centerX: number;
  centerY: number;
}

function tokenBox(observation: OcrObservation, index: number, length: number): Box {
  const width = Math.max(1, observation.box[2] - observation.box[0]);
  const start = index / Math.max(1, observation.text.length);
  const end = (index + length) / Math.max(1, observation.text.length);
  return [
    observation.box[0] + width * start,
    observation.box[1],
    observation.box[0] + width * end,
    observation.box[3]
  ];
}

function locatedTokens(observations: readonly OcrObservation[], pattern: RegExp, normalize?: (match: RegExpMatchArray) => string): LocatedToken[] {
  const output: LocatedToken[] = [];
  for (const observation of observations) {
    pattern.lastIndex = 0;
    for (const match of observation.text.matchAll(pattern)) {
      const box = tokenBox(observation, match.index ?? 0, match[0].length);
      output.push({
        text: match[0].trim(),
        normalized: normalize?.(match),
        sourceId: observation.id,
        confidence: observation.confidence,
        box,
        centerX: (box[0] + box[2]) / 2,
        centerY: (box[1] + box[3]) / 2
      });
    }
  }
  return output;
}

export function inferSimpleYearValueRelations(pageId: string, observations: readonly OcrObservation[]): DerivedRelation[] {
  const years = locatedTokens(observations, YEAR_PATTERN, (match) => `FY${match[1]}`);
  const yearRows: Array<{ centerY: number; items: LocatedToken[] }> = [];
  for (const year of [...years].sort((left, right) => left.centerY - right.centerY)) {
    const row = yearRows.find((candidate) => Math.abs(candidate.centerY - year.centerY) <= 24);
    if (row) {
      row.items.push(year);
      row.centerY = row.items.reduce((sum, item) => sum + item.centerY, 0) / row.items.length;
    } else {
      yearRows.push({ centerY: year.centerY, items: [year] });
    }
  }

  const yearRow = yearRows
    .sort((left, right) => new Set(right.items.map((item) => item.normalized)).size - new Set(left.items.map((item) => item.normalized)).size)[0];
  if (!yearRow || new Set(yearRow.items.map((item) => item.normalized)).size < 3) return [];

  const orderedYears = [...yearRow.items]
    .sort((left, right) => left.centerX - right.centerX)
    .filter((item, index, items) => index === 0 || item.normalized !== items[index - 1]!.normalized);
  const gaps = orderedYears.slice(1)
    .map((item, index) => Math.abs(item.centerX - orderedYears[index]!.centerX))
    .sort((left, right) => left - right);
  const typicalGap = gaps[Math.floor(gaps.length / 2)] ?? 80;
  const yearY = yearRow.centerY;
  const values = locatedTokens(observations, NUMBER_PATTERN)
    .filter((item) => !/^(?:FY\s*)?20\d{2}/iu.test(item.text))
    .filter((item) => item.centerY < yearY - 2)
    .filter((item) => yearY - item.centerY <= Math.max(160, typicalGap * 4));

  const used = new Set<number>();
  const relations: DerivedRelation[] = [];
  for (const year of orderedYears) {
    const candidates = values
      .map((value, index) => ({ value, index, distance: Math.abs(value.centerX - year.centerX) }))
      .filter((candidate) => !used.has(candidate.index) && candidate.distance <= typicalGap * 0.48)
      .sort((left, right) => left.distance - right.distance);
    const selected = candidates[0];
    if (!selected) continue;
    used.add(selected.index);
    const runnerUp = candidates[1];
    const margin = runnerUp
      ? Math.min(1, Math.max(0, (runnerUp.distance - selected.distance) / Math.max(1, typicalGap * 0.48)))
      : 1;
    const components: RelationComponent[] = [
      { role: 'category', sourceId: year.sourceId, text: year.normalized ?? year.text, box: year.box },
      { role: 'value', sourceId: selected.value.sourceId, text: selected.value.text, box: selected.value.box }
    ];
    const sourceIds = [...new Set(components.map((component) => component.sourceId))];
    const box = unionBoxes(components.map((component) => component.box));
    if (!box) continue;
    relations.push({
      id: createDerivedId(pageId, 'chart-category-value', sourceIds.concat(year.normalized ?? year.text)),
      pageNumber: observations[0]?.pageNumber ?? 0,
      kind: 'chart-category-value',
      method: 'single-year-row-nearest-x-v1',
      confidence: Math.min(0.85, year.confidence, selected.value.confidence, 0.55 + margin * 0.3),
      ambiguity: 1 - margin,
      sourceIds,
      box,
      components,
      attributes: { category: year.normalized ?? year.text, value: selected.value.text },
      derived: true
    });
  }
  return relations.length >= 3 ? relations : [];
}


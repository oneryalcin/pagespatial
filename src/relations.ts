import { createDerivedId } from './ids.js';
import { unionBoxes } from './geometry.js';
import {
  REFERENCE_RENDER_SCALE,
  RELATION_ASSIGN_RADIUS_RATIO,
  RELATION_CONFIDENCE_BASE,
  RELATION_CONFIDENCE_CAP,
  RELATION_CONFIDENCE_MARGIN_BONUS,
  RELATION_FALLBACK_GAP_PT,
  RELATION_ROW_TOLERANCE_PT,
  RELATION_VALUE_ABOVE_MARGIN_PT,
  RELATION_VALUE_WINDOW_MIN_PT
} from './tuning.js';
import type { Box, DerivedRelation, OcrObservation, RelationComponent } from './types.js';

import { YEAR_BODY_SOURCE } from './text.js';

const YEAR_PATTERN = new RegExp(String.raw`(?:FY\s*)?(${YEAR_BODY_SOURCE})(?:[AEF])?(?=(?:FY)|[^A-Z0-9]|$)`, 'giu');
const YEAR_PREFIX_PATTERN = new RegExp(String.raw`^(?:FY\s*)?${YEAR_BODY_SOURCE}`, 'iu');
const NUMBER_PATTERN = /(?<![\p{L}\p{N}])[-+]?[$£€]?\d[\d,.]*(?:\.\d+)?%?(?![\p{L}\p{N}])/gu;

interface LocatedToken {
  text: string;
  normalized?: string;
  sourceId: string;
  confidence: number;
  /** Full box of the source observation — the only box published as evidence. */
  sourceBox: Box;
  /** Interpolated token center, used for column assignment only. */
  centerX: number;
  centerY: number;
}

/**
 * Approximate token center by linear character position. Glyph widths are not
 * uniform, so this is a column-assignment heuristic only; it must never be
 * published as an evidence box.
 */
function tokenCenter(observation: OcrObservation, index: number, length: number): { centerX: number; centerY: number } {
  const width = Math.max(1, observation.box[2] - observation.box[0]);
  const start = index / Math.max(1, observation.text.length);
  const end = (index + length) / Math.max(1, observation.text.length);
  return {
    centerX: observation.box[0] + width * ((start + end) / 2),
    centerY: (observation.box[1] + observation.box[3]) / 2
  };
}

function locatedTokens(observations: readonly OcrObservation[], pattern: RegExp, normalize?: (match: RegExpMatchArray) => string): LocatedToken[] {
  const output: LocatedToken[] = [];
  for (const observation of observations) {
    pattern.lastIndex = 0;
    for (const match of observation.text.matchAll(pattern)) {
      output.push({
        text: match[0].trim(),
        normalized: normalize?.(match),
        sourceId: observation.id,
        confidence: observation.confidence,
        sourceBox: observation.box,
        ...tokenCenter(observation, match.index ?? 0, match[0].length)
      });
    }
  }
  return output;
}

export function inferSimpleYearValueRelations(
  pageId: string,
  observations: readonly OcrObservation[],
  pixelsPerPoint: number = REFERENCE_RENDER_SCALE
): DerivedRelation[] {
  const years = locatedTokens(observations, YEAR_PATTERN, (match) => `FY${match[1]}`);
  const yearRows: Array<{ centerY: number; items: LocatedToken[] }> = [];
  for (const year of [...years].sort((left, right) => left.centerY - right.centerY)) {
    const row = yearRows.find((candidate) => Math.abs(candidate.centerY - year.centerY) <= RELATION_ROW_TOLERANCE_PT * pixelsPerPoint);
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
  const typicalGap = gaps[Math.floor(gaps.length / 2)] ?? RELATION_FALLBACK_GAP_PT * pixelsPerPoint;
  const yearY = yearRow.centerY;
  const values = locatedTokens(observations, NUMBER_PATTERN)
    .filter((item) => !YEAR_PREFIX_PATTERN.test(item.text))
    .filter((item) => item.centerY < yearY - RELATION_VALUE_ABOVE_MARGIN_PT * pixelsPerPoint)
    .filter((item) => yearY - item.centerY <= Math.max(RELATION_VALUE_WINDOW_MIN_PT * pixelsPerPoint, typicalGap * 4));

  const used = new Set<number>();
  const relations: DerivedRelation[] = [];
  for (const year of orderedYears) {
    const candidates = values
      .map((value, index) => ({ value, index, distance: Math.abs(value.centerX - year.centerX) }))
      .filter((candidate) => !used.has(candidate.index) && candidate.distance <= typicalGap * RELATION_ASSIGN_RADIUS_RATIO)
      .sort((left, right) => left.distance - right.distance);
    const selected = candidates[0];
    if (!selected) continue;
    used.add(selected.index);
    const runnerUp = candidates[1];
    const margin = runnerUp
      ? Math.min(1, Math.max(0, (runnerUp.distance - selected.distance) / Math.max(1, typicalGap * RELATION_ASSIGN_RADIUS_RATIO)))
      : 1;
    const components: RelationComponent[] = [
      { role: 'category', sourceId: year.sourceId, text: year.normalized ?? year.text, box: year.sourceBox },
      { role: 'value', sourceId: selected.value.sourceId, text: selected.value.text, box: selected.value.sourceBox }
    ];
    const sourceIds = [...new Set(components.map((component) => component.sourceId))];
    const box = unionBoxes(components.map((component) => component.box));
    if (!box) continue;
    relations.push({
      id: createDerivedId(pageId, 'chart-category-value', sourceIds.concat(year.normalized ?? year.text)),
      pageNumber: observations[0]?.pageNumber ?? 0,
      kind: 'chart-category-value',
      // The method name states the layout assumption: column charts whose
      // values sit above a single year axis row.
      method: 'column-chart-single-year-row-above-nearest-x-v1',
      confidence: Math.min(
        RELATION_CONFIDENCE_CAP,
        year.confidence,
        selected.value.confidence,
        RELATION_CONFIDENCE_BASE + margin * RELATION_CONFIDENCE_MARGIN_BONUS
      ),
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


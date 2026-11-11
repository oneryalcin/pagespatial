import { boxArea, intersectionArea } from './geometry.js';
import { LETTER, chars, fontLetterEvidence, glyphMismatches, type FontLetterEvidence } from './glyph-audit.js';
import { SELECTIVE_OCR_MIN_CONFIRMATIONS, SELECTIVE_OCR_MIN_COVERAGE, SELECTIVE_OCR_MIN_NATIVE_CHARS } from './tuning.js';
import type { Box, NativeLine, NativeObservation, OcrObservation } from './types.js';

/**
 * Selective OCR: which detected text boxes may go unrecognized.
 * Design: docs/design/2026-11-07-selective-ocr.md.
 *
 * The detector runs on every page. A detected box is left unread only when
 * `skipVerdict` allows it, and that verdict is a pure function of evidence the
 * record keeps: the native observations and the OCR observations that were
 * read. The schema re-derives it, so a record cannot claim a skip the evidence
 * does not support.
 *
 * A box may be skipped when all of these hold:
 *  - the page has a usable native text layer;
 *  - native text covers the box;
 *  - no native line touching the box holds a numeral or a character without a
 *    faithful Unicode mapping, so every number stays two-witness;
 *  - every font under the box is uncontradicted by OCR on this page;
 *  - every letter of the native text under the box was read by OCR as that
 *    same letter, in that font, at least SELECTIVE_OCR_MIN_CONFIRMATIONS times
 *    elsewhere on the page.
 */
export type RecognizeReason =
  | 'no-usable-native-layer'
  | 'not-native-covered'
  | 'native-has-numeral'
  | 'native-suspicious-characters'
  | 'native-font-unknown'
  | 'font-contradicted'
  | 'letters-unconfirmed';

export type SkipVerdict =
  | { skip: true; nativeIds: string[] }
  | { skip: false; reason: RecognizeReason };

// Ideographic numerals are letters to Unicode (category Lo) but numbers to a reader.
const NUMERAL = /[\p{N}零一二三四五六七八九十百千万萬億亿兆壹貳貮參叁肆伍陸陆柒捌玖拾佰仟廿卅]/u;
const SUSPICIOUS = /[\p{Cc}\p{Co}\p{Cn}�]/u;

function hasNumeral(text: string): boolean {
  return NUMERAL.test(text);
}

/** Control, private-use, unassigned or replacement characters: a glyph with no faithful Unicode mapping. */
function isSuspicious(text: string): boolean {
  return SUSPICIOUS.test(text.replace(/[\t\n\r]/gu, ''));
}

function letters(text: string): string[] {
  return chars(text).filter((ch) => LETTER.test(ch));
}

/** What the page's native layer and the OCR read so far say about each font. */
export interface SelectiveEvidence {
  nativeObservations: readonly NativeObservation[];
  nativeLines: readonly NativeLine[];
  usableNativeLayer: boolean;
  fonts: ReadonlyMap<string, FontLetterEvidence>;
  contradictedFonts: ReadonlySet<string>;
}

export function selectiveEvidence(
  nativeObservations: readonly NativeObservation[],
  nativeLines: readonly NativeLine[],
  ocrObservations: readonly Pick<OcrObservation, 'id' | 'box' | 'text' | 'recoveryMethod'>[]
): SelectiveEvidence {
  const fonts = fontLetterEvidence(nativeObservations, ocrObservations as readonly OcrObservation[]);
  return {
    nativeObservations,
    nativeLines,
    usableNativeLayer: nativeObservations.reduce((sum, observation) => sum + observation.text.length, 0)
      >= SELECTIVE_OCR_MIN_NATIVE_CHARS,
    fonts,
    contradictedFonts: new Set(glyphMismatches(fonts).map((mismatch) => mismatch.font))
  };
}

function confirmations(evidence: SelectiveEvidence, font: string, letter: string): number {
  const entry = evidence.fonts.get(font);
  if (!entry) return 0;
  const substituted = [...(entry.subs.get(letter)?.values() ?? [])].reduce((sum, count) => sum + count, 0);
  return (entry.seen.get(letter) ?? 0) - substituted;
}

export function skipVerdict(box: Box, evidence: SelectiveEvidence): SkipVerdict {
  if (!evidence.usableNativeLayer) return { skip: false, reason: 'no-usable-native-layer' };
  const over = evidence.nativeObservations.filter((native) => intersectionArea(box, native.box) > 0);
  const area = boxArea(box);
  const covered = area > 0
    ? Math.min(1, over.reduce((sum, native) => sum + intersectionArea(box, native.box), 0) / area)
    : 0;
  if (covered < SELECTIVE_OCR_MIN_COVERAGE) return { skip: false, reason: 'not-native-covered' };
  // The whole native line, so a digit just outside the detector box (a margin
  // line number, a trailing table value) still forces recognition.
  const texts = [
    ...over.map((native) => native.text),
    ...evidence.nativeLines.filter((line) => intersectionArea(box, line.box) > 0).map((line) => line.text)
  ];
  if (texts.some(hasNumeral)) return { skip: false, reason: 'native-has-numeral' };
  if (texts.some(isSuspicious)) return { skip: false, reason: 'native-suspicious-characters' };
  if (over.some((native) => !native.font)) return { skip: false, reason: 'native-font-unknown' };
  if (over.some((native) => evidence.contradictedFonts.has(native.font!))) return { skip: false, reason: 'font-contradicted' };
  for (const native of over) {
    for (const letter of letters(native.text)) {
      if (confirmations(evidence, native.font!, letter) < SELECTIVE_OCR_MIN_CONFIRMATIONS) {
        return { skip: false, reason: 'letters-unconfirmed' };
      }
    }
  }
  return { skip: true, nativeIds: over.map((native) => native.id) };
}

/**
 * Audit lines: among boxes that could be skipped if their letters were
 * confirmed, the ones to read so that they are. Greedy, and optimistic (it
 * assumes OCR will read each chosen line's letters correctly); the caller
 * re-checks every remaining box against what OCR actually read.
 */
export function chooseAuditBoxes(boxes: readonly Box[], candidates: readonly number[], evidence: SelectiveEvidence): number[] {
  const supply = new Map<number, Map<string, number>>();
  for (const index of candidates) {
    const counts = new Map<string, number>();
    for (const native of evidence.nativeObservations) {
      if (!native.font || intersectionArea(boxes[index]!, native.box) <= 0) continue;
      for (const letter of letters(native.text)) {
        const key = `${native.font}\u0000${letter}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    supply.set(index, counts);
  }
  const need = new Map<string, number>();
  for (const counts of supply.values()) {
    for (const key of counts.keys()) {
      if (need.has(key)) continue;
      const [font, letter] = key.split('\u0000') as [string, string];
      need.set(key, Math.max(0, SELECTIVE_OCR_MIN_CONFIRMATIONS - confirmations(evidence, font, letter)));
    }
  }
  const remaining = new Set(candidates);
  const picked: number[] = [];
  for (;;) {
    // Letters still short of confirmation in some box that is not being read.
    const demanded = new Set<string>();
    for (const index of remaining) {
      for (const key of supply.get(index)!.keys()) if (need.get(key)! > 0) demanded.add(key);
    }
    if (!demanded.size) break;
    let best = -1;
    let bestGain = 0;
    for (const index of remaining) {
      let gain = 0;
      for (const [key, count] of supply.get(index)!) if (demanded.has(key)) gain += Math.min(need.get(key)!, count);
      if (gain > bestGain) { best = index; bestGain = gain; }
    }
    if (best < 0) break;
    remaining.delete(best);
    picked.push(best);
    for (const [key, count] of supply.get(best)!) need.set(key, Math.max(0, need.get(key)! - count));
  }
  return picked;
}

export interface SelectiveReading {
  index: number;
  text: string;
}

export interface SelectivePlanResult<TReading extends SelectiveReading> {
  /** Every reading the recognizer returned, in the order requested. */
  readings: TReading[];
  /** Detected boxes left unread, with the native observations standing in. */
  skipped: Array<{ index: number; nativeIds: string[] }>;
  /** Why each read box was read: a RecognizeReason, 'audit-line', or the page-level reason. */
  reasons: Map<number, string>;
}

/**
 * Drive a recognizer over the detected boxes of one page, reading only what
 * `skipVerdict` cannot excuse. `recognize` is called at most a few times, each
 * with box indices not requested before. With `readAll` set (a page-level
 * reason to distrust the native layer), every box is read.
 */
export async function recognizeSelectively<TReading extends SelectiveReading>(input: {
  boxes: readonly Box[];
  nativeObservations: readonly NativeObservation[];
  nativeLines: readonly NativeLine[];
  readAll?: string;
  recognize: (indices: number[]) => Promise<TReading[]>;
}): Promise<SelectivePlanResult<TReading>> {
  const { boxes } = input;
  const readings: TReading[] = [];
  const reasons = new Map<number, string>();
  const unread = new Set(boxes.keys());
  const read = async (indices: number[], reason: (index: number) => string): Promise<void> => {
    if (!indices.length) return;
    for (const index of indices) { unread.delete(index); reasons.set(index, reason(index)); }
    readings.push(...await input.recognize(indices));
  };
  const evidence = (): SelectiveEvidence => selectiveEvidence(
    input.nativeObservations,
    input.nativeLines,
    // Readings with no text never reach the record, so they are not evidence here either.
    readings.filter((reading) => reading.text.trim()).map((reading) => ({
      id: String(reading.index), box: boxes[reading.index]!, text: reading.text.trim()
    }))
  );

  if (input.readAll) {
    await read([...unread], () => input.readAll!);
    return { readings, skipped: [], reasons };
  }

  // 1. Boxes no amount of audit evidence could excuse.
  const blocked = new Map<number, string>();
  const unaudited = evidence();
  for (const index of unread) {
    const verdict = skipVerdict(boxes[index]!, unaudited);
    if (!verdict.skip && verdict.reason !== 'letters-unconfirmed' && verdict.reason !== 'font-contradicted') {
      blocked.set(index, verdict.reason);
    }
  }
  await read([...blocked.keys()], (index) => blocked.get(index)!);

  // 2. Audit lines, so the remaining boxes' letters get confirmed.
  await read(chooseAuditBoxes(boxes, [...unread], evidence()), () => 'audit-line');

  // 3. Whatever the evidence still does not excuse. More reading can newly
  // contradict a font, so repeat until every unread box is excused.
  for (;;) {
    const current = evidence();
    const failing = new Map<number, string>();
    for (const index of unread) {
      const verdict = skipVerdict(boxes[index]!, current);
      if (!verdict.skip) failing.set(index, verdict.reason);
    }
    if (!failing.size) {
      const skipped = [...unread].map((index) => {
        const verdict = skipVerdict(boxes[index]!, current);
        return { index, nativeIds: verdict.skip ? verdict.nativeIds : [] };
      });
      return { readings, skipped, reasons };
    }
    await read([...failing.keys()], (index) => failing.get(index)!);
  }
}

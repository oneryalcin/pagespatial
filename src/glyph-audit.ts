import { intersectionArea, boxArea } from './geometry.js';
import {
  GLYPH_AUDIT_MIN_COVERAGE,
  GLYPH_AUDIT_MIN_RATE,
  GLYPH_AUDIT_MIN_SUBSTITUTIONS,
  GLYPH_AUDIT_WITHHOLD_MIN_LETTERS,
  GLYPH_AUDIT_WITHHOLD_SHARE
} from './tuning.js';
import type { NativeObservation, OcrObservation } from './types.js';

/**
 * Native glyph audit: does OCR systematically read a native font's letters as
 * different letters? A corrupted ToUnicode map renders correctly but extracts
 * wrong letters, and since conflicts are raised only for digit-bearing tokens,
 * such prose corruption otherwise passes silently into the record.
 *
 * Pure and deterministic. Diagnostics and the schema both call it, so the
 * derived escalation cannot drift from the evidence.
 */
export interface GlyphMismatch {
  font: string;
  /** Native observations in this font containing a contradicted letter. */
  nativeIds: string[];
  /** Every native observation in this font on the page. */
  fontNativeIds: string[];
  letters: Array<{ native: string; ocr: string; substitutions: number; occurrences: number }>;
  /** Contradicted letter occurrences / aligned letter occurrences in this font. */
  share: number;
  /** Aligned letter occurrences in this font on the page (the share's denominator). */
  letterCount: number;
  /**
   * Share at or above GLYPH_AUDIT_WITHHOLD_SHARE over at least
   * GLYPH_AUDIT_WITHHOLD_MIN_LETTERS letters: keep this font's native text out
   * of the projection.
   */
  withhold: boolean;
}

export const LETTER = /\p{L}/u;

// Scripts OCR must demonstrably read on the page before its readings can
// testify against native letters of that script.
const SCRIPTS: Array<[string, RegExp]> = [
  ['Latin', /\p{Script=Latin}/u], ['Greek', /\p{Script=Greek}/u], ['Cyrillic', /\p{Script=Cyrillic}/u],
  ['Han', /\p{Script=Han}/u], ['Hiragana', /\p{Script=Hiragana}/u], ['Katakana', /\p{Script=Katakana}/u],
  ['Hangul', /\p{Script=Hangul}/u], ['Arabic', /\p{Script=Arabic}/u], ['Hebrew', /\p{Script=Hebrew}/u],
  ['Thai', /\p{Script=Thai}/u], ['Devanagari', /\p{Script=Devanagari}/u]
];

function scriptOf(ch: string): string {
  for (const [name, pattern] of SCRIPTS) if (pattern.test(ch)) return name;
  return 'Other';
}

/** NFKC-normalised characters with whitespace removed: the unit both audits align. */
export function chars(text: string): string[] {
  return Array.from(text.normalize('NFKC').replace(/\s+/gu, ''));
}

/**
 * Align native characters against the OCR text and report, for each native
 * character, the OCR character it aligned to, or null when it was deleted.
 *
 * Gaps cost 2, substitutions 1. When the OCR text is clearly longer (an OCR
 * line covering several native fragments) its leading and trailing characters
 * are free; otherwise the alignment is global. Both choices exist for
 * substitution ciphers (an offset CMap, "wkh" for "the"): with unit gaps or
 * free ends the alignment slides onto coincidental matches and pairs the
 * wrong letters.
 */
const GAP = 2;
function alignNativeIntoOcr(native: string[], ocr: string[]): Array<string | null> {
  const n = native.length;
  const m = ocr.length;
  const freeEnds = m > n * 1.25 + 2;
  const cost = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = 1; i <= n; i += 1) cost[i]![0] = i * GAP;
  if (!freeEnds) for (let j = 1; j <= m; j += 1) cost[0]![j] = j * GAP;
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      const sub = cost[i - 1]![j - 1]! + (native[i - 1] === ocr[j - 1] ? 0 : 1);
      cost[i]![j] = Math.min(sub, cost[i - 1]![j]! + GAP, cost[i]![j - 1]! + GAP);
    }
  }
  // Global alignment ends at the last OCR character. With free ends, take the
  // lowest-cost end, ties broken toward aligning the full native length.
  let j = freeEnds ? 0 : m;
  if (freeEnds) {
    for (let k = 1; k <= m; k += 1) {
      const better = cost[n]![k]! < cost[n]![j]!
        || (cost[n]![k] === cost[n]![j] && Math.abs(k - n) < Math.abs(j - n));
      if (better) j = k;
    }
  }
  const aligned: Array<string | null> = new Array(n).fill(null);
  let i = n;
  while (i > 0 && j > 0) {
    const diagonal = cost[i - 1]![j - 1]! + (native[i - 1] === ocr[j - 1] ? 0 : 1);
    if (cost[i]![j] === diagonal) {
      aligned[i - 1] = ocr[j - 1]!;
      i -= 1;
      j -= 1;
    } else if (cost[i]![j] === cost[i - 1]![j]! + GAP) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
  return aligned;
}

/** Per-font alignment evidence: what OCR read for each native letter of the font. */
export interface FontLetterEvidence {
  /** Every native observation in this font on the page. */
  ids: string[];
  /** Aligned occurrences per native letter. */
  seen: Map<string, number>;
  /** Per native letter: the other letters OCR read it as, with counts. */
  subs: Map<string, Map<string, number>>;
  observationLetters: Array<{ id: string; letters: Set<string> }>;
  /** First-pass OCR observations whose text was aligned against this font. */
  ocrIds: Set<string>;
}

export function fontLetterEvidence(
  nativeObservations: readonly NativeObservation[],
  ocrObservations: readonly OcrObservation[]
): Map<string, FontLetterEvidence> {
  const firstPass = ocrObservations.filter((observation) => !observation.recoveryMethod);
  // A script OCR never emitted on this page is one it cannot read (e.g. a
  // model without Japanese reads kana as Han): its substitutions there are
  // OCR blindness, not evidence against the text layer.
  const ocrScripts = new Set(firstPass.flatMap((observation) =>
    chars(observation.text).filter((ch) => LETTER.test(ch)).map(scriptOf)));
  // Japanese: native kana with no OCR kana means a model without Japanese, whose
  // Han readings are Chinese forms (円 read as 内), not evidence either.
  const nativeHasKana = nativeObservations.some((observation) =>
    chars(observation.text).some((ch) => scriptOf(ch) === 'Hiragana' || scriptOf(ch) === 'Katakana'));
  if (nativeHasKana && !ocrScripts.has('Hiragana') && !ocrScripts.has('Katakana')) ocrScripts.delete('Han');
  const auditable = (ch: string): boolean => LETTER.test(ch) && ocrScripts.has(scriptOf(ch));
  const byFont = new Map<string, FontLetterEvidence>();
  for (const observation of nativeObservations) {
    const font = observation.font;
    if (!font) continue;
    const entry = byFont.get(font)
      ?? byFont.set(font, { ids: [], seen: new Map(), subs: new Map(), observationLetters: [], ocrIds: new Set() }).get(font)!;
    entry.ids.push(observation.id);
    const nativeChars = chars(observation.text);
    if (!nativeChars.some(auditable)) continue;
    const area = boxArea(observation.box);
    const over = firstPass.filter((ocr) => intersectionArea(ocr.box, observation.box) > 0);
    const covered = area > 0
      ? Math.min(1, over.reduce((sum, ocr) => sum + intersectionArea(ocr.box, observation.box), 0) / area)
      : 0;
    if (!over.length || covered < GLYPH_AUDIT_MIN_COVERAGE) continue;
    const ocrText = [...over]
      .sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0])
      .map((ocr) => ocr.text)
      .join('');
    const aligned = alignNativeIntoOcr(nativeChars, chars(ocrText));
    entry.observationLetters.push({ id: observation.id, letters: new Set(nativeChars.filter(auditable)) });
    for (const ocr of over) entry.ocrIds.add(ocr.id);
    nativeChars.forEach((ch, index) => {
      const read = aligned[index];
      if (read === null || read === undefined || !auditable(ch)) return;
      entry.seen.set(ch, (entry.seen.get(ch) ?? 0) + 1);
      if (read.toLowerCase() !== ch.toLowerCase()) {
        const row = entry.subs.get(ch) ?? entry.subs.set(ch, new Map()).get(ch)!;
        row.set(read, (row.get(read) ?? 0) + 1);
      }
    });
  }
  return byFont;
}

export function auditNativeGlyphs(
  nativeObservations: readonly NativeObservation[],
  ocrObservations: readonly OcrObservation[]
): GlyphMismatch[] {
  return glyphMismatches(fontLetterEvidence(nativeObservations, ocrObservations));
}

export function glyphMismatches(byFont: ReadonlyMap<string, FontLetterEvidence>): GlyphMismatch[] {
  const mismatches: GlyphMismatch[] = [];
  for (const [font, entry] of [...byFont].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const letters: GlyphMismatch['letters'] = [];
    for (const [native, row] of entry.subs) {
      const [ocr, substitutions] = [...row].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]!;
      const occurrences = entry.seen.get(native) ?? 0;
      if (substitutions >= GLYPH_AUDIT_MIN_SUBSTITUTIONS && substitutions / occurrences >= GLYPH_AUDIT_MIN_RATE) {
        letters.push({ native, ocr, substitutions, occurrences });
      }
    }
    if (!letters.length) continue;
    letters.sort((a, b) => (a.native < b.native ? -1 : 1));
    const total = [...entry.seen.values()].reduce((sum, count) => sum + count, 0);
    const share = letters.reduce((sum, letter) => sum + letter.substitutions, 0) / total;
    const contradicted = new Set(letters.map((letter) => letter.native));
    mismatches.push({
      font,
      nativeIds: entry.observationLetters
        .filter((observation) => [...observation.letters].some((letter) => contradicted.has(letter)))
        .map((observation) => observation.id),
      fontNativeIds: entry.ids,
      letters,
      share,
      letterCount: total,
      withhold: share >= GLYPH_AUDIT_WITHHOLD_SHARE && total >= GLYPH_AUDIT_WITHHOLD_MIN_LETTERS
    });
  }
  return mismatches;
}

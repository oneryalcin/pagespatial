const WORD_PATTERN = /[\p{L}\p{N}%£€$+.,:/-]+/gu;

/** Single definition of a calendar/fiscal year body, shared with relations.ts. */
export const YEAR_BODY_SOURCE = String.raw`(?:19|20)\d{2}`;

/*
 * Critical tokens exist for CROSS-ENGINE comparison: the native text layer and
 * OCR transcribe the same visible ink, so only engine-introduced variance is
 * healed — codepoint variants, typographic whitespace, segmentation, case.
 * Differences in the visible marks themselves (comma vs period, mm vs m,
 * O vs 0, unit words) are preserved verbatim and therefore conflict.
 * No unit whitelist, no unit interpretation.
 *
 * A token has two channels: a numeric CORE (sign, currency, digits,
 * separators, percent) that is always compared, and an optional TAIL — one
 * adjacent unit-like word — compared only when BOTH sides captured one.
 * Extractors segment the same ink differently, so an observation that simply
 * covers less ink (a core without its unit word, or a number without its FY
 * prefix) must never conflict with one that covers more. Leading words are
 * not compared at all: they are labels, and comparing them turned ordinary
 * alphabetic OCR noise into blocking conflicts. Known trade-off: a misread
 * leading currency code (USD vs USO) is no longer caught; misread trailing
 * units (million vs rnillion, mm vs m) still are. Known collision: footnote
 * "(1)" and negative "-1" canonicalize identically via the accounting fold.
 */
function canonicalizeCritical(value: string): string {
  return String(value ?? '')
    // Typographic digit-grouping separators (NBSP/thin/narrow/figure/
    // punctuation space) are unambiguous presentation; heal them BEFORE NFKC
    // folds them into plain space. Plain-space grouping ("1 234") stays
    // split: it could be two values. Residual risk: a year and an adjacent
    // 3-digit column value separated only by NBSP merge into one token.
    .replace(/(?<=\d)[\u00a0\u2007\u2008\u2009\u202f](?=\d{3}(?!\d))/gu, '')
    .normalize('NFKC')
    // Locale-independent: toLocaleLowerCase() follows the host locale.
    .toLowerCase()
    // Soft hyphens, zero-width and other invisible format characters.
    .replace(/\p{Cf}/gu, '')
    .replace(/[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/gu, ' ')
    .replace(/[‐‑‒–—−]/gu, '-')
    // NFKC expands vulgar fractions (1/4) via U+2044 FRACTION SLASH; fold it
    // into the plain slash the body class already accepts.
    .replace(/\u2044/gu, '/')
    // Accounting negative: a symmetric, well-defined presentation convention.
    .replace(/\(\s*((?:\p{Sc}|[+-])?\s?\d[\d.,:\/-]*\d?\s?[%‰‱]?)\s*\)/gu, '-$1');
}

// Verbatim capture: a maximal digit run plus tightly attached symbols, and an
// optional captured tail word. A word that itself precedes another number is
// that number's (ignored) label, not this token's tail. Nothing captured is
// interpreted.
const CRITICAL_TOKEN = new RegExp(
  [
    String.raw`(?:[+-] ?)?`,
    String.raw`(?:\p{Sc} ?)?`,
    String.raw`(?:[+-] ?)?`,
    String.raw`\d(?:[\d.,:/-]*\d)?`,
    String.raw`(?: ?[%‰‱])?`,
    String.raw`(?: ?\p{Sc})?`,
    String.raw`(?: ?(\p{L}+)(?! ?[+-]?\p{Sc}?[+-]?\d))?`
  ].join(''),
  'gu'
);

export function normalizeEvidenceText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    // Locale-independent: toLocaleLowerCase() follows the host locale (e.g.
    // Turkish dotless ı), which would make matching nondeterministic across machines.
    .toLowerCase()
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/([$£€])\s*([+-])\s*/gu, '$2$1')
    .replace(/([+-])\s*([$£€])\s*/gu, '$1$2')
    .replace(/(\d[\d,.]*(?:\.\d+)?)\s+%/gu, '$1%')
    .replace(/[^\p{L}\p{N}%£€$+.-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordTokens(value: string): string[] {
  return normalizeEvidenceText(value).match(WORD_PATTERN) ?? [];
}

const TAIL_SEPARATOR = '|';

function splitCriticalToken(token: string): { core: string; tail: string | null } {
  const index = token.indexOf(TAIL_SEPARATOR);
  return index < 0
    ? { core: token, tail: null }
    : { core: token.slice(0, index), tail: token.slice(index + 1) };
}

/**
 * Encoded as `core` or `core|tail`. The encoding is an implementation detail
 * of this module and the evaluation tooling; compare tokens with
 * criticalTokensAgree / criticalTokensCompatible, not string equality.
 */
export function criticalTokens(value: string): string[] {
  const output: string[] = [];
  for (const match of canonicalizeCritical(value).matchAll(CRITICAL_TOKEN)) {
    const tail = match[1];
    const core = (tail ? match[0].slice(0, match[0].length - tail.length) : match[0])
      .replaceAll(' ', '');
    if (!/\d/.test(core)) continue;
    output.push(tail ? `${core}${TAIL_SEPARATOR}${tail}` : core);
  }
  return output;
}

/**
 * Two tokens describe the same ink when their cores are equal and their
 * tails do not contradict: a missing tail means the observation simply
 * covered less ink, never a disagreement.
 */
export function criticalTokensCompatible(left: string, right: string): boolean {
  const a = splitCriticalToken(left);
  const b = splitCriticalToken(right);
  return a.core === b.core && (a.tail === null || b.tail === null || a.tail === b.tail);
}

/**
 * Multiset agreement under tail optionality. Within each core group, exact
 * tail pairs cancel first; every remaining pairing must involve a missing
 * tail on one side.
 */
export function criticalTokensAgree(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const groups = new Map<string, { left: Map<string | null, number>; right: Map<string | null, number> }>();
  const add = (side: 'left' | 'right', token: string): void => {
    const { core, tail } = splitCriticalToken(token);
    const group = groups.get(core) ?? { left: new Map(), right: new Map() };
    group[side].set(tail, (group[side].get(tail) ?? 0) + 1);
    groups.set(core, group);
  };
  for (const token of left) add('left', token);
  for (const token of right) add('right', token);
  for (const group of groups.values()) {
    const total = (side: Map<string | null, number>) => [...side.values()].reduce((sum, count) => sum + count, 0);
    if (total(group.left) !== total(group.right)) return false;
    let leftPresent = 0; let leftAbsent = 0; let rightPresent = 0; let rightAbsent = 0;
    for (const [tail, count] of group.left) {
      const matched = Math.min(count, group.right.get(tail) ?? 0);
      const remaining = count - matched;
      if (tail === null) leftAbsent += remaining; else leftPresent += remaining;
      group.right.set(tail, (group.right.get(tail) ?? 0) - matched);
    }
    for (const [tail, count] of group.right) {
      if (count <= 0) continue;
      if (tail === null) rightAbsent += count; else rightPresent += count;
    }
    if (leftPresent > rightAbsent || rightPresent > leftAbsent) return false;
  }
  return true;
}

export function sameTokenMultiset(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((token, index) => token === sortedRight[index]);
}

export function textSimilarity(left: string, right: string): number {
  const normalizedLeft = normalizeEvidenceText(left);
  const normalizedRight = normalizeEvidenceText(right);
  if (!normalizedLeft || !normalizedRight) return 0;
  if (normalizedLeft === normalizedRight) return 1;
  const compactLeft = normalizedLeft.replace(/\s+/g, '');
  const compactRight = normalizedRight.replace(/\s+/g, '');
  if (compactLeft === compactRight) return 1;
  if (compactLeft.includes(compactRight) || compactRight.includes(compactLeft)) {
    return Math.min(compactLeft.length, compactRight.length) / Math.max(compactLeft.length, compactRight.length);
  }
  const leftTokens = wordTokens(normalizedLeft);
  const rightTokens = wordTokens(normalizedRight);
  if (!leftTokens.length || !rightTokens.length) return 0;
  const available = [...rightTokens];
  let matched = 0;
  for (const token of leftTokens) {
    const index = available.indexOf(token);
    if (index >= 0) {
      matched += 1;
      available.splice(index, 1);
    }
  }
  return 2 * matched / (leftTokens.length + rightTokens.length);
}


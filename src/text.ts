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
 */
function canonicalizeCritical(value: string): string {
  return String(value ?? '')
    // Typographic digit-grouping separators (NBSP/thin/narrow) are unambiguous
    // presentation; heal them BEFORE NFKC folds them into plain space.
    // Plain-space grouping ("1 234") stays split: it could be two values.
    .replace(/(?<=\d)[\u00a0\u2009\u202f](?=\d{3}(?!\d))/gu, '')
    .normalize('NFKC')
    // Locale-independent: toLocaleLowerCase() follows the host locale.
    .toLowerCase()
    // Soft hyphens, zero-width and other invisible format characters.
    .replace(/\p{Cf}/gu, '')
    .replace(/[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/gu, ' ')
    .replace(/[‐‑‒–—−]/gu, '-')
    // Accounting negative: a symmetric, well-defined presentation convention.
    .replace(/\(\s*((?:\p{Sc}|[+-])?\s?\d[\d.,:/-]*\d?\s?[%‰‱]?)\s*\)/gu, '-$1');
}

// Verbatim capture: a maximal digit run plus tightly attached context
// (leading word like FY, sign, any Unicode currency symbol, percent family,
// one adjacent unit-like word). Nothing captured is interpreted.
const CRITICAL_TOKEN = new RegExp(
  [
    String.raw`(?:\p{L}+ ?(?=[+\-\p{Sc}\d]))?`,
    String.raw`(?:[+-] ?)?`,
    String.raw`(?:\p{Sc} ?)?`,
    String.raw`(?:[+-] ?)?`,
    String.raw`\d(?:[\d.,:/-]*\d)?`,
    String.raw`(?: ?[%‰‱])?`,
    String.raw`(?: ?\p{Sc})?`,
    String.raw`(?: ?\p{L}+)?`
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

export function criticalTokens(value: string): string[] {
  return (canonicalizeCritical(value).match(CRITICAL_TOKEN) ?? [])
    .filter((token) => /\d/.test(token))
    .map((token) => token.replaceAll(' ', ''));
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


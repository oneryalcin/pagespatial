const WORD_PATTERN = /[\p{L}\p{N}%£€$+.,:/-]+/gu;
const CRITICAL_PATTERN = /\b(?:FY)?(?:19|20)\d{2}[AEF]?\b|[-+]?[$£€]?\d[\d,.]*(?:\.\d+)?(?:\s*(?:%|billion|million|bn|mm|mn|kgs|lbs|bps|kg|lb|mg|km|cm|ft|oz|ml|bp|in|k|m|b|g|l|x))?(?![\p{L}\p{N}])/giu;

export function normalizeEvidenceText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase()
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
  const normalized = value
    .normalize('NFKC')
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/\(\s*([$£€]?)\s*(\d[\d,.]*(?:\.\d+)?)\s*(%)?\s*\)/gu, '-$1$2$3')
    .replace(/([$£€])\s*([+-])\s*/gu, '$2$1')
    .replace(/([+-])\s*([$£€])\s*/gu, '$1$2')
    .replace(/(\d[\d,.]*(?:\.\d+)?)\s+%/gu, '$1%');

  return [...normalized.matchAll(CRITICAL_PATTERN)].map((match) => match[0]
    .toLocaleLowerCase()
    .replace(/\s+/g, '')
    .replace(/(?<=\d),(?=\d{3}\b)/g, '')
    .replace(/[.,]+$/g, '')
    .replace(/(million|mm|mn)$/u, 'm')
    .replace(/(billion|bn)$/u, 'bn')
    .replace(/(?<=\d)b$/u, 'bn')
    .replace(/kgs$/u, 'kg')
    .replace(/lbs$/u, 'lb'));
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


const CRITICAL_TOKEN_PATTERN = /[£€$¥]?\(?[+\-−–—]?\d+(?:[.,]\d+)*(?:%|ppt|bp|[xkmbn])?\)?/giu;
const FRAGMENT_PATTERN = /^[£€$¥()\d+\-−–—.,%]+$/u;

function finiteBox(observation) {
  const box = observation.box ?? observation.pointBox;
  if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite)) return null;
  return box;
}

function sameLineAndAdjacent(left, right, gapFactor) {
  if ((left.pageNumber ?? left.page) !== (right.pageNumber ?? right.page)) return false;
  const leftBox = finiteBox(left);
  const rightBox = finiteBox(right);
  if (!leftBox || !rightBox) return false;
  const overlap = Math.min(leftBox[3], rightBox[3]) - Math.max(leftBox[1], rightBox[1]);
  const minimumHeight = Math.min(leftBox[3] - leftBox[1], rightBox[3] - rightBox[1]);
  if (minimumHeight <= 0 || overlap / minimumHeight < 0.5) return false;
  const gap = rightBox[0] - leftBox[2];
  return gap >= -minimumHeight * 0.35 && gap <= Math.max(2, minimumHeight * gapFactor);
}

function hasFragmentBoundary(left, right) {
  const leftText = left.trim();
  const rightText = right.trim();
  if (!FRAGMENT_PATTERN.test(leftText) || !FRAGMENT_PATTERN.test(rightText)) return false;
  return /[£€$¥(,+\-−–—.]$/u.test(leftText)
    || /^[,.%)]/u.test(rightText);
}

export function coalesceCriticalFragments(observations, { gapFactor = 0.5 } = {}) {
  const result = [];
  for (const observation of observations) {
    const current = { ...observation, text: String(observation.text ?? '').trim() };
    const previous = result.at(-1);
    if (previous
      && sameLineAndAdjacent(previous, current, gapFactor)
      && hasFragmentBoundary(previous.text, current.text)) {
      previous.text += current.text;
      const left = finiteBox(previous);
      const right = finiteBox(current);
      if (left && right) {
        const merged = [
          Math.min(left[0], right[0]), Math.min(left[1], right[1]),
          Math.max(left[2], right[2]), Math.max(left[3], right[3])
        ];
        if ('pointBox' in previous) previous.pointBox = merged;
        else previous.box = merged;
      }
      continue;
    }
    result.push(current);
  }
  return result;
}

export function normalizeCriticalToken(token) {
  let value = token.normalize('NFKC').toLowerCase().replace(/[−–—]/gu, '-');
  const accountingNegative = value.startsWith('(') && value.endsWith(')');
  if (accountingNegative) value = value.slice(1, -1);
  value = value.replace(/,/gu, '');
  return accountingNegative ? `-${value}` : value;
}

export function extractCriticalTokens(observations, options) {
  return coalesceCriticalFragments(observations, options)
    .flatMap((observation) => String(observation.text ?? '').match(CRITICAL_TOKEN_PATTERN) ?? [])
    .map(normalizeCriticalToken);
}

function tokenCounts(tokens) {
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

export function compareCriticalTokens(candidateTokens, referenceTokens) {
  const candidate = tokenCounts(candidateTokens);
  const reference = tokenCounts(referenceTokens);
  let matched = 0;
  let candidateTotal = 0;
  let referenceTotal = 0;
  const missing = [];
  const unexpected = [];
  for (const count of candidate.values()) candidateTotal += count;
  for (const [token, count] of reference) {
    referenceTotal += count;
    const common = Math.min(count, candidate.get(token) ?? 0);
    matched += common;
    if (common < count) missing.push(...Array(count - common).fill(token));
  }
  for (const [token, count] of candidate) {
    const excess = count - Math.min(count, reference.get(token) ?? 0);
    if (excess > 0) unexpected.push(...Array(excess).fill(token));
  }
  return {
    matched,
    referenceTotal,
    candidateTotal,
    recall: referenceTotal ? matched / referenceTotal : 1,
    precision: candidateTotal ? matched / candidateTotal : 1,
    missing,
    unexpected
  };
}

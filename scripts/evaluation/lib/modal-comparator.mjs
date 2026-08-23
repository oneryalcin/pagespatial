/**
 * §14.3 stable-result comparator for the Modal qualification run (design
 * doc 2026-08-23-modal-scaling-and-deployment.md).
 *
 * Never compare pageDigest() across repeated parses: the digest
 * deliberately includes provenance.runId and provenance.createdAt, so a
 * valid reparse has a new digest. Instead, three named projections:
 *
 *  1. stableDeterministicProjection(page) — the page minus
 *     provenance.runId, provenance.createdAt, and the OCR-dependent roots.
 *     Its canonical JSON must be EXACT across reparses.
 *  2. ocrScoreProjection(pages) — the existing EP-scorer shape
 *     ({perPage: [{page, lines: [{text, score}]}]}) in observation order.
 *  3. ocrDerivedProjection(page) — only the OCR-dependent roots.
 *
 * Rules (§14.3): deterministic must remain exact. If the OCR score
 * projection is exact, the OCR-derived projection must also be exact. If
 * OCR varies, both complete pages must still pass schema validation and
 * only the OCR-derived projection may differ — judged by the existing
 * critical-token and raw-line scorer (same semantics as
 * score-ep-control.mjs) against a null tolerance DERIVED by parsing the
 * same manifest twice under the same deployed configuration. A scale arm
 * passes only when its critical-token and raw-line deltas are no larger
 * than that run's null tolerance.
 */
import { criticalTokens } from '../../../dist/text.js';
import { pageSpatialSchema } from '../../../dist/schema.js';

/** The OCR-dependent page roots, verbatim from §14.3. */
export const OCR_DEPENDENT_ROOTS = Object.freeze([
  'ocrObservations', 'sourceMatches', 'conflicts', 'spatialRows',
  'derivedRelations', 'unreadInkRegions', 'secondOpinion', 'diagnostics',
  'projection'
]);

/** Canonical JSON: sorted keys, undefined dropped (mirrors pageDigest's
 * stableStringify in src/enrichment.ts — same canonical form, no hash). */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Projection 1: geometry, native observations/lines, document/page
 * identity, and non-volatile provenance. Must be exact across reparses. */
export function stableDeterministicProjection(page) {
  const projection = {};
  for (const [key, value] of Object.entries(page)) {
    if (OCR_DEPENDENT_ROOTS.includes(key)) continue;
    if (key === 'provenance') {
      const { runId, createdAt, ...stable } = value ?? {};
      projection.provenance = stable;
      continue;
    }
    projection[key] = value;
  }
  return projection;
}

/** Projection 2: PageSpatial records -> the existing EP scorer shape,
 * observation order unchanged (§14.3, verbatim). */
export function ocrScoreProjection(pages) {
  return {
    perPage: pages.map((page) => ({
      page: page.pageNumber,
      lines: page.ocrObservations.map((item) => ({
        text: item.text,
        score: item.confidence ?? null
      }))
    }))
  };
}

/** Projection 3: only the OCR-dependent roots. */
export function ocrDerivedProjection(page) {
  const projection = {};
  for (const key of OCR_DEPENDENT_ROOTS) {
    if (key in page) projection[key] = page[key];
  }
  return projection;
}

/**
 * Critical-token multiset diff over the ocrScoreProjection shape — the
 * same semantics as score-ep-control.mjs (tokens via the library's own
 * criticalTokens; per-page symmetric difference of multisets).
 */
export function criticalTokenDiff(leftRun, rightRun) {
  const tokensByPage = (run) => {
    const byPage = new Map();
    for (const page of run.perPage) {
      const counts = new Map();
      for (const line of page.lines) {
        for (const token of criticalTokens(line.text)) {
          counts.set(token, (counts.get(token) ?? 0) + 1);
        }
      }
      byPage.set(page.page, counts);
    }
    return byPage;
  };
  const left = tokensByPage(leftRun);
  const right = tokensByPage(rightRun);
  let leftOnly = 0;
  let rightOnly = 0;
  let total = 0;
  const perPage = [];
  const pageNumbers = new Set([...left.keys(), ...right.keys()]);
  for (const page of pageNumbers) {
    const leftCounts = left.get(page) ?? new Map();
    const rightCounts = right.get(page) ?? new Map();
    let pageLeftOnly = 0;
    let pageRightOnly = 0;
    const keys = new Set([...leftCounts.keys(), ...rightCounts.keys()]);
    for (const key of keys) {
      const l = leftCounts.get(key) ?? 0;
      const r = rightCounts.get(key) ?? 0;
      if (l > r) pageLeftOnly += l - r;
      if (r > l) pageRightOnly += r - l;
    }
    for (const count of leftCounts.values()) total += count;
    leftOnly += pageLeftOnly;
    rightOnly += pageRightOnly;
    if (pageLeftOnly + pageRightOnly > 0) {
      perPage.push({ page, leftOnly: pageLeftOnly, rightOnly: pageRightOnly });
    }
  }
  return {
    leftTokens: total,
    leftOnly,
    rightOnly,
    symmetricDifference: leftOnly + rightOnly,
    pagesDiffering: perPage.length,
    perPage
  };
}

/**
 * Raw-line comparison (position-wise, per page) over the
 * ocrScoreProjection shape — same semantics as score-ep-control.mjs.
 */
export function rawLineDiff(leftRun, rightRun) {
  const rightByPage = new Map(rightRun.perPage.map((page) => [page.page, page]));
  let totalLines = 0;
  let differingLines = 0;
  let pagesDiffering = 0;
  let scoresIdentical = true;
  let maxScoreDelta = 0;
  for (const leftPage of leftRun.perPage) {
    const rightPage = rightByPage.get(leftPage.page) ?? { lines: [] };
    const leftLines = leftPage.lines;
    const rightLines = rightPage.lines;
    totalLines += Math.max(leftLines.length, rightLines.length);
    let pageDiff = Math.abs(leftLines.length - rightLines.length);
    for (let index = 0; index < Math.min(leftLines.length, rightLines.length); index += 1) {
      if (leftLines[index].text !== rightLines[index].text) pageDiff += 1;
      const leftScore = leftLines[index].score;
      const rightScore = rightLines[index].score;
      if (leftScore !== rightScore) scoresIdentical = false;
      if (Number.isFinite(leftScore) && Number.isFinite(rightScore)) {
        maxScoreDelta = Math.max(maxScoreDelta, Math.abs(leftScore - rightScore));
      }
    }
    if (pageDiff > 0) pagesDiffering += 1;
    differingLines += pageDiff;
  }
  return {
    totalLines,
    differingLines,
    pagesDiffering,
    textsIdentical: differingLines === 0,
    scoresIdentical,
    maxScoreDelta: Math.round(maxScoreDelta * 1e6) / 1e6
  };
}

/**
 * Compare two parses of ONE document (arrays of canonical PageSpatial
 * records, matched by pageNumber). Returns the three projection outcomes.
 */
export function comparePages(leftPages, rightPages) {
  const byNumber = (pages) => new Map(pages.map((page) => [page.pageNumber, page]));
  const left = byNumber(leftPages);
  const right = byNumber(rightPages);
  const pageNumbers = [...new Set([...left.keys(), ...right.keys()])].sort((a, b) => a - b);

  const missingPages = pageNumbers.filter((n) => !left.has(n) || !right.has(n));
  const deterministicDiffering = [];
  const ocrDerivedDiffering = [];
  const schemaFailures = [];
  for (const n of pageNumbers) {
    if (!left.has(n) || !right.has(n)) continue;
    const leftPage = left.get(n);
    const rightPage = right.get(n);
    if (canonicalJson(stableDeterministicProjection(leftPage))
      !== canonicalJson(stableDeterministicProjection(rightPage))) {
      deterministicDiffering.push(n);
    }
    if (canonicalJson(ocrDerivedProjection(leftPage))
      !== canonicalJson(ocrDerivedProjection(rightPage))) {
      ocrDerivedDiffering.push(n);
      // §14.3: when OCR varies, both complete pages must still pass
      // schema validation.
      for (const [side, page] of [['left', leftPage], ['right', rightPage]]) {
        const check = pageSpatialSchema.safeParse(page);
        if (!check.success) schemaFailures.push({ page: n, side });
      }
    }
  }

  const orderedLeft = pageNumbers.filter((n) => left.has(n)).map((n) => left.get(n));
  const orderedRight = pageNumbers.filter((n) => right.has(n)).map((n) => right.get(n));
  const leftScore = ocrScoreProjection(orderedLeft);
  const rightScore = ocrScoreProjection(orderedRight);
  const ocrScoreExact = canonicalJson(leftScore) === canonicalJson(rightScore);

  return {
    pages: pageNumbers.length,
    missingPages,
    deterministic: { exact: deterministicDiffering.length === 0, differingPages: deterministicDiffering },
    ocrScore: {
      exact: ocrScoreExact,
      criticalTokens: criticalTokenDiff(leftScore, rightScore),
      rawLines: rawLineDiff(leftScore, rightScore)
    },
    ocrDerived: { exact: ocrDerivedDiffering.length === 0, differingPages: ocrDerivedDiffering },
    schemaFailures
  };
}

/**
 * §14.3 verdict. `nullTolerance` is {criticalTokens, rawLines} DERIVED
 * from parsing the same manifest twice under the same deployed
 * configuration — never a hard-coded universal value (the previous
 * same-host control's zero/zero is evidence, not a constant).
 *
 * A native-field mutation fails REGARDLESS of the OCR score: the
 * deterministic projection is checked first and unconditionally.
 */
export function evaluateComparison(comparison, nullTolerance) {
  if (!nullTolerance
    || !Number.isFinite(nullTolerance.criticalTokens)
    || !Number.isFinite(nullTolerance.rawLines)) {
    throw new Error('nullTolerance {criticalTokens, rawLines} is required — derive it from a same-configuration double parse (§14.3)');
  }
  const reasons = [];
  if (comparison.missingPages.length > 0) {
    reasons.push(`pages present on one side only: ${comparison.missingPages.join(', ')}`);
  }
  if (!comparison.deterministic.exact) {
    reasons.push(`stable deterministic projection differs on pages ${comparison.deterministic.differingPages.join(', ')} (fails regardless of OCR score)`);
  }
  if (comparison.ocrScore.exact && !comparison.ocrDerived.exact) {
    reasons.push(`OCR score projection exact but OCR-derived projection differs on pages ${comparison.ocrDerived.differingPages.join(', ')}`);
  }
  if (comparison.schemaFailures.length > 0) {
    reasons.push(`schema validation failed under OCR variation: ${comparison.schemaFailures.map((f) => `p${f.page}/${f.side}`).join(', ')}`);
  }
  const tokenDelta = comparison.ocrScore.criticalTokens.symmetricDifference;
  const lineDelta = comparison.ocrScore.rawLines.differingLines;
  if (tokenDelta > nullTolerance.criticalTokens) {
    reasons.push(`critical-token delta ${tokenDelta} exceeds null tolerance ${nullTolerance.criticalTokens}`);
  }
  if (lineDelta > nullTolerance.rawLines) {
    reasons.push(`raw-line delta ${lineDelta} exceeds null tolerance ${nullTolerance.rawLines}`);
  }
  return {
    pass: reasons.length === 0,
    reasons,
    deltas: { criticalTokens: tokenDelta, rawLines: lineDelta },
    tolerance: { criticalTokens: nullTolerance.criticalTokens, rawLines: nullTolerance.rawLines }
  };
}

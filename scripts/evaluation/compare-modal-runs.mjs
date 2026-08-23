/**
 * §14.3 comparator CLI: compare two captured Modal qualification runs of
 * the same manifest (or duplicate submissions inside one run) under the
 * three named projections in scripts/evaluation/lib/modal-comparator.mjs.
 *
 * Pairs results by request_id (identical across runs of one manifest;
 * duplicate-arm entries share one id inside a single file with --self).
 * Only status=completed results are compared; unpaired or failed entries
 * are listed, never silently dropped.
 *
 * Usage:
 *   node scripts/evaluation/compare-modal-runs.mjs \
 *     --left runA.jsonl --right runB.jsonl \
 *     [--tolerance-tokens N --tolerance-lines N] [--out comparison.json]
 *   node scripts/evaluation/compare-modal-runs.mjs --self duplicates.jsonl \
 *     --tolerance-tokens N --tolerance-lines N
 *
 * Without tolerance flags it reports deltas only (that is how the null
 * tolerance itself is derived from the same-configuration double parse);
 * with them it applies the §14.3 verdict and exits nonzero on failure.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { comparePages, evaluateComparison } from './lib/modal-comparator.mjs';

function flag(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  return process.argv[index + 1];
}

const listFiles = (path) => statSync(path).isDirectory()
  ? readdirSync(path).map((name) => join(path, name)).filter((file) => statSync(file).isFile())
  : [path];

function loadCaptures(path) {
  const captures = [];
  for (const file of listFiles(path)) {
    const text = readFileSync(file, 'utf8').trim();
    if (!text) continue;
    if (text.startsWith('[')) captures.push(...JSON.parse(text));
    else if (text.startsWith('{') && !text.includes('\n')) captures.push(JSON.parse(text));
    else captures.push(...text.split('\n').filter(Boolean).map((line) => JSON.parse(line)));
  }
  return captures;
}

const unwrap = (entry) => entry?.kind === 'result' ? entry.result : entry?.kind === 'exception' ? null : entry;

/** Canonical PageSpatial records of one completed result's ok pages. */
const okPages = (result) => result.pages
  .filter((page) => page.ok && page.pageSpatial)
  .map((page) => page.pageSpatial);

const selfPath = flag('--self');
const tolTokens = flag('--tolerance-tokens');
const tolLines = flag('--tolerance-lines');
const outPath = flag('--out');

let pairs = [];
const skipped = [];
if (selfPath) {
  const byId = new Map();
  for (const entry of loadCaptures(selfPath)) {
    const result = unwrap(entry);
    if (!result) { skipped.push({ request_id: entry?.request_id ?? null, why: 'exception' }); continue; }
    const list = byId.get(result.request_id) ?? [];
    list.push(result);
    byId.set(result.request_id, list);
  }
  for (const [id, list] of byId) {
    if (list.length < 2) { skipped.push({ request_id: id, why: `only ${list.length} capture(s)` }); continue; }
    pairs.push({ request_id: id, left: list[0], right: list[1] });
  }
} else {
  const leftPath = flag('--left');
  const rightPath = flag('--right');
  if (!leftPath || !rightPath) throw new Error('--left and --right (or --self) are required');
  const index = (path) => {
    const map = new Map();
    for (const entry of loadCaptures(path)) {
      const result = unwrap(entry);
      if (result) map.set(result.request_id, result);
    }
    return map;
  };
  const left = index(leftPath);
  const right = index(rightPath);
  for (const [id, leftResult] of left) {
    const rightResult = right.get(id);
    if (!rightResult) { skipped.push({ request_id: id, why: 'missing on right' }); continue; }
    pairs.push({ request_id: id, left: leftResult, right: rightResult });
  }
  for (const id of right.keys()) {
    if (!left.has(id)) skipped.push({ request_id: id, why: 'missing on left' });
  }
}

const perPair = [];
let totals = { criticalTokens: 0, rawLines: 0, ocrTokensLeft: 0, rawLinesTotal: 0 };
let deterministicExactEverywhere = true;
let ocrDerivedExactWhenScoreExact = true;
let shaMismatches = 0;
for (const pair of pairs) {
  if (pair.left.status !== 'completed' || pair.right.status !== 'completed') {
    skipped.push({ request_id: pair.request_id, why: `status ${pair.left.status}/${pair.right.status}` });
    continue;
  }
  if (pair.left.document_sha256 !== pair.right.document_sha256) shaMismatches += 1;
  const comparison = comparePages(okPages(pair.left), okPages(pair.right));
  totals.criticalTokens += comparison.ocrScore.criticalTokens.symmetricDifference;
  totals.rawLines += comparison.ocrScore.rawLines.differingLines;
  totals.ocrTokensLeft += comparison.ocrScore.criticalTokens.leftTokens;
  totals.rawLinesTotal += comparison.ocrScore.rawLines.totalLines;
  if (!comparison.deterministic.exact || comparison.missingPages.length) deterministicExactEverywhere = false;
  if (comparison.ocrScore.exact && !comparison.ocrDerived.exact) ocrDerivedExactWhenScoreExact = false;
  perPair.push({
    request_id: pair.request_id,
    pages: comparison.pages,
    deterministic_exact: comparison.deterministic.exact,
    deterministic_differing_pages: comparison.deterministic.differingPages,
    missing_pages: comparison.missingPages,
    ocr_score_exact: comparison.ocrScore.exact,
    critical_token_delta: comparison.ocrScore.criticalTokens.symmetricDifference,
    raw_line_delta: comparison.ocrScore.rawLines.differingLines,
    ocr_derived_exact: comparison.ocrDerived.exact,
    schema_failures: comparison.schemaFailures
  });
}

const summary = {
  pairs_compared: perPair.length,
  skipped,
  sha_mismatches: shaMismatches,
  deterministic_exact_everywhere: deterministicExactEverywhere,
  ocr_derived_exact_whenever_score_exact: ocrDerivedExactWhenScoreExact,
  totals,
  per_pair_nonzero: perPair.filter((pair) =>
    !pair.deterministic_exact || pair.critical_token_delta || pair.raw_line_delta
    || !pair.ocr_derived_exact || pair.missing_pages.length || pair.schema_failures.length),
  per_pair: perPair
};

let verdict = null;
if (tolTokens !== undefined && tolLines !== undefined) {
  const tolerance = { criticalTokens: Number(tolTokens), rawLines: Number(tolLines) };
  const reasons = [];
  if (!deterministicExactEverywhere) reasons.push('a stable deterministic projection differs (fails regardless of OCR score)');
  if (!ocrDerivedExactWhenScoreExact) reasons.push('OCR score projection exact but OCR-derived projection differs');
  if (shaMismatches) reasons.push(`${shaMismatches} document sha mismatches`);
  if (perPair.some((pair) => pair.schema_failures.length)) reasons.push('schema validation failed under OCR variation');
  if (totals.criticalTokens > tolerance.criticalTokens) reasons.push(`critical-token delta ${totals.criticalTokens} exceeds null tolerance ${tolerance.criticalTokens}`);
  if (totals.rawLines > tolerance.rawLines) reasons.push(`raw-line delta ${totals.rawLines} exceeds null tolerance ${tolerance.rawLines}`);
  verdict = { pass: reasons.length === 0, reasons, tolerance };
  summary.verdict = verdict;
}

const rendered = JSON.stringify({ ...summary, per_pair: undefined }, null, 1);
console.log(rendered);
if (outPath) {
  writeFileSync(outPath, `${JSON.stringify(summary, null, 1)}\n`);
  console.log('wrote', outPath);
}
process.exitCode = verdict ? (verdict.pass ? 0 : 1) : 0;

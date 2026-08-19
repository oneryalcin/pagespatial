/**
 * Evaluates a dev run against human-verified gold verdicts from the pilot.
 *
 * Inputs: proposals.json + gold-verdicts.json (from the review UI) + a run
 * root. Output: a text-free metrics aggregate (counts and rates only — no
 * page text), suitable for committing.
 *
 * Metric semantics:
 * - token recall: a gold token counts as recalled by an engine when the
 *   engine's page text contains the token's critical-token multiset under the
 *   library's own "same ink" canonicalization.
 * - conflict composition: human-confirmed verdicts over recorded conflicts.
 * - chart relations: gold tuples vs derivedRelations, matched on canonical
 *   (category, value) pairs.
 *
 * Usage:
 *   node scripts/evaluation/evaluate-gold-pilot.mjs \
 *     --gold-dir .evaluation/gold/<pilot-id> \
 *     --run-root .evaluation/runs/<run-id> \
 *     --output .evaluation/gold/<pilot-id>/metrics.json
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { criticalTokens } from '../../dist/text.js';

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  throw new Error(`Missing required argument ${name}`);
}

const goldDir = arg('--gold-dir');
const runRoot = arg('--run-root');
const outputPath = arg('--output');

const proposals = JSON.parse(readFileSync(join(goldDir, 'proposals.json'), 'utf8'));
const verdicts = JSON.parse(readFileSync(join(goldDir, 'gold-verdicts.json'), 'utf8'));
const proposalByPage = new Map(proposals.map((page) => [`${page.objectId}#${page.pageNumber}`, page]));

const recordIndex = new Map();
const documentsRoot = join(runRoot, 'documents');
for (const doc of readdirSync(documentsRoot)) {
  let pages;
  try { pages = readdirSync(join(documentsRoot, doc, 'pages')); } catch { continue; }
  for (const file of pages) {
    const record = JSON.parse(readFileSync(join(documentsRoot, doc, 'pages', file), 'utf8'));
    if (record.pageSpatial) recordIndex.set(`${record.objectId}#${record.pageNumber}`, record.pageSpatial);
  }
}

const multisetContains = (haystack, needle) => {
  const pool = [...haystack];
  return needle.every((token) => {
    const index = pool.indexOf(token);
    if (index < 0) return false;
    pool.splice(index, 1);
    return true;
  });
};

const tokenRecall = { gold: 0, native: 0, ocr: 0, union: 0, neither: 0 };
const conflictComposition = {};
const relationTotals = { goldTuples: 0, detected: 0, matched: 0 };
const escalation = { escalatedPages: 0, escalatedWithConfirmedError: 0, cleanPages: 0, cleanWithMissedGoldToken: 0 };
const perPage = [];

for (const page of verdicts.pages) {
  const key = `${page.objectId}#${page.pageNumber}`;
  const proposal = proposalByPage.get(key);
  const record = recordIndex.get(key);
  if (!proposal || !record) throw new Error(`Missing proposal or run record for ${key}`);

  const nativePool = criticalTokens(record.nativeObservations.map((observation) => observation.text).join('\n'));
  const ocrPool = criticalTokens(record.ocrObservations.map((observation) => observation.text).join('\n'));

  // The proposal text is authoritative unless the human edited it: exported
  // text can be blank for rows that were collapsed in the review UI.
  const proposalTokens = proposal.proposal.criticalTokens ?? [];
  const goldTexts = [
    ...page.tokens
      .filter((token) => token.verdict !== 'wrong')
      .map((token) => (token.verdict === 'edited' && token.text) ? token.text : proposalTokens[token.index]?.text)
      .filter(Boolean),
    ...(page.missedTokens ?? [])
  ];
  const pageStats = { objectId: page.objectId, pageNumber: page.pageNumber, gold: 0, native: 0, ocr: 0, neither: 0 };
  for (const text of goldTexts) {
    const needle = criticalTokens(text);
    if (!needle.length) continue;
    tokenRecall.gold += 1;
    pageStats.gold += 1;
    const inNative = multisetContains(nativePool, needle);
    const inOcr = multisetContains(ocrPool, needle);
    if (inNative) { tokenRecall.native += 1; pageStats.native += 1; }
    if (inOcr) { tokenRecall.ocr += 1; pageStats.ocr += 1; }
    if (inNative || inOcr) tokenRecall.union += 1;
    else { tokenRecall.neither += 1; pageStats.neither += 1; }
  }

  let confirmedError = false;
  for (const conflict of page.conflicts ?? []) {
    const machine = (proposal.conflictAdjudications ?? []).find((item) => item.id === conflict.id);
    const verdict = conflict.verdict === 'confirm' ? machine?.proposal?.verdict ?? 'unsure' : conflict.verdict;
    conflictComposition[verdict] = (conflictComposition[verdict] ?? 0) + 1;
    if (['native', 'ocr', 'both-wrong'].includes(verdict)) confirmedError = true;
  }

  const goldCharts = (page.charts ?? [])
    .filter((chart) => chart.verdict === 'correct')
    .map((chart) => proposal.proposal.chartRelations[chart.index])
    .filter(Boolean);
  const detected = record.derivedRelations ?? [];
  relationTotals.goldTuples += goldCharts.length;
  relationTotals.detected += detected.length;
  for (const tuple of goldCharts) {
    const wanted = criticalTokens(`${tuple.category ?? ''} ${tuple.value ?? ''}`).sort().join('|');
    if (detected.some((relation) =>
      criticalTokens(`${relation.attributes.category ?? ''} ${relation.attributes.value ?? ''}`).sort().join('|') === wanted)) {
      relationTotals.matched += 1;
    }
  }

  const escalated = record.diagnostics.requiresEscalation;
  if (escalated) {
    escalation.escalatedPages += 1;
    if (confirmedError) escalation.escalatedWithConfirmedError += 1;
  } else {
    escalation.cleanPages += 1;
    if (pageStats.neither > 0) escalation.cleanWithMissedGoldToken += 1;
  }
  perPage.push(pageStats);
}

const rate = (numerator, denominator) => denominator ? Number((numerator / denominator).toFixed(4)) : null;
const metrics = {
  goldPilotMetricsVersion: 'gold-pilot-metrics-v1',
  createdAt: new Date().toISOString(),
  runRoot,
  goldVerifiedAt: verdicts.verifiedAt,
  pages: verdicts.pages.length,
  criticalTokenRecall: {
    goldTokens: tokenRecall.gold,
    native: rate(tokenRecall.native, tokenRecall.gold),
    ocr: rate(tokenRecall.ocr, tokenRecall.gold),
    union: rate(tokenRecall.union, tokenRecall.gold),
    missedByBoth: tokenRecall.neither
  },
  conflictComposition,
  chartRelations: {
    goldTuples: relationTotals.goldTuples,
    detectedRelations: relationTotals.detected,
    recall: rate(relationTotals.matched, relationTotals.goldTuples)
  },
  escalation,
  perPage,
  caveats: [
    'Pilot-scale: 16 stratified pages, not the full corpus.',
    'Recall is text-containment under the same-ink canonicalization; box agreement is not yet scored.',
    'Gold source: machine pre-labels verified by one human annotator; no second annotator or adjudication yet.'
  ]
};

writeFileSync(outputPath, JSON.stringify(metrics, null, 1));
console.log(JSON.stringify(metrics, null, 1));

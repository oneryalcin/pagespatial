/**
 * Evaluates a dev run against human-verified gold verdicts from the pilot.
 *
 * Inputs: proposals.json + gold-verdicts.json (from the review UI) + a run
 * root. Output: a text-free metrics aggregate (counts and rates only — no
 * page text), suitable for committing.
 *
 * Metric semantics:
 * - Tokens are TIERED. "human" tier: verdicts a person actually confirmed
 *   (correct/edited) plus manually added missed tokens — independent gold.
 *   "silver" tier: auto-accepted via native-text corroboration in the review
 *   UI. Silver is NOT independent of the native engine (the corroboration
 *   test and the recall test coincide), so native recall on the silver tier
 *   is tautological and is reported only as a labeled tautology check.
 * - Occurrences are consumed: one extracted token satisfies one gold token.
 *   Matching uses the library's own tail-optional token compatibility.
 * - Joins are hash-bound: verdicts, proposals, and run records must agree on
 *   the document SHA-256 or the evaluator fails closed.
 * - Chart relations join on token compatibility of (category, value); the
 *   tokenizer drops label prefixes, so detector categories like "FY2024"
 *   match verbatim gold "2024".
 *
 * Usage:
 *   node scripts/evaluation/evaluate-gold-pilot.mjs \
 *     --gold-dir .evaluation/gold/<pilot-id> \
 *     --run-root .evaluation/runs/<run-id> \
 *     --output .evaluation/gold/<pilot-id>/metrics.json
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { criticalTokens, criticalTokensCompatible } from '../../dist/text.js';

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
const proposalByPage = new Map();
for (const page of proposals) {
  const key = `${page.objectId}#${page.pageNumber}`;
  if (proposalByPage.has(key)) throw new Error(`Duplicate proposal page key ${key}.`);
  proposalByPage.set(key, page);
}

const recordIndex = new Map();
const documentsRoot = join(runRoot, 'documents');
for (const doc of readdirSync(documentsRoot)) {
  let pages;
  try { pages = readdirSync(join(documentsRoot, doc, 'pages')); } catch { continue; }
  for (const file of pages) {
    const record = JSON.parse(readFileSync(join(documentsRoot, doc, 'pages', file), 'utf8'));
    if (!record.pageSpatial) continue;
    const key = `${record.objectId}#${record.pageNumber}`;
    if (recordIndex.has(key)) throw new Error(`Duplicate run record page key ${key}.`);
    recordIndex.set(key, record.pageSpatial);
  }
}

/** Consume one pool entry compatible with the token; exact matches first. */
function consumeCompatible(pool, token) {
  let index = pool.indexOf(token);
  if (index < 0) index = pool.findIndex((candidate) => criticalTokensCompatible(candidate, token));
  if (index < 0) return false;
  pool.splice(index, 1);
  return true;
}

function makeTierCounter() {
  return { gold: 0, native: 0, ocr: 0, union: 0, neither: 0 };
}
function scoreTokens(texts, nativePool, ocrPool, counter) {
  for (const text of texts) {
    for (const token of criticalTokens(text ?? '')) {
      counter.gold += 1;
      const inNative = consumeCompatible(nativePool, token);
      const inOcr = consumeCompatible(ocrPool, token);
      if (inNative) counter.native += 1;
      if (inOcr) counter.ocr += 1;
      if (inNative || inOcr) counter.union += 1;
      else counter.neither += 1;
    }
  }
}
const rate = (numerator, denominator) => denominator ? Number((numerator / denominator).toFixed(4)) : null;
const tierReport = (counter) => ({
  goldTokens: counter.gold,
  native: rate(counter.native, counter.gold),
  ocr: rate(counter.ocr, counter.gold),
  union: rate(counter.union, counter.gold),
  missedByBoth: counter.neither
});

const human = makeTierCounter();
const silver = makeTierCounter();
const conflictComposition = {};
const relationTotals = { goldTuples: 0, detectedRelations: 0, matchedGoldTuples: 0, matchedDetections: 0 };
const escalation = {
  escalatedPages: 0,
  escalatedBlockingPages: 0,
  escalatedBlockingWithConfirmedError: 0,
  // Pages whose only blocking reason is uncorroborated-ocr carry no conflict
  // a human could adjudicate; their confirmation signal is human gold the
  // engines missed, tracked separately from conflict-confirmed errors.
  escalatedUncorroboratedOnlyPages: 0,
  escalatedUncorroboratedOnlyWithHumanGoldMissedByBoth: 0,
  escalatedAdvisoryOnlyPages: 0,
  cleanPages: 0,
  cleanWithHumanGoldMissedByBoth: 0
};
const perPage = [];
const validatedInputs = [];

for (const page of verdicts.pages) {
  const key = `${page.objectId}#${page.pageNumber}`;
  const proposal = proposalByPage.get(key);
  const record = recordIndex.get(key);
  if (!proposal || !record) throw new Error(`Missing proposal or run record for ${key}`);
  // Fail closed on identity: gold must describe the same document bytes the
  // run parsed. objectId reuse across revisions must not silently score.
  const hashes = new Set([page.sha256, proposal.sha256, record.documentSha256].filter(Boolean));
  if (hashes.size !== 1) {
    throw new Error(`SHA-256 mismatch for ${key}: verdicts=${page.sha256} proposal=${proposal.sha256} run=${record.documentSha256}`);
  }
  validatedInputs.push({ objectId: page.objectId, pageNumber: page.pageNumber, sha256: record.documentSha256 });

  const nativePool = record.nativeObservations.flatMap((observation) => criticalTokens(observation.text));
  const ocrPool = record.ocrObservations.flatMap((observation) => criticalTokens(observation.text));

  const proposalTokens = proposal.proposal.criticalTokens ?? [];
  const tokenText = (token) => (token.verdict === 'edited' && token.text) ? token.text : proposalTokens[token.index]?.text;
  const humanTexts = [
    ...page.tokens.filter((token) => ['correct', 'edited'].includes(token.verdict)).map(tokenText),
    ...(page.missedTokens ?? [])
  ].filter(Boolean);
  const silverTexts = page.tokens.filter((token) => token.verdict === 'auto').map(tokenText).filter(Boolean);
  const unreviewed = page.tokens.filter((token) => !['correct', 'edited', 'auto', 'wrong'].includes(token.verdict));
  if (unreviewed.length) throw new Error(`${key} has ${unreviewed.length} unreviewed token verdicts; finish the review before evaluating.`);

  const pageHuman = makeTierCounter();
  const pageSilver = makeTierCounter();
  scoreTokens(humanTexts, nativePool, ocrPool, pageHuman);
  scoreTokens(silverTexts, nativePool, ocrPool, pageSilver);
  for (const [total, part] of [[human, pageHuman], [silver, pageSilver]]) {
    for (const field of Object.keys(total)) total[field] += part[field];
  }

  let confirmedError = false;
  for (const conflict of page.conflicts ?? []) {
    if (!conflict.verdict || conflict.verdict === 'unreviewed') {
      throw new Error(`${key} has an unreviewed conflict verdict; finish the review before evaluating.`);
    }
    const machine = (proposal.conflictAdjudications ?? []).find((item) => item.id === conflict.id);
    const verdict = conflict.verdict === 'confirm' ? machine?.proposal?.verdict ?? 'unsure' : conflict.verdict;
    conflictComposition[verdict] = (conflictComposition[verdict] ?? 0) + 1;
    if (['native', 'ocr', 'both-wrong'].includes(verdict)) confirmedError = true;
  }

  for (const chart of page.charts ?? []) {
    if (!chart.verdict || chart.verdict === 'unreviewed') {
      throw new Error(`${key} has an unreviewed chart verdict; finish the review before evaluating.`);
    }
  }
  const goldCharts = [
    ...(page.charts ?? [])
      .filter((chart) => chart.verdict === 'correct' || chart.verdict === 'edited')
      .map((chart) => {
        const machine = proposal.proposal.chartRelations?.[chart.index];
        return chart.verdict === 'edited' && chart.value ? { ...machine, value: chart.value } : machine;
      })
      .filter(Boolean),
    ...(page.missedCharts ?? [])
  ];
  const detected = record.derivedRelations ?? [];
  relationTotals.goldTuples += goldCharts.length;
  relationTotals.detectedRelations += detected.length;
  const tupleKey = (category, value) => criticalTokens(`${category ?? ''} ${value ?? ''}`);
  const tuplesCompatible = (a, b) =>
    a.length === b.length && a.every((token, index) => criticalTokensCompatible(token, b[index]));
  const availableDetections = detected.map((relation) => tupleKey(relation.attributes.category, relation.attributes.value));
  for (const tuple of goldCharts) {
    const wanted = tupleKey(tuple.category, tuple.value);
    const index = availableDetections.findIndex((candidate) => tuplesCompatible(candidate, wanted));
    if (index >= 0) {
      availableDetections.splice(index, 1);
      relationTotals.matchedGoldTuples += 1;
      relationTotals.matchedDetections += 1;
    }
  }

  const reasons = record.diagnostics.escalationReasons ?? [];
  const blockingTypes = reasons.filter((reason) => reason.severity === 'blocking').map((reason) => reason.type);
  const hasBlocking = blockingTypes.length > 0;
  const uncorroboratedOnly = hasBlocking && blockingTypes.every((type) => type === 'uncorroborated-ocr');
  if (record.diagnostics.requiresEscalation) {
    escalation.escalatedPages += 1;
    if (uncorroboratedOnly) {
      escalation.escalatedUncorroboratedOnlyPages += 1;
      if (pageHuman.neither > 0) escalation.escalatedUncorroboratedOnlyWithHumanGoldMissedByBoth += 1;
    } else if (hasBlocking) {
      escalation.escalatedBlockingPages += 1;
      if (confirmedError) escalation.escalatedBlockingWithConfirmedError += 1;
    } else {
      // Advisory-only escalations have no conflict record for a human to
      // adjudicate, so "confirmed error" is not measurable for them here.
      escalation.escalatedAdvisoryOnlyPages += 1;
    }
  } else {
    escalation.cleanPages += 1;
    if (pageHuman.neither > 0) escalation.cleanWithHumanGoldMissedByBoth += 1;
  }
  perPage.push({
    objectId: page.objectId,
    pageNumber: page.pageNumber,
    human: pageHuman,
    silver: pageSilver
  });
}

const metrics = {
  goldPilotMetricsVersion: 'gold-pilot-metrics-v2',
  createdAt: new Date().toISOString(),
  runRoot,
  goldVerifiedAt: verdicts.verifiedAt,
  pages: verdicts.pages.length,
  validatedInputs,
  criticalTokenRecall: {
    humanVerified: tierReport(human),
    silverNativeCorroborated: {
      ...tierReport(silver),
      note: 'Silver labels were auto-accepted because native text agreed; native/union rates on this tier are tautological by construction and must not be quoted as independent recall.'
    }
  },
  conflictComposition,
  chartRelations: {
    goldTuples: relationTotals.goldTuples,
    detectedRelations: relationTotals.detectedRelations,
    recall: rate(relationTotals.matchedGoldTuples, relationTotals.goldTuples),
    precision: rate(relationTotals.matchedDetections, relationTotals.detectedRelations)
  },
  escalation,
  perPage,
  caveats: [
    `Pilot-scale: ${verdicts.pages.length} pages, not the full corpus.`,
    'Recall is occurrence-consuming token containment under the same-ink canonicalization; box agreement is not yet scored.',
    'Human-tier gold: machine pre-labels verified by one annotator; no second annotator or adjudication yet. Silver tier is not independent of the native engine.',
    'Chart precision counts detections matched by any gold tuple; unmatched detections may be correct tuples the gold set does not cover.'
  ]
};

writeFileSync(outputPath, JSON.stringify(metrics, null, 1) + '\n');
console.log(JSON.stringify(metrics, null, 1));

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
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { criticalTokens, criticalTokensCompatible } from '../../dist/text.js';
import { consumeMatch } from './lib/recall-match.mjs';

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


function makeTierCounter() {
  return { gold: 0, native: 0, ocr: 0, union: 0, neither: 0, strictNative: 0, strictOcr: 0, strictUnion: 0, strictNeither: 0 };
}

/**
 * Two passes, strict before tolerant, so an exact match is never displaced by
 * a relaxed one: the tolerant pass only ever sees pool entries the strict pass
 * left behind. Both results are reported — the strict figures are what earlier
 * eras of this file measured, and keeping them visible is what makes the
 * correction auditable instead of a number that quietly improved.
 */
function scoreTokens(texts, nativePool, ocrPool, counter) {
  const tokens = texts.flatMap((text) => criticalTokens(text ?? ''));
  counter.gold += tokens.length;
  const found = tokens.map(() => ({ native: false, ocr: false }));

  tokens.forEach((token, index) => {
    found[index].native = consumeMatch(nativePool, token);
    found[index].ocr = consumeMatch(ocrPool, token);
    if (found[index].native) counter.strictNative += 1;
    if (found[index].ocr) counter.strictOcr += 1;
    if (found[index].native || found[index].ocr) counter.strictUnion += 1;
    else counter.strictNeither += 1;
  });

  tokens.forEach((token, index) => {
    if (!found[index].native) found[index].native = consumeMatch(nativePool, token, { tolerant: true });
    if (!found[index].ocr) found[index].ocr = consumeMatch(ocrPool, token, { tolerant: true });
    if (found[index].native) counter.native += 1;
    if (found[index].ocr) counter.ocr += 1;
    if (found[index].native || found[index].ocr) counter.union += 1;
    else counter.neither += 1;
  });
}
const rate = (numerator, denominator) => denominator ? Number((numerator / denominator).toFixed(4)) : null;
const tierReport = (counter) => ({
  goldTokens: counter.gold,
  native: rate(counter.native, counter.gold),
  ocr: rate(counter.ocr, counter.gold),
  union: rate(counter.union, counter.gold),
  missedByBoth: counter.neither,
  // What the strict comparison would have said. Kept so the currency-symbol
  // correction stays visible in every aggregate rather than being absorbed.
  strict: {
    native: rate(counter.strictNative, counter.gold),
    ocr: rate(counter.strictOcr, counter.gold),
    union: rate(counter.strictUnion, counter.gold),
    missedByBoth: counter.strictNeither
  }
});

const human = makeTierCounter();
const silver = makeTierCounter();
// Third tier: rows accepted with the review UI's page-level button. A person
// chose to accept them, but did not read them one by one, so they are neither
// independent human gold nor native-corroborated silver. Kept separate so a
// fast batch can never inflate the independent denominator.
const bulk = makeTierCounter();
let nonScoringProposals = 0;
const conflictComposition = {};
const relationTotals = { goldTuples: 0, detectedRelations: 0, matchedGoldTuples: 0, matchedDetections: 0 };
const escalation = {
  escalatedPages: 0,
  // Every page carrying any blocking-severity reason. Two disjoint subsets:
  // conflict-blocking pages (critical-token reasons; confirmed via human
  // conflict adjudication) and uncorroborated-only pages (no conflict a
  // human could adjudicate; their confirmation signal is human gold the
  // engines missed). escalatedBlockingPages = sum of the two subsets.
  escalatedBlockingPages: 0,
  escalatedConflictBlockingPages: 0,
  escalatedConflictBlockingWithConfirmedError: 0,
  escalatedUncorroboratedOnlyPages: 0,
  escalatedUncorroboratedOnlyWithHumanGoldMissedByBoth: 0,
  escalatedAdvisoryOnlyPages: 0,
  cleanPages: 0,
  cleanWithHumanGoldMissedByBoth: 0,
  // Verified negatives (gold-verdicts-v2): clean pages whose reviewer
  // RECORDED "searched, no missed figures found" and where no missed-by-both
  // gold exists. A clean page with neither a miss nor a no-miss verdict is
  // UNVERIFIED — absence of evidence, never a negative. A future rate's
  // denominator is cleanWithHumanGoldMissedByBoth + cleanVerifiedNoMiss;
  // this file reports the counts and deliberately no rate.
  cleanVerifiedNoMiss: 0,
  cleanUnverified: 0,
  // A no-miss verdict on a page where verified gold still shows a
  // missed-by-both token: the reviewer searched and found nothing, but the
  // engine comparison did. The computed miss supersedes the human negative —
  // counted here so the disagreement stays visible, never as a negative.
  noMissVerdictsSupersededByComputedMiss: 0,
  // A no-miss verdict on an ESCALATED page is an anomaly (the checkbox is
  // meant for clean pages) — counted, never silently dropped.
  noMissVerdictsOnEscalatedPages: 0
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
    ...(page.missedTokens ?? []),
    // Missed chart VALUES are human-verified figures on the page like any
    // other missed token: scoring them through the same pools means a chart
    // value neither engine read counts as a miss (and can supersede a no-miss
    // claim) instead of vanishing into relation accounting.
    ...(page.missedCharts ?? []).map((chart) => chart.value)
  ].filter(Boolean);
  const silverTexts = page.tokens.filter((token) => token.verdict === 'auto').map(tokenText).filter(Boolean);
  const bulkTexts = page.tokens.filter((token) => token.verdict === 'bulk').map(tokenText).filter(Boolean);
  // 'noise': a proposal that tokenizes to nothing, dropped by the review UI
  // before a human ever saw it. Present so verdict indices still line up with
  // proposals; scored in no tier, because it could never have been gold.
  nonScoringProposals += page.tokens.filter((token) => token.verdict === 'noise').length;
  const unreviewed = page.tokens.filter((token) => !['correct', 'edited', 'auto', 'wrong', 'bulk', 'noise'].includes(token.verdict));
  if (unreviewed.length) throw new Error(`${key} has ${unreviewed.length} unreviewed token verdicts; finish the review before evaluating.`);

  const pageHuman = makeTierCounter();
  const pageSilver = makeTierCounter();
  const pageBulk = makeTierCounter();
  scoreTokens(humanTexts, nativePool, ocrPool, pageHuman);
  scoreTokens(silverTexts, nativePool, ocrPool, pageSilver);
  scoreTokens(bulkTexts, nativePool, ocrPool, pageBulk);
  for (const [total, part] of [[human, pageHuman], [silver, pageSilver], [bulk, pageBulk]]) {
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

  // Fail closed on a direct contradiction regardless of escalation state:
  // the reviewer both claimed "no missed figures found" and entered missed
  // tokens or missed chart values by hand on the same page. One of the two
  // is wrong; re-review.
  const handEnteredMisses = (page.missedTokens ?? []).length + (page.missedCharts ?? []).length;
  if (page.noMissFound === true && handEnteredMisses > 0) {
    throw new Error(`${key} claims noMissFound but lists ${handEnteredMisses} missed tokens/charts; resolve the contradiction before evaluating.`);
  }

  const reasons = record.diagnostics.escalationReasons ?? [];
  const blockingTypes = reasons.filter((reason) => reason.severity === 'blocking').map((reason) => reason.type);
  const hasBlocking = blockingTypes.length > 0;
  const uncorroboratedOnly = hasBlocking && blockingTypes.every((type) => type === 'uncorroborated-ocr');
  if (record.diagnostics.requiresEscalation) {
    escalation.escalatedPages += 1;
    if (page.noMissFound === true) escalation.noMissVerdictsOnEscalatedPages += 1;
    if (hasBlocking) escalation.escalatedBlockingPages += 1;
    if (uncorroboratedOnly) {
      escalation.escalatedUncorroboratedOnlyPages += 1;
      if (pageHuman.neither > 0) escalation.escalatedUncorroboratedOnlyWithHumanGoldMissedByBoth += 1;
    } else if (hasBlocking) {
      escalation.escalatedConflictBlockingPages += 1;
      if (confirmedError) escalation.escalatedConflictBlockingWithConfirmedError += 1;
    } else {
      // Advisory-only escalations have no conflict record for a human to
      // adjudicate, so "confirmed error" is not measurable for them here.
      escalation.escalatedAdvisoryOnlyPages += 1;
    }
  } else {
    escalation.cleanPages += 1;
    if (pageHuman.neither > 0) {
      escalation.cleanWithHumanGoldMissedByBoth += 1;
      if (page.noMissFound === true) escalation.noMissVerdictsSupersededByComputedMiss += 1;
    } else if (page.noMissFound === true) {
      escalation.cleanVerifiedNoMiss += 1;
    } else {
      escalation.cleanUnverified += 1;
    }
  }
  perPage.push({
    objectId: page.objectId,
    pageNumber: page.pageNumber,
    human: pageHuman,
    silver: pageSilver,
    bulk: pageBulk,
    ...(page.noMissFound === true ? { noMissFound: true } : {})
  });
}

// Reconciliation invariants: the escalation taxonomy must partition pages.
if (escalation.escalatedConflictBlockingPages + escalation.escalatedUncorroboratedOnlyPages !== escalation.escalatedBlockingPages) {
  throw new Error('Blocking subsets do not sum to escalatedBlockingPages.');
}
if (escalation.escalatedBlockingPages + escalation.escalatedAdvisoryOnlyPages !== escalation.escalatedPages) {
  throw new Error('Blocking and advisory-only pages do not sum to escalatedPages.');
}
if (escalation.escalatedPages + escalation.cleanPages !== verdicts.pages.length) {
  throw new Error('Escalated and clean pages do not sum to the evaluated page count.');
}
if (escalation.cleanWithHumanGoldMissedByBoth + escalation.cleanVerifiedNoMiss + escalation.cleanUnverified !== escalation.cleanPages) {
  throw new Error('Clean-page miss/verified-negative/unverified buckets do not sum to cleanPages.');
}

// Selection provenance, when the batch dir carries the sampler's
// selection.json: which profile/seed drew these pages and — for the clean
// profile — the population partition. Embedded here so the stratum a clean
// page belongs to is visible in the file where its numbers are written; a
// clean-page miss rate is only honest over the UNION of strata across
// batches (residual + each prior batch's clean pages), never one aggregate's
// clean pages alone.
const selectionPath = join(goldDir, 'selection.json');
const selection = existsSync(selectionPath)
  ? (({ profile, seed, population, populationPartition, skippedMissingRunRecords }) => ({
      profile,
      ...(seed ? { seed } : {}),
      ...(population ? { population } : {}),
      ...(populationPartition ? {
        populationPartition: {
          residualUnlabeledClean: populationPartition.residualUnlabeledClean.length,
          previouslyLabeledClean: populationPartition.previouslyLabeledClean.length,
          previouslyLabeledCleanByBatch: populationPartition.previouslyLabeledClean.reduce(
            (acc, entry) => ({ ...acc, [entry.batch]: (acc[entry.batch] ?? 0) + 1 }), {}),
          note: populationPartition.note
        }
      } : {}),
      ...(skippedMissingRunRecords?.count ? { skippedMissingRunRecords: skippedMissingRunRecords.count } : {})
    }))(JSON.parse(readFileSync(selectionPath, 'utf8')))
  : undefined;

const metrics = {
  // v5 adds verified-negative accounting (cleanVerifiedNoMiss /
  // cleanUnverified / noMissVerdictsSupersededByComputedMiss /
  // noMissVerdictsOnEscalatedPages) from gold-verdicts-v2's page-level
  // no-miss verdict, scores missed chart VALUES through the same token pools
  // as missed tokens (a chart figure neither engine read now counts as a
  // miss), and embeds sampler selection provenance where present. Earlier
  // aggregates predate the verdict: their clean pages are all "unverified",
  // not negatives, and their missed chart values were relation-only.
  // v4 added the bulk tier. v3 aggregates stay readable as their own era —
  // they predate page-level accept, so their human tier means what it says.
  goldPilotMetricsVersion: 'gold-pilot-metrics-v5',
  createdAt: new Date().toISOString(),
  runRoot,
  goldVerifiedAt: verdicts.verifiedAt,
  pages: verdicts.pages.length,
  ...(selection ? { selection } : {}),
  validatedInputs,
  criticalTokenRecall: {
    humanVerified: tierReport(human),
    silverNativeCorroborated: {
      ...tierReport(silver),
      note: 'Silver labels were auto-accepted because native text agreed; native/union rates on this tier are tautological by construction and must not be quoted as independent recall.'
    },
    bulkPageAccepted: {
      ...tierReport(bulk),
      note: 'Accepted with the review UI page-level button: a person accepted these without reading them individually. Not independent gold — report separately and never fold into the human tier.'
    }
  },
  nonScoringProposals,
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
    `Bulk tier: ${bulk.gold} tokens were page-accepted without individual reading and are excluded from the human tier.`,
    'Chart precision counts detections matched by any gold tuple; unmatched detections may be correct tuples the gold set does not cover.',
    'Verified negatives require an explicit no-miss verdict (gold-verdicts-v2); clean pages without one are counted cleanUnverified and may not enter any miss-rate denominator. No rate is computed here.',
    'Clean-page outcomes in this file are ONE STRATUM (this batch). The residual clean pool is conditioned on prior extractor-driven sampling, so any future miss rate must union clean-page outcomes across all batches (see selection.populationPartition), never quote one aggregate alone.',
    'Union preconditions — prior strata are NOT admissible as they stand: (a) their clean pages predate the no-miss verdict (all cleanUnverified — misses without verified negatives = numerator selection bias), so they must first pass a no-miss re-review; (b) their outcomes were evaluated against older run roots and must be re-evaluated against the union run root before entering. Until both hold, no rate exists.'
  ]
};

writeFileSync(outputPath, JSON.stringify(metrics, null, 1) + '\n');
console.log(JSON.stringify(metrics, null, 1));

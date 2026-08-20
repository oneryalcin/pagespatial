/**
 * Re-scores evaluation-debts.md row 1: cross-family TOKEN-path agreement
 * precision, and the agree-on-wrong rate that bounds it.
 *
 * The question. When PP-OCR and the second-opinion engine independently read
 * the same token, how often are they both right? Agreement between two
 * engines is only worth something if shared agreement implies correctness;
 * every agree-on-wrong is a misreading that no amount of corroboration will
 * catch, and the whole starved-scan tier rests on that rate being small.
 *
 * Matching rules are the library's, not this script's (hygiene rule in
 * evaluation-debts.md): buildCorroborationPool / poolCorroborates for
 * consume-once tail-compatible matching, criticalTokens for tokenization.
 * The observation filter mirrors crossEngineEngagedIds — same confidence
 * floor, same exclusion of second-pass recoveries — because this script
 * additionally needs to know WHICH path engaged each observation, which that
 * function does not report.
 *
 * On incomplete gold, and why this reports bounds instead of a number.
 * Gold is the pre-labeler's proposals after human verification, and the
 * pre-labeler proposes a subset of a page's ink. So an agreed token missing
 * from gold is ambiguous: it may be a shared misreading (agree-on-wrong), or
 * a correct reading nobody labelled. Collapsing that ambiguity into a single
 * precision figure would manufacture confidence the evidence does not
 * support, so both bounds are reported. Quote the lower bound as the
 * guarantee and the gap as the work remaining.
 *
 * Usage:
 *   node scripts/evaluation/rescore-cross-family.mjs \
 *     --run-root .evaluation/runs/<run-id> \
 *     [--gold-root .evaluation/gold] [--output <path>]
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { criticalTokens } from '../../dist/text.js';
import { buildCorroborationPool, poolCorroborates } from '../../dist/corroborate.js';

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required argument ${name}`);
}

const runRoot = arg('--run-root');
const goldRoot = arg('--gold-root', '.evaluation/gold');
const outputPath = arg('--output', '');

const slug = (objectId) => objectId.replace(/[^a-zA-Z0-9._-]+/g, '_');
const pageKey = (objectId, pageNumber) => `${objectId}#${pageNumber}`;

// Verified gold per page, human tier only. Silver is the native engine's own
// opinion and bulk was never read, so neither can adjudicate a second engine.
const goldByPage = new Map();
for (const entry of readdirSync(goldRoot)) {
  const dir = join(goldRoot, entry);
  const verdictsPath = join(dir, 'gold-verdicts.json');
  const proposalsPath = join(dir, 'proposals.json');
  if (!existsSync(verdictsPath) || !existsSync(proposalsPath)) continue;
  const verdicts = JSON.parse(readFileSync(verdictsPath, 'utf8'));
  const proposals = JSON.parse(readFileSync(proposalsPath, 'utf8'));
  const proposalByPage = new Map(proposals.map((page) => [pageKey(page.objectId, page.pageNumber), page]));
  for (const page of verdicts.pages) {
    const key = pageKey(page.objectId, page.pageNumber);
    const proposalTokens = proposalByPage.get(key)?.proposal.criticalTokens ?? [];
    const texts = [
      ...page.tokens
        .filter((token) => ['correct', 'edited'].includes(token.verdict))
        .map((token) => (token.verdict === 'edited' && token.text) ? token.text : proposalTokens[token.index]?.text),
      ...(page.missedTokens ?? [])
    ].filter(Boolean);
    if (!texts.length) continue;
    const existing = goldByPage.get(key) ?? { batch: entry, texts: [] };
    existing.texts.push(...texts);
    goldByPage.set(key, existing);
  }
}

const totals = { pages: 0, agreedObservations: 0, agreedTokens: 0, confirmed: 0, unadjudicated: 0, containmentObservations: 0 };
const perPage = [];

for (const [key, gold] of goldByPage) {
  const [objectId, pageNumber] = [key.slice(0, key.lastIndexOf('#')), Number(key.slice(key.lastIndexOf('#') + 1))];
  const recordPath = join(runRoot, 'documents', slug(objectId), 'pages', `${String(pageNumber).padStart(6, '0')}.json`);
  if (!existsSync(recordPath)) continue;
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  const page = record.pageSpatial;
  const readings = page?.secondOpinion?.readings ?? [];
  if (!readings.length) continue;

  // Row 1's population is the coverage-starved scan page: read entirely by
  // OCR, which is exactly where cross-family agreement is load-bearing.
  const diagnostics = page.diagnostics ?? {};
  const starved = diagnostics.nativeObservationCount === 0
    || (diagnostics.nativeOcrAssociationCoverage ?? 1) < 0.2;
  if (!starved) continue;

  const floor = diagnostics.thresholds?.lowOcrConfidence ?? 0.5;
  const secondPool = buildCorroborationPool(readings
    .filter((reading) => reading.confidence === undefined || reading.confidence >= floor)
    .map((reading) => reading.text));

  // One gold pool per page, consumed once across all agreed tokens: two
  // engines agreeing twice on "1,234" need two verified occurrences, not one
  // reused. Same rule the evaluator scores recall under.
  const goldPool = buildCorroborationPool(gold.texts);

  const pageStats = { objectId, pageNumber, batch: gold.batch, agreedObservations: 0, agreedTokens: 0, confirmed: 0, unadjudicated: 0, containmentObservations: 0 };
  for (const observation of page.ocrObservations ?? []) {
    if (observation.recoveryMethod) continue;
    const tokens = criticalTokens(observation.text ?? '');
    // poolCorroborates mutates on success — that IS the consume-once rule.
    if (!poolCorroborates(observation.text ?? '', secondPool)) continue;
    if (!tokens.length) { pageStats.containmentObservations += 1; continue; } // row 1b's path, counted not scored
    pageStats.agreedObservations += 1;
    for (const token of tokens) {
      pageStats.agreedTokens += 1;
      if (poolCorroborates(token, goldPool)) pageStats.confirmed += 1;
      else pageStats.unadjudicated += 1;
    }
  }
  if (!pageStats.agreedTokens && !pageStats.containmentObservations) continue;
  perPage.push(pageStats);
  totals.pages += 1;
  for (const field of ['agreedObservations', 'agreedTokens', 'confirmed', 'unadjudicated', 'containmentObservations']) {
    totals[field] += pageStats[field];
  }
}

const rate = (numerator, denominator) => denominator ? Number((numerator / denominator).toFixed(4)) : null;
const report = {
  crossFamilyRescoreVersion: 'cross-family-rescore-v1',
  createdAt: new Date().toISOString(),
  runRoot,
  population: 'gold ∩ native-starved scan pages',
  totals,
  tokenPathPrecision: {
    lowerBound: rate(totals.confirmed, totals.agreedTokens),
    upperBound: rate(totals.confirmed + totals.unadjudicated, totals.agreedTokens),
    note: 'Lower bound treats every agreed token absent from gold as a shared misreading; upper bound treats every one as correct-but-unlabelled. The truth is between. Narrow the gap by labelling more tokens on these pages, not by picking a bound.'
  },
  perPage,
  caveats: [
    `Gold is the pre-labeler's proposal set after human verification, so ${totals.unadjudicated} agreed tokens have no verdict either way.`,
    'Containment-path engagements are counted, never scored: that is row 1b, and verifying it needs prose labels this instrument does not collect.'
  ]
};

if (outputPath) writeFileSync(outputPath, `${JSON.stringify(report, null, 1)}\n`);
console.log(JSON.stringify(report, null, 1));

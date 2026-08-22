/**
 * HPI benchmark, step 3 (issue #2 speed-arm 2): score a candidate witness's
 * observations (JSON dumped by hpi_bench_modal.py) against the browser
 * reference and gold — the same consume-once library mechanics as
 * witness-equivalence.mjs, so candidate numbers are comparable with the
 * committed server-witness figures.
 *
 * Scoring is TEXT-ONLY (token agreement + gold recall); candidate boxes are
 * carried in the results JSON but not scored here — geometry/box-IoU
 * verification is a named item for the full adoption ceremony.
 *
 * Usage:
 *   node scripts/evaluation/score-candidate-witness.mjs \
 *     --results .evaluation/hpi-bench/results-<config>.json \
 *     --manifest .evaluation/hpi-bench/manifest.json \
 *     --run-root .evaluation/runs/<run-id> \
 *     --gold-root .evaluation/gold
 * Output (stdout JSON) is text-free: counts, rates, timings only.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { criticalTokens } from '../../dist/text.js';
import { buildCorroborationPool, poolCorroborates } from '../../dist/corroborate.js';

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  throw new Error(`Missing required argument ${name}`);
}

const results = JSON.parse(readFileSync(arg('--results'), 'utf8'));
const manifest = JSON.parse(readFileSync(arg('--manifest'), 'utf8'));
const runRoot = arg('--run-root');
const goldRoot = arg('--gold-root');

const manifestByPage = new Map(manifest.map((entry) => [entry.page, entry]));

const gold = new Map();
for (const source of readdirSync(goldRoot)) {
  let verdicts;
  try { verdicts = JSON.parse(readFileSync(join(goldRoot, source, 'gold-verdicts.json'), 'utf8')); } catch { continue; }
  for (const page of verdicts.pages) {
    const tokens = page.tokens
      .filter((token) => token.verdict === 'correct' || token.verdict === 'edited')
      .map((token) => token.text)
      .filter(Boolean);
    const key = `${page.objectId}#${page.pageNumber}`;
    if (!gold.has(key)) gold.set(key, { tokens, sha256: page.sha256 });
  }
}

const recordIndex = new Map();
for (const doc of readdirSync(join(runRoot, 'documents'))) {
  let files;
  try { files = readdirSync(join(runRoot, 'documents', doc, 'pages')); } catch { continue; }
  for (const file of files) {
    const record = JSON.parse(readFileSync(join(runRoot, 'documents', doc, 'pages', file), 'utf8'));
    if (!record.pageSpatial) continue;
    recordIndex.set(`${record.objectId}#${record.pageNumber}`, record);
  }
}

function tokenOverlap(fromTexts, intoTexts) {
  const tokens = fromTexts.flatMap((text) => criticalTokens(text));
  if (!tokens.length) return { tokens: 0, matched: 0 };
  const pool = buildCorroborationPool(intoTexts);
  let matched = 0;
  for (const token of tokens) if (poolCorroborates(token, pool)) matched += 1;
  return { tokens: tokens.length, matched };
}

const sum = (values) => values.reduce((a, b) => a + b, 0);
const perPage = [];
for (const entry of results.perPage) {
  const record = recordIndex.get(entry.page);
  const meta = manifestByPage.get(entry.page);
  if (!record || !meta) throw new Error(`No run record or manifest entry for ${entry.page}`);
  const page = record.pageSpatial;
  const goldEntry = gold.get(entry.page);
  if (goldEntry && goldEntry.sha256 !== page.documentSha256) {
    throw new Error(`SHA-256 mismatch for ${entry.page}`);
  }
  // First-pass vs first-pass, same rule as the equivalence run.
  const firstPass = page.ocrObservations.filter((observation) => !observation.recoveryMethod);
  const browserTexts = firstPass.map((observation) => observation.text);
  const candidateTexts = entry.lines.map((line) => line.text);

  const browserIntoCandidate = tokenOverlap(browserTexts, candidateTexts);
  const candidateIntoBrowser = tokenOverlap(candidateTexts, browserTexts);

  let goldRecall = null;
  if (goldEntry?.tokens.length) {
    const browserPool = buildCorroborationPool(browserTexts);
    const candidatePool = buildCorroborationPool(candidateTexts);
    let bothHit = 0, candidateOnly = 0, browserOnly = 0, bothMiss = 0;
    for (const token of goldEntry.tokens) {
      const inBrowser = poolCorroborates(token, browserPool);
      const inCandidate = poolCorroborates(token, candidatePool);
      if (inBrowser && inCandidate) bothHit += 1;
      else if (inCandidate) candidateOnly += 1;
      else if (inBrowser) browserOnly += 1;
      else bothMiss += 1;
    }
    goldRecall = {
      goldTokens: goldEntry.tokens.length,
      browser: bothHit + browserOnly,
      candidate: bothHit + candidateOnly,
      bothHit, candidateOnly, browserOnly, bothMiss
    };
  }
  perPage.push({
    page: entry.page,
    ms: entry.ms,
    browserObservations: firstPass.length,
    candidateLines: entry.lines.length,
    browserTokensMatchedByCandidate: browserIntoCandidate,
    candidateTokensMatchedByBrowser: candidateIntoBrowser,
    goldRecall
  });
}

const goldPages = perPage.filter((p) => p.goldRecall);
const bIntoC = perPage.map((p) => p.browserTokensMatchedByCandidate);
const cIntoB = perPage.map((p) => p.candidateTokensMatchedByBrowser);
const timings = perPage.map((p) => p.ms).sort((a, b) => a - b);
console.log(JSON.stringify({
  method: 'candidate-witness-score-v1',
  config: results.config,
  versions: results.versions,
  resources: results.resources,
  pages: perPage.length,
  timings: {
    initS: results.initS,
    firstPageMs: results.firstPageMs,
    warmMsP50: Math.round(timings[Math.floor(timings.length / 2)]),
    warmMsP95: Math.round(timings[Math.floor(timings.length * 0.95)]),
    warmMsMean: Math.round(sum(timings) / timings.length)
  },
  criticalTokenAgreement: {
    browserTokensMatchedByCandidate: `${sum(bIntoC.map((x) => x.matched))}/${sum(bIntoC.map((x) => x.tokens))}`,
    candidateTokensMatchedByBrowser: `${sum(cIntoB.map((x) => x.matched))}/${sum(cIntoB.map((x) => x.tokens))}`
  },
  goldRecall: {
    pages: goldPages.length,
    goldTokens: sum(goldPages.map((p) => p.goldRecall.goldTokens)),
    browser: sum(goldPages.map((p) => p.goldRecall.browser)),
    candidate: sum(goldPages.map((p) => p.goldRecall.candidate)),
    candidateOnly: sum(goldPages.map((p) => p.goldRecall.candidateOnly)),
    browserOnly: sum(goldPages.map((p) => p.goldRecall.browserOnly)),
    bothMiss: sum(goldPages.map((p) => p.goldRecall.bothMiss))
  },
  perPage
}, null, 1));

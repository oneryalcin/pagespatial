/**
 * Scores a silver spot-check export (issue #8 / ledger row 7): the error
 * rate of the tier no human ever reads, with the sample size stated.
 *
 * Reads the gold-spotcheck JSON the review page exports and reports, per
 * batch and overall: sampled, disagreements, and the rate — plus the silver
 * population the sample was drawn from, so the number is always quoted with
 * its denominator. Unreviewed rows are reported and NEVER counted as agree:
 * silence is not a confirmed negative.
 *
 * Usage:
 *   node scripts/evaluation/score-silver-spotcheck.mjs --export <gold-spotcheck.json>
 */
import { readFileSync } from 'node:fs';

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  throw new Error(`Missing required argument ${name}`);
}

const data = JSON.parse(readFileSync(arg('--export'), 'utf8'));
if (data.tier !== 'silver') {
  throw new Error(`Export tier is ${data.tier ?? 'absent (pre-v3 export?)'}; this scorer only reads silver spot-checks.`);
}

const byBatch = new Map();
for (const row of data.rows) {
  const key = row.batch ?? 'unknown';
  if (!byBatch.has(key)) byBatch.set(key, { sampled: 0, disagree: 0, unreviewed: 0 });
  const entry = byBatch.get(key);
  entry.sampled += 1;
  if (row.spotcheck === 'disagree') entry.disagree += 1;
  if (row.spotcheck === 'unreviewed') entry.unreviewed += 1;
}
const reviewed = data.rows.filter((row) => row.spotcheck !== 'unreviewed').length;
const disagree = data.rows.filter((row) => row.spotcheck === 'disagree').length;
const rate = (part, whole) => whole ? `${(100 * part / whole).toFixed(1)}%` : 'n/a';

// Exact one-sided 95% Clopper-Pearson upper bound: the largest error rate
// consistent with seeing x disagreements in n reviews. At n=30 a clean
// 0/30 still admits ~9.5% — the bound is what the ledger may quote, the
// point rate alone over-claims at this sample size.
function binomialCdf(x, n, p) {
  let term = (1 - p) ** n;
  let sum = term;
  for (let k = 1; k <= x; k += 1) {
    term *= ((n - k + 1) / k) * (p / (1 - p));
    sum += term;
  }
  return sum;
}
function upperBound95(x, n) {
  if (!n) return null;
  if (x >= n) return 1;
  let lo = x / n;
  let hi = 1;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (binomialCdf(x, n, mid) > 0.05) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
const bound = upperBound95(disagree, reviewed);

console.log(JSON.stringify({
  scorerVersion: 'silver-spotcheck-v1',
  seed: data.seed,
  silverPopulation: data.population,
  sampled: data.rows.length,
  reviewed,
  unreviewed: data.rows.length - reviewed,
  disagreements: disagree,
  errorRate: `${rate(disagree, reviewed)} of ${reviewed} reviewed (population ${data.population}); 95% upper bound ${bound === null ? 'n/a' : `${(100 * bound).toFixed(1)}%`} — quote the bound, not the point rate`,
  errorRateUpperBound95: bound,
  perBatch: Object.fromEntries([...byBatch].map(([key, entry]) => [key, {
    ...entry, rate: rate(entry.disagree, entry.sampled - entry.unreviewed)
  }])),
  disagreementRows: data.rows.filter((row) => row.spotcheck === 'disagree')
    .map((row) => ({ page: `${row.objectId}#${row.pageNumber}`, index: row.index, batch: row.batch ?? null }))
}, null, 1));

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

console.log(JSON.stringify({
  scorerVersion: 'silver-spotcheck-v1',
  seed: data.seed,
  silverPopulation: data.population,
  sampled: data.rows.length,
  reviewed,
  unreviewed: data.rows.length - reviewed,
  disagreements: disagree,
  errorRate: `${rate(disagree, reviewed)} of ${reviewed} reviewed (population ${data.population})`,
  perBatch: Object.fromEntries([...byBatch].map(([key, entry]) => [key, {
    ...entry, rate: rate(entry.disagree, entry.sampled - entry.unreviewed)
  }])),
  disagreementRows: data.rows.filter((row) => row.spotcheck === 'disagree')
    .map((row) => ({ page: `${row.objectId}#${row.pageNumber}`, index: row.index, batch: row.batch ?? null }))
}, null, 1));

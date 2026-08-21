/**
 * Scores a blind adjudication audit (issue #31) against the machine verdicts
 * it was deliberately not shown.
 *
 * Ledger row 4 reads 272/272 adjudications confirmed, zero wrong-side — the
 * most-cited number in the ledger, produced entirely inside the review flow
 * that also recorded it. This rejoins the auditor's independent verdicts to
 * the machine's and reports where they part.
 *
 * Two classes, reported separately, because one count has been hiding two
 * jobs. When both readings carry the same digits the disagreement is a
 * currency symbol landing on one side or the other and either verdict
 * preserves the number; when the digits differ, a wrong verdict puts a wrong
 * figure in the index. Only the second class can cost anything, so a single
 * blended accuracy figure would flatter the adjudicator in exact proportion
 * to how many easy conflicts the corpus happens to contain.
 *
 * `unsure` is counted, never silently dropped: a conflict a careful human
 * could not call from the page is evidence about the task, not a missing
 * data point.
 *
 * Usage:
 *   node scripts/evaluation/score-adjudication-audit.mjs \
 *     --audit /path/to/gold-spotcheck.json \
 *     [--gold-root .evaluation/gold] [--output <path>]
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required argument ${name}`);
}

const auditPath = arg('--audit');
const goldRoot = arg('--gold-root', '.evaluation/gold');
const outputPath = arg('--output', '');

const audit = JSON.parse(readFileSync(auditPath, 'utf8'));
const rows = audit.adjudications ?? [];
if (!rows.length) throw new Error('Audit file carries no adjudications.');

// Machine verdicts come from the proposals, which the audit page never
// embedded. Rejoining here is what keeps the audit blind.
const machineByKey = new Map();
for (const entry of readdirSync(goldRoot)) {
  const path = join(goldRoot, entry, 'proposals.json');
  if (!existsSync(path)) continue;
  for (const page of JSON.parse(readFileSync(path, 'utf8'))) {
    (page.conflictAdjudications ?? []).forEach((conflict, conflictIndex) => {
      machineByKey.set(`${page.objectId}#${page.pageNumber}#${conflictIndex}`, conflict.proposal ?? null);
    });
  }
}

const tally = () => ({ compared: 0, agree: 0, disagree: 0, unsure: 0, unreviewed: 0, disagreements: [] });
const overall = tally();
const byClass = { digitsDiffer: tally(), symbolOnly: tally() };
let missingMachineVerdict = 0;

for (const row of rows) {
  const machine = machineByKey.get(`${row.objectId}#${row.pageNumber}#${row.conflictIndex}`);
  if (!machine) { missingMachineVerdict += 1; continue; }
  const bucket = row.digitsDiffer ? byClass.digitsDiffer : byClass.symbolOnly;
  for (const target of [overall, bucket]) {
    if (row.independentVerdict === 'unreviewed') { target.unreviewed += 1; continue; }
    if (row.independentVerdict === 'unsure') { target.unsure += 1; continue; }
    target.compared += 1;
    if (row.independentVerdict === machine.verdict) target.agree += 1;
    else {
      target.disagree += 1;
      target.disagreements.push({
        objectId: row.objectId,
        pageNumber: row.pageNumber,
        conflictIndex: row.conflictIndex,
        machine: machine.verdict,
        independent: row.independentVerdict,
        machineInk: machine.inkText ?? null,
        auditorInk: row.inkText ?? null
      });
    }
  }
}

const rate = (n, d) => (d ? Number((n / d).toFixed(4)) : null);
const report = {
  adjudicationAuditVersion: 'adjudication-audit-v1',
  createdAt: new Date().toISOString(),
  auditFile: auditPath,
  seed: audit.seed,
  adjudicationPopulation: audit.adjudicationPopulation ?? null,
  sampled: rows.length,
  missingMachineVerdict,
  overall: { ...overall, agreementRate: rate(overall.agree, overall.compared) },
  byClass: {
    digitsDiffer: { ...byClass.digitsDiffer, agreementRate: rate(byClass.digitsDiffer.agree, byClass.digitsDiffer.compared) },
    symbolOnly: { ...byClass.symbolOnly, agreementRate: rate(byClass.symbolOnly.agree, byClass.symbolOnly.compared) }
  },
  caveats: [
    'Agreement between an independent human and the machine, not proof of correctness: both can be wrong together on degraded ink.',
    'The digitsDiffer class is the one that can put a wrong figure in the index; quote it separately from the blended rate.',
    'Sampling is stratified half and half, so the blended rate is NOT an estimate of population accuracy — the classes are not equally common.'
  ]
};

if (outputPath) writeFileSync(outputPath, `${JSON.stringify(report, null, 1)}\n`);
console.log(JSON.stringify(report, null, 1));

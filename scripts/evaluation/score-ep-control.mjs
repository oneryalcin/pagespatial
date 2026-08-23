/**
 * Same-host EP control scorer (M1 criterion 2, the era rule's condition).
 *
 * Input: the ep-control JSON from m1_linux_verification_modal.py — three
 * runs over one fixed page set in ONE container: hpi_a, hpi_b (same
 * config; their disagreement IS the null tolerance for this page set) and
 * default (paddle-default; its disagreement with hpi_a is the cross-EP
 * delta, judged against that derived tolerance — never against the ±4
 * cross-container window, which measured a different population).
 *
 * Tokens are the library's own criticalTokens (dist/text.js) — the
 * numeric currency every conflict decision runs on — compared as per-page
 * multisets; the symmetric difference counts tokens present in one run's
 * page and absent from the other's. Output is count-level only.
 *
 * Usage:
 *   node scripts/evaluation/score-ep-control.mjs --results .evaluation/m1-linux/ep-control.json
 */
import { readFileSync } from 'node:fs';
import { criticalTokens } from '../../dist/text.js';

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  throw new Error(`Missing required argument ${name}`);
}

const payload = JSON.parse(readFileSync(arg('--results'), 'utf8'));
const runs = payload.runs;

function pageTokens(run) {
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
}

function diff(leftRun, rightRun) {
  const left = pageTokens(leftRun);
  const right = pageTokens(rightRun);
  let leftOnly = 0;
  let rightOnly = 0;
  let total = 0;
  const perPage = [];
  for (const [page, leftCounts] of left) {
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
    if (pageLeftOnly + pageRightOnly > 0) perPage.push({ page, leftOnly: pageLeftOnly, rightOnly: pageRightOnly });
  }
  return { leftTokens: total, leftOnly, rightOnly, symmetricDifference: leftOnly + rightOnly, pagesDiffering: perPage.length, perPage };
}

const nullControl = diff(runs.hpi_a, runs.hpi_b);
const crossEp = diff(runs.hpi_a, runs.default);
const crossEpB = diff(runs.hpi_b, runs.default);

const summary = {
  pages: runs.hpi_a.perPage.length,
  meta: Object.fromEntries(Object.entries(runs).map(([name, run]) => [name, {
    useHpip: run.meta.useHpip,
    hpiRequested: run.meta.hpiRequested,
    versions: run.meta.versions,
    threads: run.meta.threads,
    initS: run.initS
  }])),
  warmMsP50: Object.fromEntries(Object.entries(runs).map(([name, run]) => {
    const sorted = run.perPage.map((page) => page.ms).sort((a, b) => a - b);
    return [name, sorted[Math.floor(sorted.length / 2)]];
  })),
  nullControl_hpiA_vs_hpiB: nullControl,
  crossEp_hpiA_vs_default: crossEp,
  crossEp_hpiB_vs_default: crossEpB,
  verdict: {
    derivedNullTolerance: nullControl.symmetricDifference,
    crossEpDelta: crossEp.symmetricDifference,
    exceedsTolerance: crossEp.symmetricDifference > nullControl.symmetricDifference
  }
};

console.log(JSON.stringify(summary, null, 1));

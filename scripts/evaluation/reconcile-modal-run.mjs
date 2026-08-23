/**
 * Reconcile a Modal qualification run against the fixed manifest (design
 * doc §12: metrics must reconcile to a manifest of submitted request IDs —
 * dashboard counts without reconciliation are not acceptance evidence).
 *
 * Inputs:
 *  - captured results: a JSON array, or a JSONL file, or a directory of
 *    .json files — each entry is either a raw adapter result object or a
 *    wrapper {"request_id", "kind": "result"|"exception", "result"?,
 *    "error"?, "spawned_at_ms"?, "result_at_ms"?}; the two optional epoch-ms
 *    wall clocks (recorded by the M3 harness at spawn() and at
 *    result/exception receipt) enable the completion-percentile and
 *    aggregate pages/s rows;
 *  - container logs: a directory of per-container log files (or single
 *    files); structured adapter events are extracted from JSON log lines
 *    and tagged with their source file name as the container id.
 *
 * Cold readiness is derived from `service_started` LOG events, never from
 * results: after a rejected first call the next result reports
 * service_ready_ms=0 (§12; PR #89 closure).
 *
 * Usage:
 *   node scripts/evaluation/reconcile-modal-run.mjs \
 *     --results <file-or-dir> [--logs <file-or-dir>] \
 *     [--manifest evaluation/modal-qualification/manifest.v1.json] \
 *     [--set correctness|scaling|all] [--out aggregation.json]
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLogText, reconcileRun, renderAggregationTable } from './lib/modal-qualification.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function flag(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  return process.argv[index + 1];
}

const manifestPath = flag('--manifest', join(root, 'evaluation', 'modal-qualification', 'manifest.v1.json'));
const resultsPath = flag('--results');
if (!resultsPath) throw new Error('--results is required (file, JSONL, or directory of captured results).');
const logsPath = flag('--logs');
const set = flag('--set', 'all');
const outPath = flag('--out');

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

function loadLogEvents(path) {
  if (!path) return [];
  const events = [];
  for (const file of listFiles(path)) {
    events.push(...parseLogText(readFileSync(file, 'utf8'), basename(file)));
  }
  return events;
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const expected = set === 'correctness' ? manifest.correctness
  : set === 'scaling' ? manifest.scaling
    : [...manifest.correctness, ...manifest.scaling];

const aggregation = reconcileRun({
  expected,
  captures: loadCaptures(resultsPath),
  logEvents: loadLogEvents(logsPath),
});

console.log(renderAggregationTable(aggregation));
if (outPath) {
  writeFileSync(outPath, `${JSON.stringify(aggregation, null, 1)}\n`);
  console.log('\nwrote', outPath);
}
const clean = aggregation.documents.missing.length === 0
  && aggregation.documents.duplicates.length === 0
  && aggregation.documents.unexpected.length === 0
  && aggregation.pages.count_mismatches.length === 0
  && aggregation.pages.sha_mismatches.length === 0;
process.exitCode = clean ? 0 : 1;

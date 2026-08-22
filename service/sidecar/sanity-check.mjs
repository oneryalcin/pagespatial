/**
 * Integrated-path witness sanity check (adoption precondition, not the
 * full ceremony): drive the REAL sidecar through the service adapter over
 * N ceremony pages and assert gold-token parity with the ceremony's
 * committed per-page numbers within the known ±4 cross-run variance.
 *
 * Zero new scoring code: this runner emits results in the exact shape the
 * ceremony's Modal run produced and feeds them through the SAME
 * score-candidate-witness.mjs. What is compared is therefore the
 * integrated path (tmpfile protocol → adapter → observation mapping)
 * against the ceremonial path, holding scorer and gold constant.
 *
 * Usage (repo root; models fetched via fetch_models.py):
 *   SERVICE_SIDECAR_MODELS_DIR=.evaluation/sidecar-models \
 *   node service/sidecar/sanity-check.mjs \
 *     --ceremony-dir .evaluation/hpi-ceremony \
 *     --ceremony-aggregate evaluation/sidecar-adoption-ceremony-v1.json \
 *     --run-root .evaluation/runs/dev-v12-cross-family-2026-08-20 \
 *     --gold-root .evaluation/gold [--pages 10]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPpOcrSidecarAdapter } from '../adapters/ppocr-sidecar.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required argument ${name}`);
}

const ceremonyDir = arg('--ceremony-dir');
const aggregatePath = arg('--ceremony-aggregate');
const runRoot = arg('--run-root');
const goldRoot = arg('--gold-root');
const pageBudget = Number(arg('--pages', '10'));
const VARIANCE_TOKENS = 4; // measured cross-run/container variance (PR #67 doc)

const aggregate = JSON.parse(readFileSync(aggregatePath, 'utf8'));
const manifest = JSON.parse(readFileSync(join(ceremonyDir, 'manifest.json'), 'utf8'));
const byPage = new Map(manifest.map((page) => [page.page, page]));

// The most gold-bearing pages give the check its statistical teeth.
const targets = [...aggregate.perPage]
  .filter((page) => page.goldRecall && page.goldRecall.goldTokens > 0 && byPage.has(page.page))
  .sort((a, b) => b.goldRecall.goldTokens - a.goldRecall.goldTokens)
  .slice(0, pageBudget);

const adapter = createPpOcrSidecarAdapter({
  modelsDir: process.env.SERVICE_SIDECAR_MODELS_DIR,
  threads: Number(process.env.SERVICE_SIDECAR_THREADS ?? 1)
});

const perPage = [];
await adapter.warmup();
console.error(`sidecar up (${adapter.descriptor}), cold init ${adapter.coldInitMs()}ms`);
for (const target of targets) {
  const entry = byPage.get(target.page);
  const png = readFileSync(join(ceremonyDir, entry.png));
  const pageNumber = Number(target.page.split('#').pop());
  const start = performance.now();
  const result = await adapter.recognize({ pageNumber, data: png });
  const ms = performance.now() - start;
  perPage.push({
    page: target.page,
    ms,
    lines: result.observations.map((observation) => ({
      text: observation.text,
      poly: observation.polygon,
      score: observation.confidence
    }))
  });
  console.error(`${target.page}: ${result.observations.length} lines, ${Math.round(ms)}ms`);
}
await adapter.dispose();

const resultsPath = join(ceremonyDir, 'sidecar-sanity-results.json');
writeFileSync(resultsPath, JSON.stringify({
  deviceTruth: null,
  config: { name: 'sidecar-sanity', backend: adapter.backend },
  initS: (adapter.coldInitMs() ?? 0) / 1000,
  firstPageMs: perPage[0]?.ms ?? null,
  versions: adapter.sidecarMeta?.versions ?? {},
  perPage
}, null, 1));

const scored = JSON.parse(execFileSync(process.execPath, [
  join(root, 'scripts/evaluation/score-candidate-witness.mjs'),
  '--results', resultsPath,
  '--manifest', join(ceremonyDir, 'manifest.json'),
  '--run-root', runRoot,
  '--gold-root', goldRoot
], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));

const scoredByPage = new Map(scored.perPage.map((page) => [page.page, page]));
let ceremonyTotal = 0;
let sidecarTotal = 0;
const rows = [];
for (const target of targets) {
  const mine = scoredByPage.get(target.page);
  const ceremonyHits = target.goldRecall.candidate;
  const sidecarHits = mine?.goldRecall?.candidate ?? 0;
  ceremonyTotal += ceremonyHits;
  sidecarTotal += sidecarHits;
  rows.push({ page: target.page, goldTokens: target.goldRecall.goldTokens, ceremony: ceremonyHits, sidecar: sidecarHits });
}
const delta = Math.abs(sidecarTotal - ceremonyTotal);
const verdict = delta <= VARIANCE_TOKENS ? 'PARITY' : 'DRIFT';
console.log(JSON.stringify({
  sanityCheck: 'sidecar-vs-ceremony gold parity',
  pages: rows.length,
  goldTokens: rows.reduce((sum, row) => sum + row.goldTokens, 0),
  ceremonyHits: ceremonyTotal,
  sidecarHits: sidecarTotal,
  absDelta: delta,
  allowedVariance: VARIANCE_TOKENS,
  verdict,
  backend: adapter.backend ?? null,
  rows
}, null, 1));
if (verdict !== 'PARITY') process.exit(1);

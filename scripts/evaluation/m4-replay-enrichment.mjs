/**
 * M4 replay instrument (design 2026-08-23, workstream-2 acceptance
 * criteria 1 and 3): feed the SAME baseline records — dev-v13, replayed —
 * to the SERVICE's enrichment routing (service/lib/enrichment.mjs
 * buildManifest) and to the evaluation runner's routing (the exact loop
 * run-flash-enrichment.mjs executes), and require identical request plans
 * page-for-page. With --enrich, additionally run the service's phase-B
 * machinery for real over those replayed records (chunked Gemini batches,
 * digest-bound records) so the committed recall scorer
 * (score-enrichment-recall.mjs) can measure the token gain on the same
 * gold∩blocking pages.
 *
 * Privacy: --enrich sends rendered page images of the private corpus to
 * the Gemini API. Run only with explicit authorization from the corpus
 * owner. Outputs under --data-dir / --score-dir are corpus-derived — keep
 * them out of git; the --out summary is count-level only.
 *
 * Usage:
 *   node scripts/evaluation/m4-replay-enrichment.mjs \
 *     --run-root /abs/.evaluation/runs/<run-id> \
 *     --corpus-root /abs/.evaluation/corpus \
 *     --data-dir /abs/.evaluation/m4/replay-jobs \
 *     --out /abs/.evaluation/m4/replay-parity.json \
 *     [--enrich] [--score-dir /abs/.evaluation/m4/replay-scoring]
 *
 * Zero interactive Gemini calls, structurally: this script imports NO
 * Gemini adapter at all — the service module it drives imports only the
 * batch executor (its own invariant).
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildEnrichmentRequestPlan, pageQualifiesForEscalatedEnrichment } from '../../dist/index.js';
import { EnrichmentPhase, ENRICH_RENDER_DPI } from '../../service/lib/enrichment.mjs';

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required argument ${name}`);
}

const runRoot = arg('--run-root');
const corpusRoot = arg('--corpus-root');
const dataDir = arg('--data-dir');
const outPath = arg('--out');
const enrich = process.argv.includes('--enrich');
const scoreDir = arg('--score-dir', '');
const padded = (n) => String(n).padStart(6, '0');

// ---------------------------------------------------------------------------
// Load the replayed records and materialize service job dirs from them:
// <data-dir>/<doc>/pages/NNNNNN.json in the service's stored-wrapper shape.
// ---------------------------------------------------------------------------
const jobs = [];
for (const doc of readdirSync(join(runRoot, 'documents')).sort()) {
  let files;
  try { files = readdirSync(join(runRoot, 'documents', doc, 'pages')); } catch { continue; }
  const pages = [];
  let pdfPath;
  let sha256;
  for (const file of files.sort()) {
    const record = JSON.parse(readFileSync(join(runRoot, 'documents', doc, 'pages', file), 'utf8'));
    if (!record.pageSpatial) continue; // dev-v13 is 162/162 ok; guard anyway
    pages.push({ pageNumber: record.pageNumber, pageSpatial: record.pageSpatial });
    pdfPath ??= join(corpusRoot, record.path);
    sha256 ??= record.pageSpatial.documentSha256;
  }
  const pagesDir = join(dataDir, doc, 'pages');
  mkdirSync(pagesDir, { recursive: true });
  for (const page of pages) {
    writeFileSync(join(pagesDir, `${padded(page.pageNumber)}.json`),
      JSON.stringify({ ok: true, pageNumber: page.pageNumber, pageSpatial: page.pageSpatial }, null, 1));
  }
  jobs.push({
    jobId: doc,
    pdfPath,
    sha256,
    pageCount: Math.max(...pages.map((page) => page.pageNumber)),
    enrichment: 'batch',
    status: 'completed',
    pages
  });
}

// ---------------------------------------------------------------------------
// Runner-side routing: the EXACT selection + plan loop the evaluation
// runner executes (run-flash-enrichment.mjs) — qualification predicate,
// then the shared plan builder, then request kinds exactly as the runner
// derives its batch keys (full subsumes crops; adj additive).
// ---------------------------------------------------------------------------
const runnerPlans = new Map(); // `${doc}#${pageNumber}` -> {kinds, plan}
for (const job of jobs) {
  for (const { pageNumber, pageSpatial } of job.pages) {
    if (!pageQualifiesForEscalatedEnrichment(pageSpatial)) continue;
    const plan = buildEnrichmentRequestPlan({ pageSpatial }, { renderDpi: ENRICH_RENDER_DPI });
    const kinds = [];
    if (plan.fullTranscription) kinds.push('full');
    else if (plan.residueCrops) kinds.push('crops');
    if (plan.adjudication) kinds.push('adj');
    runnerPlans.set(`${job.jobId}#${pageNumber}`, { kinds, plan });
  }
}

// ---------------------------------------------------------------------------
// Service-side routing: EnrichmentPhase.buildManifest over the same stored
// records (the real code path phase B runs), then the submitted chunk keys.
// ---------------------------------------------------------------------------
const apiKey = process.env.GEMINI_API_KEY;
if (enrich && !apiKey) throw new Error('--enrich requires GEMINI_API_KEY.');
const phase = new EnrichmentPhase({ dataDir, metrics: undefined, options: { apiKey: apiKey ?? 'replay-parity-only' } });

const servicePlans = new Map();
const parity = { pagesReplayed: 0, plansCompared: 0, mismatches: [] };
for (const job of jobs) {
  parity.pagesReplayed += job.pages.length;
  // Never rebuild an existing manifest: a prior --enrich run may hold
  // submitted operation names, and rebuilding would resubmit paid work.
  const manifest = phase.readManifest(job.jobId)
    ?? (await phase.buildManifest(job))
    ?? phase.readManifest(job.jobId);
  for (const chunk of manifest?.chunks ?? []) {
    for (const key of chunk.keys) {
      const [page, kind] = key.split('|');
      const id = `${job.jobId}#${Number(page)}`;
      if (!servicePlans.has(id)) servicePlans.set(id, []);
      servicePlans.get(id).push(kind);
    }
  }
}

// Page-for-page comparison: same selected pages, same rung kinds, and the
// full plan payload (conflict inputs, crop windows) byte-equal when the
// service rebuilds it at submission time (buildChunkRequests re-runs the
// builder on the stored record — same inputs by construction; asserted
// here against the runner's plan object).
const allIds = new Set([...runnerPlans.keys(), ...servicePlans.keys()]);
for (const id of [...allIds].sort()) {
  parity.plansCompared += 1;
  const runner = runnerPlans.get(id);
  const service = servicePlans.get(id);
  if (!runner || !service) {
    parity.mismatches.push({ id, runner: runner?.kinds ?? null, service: service ?? null });
    continue;
  }
  const runnerKinds = [...runner.kinds].sort().join(',');
  const serviceKinds = [...service].sort().join(',');
  if (runnerKinds !== serviceKinds) parity.mismatches.push({ id, runner: runnerKinds, service: serviceKinds });
  const [doc, pageNumber] = id.split('#');
  const stored = JSON.parse(readFileSync(join(dataDir, doc, 'pages', `${padded(Number(pageNumber))}.json`), 'utf8'));
  const servicePlan = buildEnrichmentRequestPlan(stored, { renderDpi: ENRICH_RENDER_DPI });
  if (JSON.stringify(servicePlan) !== JSON.stringify(runner.plan)) {
    parity.mismatches.push({ id, payload: 'plan payload differs between stored-record and in-memory record' });
  }
}

const rungTotals = { full: 0, crops: 0, adj: 0 };
for (const { kinds } of runnerPlans.values()) for (const kind of kinds) rungTotals[kind] += 1;

const summary = {
  createdAt: new Date().toISOString(),
  runRoot,
  renderDpi: ENRICH_RENDER_DPI,
  parity: {
    pagesReplayed: parity.pagesReplayed,
    qualifyingRunner: runnerPlans.size,
    qualifyingService: servicePlans.size,
    plansCompared: parity.plansCompared,
    rungTotals,
    mismatches: parity.mismatches
  }
};

// ---------------------------------------------------------------------------
// --enrich: run the real phase B over the replayed records (paid; batch
// API only). Then optionally lay records out for the committed scorer.
// ---------------------------------------------------------------------------
if (enrich) {
  if (parity.mismatches.length) throw new Error('Routing parity failed; refusing to spend on a divergent plan set.');
  for (const job of jobs) phase.start(job);
  await phase.idle();
  const perJob = [];
  const spend = { promptTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
  const states = {};
  for (const job of jobs) {
    const manifest = phase.readManifest(job.jobId);
    if (!manifest) { perJob.push({ jobId: job.jobId, status: 'no-manifest' }); continue; }
    for (const entry of Object.values(manifest.pages)) states[entry.state] = (states[entry.state] ?? 0) + 1;
    spend.promptTokens += manifest.spend.promptTokens;
    spend.outputTokens += manifest.spend.outputTokens;
    spend.estimatedCostUsd = Math.round((spend.estimatedCostUsd + manifest.spend.estimatedCostUsd) * 1e6) / 1e6;
    perJob.push({
      jobId: job.jobId,
      status: manifest.status,
      chunks: manifest.chunks.map((chunk) => ({ state: chunk.state, keys: chunk.keys.length, wallMs: chunk.wallMs ?? null })),
      spend: manifest.spend
    });
  }
  summary.enrich = { perJob, spend, pageStates: states, completePages: states.complete ?? 0 };
  if (scoreDir) {
    mkdirSync(scoreDir, { recursive: true });
    let copied = 0;
    for (const job of jobs) {
      for (const name of readdirSync(join(dataDir, job.jobId, 'enrichment')).sort()) {
        if (name === 'manifest.json') continue;
        const record = JSON.parse(readFileSync(join(dataDir, job.jobId, 'enrichment', name), 'utf8'));
        writeFileSync(join(scoreDir, `ps_${record.documentSha256.slice(0, 12)}_p${record.pageNumber}.json`),
          JSON.stringify(record, null, 1));
        copied += 1;
      }
    }
    summary.enrich.scoreDirRecords = copied;
  }
}

mkdirSync(join(outPath, '..'), { recursive: true });
writeFileSync(outPath, JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary.parity, null, 1));
if (summary.enrich) console.log(JSON.stringify({ spend: summary.enrich.spend, pageStates: summary.enrich.pageStates }, null, 1));

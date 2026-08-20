/**
 * Escalated-tier enrichment run (issue #2): route every page of a baseline
 * run that carries blocking escalation reasons to the Flash transcriber,
 * and land each result as an explicit enrichment revision record bound
 * fail-closed to the page it enriched.
 *
 * Privacy: sends rendered page images of the private corpus to the Gemini
 * API. Run only with explicit authorization from the corpus owner.
 *
 * Usage:
 *   GEMINI_API_KEY=... node scripts/evaluation/run-flash-enrichment.mjs \
 *     --run-root .evaluation/runs/<run-id> \
 *     --output .evaluation/runs/<run-id>/enrichment \
 *     [--corpus-root .evaluation/corpus] [--concurrency 4] [--limit N]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildEscalatedOcrEnrichment, pageQualifiesForEscalatedEnrichment } from '../../dist/index.js';
import { transcribePageImage } from '../../dist/node/flash-ocr.js';

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required argument ${name}`);
}

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error('GEMINI_API_KEY is required.');
const runRoot = arg('--run-root');
const outputDir = arg('--output', join(runRoot, 'enrichment'));
const corpusRoot = arg('--corpus-root', '.evaluation/corpus');
const concurrency = Number(arg('--concurrency', '4'));
const limit = Number(arg('--limit', 'Infinity'));
const skipExisting = process.argv.includes('--skip-existing');
const renderDpi = 150;
mkdirSync(outputDir, { recursive: true });

// Collect blocking pages from the baseline run.
const targets = [];
const documentsRoot = join(runRoot, 'documents');
for (const doc of readdirSync(documentsRoot)) {
  let files;
  try { files = readdirSync(join(documentsRoot, doc, 'pages')); } catch { continue; }
  for (const file of files) {
    const record = JSON.parse(readFileSync(join(documentsRoot, doc, 'pages', file), 'utf8'));
    const page = record.pageSpatial;
    if (!page || !pageQualifiesForEscalatedEnrichment(page)) continue;
    targets.push({ doc, page, pdfPath: join(corpusRoot, record.path), pageNumber: record.pageNumber });
  }
}
targets.sort((a, b) => a.page.pageId.localeCompare(b.page.pageId));
const selected = targets.slice(0, limit);
console.log(`Blocking pages: ${targets.length}; enriching ${selected.length} at concurrency ${concurrency}.`);

function renderPng(pdfPath, pageNumber) {
  const dir = join(tmpdir(), `flash-enrich-${process.pid}-${pageNumber}-${Math.floor(performance.now())}`);
  mkdirSync(dir, { recursive: true });
  try {
    execFileSync('pdftoppm', ['-f', String(pageNumber), '-l', String(pageNumber), '-r', String(renderDpi), '-png', pdfPath, join(dir, 'p')]);
    const file = readdirSync(dir).find((name) => name.endsWith('.png'));
    if (!file) throw new Error('pdftoppm produced no output.');
    return readFileSync(join(dir, file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const results = [];
const failures = [];
let cursor = 0;
async function worker() {
  while (cursor < selected.length) {
    const target = selected[cursor];
    cursor += 1;
    const name = `${target.page.pageId.replaceAll(':', '_')}.json`;
    try {
      if (skipExisting && existsSync(join(outputDir, name))) {
        results.push(JSON.parse(readFileSync(join(outputDir, name), 'utf8')));
        continue;
      }
      const png = renderPng(target.pdfPath, target.pageNumber);
      const transcription = await transcribePageImage({ apiKey, png: new Uint8Array(png) });
      const enrichment = await buildEscalatedOcrEnrichment({
        page: target.page,
        proposals: transcription.proposals,
        provenance: transcription.provenance,
        telemetry: transcription.telemetry
      });
      writeFileSync(join(outputDir, name), JSON.stringify(enrichment, null, 1));
      results.push(enrichment);
      const novel = enrichment.proposals.filter((proposal) => proposal.corroboration === 'novel').length;
      console.log(`${target.page.pageId}: ${enrichment.proposals.length} proposals (${novel} novel) ${enrichment.telemetry.latencyMs}ms`);
    } catch (error) {
      failures.push({ pageId: target.page.pageId, error: String(error).slice(0, 200) });
      console.warn(`${target.page.pageId}: FAILED ${String(error).slice(0, 120)}`);
    }
  }
}
await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));

const byStatus = { 'corroborated-both': 0, 'corroborated-native': 0, 'corroborated-ocr': 0, novel: 0 };
let promptTokens = 0;
let outputTokens = 0;
const latencies = [];
for (const enrichment of results) {
  for (const proposal of enrichment.proposals) byStatus[proposal.corroboration] += 1;
  promptTokens += enrichment.telemetry.promptTokens;
  outputTokens += enrichment.telemetry.outputTokens;
  latencies.push(enrichment.telemetry.latencyMs);
}
latencies.sort((a, b) => a - b);
const quantile = (q) => latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))] : 0;
const costUsd = (promptTokens * 0.75 + outputTokens * 3.75) / 1e6;
const aggregate = {
  enrichmentRunVersion: 'flash-enrichment-run-v1',
  createdAt: new Date().toISOString(),
  runRoot,
  pagesEnriched: results.length,
  failures,
  proposals: byStatus,
  telemetry: {
    promptTokens,
    outputTokens,
    estimatedCostUsd: Math.round(costUsd * 10000) / 10000,
    costPerPageUsd: results.length ? Math.round((costUsd / results.length) * 10000) / 10000 : 0,
    latencyMsP50: quantile(0.5),
    latencyMsP95: quantile(0.95)
  }
};
writeFileSync(join(outputDir, 'aggregate.json'), JSON.stringify(aggregate, null, 1));
console.log(JSON.stringify(aggregate.proposals), JSON.stringify(aggregate.telemetry));

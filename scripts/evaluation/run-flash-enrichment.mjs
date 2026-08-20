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
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildEscalatedOcrEnrichment, pageQualifiesForEscalatedEnrichment, validateEnrichmentAgainstPage } from '../../dist/index.js';
import { adjudicatePageConflicts, transcribePageImage } from '../../dist/node/flash-ocr.js';

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

const verifiedPdfSha = new Map();
function assertPdfMatchesRecord(pdfPath, expectedSha) {
  // The page record binds evidence to documentSha256; the bytes about to be
  // rendered and sent to a remote API must be that same document. Fail closed
  // on mismatch — never render, never transmit.
  let actual = verifiedPdfSha.get(pdfPath);
  if (!actual) {
    actual = createHash('sha256').update(readFileSync(pdfPath)).digest('hex');
    verifiedPdfSha.set(pdfPath, actual);
  }
  if (actual !== expectedSha) {
    throw new Error(`PDF bytes at ${pdfPath} (${actual.slice(0, 12)}…) do not match the record's documentSha256.`);
  }
}

function renderPng(pdfPath, pageNumber) {
  // mkdtempSync: concurrent workers rendering the same page number of
  // different documents must never share (or delete) each other's dir —
  // a collision silently attaches another page's proposals.
  const dir = mkdtempSync(join(tmpdir(), 'flash-enrich-'));
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
let reused = 0;
let cursor = 0;
async function worker() {
  while (cursor < selected.length) {
    const target = selected[cursor];
    cursor += 1;
    const name = `${target.page.pageId.replaceAll(':', '_')}.json`;
    // Escalation ladder (issue #17), measured decision:
    // - conflict/omission reasons -> page-batched adjudication (~$0.0023)
    // - starved/residue reasons  -> full-page transcription at HIGH (~$0.0085)
    // A page carrying both reason kinds gets both calls; telemetry sums.
    const reasons = new Set(target.page.diagnostics.escalationReasons
      .filter((reason) => reason.severity === 'blocking')
      .map((reason) => reason.type));
    const needsAdjudication = reasons.has('critical-token-conflict') || reasons.has('critical-token-omission');
    const needsTranscription = reasons.has('uncorroborated-ocr') || reasons.has('unread-ink-region');
    try {
      if (skipExisting && existsSync(join(outputDir, name))) {
        const stored = JSON.parse(readFileSync(join(outputDir, name), 'utf8'));
        const verdict = await validateEnrichmentAgainstPage(stored, target.page);
        if (verdict.valid) {
          reused += 1;
          results.push(verdict.record);
          continue;
        }
        console.warn(`${target.page.pageId}: stored enrichment stale/invalid (${verdict.issues[0]}); re-enriching.`);
      }
      assertPdfMatchesRecord(target.pdfPath, target.page.documentSha256);
      const png = renderPng(target.pdfPath, target.pageNumber);
      let proposals = [];
      let adjudications = [];
      let provenance;
      const telemetry = { promptTokens: 0, outputTokens: 0, latencyMs: 0 };
      if (needsTranscription) {
        const transcription = await transcribePageImage({ apiKey, png: new Uint8Array(png) });
        proposals = transcription.proposals;
        provenance = transcription.provenance;
        telemetry.promptTokens += transcription.telemetry.promptTokens;
        telemetry.outputTokens += transcription.telemetry.outputTokens;
        telemetry.latencyMs += transcription.telemetry.latencyMs;
      }
      if (needsAdjudication && target.page.conflicts.length) {
        const { width, height } = target.page.geometry;
        const obsBox = new Map(target.page.ocrObservations.map((observation) => [observation.id, observation.box]));
        const conflicts = target.page.conflicts.map((conflict) => {
          const box = obsBox.get(conflict.ocrId);
          return {
            conflictId: conflict.id,
            nativeText: conflict.nativeText,
            ocrText: conflict.ocrText,
            normalizedBox: [
              Math.round((box[1] / height) * 1000), Math.round((box[0] / width) * 1000),
              Math.round((box[3] / height) * 1000), Math.round((box[2] / width) * 1000)
            ]
          };
        });
        const adjudication = await adjudicatePageConflicts({ apiKey, png: new Uint8Array(png), conflicts });
        adjudications = adjudication.verdicts;
        provenance = provenance ?? adjudication.provenance;
        telemetry.promptTokens += adjudication.telemetry.promptTokens;
        telemetry.outputTokens += adjudication.telemetry.outputTokens;
        telemetry.latencyMs += adjudication.telemetry.latencyMs;
      }
      const enrichment = await buildEscalatedOcrEnrichment({
        page: target.page,
        proposals,
        adjudications,
        provenance,
        telemetry
      });
      writeFileSync(join(outputDir, name), JSON.stringify(enrichment, null, 1));
      results.push(enrichment);
      const novel = enrichment.proposals.filter((proposal) => proposal.corroboration === 'novel').length;
      console.log(`${target.page.pageId}: ${enrichment.proposals.length} proposals (${novel} novel), ${enrichment.adjudications.length} adjudications, ${enrichment.telemetry.latencyMs}ms`);
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
  // Aggregate describes the output DIRECTORY. reusedFromDisk enrichments
  // were validated against their pages but their telemetry is prior-run
  // spend; this run's marginal spend is pagesEnriched - reusedFromDisk
  // pages' worth. Prices below are for the default model only.
  reusedFromDisk: reused,
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

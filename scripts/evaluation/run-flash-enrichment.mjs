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
import { buildEnrichmentRequestPlan, buildEscalatedOcrEnrichment, pageQualifiesForEscalatedEnrichment, validateEnrichmentAgainstPage } from '../../dist/index.js';
import {
  adjudicatePageConflicts,
  adjudicationProvenance,
  buildAdjudicationRequest,
  buildResidueCropsRequest,
  buildTranscriptionRequest,
  parseAdjudicationPayload,
  parseTranscriptionPayload,
  RESIDUE_CROPS_PROMPT_REVISION,
  awaitFlashBatch,
  runFlashBatch,
  transcribePageImage,
  transcribeResidueCrops,
  transcriptionProvenance
} from '../../dist/node/flash-ocr.js';

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
// --batch: submit every request through the Gemini Batch API (50% price).
// Enrichment is async by design, so batch latency costs nothing in UX;
// per-page latencyMs then records the shared batch wall-clock.
const batchMode = process.argv.includes('--batch') || process.argv.includes('--batch-resume');
// --batch-resume <operationName>: rebuild requests locally ($0) and join
// the results of an already-submitted batch — a crashed client must be
// able to collect paid-for results without resubmitting.
const batchResume = arg('--batch-resume', '');
if (process.argv.includes('--batch-resume') && (!batchResume || batchResume.startsWith('--'))) {
  // A missing value must never silently submit a NEW batch at full price.
  throw new Error('--batch-resume requires an operation name or "auto".');
}
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

// Render just one residue region as a PNG crop. The crop window comes
// pre-computed on the request plan (pdftoppm's -x/-y/-W/-H take pixels at
// the requested dpi; the plan converts rendered-px boxes through points
// and applies the boundary-glyph margin).
function renderCrop(pdfPath, pageNumber, crop) {
  const dir = mkdtempSync(join(tmpdir(), 'flash-crop-'));
  try {
    execFileSync('pdftoppm', ['-f', String(pageNumber), '-l', String(pageNumber), '-r', String(renderDpi),
      '-x', String(crop.x), '-y', String(crop.y), '-W', String(crop.w), '-H', String(crop.h), '-png', pdfPath, join(dir, 'c')]);
    const file = readdirSync(dir).find((name) => name.endsWith('.png'));
    if (!file) throw new Error('pdftoppm produced no crop output.');
    return readFileSync(join(dir, file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
const prepared = [];
let reused = 0;
let residueWithoutCrops = 0;
let cursor = 0;
async function worker() {
  while (cursor < selected.length) {
    const target = selected[cursor];
    cursor += 1;
    const name = `${target.page.pageId.replaceAll(':', '_')}.json`;
    // Routing (which rungs, with what inputs) lives in the library plan
    // builder — src/enrichment-plan.ts — shared with the service so the
    // measured cost ladder describes production. The runner only executes
    // the plan.
    const plan = buildEnrichmentRequestPlan({ pageSpatial: target.page }, { renderDpi });
    let partialTelemetry;
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
      if (batchMode) {
        // Phase A: build requests ONLY, then continue — no synchronous
        // adapter may run in batch mode (it would transmit and bill the
        // page twice and leave interactive spend off the batch ledger).
        // test/enrichment-runner.test.mjs asserts zero generateContent
        // calls fire under --batch.
        const entry = { target, name, requests: {}, conflicts: undefined };
        if (plan.fullTranscription) {
          entry.requests.full = buildTranscriptionRequest([new Uint8Array(png)]);
        } else if (plan.residueCrops) {
          const pngs = plan.residueCrops.crops.map((item) => new Uint8Array(renderCrop(target.pdfPath, target.pageNumber, item.crop)));
          entry.requests.crops = buildResidueCropsRequest(pngs);
        } else if (plan.residueUnanswered) {
          console.warn(`${target.page.pageId}: unread-ink alarm fired but no crop-eligible regions; residue goes unanswered.`);
          residueWithoutCrops += 1;
        }
        if (plan.adjudication) {
          entry.conflicts = plan.adjudication.conflicts;
          entry.requests.adj = buildAdjudicationRequest(new Uint8Array(png), entry.conflicts);
        }
        prepared.push(entry);
        continue;
      }
      let proposals = [];
      let adjudications = [];
      const provenance = {};
      const telemetry = { promptTokens: 0, outputTokens: 0, latencyMs: 0 };
      if (plan.fullTranscription) {
        const transcription = await transcribePageImage({ apiKey, png: new Uint8Array(png) });
        proposals = transcription.proposals;
        provenance.transcription = transcription.provenance;
        telemetry.promptTokens += transcription.telemetry.promptTokens;
        telemetry.outputTokens += transcription.telemetry.outputTokens;
        telemetry.latencyMs += transcription.telemetry.latencyMs;
      } else if (plan.residueCrops) {
        const pngs = plan.residueCrops.crops.map((item) => new Uint8Array(renderCrop(target.pdfPath, target.pageNumber, item.crop)));
        const transcription = await transcribeResidueCrops({ apiKey, pngs });
        // Crops are text-only by schema; strip any hint defensively.
        proposals = transcription.proposals.map(({ text }) => ({ text }));
        provenance.transcription = transcription.provenance;
        telemetry.promptTokens += transcription.telemetry.promptTokens;
        telemetry.outputTokens += transcription.telemetry.outputTokens;
        telemetry.latencyMs += transcription.telemetry.latencyMs;
      } else if (plan.residueUnanswered) {
        console.warn(`${target.page.pageId}: unread-ink alarm fired but no crop-eligible regions; residue goes unanswered.`);
        residueWithoutCrops += 1;
      }
      if (plan.adjudication) {
        const conflicts = plan.adjudication.conflicts;
        // Partial-spend honesty: if this second rung fails, the outer
        // catch records the telemetry already accumulated — spend is never
        // invisible just because a later rung failed.
        const adjudication = await adjudicatePageConflicts({ apiKey, png: new Uint8Array(png), conflicts });
        adjudications = adjudication.verdicts;
        provenance.adjudication = adjudication.provenance;
        telemetry.promptTokens += adjudication.telemetry.promptTokens;
        telemetry.outputTokens += adjudication.telemetry.outputTokens;
        telemetry.latencyMs += adjudication.telemetry.latencyMs;
      }
      partialTelemetry = telemetry;
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
      // Failed pages still carry their spend into the ledger — both the
      // rungs that completed and the attempts of the call that failed
      // (the adapter attaches attempt telemetry to its terminal error).
      const errorTelemetry = error?.telemetry ?? { promptTokens: 0, outputTokens: 0, latencyMs: 0 };
      const spent = {
        promptTokens: (partialTelemetry?.promptTokens ?? 0) + errorTelemetry.promptTokens,
        outputTokens: (partialTelemetry?.outputTokens ?? 0) + errorTelemetry.outputTokens,
        latencyMs: (partialTelemetry?.latencyMs ?? 0) + errorTelemetry.latencyMs
      };
      failures.push({
        pageId: target.page.pageId,
        error: String(error).slice(0, 200),
        ...(spent.promptTokens || spent.outputTokens ? { telemetry: spent } : {})
      });
      console.warn(`${target.page.pageId}: FAILED ${String(error).slice(0, 120)}`);
    }
  }
}
await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));

if (batchMode && prepared.length) {
  const entries = [];
  for (const item of prepared) {
    for (const [kind, request] of Object.entries(item.requests)) {
      entries.push({ key: `${item.name}|${kind}`, request });
    }
  }
  const manifestPath = join(outputDir, 'batch-manifest.json');
  let resumeOperation = batchResume;
  if (batchResume === 'auto') {
    // Recover from the persisted manifest of a crashed run.
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    resumeOperation = manifest.operationName;
  }
  if (resumeOperation) {
    // A resumed join is only safe when the locally rebuilt requests are
    // the ones the batch actually ran: verify the key sets match the
    // persisted manifest, fail closed on any drift (a page reparsed since
    // submission must not silently receive the old batch's results).
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.operationName !== resumeOperation) {
      throw new Error(`Manifest records operation ${manifest.operationName}, not ${resumeOperation}.`);
    }
    const localKeys = entries.map((entry) => entry.key).sort();
    if (JSON.stringify(localKeys) !== JSON.stringify([...manifest.keys].sort())) {
      throw new Error('Rebuilt batch entries do not match the submitted manifest; refuse to join results to changed pages.');
    }
  }
  console.log(`Batch: ${resumeOperation ? 'resuming ' + resumeOperation : 'submitting'} — ${entries.length} requests for ${prepared.length} pages…`);
  const batch = resumeOperation
    ? await awaitFlashBatch({ apiKey, entries, operationName: resumeOperation })
    : await runFlashBatch({
        apiKey, entries,
        onSubmitted(operationName) {
          // Persist the recovery handle BEFORE polling: a crash after
          // submission must never orphan paid work (resume with
          // --batch-resume auto or the printed operation name).
          writeFileSync(manifestPath, JSON.stringify({
            operationName,
            submittedAt: new Date().toISOString(),
            runRoot,
            keys: entries.map((entry) => entry.key)
          }, null, 1));
          console.log(`Batch submitted: ${operationName} (manifest: ${manifestPath})`);
        }
      });
  console.log(`Batch done in ${Math.round(batch.wallMs / 1000)}s (${batch.errors.size} item errors).`);
  for (const item of prepared) {
    const telemetry = { promptTokens: 0, outputTokens: 0, latencyMs: batch.wallMs };
    try {
      let proposals = [];
      let adjudications = [];
      const provenance = {};
      const take = (kind) => {
        const key = `${item.name}|${kind}`;
        if (batch.errors.has(key)) throw new Error(`batch item ${kind}: ${batch.errors.get(key)}`);
        const payload = batch.payloads.get(key);
        // Usage lands the moment the payload is taken — a sibling rung
        // failing later must not erase this rung's billed spend.
        telemetry.promptTokens += payload?.usageMetadata?.promptTokenCount ?? 0;
        telemetry.outputTokens += payload?.usageMetadata?.candidatesTokenCount ?? 0;
        return payload;
      };
      if (item.requests.full) {
        const parsed = parseTranscriptionPayload(take('full'));
        proposals = parsed.proposals;
        provenance.transcription = { ...transcriptionProvenance(), transport: 'batch' };
      } else if (item.requests.crops) {
        const parsed = parseTranscriptionPayload(take('crops'));
        // Crops are text-only by schema; strip any hint defensively.
        proposals = parsed.proposals.map(({ text }) => ({ text }));
        provenance.transcription = { ...transcriptionProvenance(undefined, RESIDUE_CROPS_PROMPT_REVISION), transport: 'batch' };
      }
      if (item.requests.adj) {
        const parsed = parseAdjudicationPayload(take('adj'), item.conflicts);
        adjudications = parsed.verdicts;
        provenance.adjudication = { ...adjudicationProvenance(), transport: 'batch' };
      }
      const enrichment = await buildEscalatedOcrEnrichment({
        page: item.target.page, proposals, adjudications, provenance, telemetry
      });
      writeFileSync(join(outputDir, item.name), JSON.stringify(enrichment, null, 1));
      results.push(enrichment);
    } catch (error) {
      // Sibling-rung usage already accumulated in take() stays on the
      // ledger even when the page's record cannot be built.
      failures.push({
        pageId: item.target.page.pageId,
        error: String(error).slice(0, 200),
        ...(telemetry.promptTokens || telemetry.outputTokens
          ? { telemetry: { promptTokens: telemetry.promptTokens, outputTokens: telemetry.outputTokens, latencyMs: telemetry.latencyMs } }
          : {})
      });
      console.warn(`${item.target.page.pageId}: FAILED ${String(error).slice(0, 120)}`);
    }
  }
}

const byStatus = { 'corroborated-both': 0, 'corroborated-native': 0, 'corroborated-ocr': 0, novel: 0 };
let batchPromptTokens = 0;
let batchOutputTokens = 0;
const byVerdict = { native: 0, ocr: 0, 'both-wrong': 0, unsure: 0, unanswered: 0 };
let promptTokens = 0;
let outputTokens = 0;
const latencies = [];
for (const enrichment of results) {
  for (const proposal of enrichment.proposals) byStatus[proposal.corroboration] += 1;
  for (const adjudication of enrichment.adjudications) {
    if (adjudication.unanswered) byVerdict.unanswered += 1;
    else byVerdict[adjudication.verdict] += 1;
  }
  if (enrichment.provenance.transcription?.transport === 'batch' || enrichment.provenance.adjudication?.transport === 'batch') {
    batchPromptTokens += enrichment.telemetry.promptTokens;
    batchOutputTokens += enrichment.telemetry.outputTokens;
  }
  promptTokens += enrichment.telemetry.promptTokens;
  outputTokens += enrichment.telemetry.outputTokens;
  latencies.push(enrichment.telemetry.latencyMs);
}
for (const failure of failures) {
  promptTokens += failure.telemetry?.promptTokens ?? 0;
  outputTokens += failure.telemetry?.outputTokens ?? 0;
}
latencies.sort((a, b) => a - b);
const quantile = (q) => latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))] : 0;
// Batch API bills at 50% of interactive pricing. Price per source: in
// batch mode any interactive spend that reaches the ledger (failed sync
// rungs) must not ride the discount.
const batchCost = ((batchPromptTokens * 0.75 + batchOutputTokens * 3.75) / 1e6) * 0.5;
const interactiveCost = ((promptTokens - batchPromptTokens) * 0.75 + (outputTokens - batchOutputTokens) * 3.75) / 1e6;
const costUsd = batchCost + interactiveCost;
const aggregate = {
  enrichmentRunVersion: batchMode ? 'flash-enrichment-run-v3-batch' : 'flash-enrichment-run-v2-ladder',
  batchMode,
  createdAt: new Date().toISOString(),
  runRoot,
  pagesEnriched: results.length,
  // Aggregate describes the output DIRECTORY. reusedFromDisk enrichments
  // were validated against their pages but their telemetry is prior-run
  // spend; this run's marginal spend is pagesEnriched - reusedFromDisk
  // pages' worth. Prices below are for the default model only.
  reusedFromDisk: reused,
  residuePagesWithoutCropRequests: residueWithoutCrops,
  failures,
  proposals: byStatus,
  adjudicationVerdicts: byVerdict,
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

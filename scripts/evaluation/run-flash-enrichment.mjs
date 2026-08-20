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
import { buildEscalatedOcrEnrichment, pageQualifiesForEscalatedEnrichment, renderedPixelsPerPoint, validateEnrichmentAgainstPage } from '../../dist/index.js';
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

const RESIDUE_MIN_SIDE_PT = 8; // mirrors INK_RESIDUE_MIN_SIDE_PT (src/tuning.ts)
// Rotation-correct pixels-per-point: width/pointWidth is wrong for 90/270
// pages (rendered width corresponds to point HEIGHT there). The library
// helper prefers the viewport-transform magnitude and swaps axes on
// rotation — single source of truth.
const CROP_MARGIN_PT = 8;      // mirrors RECOVERY_REGION_MARGIN_PT

// Structured unread-ink regions that fired the residue alarm: nothing
// recovered, nothing confirmed, text-capable geometry. Boxes are in the
// browser-rendered pixel space of page.geometry.
function residueRegions(page) {
  const ppp = renderedPixelsPerPoint(page.geometry);
  return (page.unreadInkRegions ?? []).filter((region) =>
    region.kind === 'structured'
    && region.recoveredObservationCount === 0
    && region.confirmations.length === 0
    && Math.min(region.box[2] - region.box[0], region.box[3] - region.box[1]) >= RESIDUE_MIN_SIDE_PT * ppp);
}

// Render just one residue region as a PNG crop: pdftoppm's -x/-y/-W/-H
// take pixels at the requested dpi, so rendered-px boxes convert through
// points. Margin keeps boundary glyphs whole.
function renderCrop(pdfPath, pageNumber, page, box) {
  const ppp = renderedPixelsPerPoint(page.geometry);
  const toDpiPx = (px) => Math.round(((px / ppp) * renderDpi) / 72);
  const x = Math.max(0, toDpiPx(box[0]) - toDpiPx(CROP_MARGIN_PT * ppp));
  const y = Math.max(0, toDpiPx(box[1]) - toDpiPx(CROP_MARGIN_PT * ppp));
  const w = toDpiPx(box[2]) - toDpiPx(box[0]) + 2 * toDpiPx(CROP_MARGIN_PT * ppp);
  const h = toDpiPx(box[3]) - toDpiPx(box[1]) + 2 * toDpiPx(CROP_MARGIN_PT * ppp);
  const dir = mkdtempSync(join(tmpdir(), 'flash-crop-'));
  try {
    execFileSync('pdftoppm', ['-f', String(pageNumber), '-l', String(pageNumber), '-r', String(renderDpi),
      '-x', String(x), '-y', String(y), '-W', String(w), '-H', String(h), '-png', pdfPath, join(dir, 'c')]);
    const file = readdirSync(dir).find((name) => name.endsWith('.png'));
    if (!file) throw new Error('pdftoppm produced no crop output.');
    return readFileSync(join(dir, file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function conflictInputs(page) {
  const { width, height } = page.geometry;
  const obsBox = new Map(page.ocrObservations.map((observation) => [observation.id, observation.box]));
  return page.conflicts.map((conflict) => {
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
    // Ladder rung split (issue #20): starved pages need FULL transcription
    // (unknown missing content anywhere); residue-only pages transcribe
    // just their unread-ink region crops — the boxes are on the record.
    const needsFullTranscription = reasons.has('uncorroborated-ocr');
    const needsCrops = !needsFullTranscription && reasons.has('unread-ink-region');
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
        // Phase A: build requests ONLY — no synchronous adapter may run in
        // batch mode (running one would transmit and bill the page twice
        // and leave the interactive spend off the batch ledger).
        const entry = { target, name, requests: {}, conflicts: undefined };
        if (needsFullTranscription) entry.requests.full = buildTranscriptionRequest([new Uint8Array(png)]);
        else if (needsCrops) {
          const regions = residueRegions(target.page);
          if (regions.length) {
            const pngs = regions.map((region) => new Uint8Array(renderCrop(target.pdfPath, target.pageNumber, target.page, region.box)));
            entry.requests.crops = buildResidueCropsRequest(pngs);
          }
        }
        let proposals = [];
      let adjudications = [];
      const provenance = {};
      const telemetry = { promptTokens: 0, outputTokens: 0, latencyMs: 0 };
      if (needsFullTranscription) {
        const transcription = await transcribePageImage({ apiKey, png: new Uint8Array(png) });
        proposals = transcription.proposals;
        provenance.transcription = transcription.provenance;
        telemetry.promptTokens += transcription.telemetry.promptTokens;
        telemetry.outputTokens += transcription.telemetry.outputTokens;
        telemetry.latencyMs += transcription.telemetry.latencyMs;
      } else if (needsCrops) {
        const regions = residueRegions(target.page);
        if (regions.length) {
          const pngs = regions.map((region) => new Uint8Array(renderCrop(target.pdfPath, target.pageNumber, target.page, region.box)));
          const transcription = await transcribeResidueCrops({ apiKey, pngs });
          proposals = transcription.proposals;
          provenance.transcription = transcription.provenance;
          telemetry.promptTokens += transcription.telemetry.promptTokens;
          telemetry.outputTokens += transcription.telemetry.outputTokens;
          telemetry.latencyMs += transcription.telemetry.latencyMs;
        }
      }
      if (needsAdjudication && target.page.conflicts.length) {
          entry.conflicts = conflictInputs(target.page);
          entry.requests.adj = buildAdjudicationRequest(new Uint8Array(png), entry.conflicts);
        }
        prepared.push(entry);
        continue;
      }
      if (needsAdjudication && target.page.conflicts.length) {
        const conflicts = conflictInputs(target.page);
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
        provenance.transcription = transcriptionProvenance();
      } else if (item.requests.crops) {
        const parsed = parseTranscriptionPayload(take('crops'));
        proposals = parsed.proposals;
        provenance.transcription = transcriptionProvenance(undefined, RESIDUE_CROPS_PROMPT_REVISION);
      }
      if (item.requests.adj) {
        const parsed = parseAdjudicationPayload(take('adj'), item.conflicts);
        adjudications = parsed.verdicts;
        provenance.adjudication = adjudicationProvenance();
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
// Batch API bills at 50% of interactive pricing.
const priceMultiplier = batchMode ? 0.5 : 1;
const costUsd = ((promptTokens * 0.75 + outputTokens * 3.75) / 1e6) * priceMultiplier;
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

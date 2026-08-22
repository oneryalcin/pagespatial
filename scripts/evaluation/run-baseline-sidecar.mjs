/**
 * Sidecar-era development baseline runner (dev-v13+): the full development
 * corpus through the ADOPTED witness path — the parse service's pipeline
 * (pdftoppm render -> pdf-inspector+pdf.js native -> PP-OCR sidecar ->
 * assembly -> Tesseract second opinion where the library engages it) —
 * emitting the exact artifact-graph contract run-baseline.mjs established:
 * immutable attempt envelopes, hash-referenced document summaries, a
 * schema-validated run invocation, and a current.json pointer, so
 * generate-baseline-summary.mjs verifies this era's runs with the same
 * fail-closed graph walk as every browser-era baseline.
 *
 * Era differences, deliberate and visible in the profile: no region
 * recovery and no unread-ink analysis (both are browser-harness render-side
 * features; the service path has neither), renderer is pdftoppm at the
 * pdf.js-parity fractional dpi, and the OCR witness is the pinned Python
 * sidecar with truthful per-host EP. Cross-era diagnostic comparisons are
 * invalid by the era rules; gold-level comparisons only.
 *
 * Usage (models fetched per service/README):
 *   node scripts/evaluation/run-baseline-sidecar.mjs \
 *     --data-root .evaluation --models-dir .evaluation/sidecar-models \
 *     --run-id dev-v13-sidecar-2026-08-23 [--document-id <objectId>] [--page N]
 */
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { cpus, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { atomicCreateJson, atomicWriteJson, appendJsonLine, sha256File } from './lib/atomic-json.mjs';
import { stableFingerprint, workspaceIdentity } from './lib/fingerprint.mjs';
import { getDevelopmentDocuments, loadCorpusManifest } from './lib/manifest.mjs';
import { resumablePage, safeObjectId, sanitizedFailure } from './lib/run-state.mjs';
import { attemptEnvelopeSchema, documentSummarySchema, runInvocationSchema } from './lib/run-schema.mjs';
import { assemblyStage, nativeStage, ocrStage, openDocumentContext, renderStage, RENDER_SCALE } from '../../service/lib/stages.mjs';
import { createPpOcrSidecarAdapter } from '../../service/adapters/ppocr-sidecar.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const valueFlags = new Set(['--data-root', '--models-dir', '--document-id', '--page', '--threads', '--render-scale', '--document-timeout-ms', '--run-id']);
const booleanFlags = new Set(['--allow-dirty']);
for (let index = 2; index < process.argv.length; index += 1) {
  const name = process.argv[index];
  if (booleanFlags.has(name)) continue;
  if (!valueFlags.has(name)) throw new Error(`Unknown baseline argument: ${name}`);
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  index += 1;
}

function flag(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  return process.argv[index + 1];
}

function positiveNumber(name, fallback) {
  const value = Number(flag(name, fallback));
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive.`);
  return value;
}

const dataRoot = resolve(flag('--data-root', join(root, '.evaluation')));
const modelsDir = resolve(flag('--models-dir', join(dataRoot, 'sidecar-models')));
const requestedObjectId = flag('--document-id');
const requestedPage = flag('--page') === undefined ? undefined : positiveNumber('--page');
const threads = positiveNumber('--threads', 1);
const renderScale = positiveNumber('--render-scale', RENDER_SCALE);
const documentTimeoutMs = positiveNumber('--document-timeout-ms', 60 * 60_000);
const runId = flag('--run-id', `dev-sidecar-${new Date().toISOString().replace(/[:.]/gu, '-')}`);
if (!/^[A-Za-z0-9._-]+$/u.test(runId)) throw new Error('--run-id contains unsupported characters.');

const loaded = await loadCorpusManifest(join(root, 'evaluation/corpus.v1.json'));
const manifest = loaded.manifest ?? loaded;
const manifestHash = loaded.hash ?? await sha256File(join(root, 'evaluation/corpus.v1.json'));
const corpusId = `${manifest.schemaVersion}:${manifest.dataset.repoId}@${manifest.dataset.revision}`;
let documents = getDevelopmentDocuments(manifest);
if (requestedObjectId) {
  const anyDocument = manifest.documents.find((document) => document.objectId === requestedObjectId);
  if (!anyDocument) throw new Error(`Unknown corpus object ID ${requestedObjectId}.`);
  if (anyDocument.split !== 'development') throw new Error('Holdout documents are unavailable in the development baseline.');
  documents = documents.filter((document) => document.objectId === requestedObjectId);
}
if (requestedPage !== undefined) {
  if (documents.length !== 1) throw new Error('--page requires one --document-id.');
  if (!documents[0].pages.some((page) => page.pageNumber === requestedPage)) throw new Error('Requested page is not nominated by the development manifest.');
  documents = [{ ...documents[0], pages: documents[0].pages.filter((page) => page.pageNumber === requestedPage) }];
}

const runRoot = join(dataRoot, 'runs', runId);
const invocationId = `${Date.now()}-${process.pid}-${randomBytes(6).toString('hex')}`;
const invocationRelativePath = join('invocations', `${invocationId}.json`);
const invocationPath = join(runRoot, invocationRelativePath);
const lockPath = join(runRoot, '.lock');
let lock;

const implementation = await workspaceIdentity(root);
if (implementation.dirty && !process.argv.includes('--allow-dirty')) {
  throw new Error('Reference baselines must run from a clean workspace (dirty:false). Commit first, or pass --allow-dirty for non-reference experiments.');
}
const packageMetadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const lockfileHash = await sha256File(join(root, 'package-lock.json'));
const pinsPath = join(root, 'service/sidecar/model-pins.json');
const pinsHash = await sha256File(pinsPath);

// One sidecar engine for the whole run, warmed before the profile is
// frozen so the descriptor's ep/version reflect the child's own testimony.
const adapter = createPpOcrSidecarAdapter({ modelsDir, threads });
const warmupStarted = performance.now();
await adapter.warmup();
const warmupMs = Math.round(performance.now() - warmupStarted);
const sidecarMeta = adapter.sidecarMeta;
const backendDescriptor = adapter.backend;
const actualBackend = backendDescriptor.executionProvider;
const sidecarSession = {
  sessionId: `${Date.now()}-${randomBytes(6).toString('hex')}`,
  startedAt: new Date().toISOString(),
  kind: 'sidecar',
  launcher: 'uv run --with paddleocr==3.7.0 --with paddlepaddle==3.2.1 python',
  platform: sidecarMeta.platform,
  paddleocr: sidecarMeta.versions?.paddleocr ?? 'unknown',
  paddlepaddle: sidecarMeta.versions?.paddlepaddle ?? 'unknown',
  ep: actualBackend,
  threads,
  modelPins: backendDescriptor.modelPins,
  warmupMs,
  backend: actualBackend
};

const profile = {
  id: 'pdf-inspector-ppocrv6-sidecar-service-v1',
  nativeAdapter: 'pdf-inspector-markdown-pdfjs-geometry@1.14.2+pdfjs.5.5.207',
  renderer: 'pdftoppm+pdfjs-geometry',
  ocrAdapter: adapter.descriptor,
  ocrVariant: 'small',
  // Browser-harness features the service path does not have; absent by
  // design in this era's records, not by omission.
  regionRecovery: false,
  unreadInkAnalysis: false,
  backendPolicy: 'sidecar-truthful-per-host',
  renderScale,
  threads,
  documentTimeoutMs,
  maxBytes: 256 * 1024 * 1024,
  maxPages: 2_000
};
const commonFingerprint = {
  corpusId,
  manifestHash,
  datasetRevision: manifest.dataset.revision,
  implementation,
  lockfileHash,
  pinsHash,
  packages: { pagespatial: packageMetadata.version },
  profile
};
const eventsPath = join(runRoot, 'events.ndjson');
const startedAt = new Date().toISOString();
const summaries = [];
let failures = 0;
let eventLogFailures = 0;

async function safeEvent(type, detail = {}) {
  try {
    await appendJsonLine(eventsPath, { at: new Date().toISOString(), type, ...detail });
  } catch (error) {
    eventLogFailures += 1;
    console.error(`Could not retain evaluation event ${type}: ${sanitizedFailure(error, 'event-log').message}`);
  }
}

function pageFingerprint(document, pageNumber) {
  return stableFingerprint({
    ...commonFingerprint,
    objectId: document.objectId,
    sourceSha256: document.sha256,
    pageCount: document.pageCount,
    selectedPages: document.pages.map((page) => page.pageNumber),
    pageNumber,
    actualBackend
  });
}

async function readPriorSummary(path, expectedSha256) {
  try {
    if (!path || !expectedSha256 || await sha256File(path) !== expectedSha256) return new Map();
    const summary = JSON.parse(await readFile(path, 'utf8'));
    return new Map((summary.pages ?? [])
      .filter((page) => ['succeeded', 'resumed'].includes(page.status) && typeof page.outputSha256 === 'string')
      .map((page) => [page.pageNumber, page]));
  } catch {
    return new Map();
  }
}

async function readPriorInvocation() {
  try {
    const pointer = JSON.parse(await readFile(join(runRoot, 'current.json'), 'utf8'));
    if (!pointer.invocation || !pointer.sha256) return null;
    const path = join(runRoot, pointer.invocation);
    if (await sha256File(path) !== pointer.sha256) return null;
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function retainAttempt(documentRoot, pageNumber, envelope) {
  attemptEnvelopeSchema.parse(envelope);
  const path = join(documentRoot, 'attempts', `${String(pageNumber).padStart(6, '0')}/${Date.now()}-${randomBytes(6).toString('hex')}.json`);
  await atomicCreateJson(path, envelope);
  return { attemptPath: relative(runRoot, path), attemptSha256: await sha256File(path) };
}

async function verifiedCorpusFile(corpusRoot, path, expectedSha256) {
  const rootReal = await realpath(corpusRoot);
  const state = await lstat(path);
  if (state.isSymbolicLink() || !state.isFile()) throw new Error('Materialized PDF must be a regular non-symlink file.');
  const fileReal = await realpath(path);
  const rel = relative(rootReal, fileReal);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Materialized PDF resolves outside the corpus root.');
  if (await sha256File(fileReal) !== expectedSha256) throw new Error('Materialized PDF SHA-256 differs from the corpus manifest.');
  return fileReal;
}

function envelopeCommon(document, pageSelection) {
  return {
    schemaVersion: 1,
    runId,
    fingerprint: pageFingerprint(document, pageSelection.pageNumber),
    corpusId,
    manifestHash,
    dataset: manifest.dataset,
    objectId: document.objectId,
    path: document.path,
    source: { sha256: document.sha256, pageCount: document.pageCount },
    pageNumber: pageSelection.pageNumber,
    labels: pageSelection.labels
  };
}

async function writeFailureEnvelope({ document, pageSelection, documentRoot, status, error, stage }) {
  const failure = sanitizedFailure(error, stage);
  const envelope = {
    ...envelopeCommon(document, pageSelection),
    status,
    backend: { actual: actualBackend, events: [] },
    runtime: sidecarSession,
    failure
  };
  const retained = await retainAttempt(documentRoot, pageSelection.pageNumber, envelope);
  const envelopePath = join(documentRoot, 'pages', `${String(pageSelection.pageNumber).padStart(6, '0')}.json`);
  await atomicWriteJson(envelopePath, envelope);
  return { pageNumber: pageSelection.pageNumber, status, failure, ...retained };
}

await mkdir(runRoot, { recursive: true, mode: 0o700 });
lock = await open(lockPath, 'wx', 0o600).catch((error) => {
  if (error?.code === 'EEXIST') throw new Error(`Run ${runId} is already active or requires explicit lock cleanup.`);
  throw error;
});

try {
  await safeEvent('run_started', { runId, documentCount: documents.length, pageCount: documents.reduce((sum, document) => sum + document.pages.length, 0) });
  const priorInvocation = await readPriorInvocation();
  const priorDocumentById = new Map((priorInvocation?.documents ?? []).map((document) => [document.objectId, document]));
  const corpusRoot = join(dataRoot, 'corpus');
  const verifiedPaths = new Map();
  for (const document of documents) {
    verifiedPaths.set(document.objectId, await verifiedCorpusFile(corpusRoot, join(corpusRoot, document.path), document.sha256));
  }

  for (const document of documents) {
    const documentStarted = performance.now();
    const documentRoot = join(runRoot, 'documents', safeObjectId(document.objectId));
    const pagesRoot = join(documentRoot, 'pages');
    const summaryRelativePath = join('invocations', invocationId, 'documents', `${safeObjectId(document.objectId)}.json`);
    const summaryPath = join(runRoot, summaryRelativePath);
    await mkdir(pagesRoot, { recursive: true, mode: 0o700 });
    const pageStates = [];
    const deadline = Date.now() + documentTimeoutMs;
    const priorDocument = priorDocumentById.get(document.objectId);
    const priorPages = await readPriorSummary(
      priorDocument?.summary ? join(runRoot, priorDocument.summary) : undefined,
      priorDocument?.sha256
    );
    await safeEvent('document_started', { objectId: document.objectId });
    const pendingPages = [];
    for (const pageSelection of document.pages) {
      const pageNumber = pageSelection.pageNumber;
      const prior = priorPages.get(pageNumber);
      const resumable = await resumablePage(
        join(pagesRoot, `${String(pageNumber).padStart(6, '0')}.json`),
        pageFingerprint(document, pageNumber),
        { objectId: document.objectId, sha256: document.sha256, pageNumber, actualBackend, outputSha256: prior?.outputSha256 }
      );
      if (!resumable) {
        pendingPages.push(pageSelection);
        continue;
      }
      pageStates.push({
        pageNumber,
        status: 'resumed',
        outputSha256: resumable.outputSha256,
        ...(prior?.attemptPath ? { attemptPath: prior.attemptPath, attemptSha256: prior.attemptSha256 } : {})
      });
      await safeEvent('page_resumed', { objectId: document.objectId, pageNumber });
    }

    let context;
    try {
      if (pendingPages.length > 0) {
        context = await openDocumentContext(verifiedPaths.get(document.objectId), {
          documentId: document.objectId,
          revisionId: `sha256:${document.sha256}`,
          sourceUri: `hf://datasets/${manifest.dataset.repoId}@${manifest.dataset.revision}/${document.path}`,
          maxBytes: profile.maxBytes,
          maxPages: profile.maxPages
        });
        if (context.identity.sha256 !== document.sha256) throw new Error('Opened document identity differs from the corpus manifest.');
      }
      for (const pageSelection of pendingPages) {
        const pageNumber = pageSelection.pageNumber;
        const pageStarted = performance.now();
        let stage = 'render';
        try {
          if (Date.now() > deadline) {
            const timeout = new Error(`Document exceeded ${documentTimeoutMs} ms.`);
            timeout.name = 'TimeoutError';
            throw timeout;
          }
          const rendered = await renderStage(context, pageNumber, renderScale);
          stage = 'native-extraction';
          const native = await nativeStage(context, pageNumber);
          stage = 'sidecar-ocr';
          const ocr = await ocrStage(adapter, rendered.value, pageNumber);
          stage = 'page-assembly';
          const assembled = await assemblyStage(context, pageNumber, adapter, native.value, rendered.value.renderedPage, ocr.value, {
            runId,
            ocrAdapterId: adapter.descriptor,
            configuration: { renderScale, ocrBackend: adapter.backend }
          });
          const envelope = {
            ...envelopeCommon(document, pageSelection),
            status: 'succeeded',
            backend: { actual: actualBackend, events: [] },
            timings: {
              inspectorPageMs: native.ms,
              renderMs: rendered.ms,
              ocrMs: ocr.ms,
              pageTotalMs: performance.now() - pageStarted,
              assemblyMs: assembled.ms,
              ...(assembled.value.secondOpinionMs === undefined ? {} : { secondOpinionMs: assembled.value.secondOpinionMs })
            },
            memory: { nodeRssBytes: process.memoryUsage().rss, browser: null },
            runtime: sidecarSession,
            goldMetrics: 'not_evaluated',
            pageSpatial: assembled.value.pageSpatial
          };
          const retained = await retainAttempt(documentRoot, pageNumber, envelope);
          const envelopePath = join(pagesRoot, `${String(pageNumber).padStart(6, '0')}.json`);
          await atomicWriteJson(envelopePath, envelope);
          const outputSha256 = await sha256File(envelopePath);
          pageStates.push({ pageNumber, status: 'succeeded', outputSha256, ...retained });
          await safeEvent('page_succeeded', { objectId: document.objectId, pageNumber, outputSha256, ...retained });
        } catch (error) {
          failures += 1;
          const status = error?.name === 'TimeoutError' ? 'timed_out' : 'failed';
          const failed = await writeFailureEnvelope({ document, pageSelection, documentRoot, status, error, stage });
          pageStates.push(failed);
          await safeEvent('page_failed', { objectId: document.objectId, pageNumber, status, stage, error: failed.failure, attemptPath: failed.attemptPath });
        }
      }
    } catch (error) {
      const status = error?.name === 'TimeoutError' ? 'timed_out' : 'failed';
      const completed = new Set(pageStates.map((page) => page.pageNumber));
      for (const pageSelection of document.pages.filter((page) => !completed.has(page.pageNumber))) {
        failures += 1;
        pageStates.push(await writeFailureEnvelope({ document, pageSelection, documentRoot, status, error, stage: 'document-open' }));
      }
      await safeEvent('document_failed', { objectId: document.objectId, status, error: sanitizedFailure(error, 'document-open') });
    } finally {
      await context?.dispose().catch(() => undefined);
    }

    pageStates.sort((left, right) => left.pageNumber - right.pageNumber);
    const summary = {
      schemaVersion: 1,
      objectId: document.objectId,
      path: document.path,
      sha256: document.sha256,
      pageCount: document.pageCount,
      selectedPages: document.pages.map((page) => page.pageNumber),
      inspector: null,
      wallMs: performance.now() - documentStarted,
      pages: pageStates
    };
    documentSummarySchema.parse(summary);
    await atomicWriteJson(summaryPath, summary);
    const summarySha256 = await sha256File(summaryPath);
    summaries.push({ ...summary, summarySha256, summaryRelativePath });
    await safeEvent('document_finished', { objectId: document.objectId, summarySha256 });
    console.log(`${document.objectId}: ${pageStates.filter((page) => ['succeeded', 'resumed'].includes(page.status)).length}/${pageStates.length} pages`);
  }

  const run = {
    schemaVersion: 1,
    runId,
    status: failures ? 'completed_with_failures' : 'completed',
    startedAt,
    endedAt: new Date().toISOString(),
    corpus: { corpusId, manifestPath: 'evaluation/corpus.v1.json', manifestHash, dataset: manifest.dataset, accessScope: 'development-only' },
    implementation,
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpu: { model: cpus()[0]?.model ?? 'unknown', logicalCores: cpus().length },
      totalMemoryBytes: totalmem(),
      browserSessions: [],
      sidecarSessions: [sidecarSession]
    },
    packages: { pagespatial: packageMetadata.version },
    profile,
    documents: summaries.map((summary) => ({ objectId: summary.objectId, summary: summary.summaryRelativePath, sha256: summary.summarySha256 })),
    totals: {
      documents: summaries.length,
      pagesExpected: documents.reduce((sum, document) => sum + document.pages.length, 0),
      pagesTerminal: summaries.reduce((sum, summary) => sum + summary.pages.length, 0),
      executed: summaries.flatMap((summary) => summary.pages).filter((page) => page.status !== 'resumed').length,
      resumed: summaries.flatMap((summary) => summary.pages).filter((page) => page.status === 'resumed').length,
      succeeded: summaries.flatMap((summary) => summary.pages).filter((page) => ['succeeded', 'resumed'].includes(page.status)).length,
      failures
    },
    eventLogFailures,
    goldMetrics: {
      ocrTextRecall: 'not_evaluated',
      criticalTokenRecall: 'not_evaluated',
      geometryPrecisionRecall: 'not_evaluated',
      readingOrder: 'not_evaluated',
      relationshipAccuracy: 'not_evaluated',
      retrievalAnswerQuality: 'not_evaluated',
      falseConfidenceRate: 'not_evaluated'
    }
  };
  runInvocationSchema.parse(run);
  await atomicCreateJson(invocationPath, run);
  const invocationSha256 = await sha256File(invocationPath);
  await atomicWriteJson(join(runRoot, 'current.json'), { schemaVersion: 1, invocation: invocationRelativePath, sha256: invocationSha256 });
  await safeEvent('run_finished', { status: run.status, failures });
  console.log(JSON.stringify({ runId, invocationId, runRoot, status: run.status, documents: summaries.length, failures, backend: actualBackend }, null, 2));
} catch (error) {
  await atomicCreateJson(invocationPath, {
    schemaVersion: 1,
    runId,
    status: 'aborted',
    startedAt,
    endedAt: new Date().toISOString(),
    failure: sanitizedFailure(error, 'run')
  }).then(async () => {
    const sha256 = await sha256File(invocationPath);
    await atomicWriteJson(join(runRoot, 'current.json'), { schemaVersion: 1, invocation: invocationRelativePath, sha256 });
  }).catch(() => undefined);
  throw error;
} finally {
  await adapter.dispose().catch(() => undefined);
  await lock?.close();
  await rm(lockPath, { force: true });
}

if (failures) process.exitCode = 1;

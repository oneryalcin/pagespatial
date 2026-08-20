import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { cpus, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { assemblePageSpatial } from '../../dist/page-parser.js';
import { pageSpatialSchema } from '../../dist/schema.js';
import { atomicCreateJson, atomicWriteJson, appendJsonLine, sha256File } from './lib/atomic-json.mjs';
import { startBrowserBridge } from './lib/browser-bridge.mjs';
import { stableFingerprint, workspaceIdentity } from './lib/fingerprint.mjs';
import { getDevelopmentDocuments, loadCorpusManifest } from './lib/manifest.mjs';
import { resumablePage, safeObjectId, sanitizedFailure } from './lib/run-state.mjs';
import { attemptEnvelopeSchema, documentSummarySchema, runInvocationSchema } from './lib/run-schema.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const exec = promisify(execFile);
const valueFlags = new Set([
  '--data-root', '--ocr-assets', '--document-id', '--page', '--backend', '--ocr-variant', '--render-scale',
  '--page-timeout-ms', '--document-timeout-ms', '--run-id', '--browser-executable'
]);
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (!valueFlags.has(name)) throw new Error(`Unknown baseline argument: ${name}`);
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
}

function flag(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  if (!process.argv[index + 1]) throw new Error(`${name} requires a value.`);
  return process.argv[index + 1];
}

function positiveNumber(name, fallback) {
  const value = Number(flag(name, fallback));
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive.`);
  return value;
}

const dataRoot = resolve(flag('--data-root', join(root, '.evaluation')));
const ocrAssets = resolve(flag('--ocr-assets', join(dataRoot, 'ocr-assets')));
const manifestPath = join(root, 'evaluation/corpus.v1.json');
const requestedObjectId = flag('--document-id');
const requestedPage = flag('--page') === undefined ? undefined : positiveNumber('--page');
const backend = flag('--backend', 'wasm');
const ocrVariant = flag('--ocr-variant', 'tiny');
if (!['tiny', 'small'].includes(ocrVariant)) throw new Error('--ocr-variant must be tiny or small.');
if (!['wasm', 'webgpu', 'auto'].includes(backend)) throw new Error('--backend must be wasm, webgpu, or auto.');
const renderScale = positiveNumber('--render-scale', 1.6);
const pageTimeoutMs = positiveNumber('--page-timeout-ms', 120_000);
const documentTimeoutMs = positiveNumber('--document-timeout-ms', 30 * 60_000);
const runId = flag('--run-id', `dev-${new Date().toISOString().replace(/[:.]/gu, '-')}`);
const browserExecutable = resolve(flag('--browser-executable', process.env.PAGESPATIAL_CHROME_EXECUTABLE ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
if (!/^[A-Za-z0-9._-]+$/u.test(runId)) throw new Error('--run-id contains unsupported characters.');

const loaded = await loadCorpusManifest(manifestPath);
const manifest = loaded.manifest ?? loaded;
const manifestHash = loaded.hash ?? await sha256File(manifestPath);
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
const packageMetadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const lockfileHash = await sha256File(join(root, 'package-lock.json'));
await exec(process.execPath, [join(root, 'scripts/prepare-ppocr-assets.mjs'), '--verify', '--manifest', join(root, 'assets', `ppocrv6-${ocrVariant}.manifest.json`), '--output', ocrAssets], {
  cwd: root,
  maxBuffer: 4 * 1024 * 1024
});
const assetManifestPath = join(ocrAssets, 'manifest.json');
const assetManifest = JSON.parse(await readFile(assetManifestPath, 'utf8'));
const assetManifestHash = await sha256File(assetManifestPath);
const nativeAdapterIdentity = 'pdf-inspector-markdown-pdfjs-geometry@1.14.2+pdfjs.5.5.207';
const profile = {
  id: 'pdf-inspector-ppocrv6-selected-pages-v1',
  nativeAdapter: nativeAdapterIdentity,
  renderer: 'pdfjs-dist@5.5.207',
  ocrAdapter: '@paddleocr/paddleocr-js@0.4.2',
  ocrVariant,
  backendPolicy: backend,
  renderScale,
  detectorLimit: 960,
  recognitionThreshold: 0.25,
  recognitionBatchSize: 6,
  pageConcurrency: 1,
  ocrConcurrency: 1,
  pageTimeoutMs,
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
  assetManifestHash,
  packages: { pagespatial: packageMetadata.version, ...assetManifest.packages },
  profile
};
const eventsPath = join(runRoot, 'events.ndjson');
const startedAt = new Date().toISOString();
const summaries = [];
const browserSessions = [];
let currentBrowserSession;
let browserBridge;
let failures = 0;
let eventLogFailures = 0;

async function event(type, detail = {}) {
  await appendJsonLine(eventsPath, { at: new Date().toISOString(), type, ...detail });
}

async function safeEvent(type, detail = {}) {
  try {
    await event(type, detail);
  } catch (error) {
    eventLogFailures += 1;
    console.error(`Could not retain evaluation event ${type}: ${sanitizedFailure(error, 'event-log').message}`);
  }
}

function pageFingerprint(document, pageNumber, actualBackend) {
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

function attemptName(pageNumber) {
  return `${String(pageNumber).padStart(6, '0')}/${Date.now()}-${randomBytes(6).toString('hex')}.json`;
}

async function retainAttempt(documentRoot, pageNumber, envelope) {
  attemptEnvelopeSchema.parse(envelope);
  const path = join(documentRoot, 'attempts', attemptName(pageNumber));
  await atomicCreateJson(path, envelope);
  return { attemptPath: relative(runRoot, path), attemptSha256: await sha256File(path) };
}

function partialEvidence(pageNumber, browserPage, nativeRecord) {
  if (!browserPage && nativeRecord?.status !== 'succeeded') return undefined;
  if (browserPage) {
    if (browserPage.renderedPageNumber !== pageNumber) throw new Error('Partial rendered page has a mismatched page number.');
    if (browserPage.ocr?.pageNumber !== pageNumber || browserPage.ocr.observations?.some((item) => item.pageNumber !== pageNumber)) {
      throw new Error('Partial OCR evidence has a mismatched page number.');
    }
  }
  if (nativeRecord?.status === 'succeeded' && (nativeRecord.nativePage?.pageNumber !== pageNumber || nativeRecord.nativePage.observations?.some((item) => item.pageNumber !== pageNumber))) {
    throw new Error('Partial native evidence has a mismatched page number.');
  }
  return {
    ...(browserPage ? {
      renderedPage: { pageNumber: browserPage.renderedPageNumber, geometry: browserPage.geometry },
      ocrPage: browserPage.ocr
    } : {}),
    ...(nativeRecord?.status === 'succeeded' ? { nativePage: nativeRecord.nativePage } : {})
  };
}

async function writeFailureEnvelope({ document, pageSelection, documentRoot, status, error, stage, browserPage, nativeRecord }) {
  const pageNumber = pageSelection.pageNumber;
  const partial = partialEvidence(pageNumber, browserPage, nativeRecord);
  const actualBackend = browserPage?.backend;
  const failed = {
    schemaVersion: 1,
    status,
    runId,
    fingerprint: pageFingerprint(document, pageNumber, actualBackend ?? null),
    corpusId,
    manifestHash,
    dataset: manifest.dataset,
    objectId: document.objectId,
    path: document.path,
    source: { sha256: document.sha256, pageCount: document.pageCount },
    pageNumber,
    labels: pageSelection.labels,
    ...(actualBackend ? { backend: { actual: actualBackend, events: browserPage.backendEvents } } : {}),
    ...(currentBrowserSession ? { runtime: currentBrowserSession } : {}),
    ...(browserPage?.timings ? { timings: browserPage.timings } : {}),
    ...(partial ? { partialEvidence: partial } : {}),
    failure: sanitizedFailure(error, stage, Boolean(partial))
  };
  const retained = await retainAttempt(documentRoot, pageNumber, failed);
  return {
    pageNumber,
    status,
    ...retained,
    failure: failed.failure
  };
}

async function verifiedCorpusFile(corpusRoot, path, expectedSha256) {
  const rootReal = await realpath(corpusRoot);
  const state = await lstat(path);
  if (state.isSymbolicLink() || !state.isFile()) throw new Error('Materialized PDF must be a regular non-symlink file.');
  const fileReal = await realpath(path);
  const rel = relative(rootReal, fileReal);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Materialized PDF resolves outside the corpus root.');
  const sourceHash = await sha256File(fileReal);
  if (sourceHash !== expectedSha256) throw new Error('Materialized PDF SHA-256 differs from the corpus manifest.');
  return fileReal;
}

async function runInspector(document, pdfPath, documentRoot, timeoutMs) {
  const nonce = randomBytes(8).toString('hex');
  const inputPath = join(documentRoot, `.inspector-${nonce}.input.json`);
  const outputPath = join(documentRoot, `.inspector-${nonce}.output.json`);
  await atomicWriteJson(inputPath, {
    objectId: document.objectId,
    datasetPath: document.path,
    pdfPath,
    sha256: document.sha256,
    pageCount: document.pageCount,
    pages: document.pages.map((page) => page.pageNumber),
    maxBytes: profile.maxBytes,
    maxPages: profile.maxPages
  });
  const child = spawn(process.execPath, [join(root, 'scripts/evaluation/inspect-document-worker.mjs'), inputPath, outputPath], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { if (stderr.length < 16_384) stderr += chunk; });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 5_000).unref();
  }, timeoutMs);
  try {
    const code = await new Promise((resolveExit, reject) => {
      child.once('error', reject);
      child.once('exit', resolveExit);
    });
    if (timedOut) throw new DOMException(`PDF Inspector exceeded ${timeoutMs} ms.`, 'TimeoutError');
    if (code !== 0) throw new Error(`PDF Inspector child failed with exit ${code}: ${stderr.replace(/(?:hf_[A-Za-z0-9]+|https?:\/\/[^\s]+\?[^\s]+)/gu, '[redacted]').trim()}`);
    const result = JSON.parse(await readFile(outputPath, 'utf8'));
    if (result.objectId !== document.objectId || result.sha256 !== document.sha256 || result.pageCount !== document.pageCount) {
      throw new Error('PDF Inspector child returned mismatched source identity.');
    }
    if (!Array.isArray(result.pages) || result.pages.length !== document.pages.length) throw new Error('PDF Inspector child returned an incomplete page set.');
    return result;
  } finally {
    clearTimeout(timer);
    await rm(inputPath, { force: true });
    await rm(outputPath, { force: true });
  }
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
  const routeMap = {};
  for (const document of documents) {
    const path = await verifiedCorpusFile(corpusRoot, join(corpusRoot, document.path), document.sha256);
    verifiedPaths.set(document.objectId, path);
    routeMap[stableFingerprint([runId, document.objectId, document.sha256])] = path;
  }
  const routeMapPath = join(runRoot, 'route-map.json');
  await atomicWriteJson(routeMapPath, routeMap);

  for (const document of documents) {
    const documentStarted = performance.now();
    const documentRoot = join(runRoot, 'documents', safeObjectId(document.objectId));
    const pagesRoot = join(documentRoot, 'pages');
    const summaryRelativePath = join('invocations', invocationId, 'documents', `${safeObjectId(document.objectId)}.json`);
    const summaryPath = join(runRoot, summaryRelativePath);
    await mkdir(pagesRoot, { recursive: true, mode: 0o700 });
    const pdfPath = join(dataRoot, 'corpus', document.path);
    const pageStates = [];
    const deadline = Date.now() + documentTimeoutMs;
    const priorDocument = priorDocumentById.get(document.objectId);
    const priorPages = await readPriorSummary(
      priorDocument?.summary ? join(runRoot, priorDocument.summary) : undefined,
      priorDocument?.sha256
    );
    await safeEvent('document_started', { objectId: document.objectId });
    let inspector;
    const pendingPages = [];
    try {
      for (const pageSelection of document.pages) {
        const pageNumber = pageSelection.pageNumber;
        const prior = priorPages.get(pageNumber);
        const envelopePath = join(pagesRoot, `${String(pageNumber).padStart(6, '0')}.json`);
        const resumable = backend === 'auto' ? null : await resumablePage(
          envelopePath,
          pageFingerprint(document, pageNumber, backend),
          {
            objectId: document.objectId,
            sha256: document.sha256,
            pageNumber,
            actualBackend: backend,
            outputSha256: prior?.outputSha256
          }
        );
        if (!resumable) {
          pendingPages.push(pageSelection);
          continue;
        }
        if (resumable.envelope.runtime && !browserSessions.some(({ sessionId }) => sessionId === resumable.envelope.runtime.sessionId)) {
          browserSessions.push(resumable.envelope.runtime);
        }
        pageStates.push({
          pageNumber,
          status: 'resumed',
          outputSha256: resumable.outputSha256,
          ...(prior?.attemptPath ? { attemptPath: prior.attemptPath, attemptSha256: prior.attemptSha256 } : {})
        });
        await safeEvent('page_resumed', { objectId: document.objectId, pageNumber });
      }

      if (pendingPages.length === 0) {
        await safeEvent('document_runtime_skipped', { objectId: document.objectId, reason: 'all-pages-resumed' });
      } else {
        const pendingDocument = { ...document, pages: pendingPages };
        inspector = await runInspector(pendingDocument, verifiedPaths.get(document.objectId) ?? pdfPath, documentRoot, Math.max(1, deadline - Date.now()));
      if (!browserBridge || !browserBridge.isHealthy()) {
        await browserBridge?.stop().catch(() => undefined);
        browserBridge = await startBrowserBridge({
          root,
          routeMapPath,
          ocrAssets,
          backend,
          ocrVariant,
          pageTimeoutMs,
          warmupTimeoutMs: Math.max(pageTimeoutMs, 180_000),
          chromePath: browserExecutable
        });
        currentBrowserSession = {
          sessionId: `${Date.now()}-${randomBytes(6).toString('hex')}`,
          startedAt: new Date().toISOString(),
          ...browserBridge.getRuntimeInfo()
        };
        browserSessions.push(currentBrowserSession);
      }
      const routeToken = stableFingerprint([runId, document.objectId, document.sha256]);
      await browserBridge.call('openDocument', [routeToken, {
        documentId: document.objectId,
        revisionId: `sha256:${document.sha256}`,
        sha256: document.sha256,
        pageCount: document.pageCount,
        sourceUri: `hf://datasets/${manifest.dataset.repoId}@${manifest.dataset.revision}/${document.path}`
      }, { maxBytes: profile.maxBytes, maxPages: profile.maxPages }], Math.min(pageTimeoutMs, Math.max(1, deadline - Date.now())));

      for (const pageSelection of pendingPages) {
        const pageNumber = pageSelection.pageNumber;
        const envelopePath = join(pagesRoot, `${String(pageNumber).padStart(6, '0')}.json`);
        const pageStarted = performance.now();
        let stage = 'browser-ocr';
        let browserPage;
        let nativeRecord;
        try {
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw new DOMException(`Document exceeded ${documentTimeoutMs} ms.`, 'TimeoutError');
          browserPage = await browserBridge.call('ocrPage', [pageNumber, renderScale], Math.min(pageTimeoutMs, remaining));
          if (browserBridge.getExternalRequests().length) throw new Error('Browser attempted a non-loopback request.');
          stage = 'page-assembly';
          nativeRecord = inspector.pages.find((page) => page.pageNumber === pageNumber);
          if (!nativeRecord) throw new Error('Inspector output omitted the selected page.');
          if (nativeRecord.status === 'failed') {
            stage = 'native-extraction';
            const nativeError = new Error(nativeRecord.failure?.message ?? 'PDF Inspector failed for this page.');
            nativeError.name = nativeRecord.failure?.errorClass ?? 'Error';
            throw nativeError;
          }
          const createdAt = new Date().toISOString();
          const pageSpatial = assemblePageSpatial({
            document: {
              documentId: document.objectId,
              revisionId: `sha256:${document.sha256}`,
              sha256: document.sha256,
              pageCount: document.pageCount,
              sourceUri: `hf://datasets/${manifest.dataset.repoId}@${manifest.dataset.revision}/${document.path}`
            },
            pageNumber,
            nativePage: nativeRecord.nativePage,
            renderedPage: { pageNumber: browserPage.renderedPageNumber, geometry: browserPage.geometry },
            ocrPage: browserPage.ocr,
            runId,
            nativeAdapter: nativeAdapterIdentity,
            renderer: 'pdfjs-dist@5.5.207',
            ocrAdapter: '@paddleocr/paddleocr-js@0.4.2',
            createdAt,
            configuration: profile
          });
          pageSpatialSchema.parse(pageSpatial);
          if (backend !== 'auto' && browserPage.backend !== backend) throw new Error(`Requested ${backend} but OCR reported ${browserPage.backend}.`);
          const fingerprint = pageFingerprint(document, pageNumber, browserPage.backend);
          const envelope = {
            schemaVersion: 1,
            status: 'succeeded',
            runId,
            fingerprint,
            corpusId,
            manifestHash,
            dataset: manifest.dataset,
            objectId: document.objectId,
            path: document.path,
            source: { sha256: document.sha256, pageCount: document.pageCount },
            pageNumber,
            labels: pageSelection.labels,
            backend: { actual: browserPage.backend, events: browserPage.backendEvents },
            timings: {
              inspectorPageMs: nativeRecord.extractMs,
              renderMs: browserPage.timings.renderMs,
              ocrMs: browserPage.timings.ocrMs,
              pageTotalMs: performance.now() - pageStarted
            },
            memory: { nodeRssBytes: process.memoryUsage().rss, browser: browserPage.memory },
            runtime: currentBrowserSession,
            goldMetrics: 'not_evaluated',
            pageSpatial
          };
          const retained = await retainAttempt(documentRoot, pageNumber, envelope);
          await atomicWriteJson(envelopePath, envelope);
          const outputSha256 = await sha256File(envelopePath);
          pageStates.push({ pageNumber, status: 'succeeded', outputSha256, ...retained });
          await safeEvent('page_succeeded', { objectId: document.objectId, pageNumber, outputSha256, ...retained });
        } catch (error) {
          failures += 1;
          const status = error?.name === 'TimeoutError' ? 'timed_out' : 'failed';
          const failed = await writeFailureEnvelope({
            document,
            pageSelection,
            documentRoot,
            status,
            error,
            stage,
            browserPage,
            nativeRecord
          });
          pageStates.push(failed);
          await safeEvent('page_failed', { objectId: document.objectId, pageNumber, status, stage, error: failed.failure, attemptPath: failed.attemptPath });
          if (!browserBridge.isHealthy()) break;
        }
      }
      await browserBridge.call('closeDocument', [], 10_000).catch(() => undefined);
      }
      const completed = new Set(pageStates.map((page) => page.pageNumber));
      for (const pageSelection of pendingPages.filter((page) => !completed.has(page.pageNumber))) {
        failures += 1;
        const error = new Error('The document browser runtime became unavailable before this page started.');
        pageStates.push(await writeFailureEnvelope({
          document, pageSelection, documentRoot, status: 'aborted', error, stage: 'document-runtime'
        }));
      }
    } catch (error) {
      const status = error?.name === 'TimeoutError' ? 'timed_out' : 'failed';
      const completed = new Set(pageStates.map((page) => page.pageNumber));
      for (const pageSelection of document.pages.filter((page) => !completed.has(page.pageNumber))) {
        failures += 1;
        pageStates.push(await writeFailureEnvelope({
          document, pageSelection, documentRoot, status, error, stage: 'document-preflight-or-inspector'
        }));
      }
      await safeEvent('document_failed', { objectId: document.objectId, status, error: sanitizedFailure(error, 'document-preflight-or-inspector') });
      if (browserBridge && !browserBridge.isHealthy()) {
        await browserBridge.stop().catch(() => undefined);
        browserBridge = undefined;
        currentBrowserSession = undefined;
      }
    }
    pageStates.sort((left, right) => left.pageNumber - right.pageNumber);
    const summary = {
      schemaVersion: 1,
      objectId: document.objectId,
      path: document.path,
      sha256: document.sha256,
      pageCount: document.pageCount,
      selectedPages: document.pages.map((page) => page.pageNumber),
      inspector: inspector ? { timings: inspector.timings, peakSampledRssBytes: inspector.peakSampledRssBytes } : null,
      wallMs: performance.now() - documentStarted,
      pages: pageStates
    };
    documentSummarySchema.parse(summary);
    await atomicWriteJson(summaryPath, summary);
    const summarySha256 = await sha256File(summaryPath);
    summaries.push({ ...summary, summarySha256, summaryRelativePath });
    await safeEvent('document_finished', { objectId: document.objectId, pageStates, summarySha256 });
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
      browserSessions
    },
    packages: { pagespatial: packageMetadata.version, ...assetManifest.packages },
    profile,
    documents: summaries.map((summary) => ({
      objectId: summary.objectId,
      summary: summary.summaryRelativePath,
      sha256: summary.summarySha256
    })),
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
  console.log(JSON.stringify({ runId, invocationId, runRoot, status: run.status, documents: summaries.length, failures }, null, 2));
} catch (error) {
  const aborted = {
    schemaVersion: 1,
    runId,
    status: 'aborted',
    startedAt,
    endedAt: new Date().toISOString(),
    failure: sanitizedFailure(error, 'run')
  };
  await atomicCreateJson(invocationPath, aborted).then(async () => {
    const sha256 = await sha256File(invocationPath);
    await atomicWriteJson(join(runRoot, 'current.json'), { schemaVersion: 1, invocation: invocationRelativePath, sha256 });
  }).catch(() => undefined);
  throw error;
} finally {
  await browserBridge?.stop().catch(() => undefined);
  await lock?.close();
  await rm(lockPath, { force: true });
}

if (failures) process.exitCode = 1;

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { lstat, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { createValidDocument, fixtureIdentity } from './fixture.mjs';
import { atomicCreateJson, atomicWriteJson, sha256File } from '../scripts/evaluation/lib/atomic-json.mjs';
import { generateBaselineSummary } from '../scripts/evaluation/generate-baseline-summary.mjs';
import { stableFingerprint } from '../scripts/evaluation/lib/fingerprint.mjs';
import { resumablePage, safeObjectId, sanitizedFailure } from '../scripts/evaluation/lib/run-state.mjs';
import { loadCorpusManifest } from '../scripts/evaluation/lib/manifest.mjs';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');

async function availablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

test('fingerprints are canonical and failure records do not leak signed URLs', () => {
  assert.equal(stableFingerprint({ b: 2, a: [1, { d: 4, c: 3 }] }), stableFingerprint({ a: [1, { c: 3, d: 4 }], b: 2 }));
  assert.match(sanitizedFailure(new Error('failed https://example.test/file?token=secret'), 'ocr').message, /\[redacted\]/u);
  assert.equal(sanitizedFailure(new Error('partial'), 'assembly', true).partialEvidence, true);
  assert.equal(safeObjectId('repo:path/unsafe'), 'repo_path_unsafe');
});

test('resume requires a valid PageSpatial envelope and the prior summary hash', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pagespatial-resume-'));
  try {
    const path = join(directory, 'page.json');
    const document = await createValidDocument();
    const fingerprint = stableFingerprint({ fixture: true });
    await atomicWriteJson(path, {
      status: 'succeeded',
      fingerprint,
      objectId: fixtureIdentity.documentId,
      source: { sha256: fixtureIdentity.sha256 },
      pageNumber: 1,
      backend: { actual: 'wasm' },
      pageSpatial: document.pages[0]
    });
    const outputSha256 = await sha256File(path);
    assert.ok(await resumablePage(path, fingerprint, {
      objectId: fixtureIdentity.documentId,
      sha256: fixtureIdentity.sha256,
      pageNumber: 1,
      actualBackend: 'wasm',
      outputSha256
    }));
    assert.equal(await resumablePage(path, fingerprint, {
      objectId: fixtureIdentity.documentId,
      sha256: fixtureIdentity.sha256,
      pageNumber: 1,
      actualBackend: 'wasm',
      outputSha256: '0'.repeat(64)
    }), null);
    assert.equal(await resumablePage(path, fingerprint, {
      objectId: fixtureIdentity.documentId,
      sha256: fixtureIdentity.sha256,
      pageNumber: 1,
      actualBackend: 'wasm'
    }), null);
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    parsed.pageSpatial.geometry.width = -1;
    await atomicWriteJson(path, parsed);
    assert.equal(await resumablePage(path, fingerprint, {
      objectId: fixtureIdentity.documentId,
      sha256: fixtureIdentity.sha256,
      pageNumber: 1,
      actualBackend: 'wasm',
      outputSha256: await sha256File(path)
    }), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('baseline rejects a holdout object and alternate manifests before data or asset access', async () => {
  const { manifest } = await loadCorpusManifest();
  const holdout = manifest.documents.find(({ split }) => split === 'holdout');
  await assert.rejects(exec(process.execPath, [
    'scripts/evaluation/run-baseline.mjs', '--document-id', holdout.objectId,
    '--data-root', join(tmpdir(), 'pagespatial-must-not-exist')
  ], { cwd: root }), /Holdout documents are unavailable/u);
  await assert.rejects(exec(process.execPath, [
    'scripts/evaluation/run-baseline.mjs', '--manifest', '/tmp/alternate.json'
  ], { cwd: root }), /Unknown baseline argument/u);
});

test('baseline preflight failure cannot leave a stale run lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pagespatial-lock-'));
  try {
    await assert.rejects(exec(process.execPath, [
      'scripts/evaluation/run-baseline.mjs',
      '--data-root', directory,
      '--ocr-assets', join(directory, 'missing-assets'),
      '--document-id', 'pa-sers:2024-09-24:llr-vii:staff-memo',
      '--page', '1', '--backend', 'wasm', '--run-id', 'lock-check'
    ], { cwd: root }));
    await assert.rejects(lstat(join(directory, 'runs', 'lock-check', '.lock')), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('npm package excludes evaluation corpus definitions and private runtime paths', async () => {
  const cache = await mkdtemp(join(tmpdir(), 'pagespatial-npm-cache-'));
  try {
    const { stdout } = await exec('npm', ['pack', '--dry-run', '--json'], {
      cwd: root,
      env: { ...process.env, npm_config_cache: cache },
      maxBuffer: 16 * 1024 * 1024
    });
    const [pack] = JSON.parse(stdout);
    const paths = pack.files.map(({ path }) => path);
    assert.equal(paths.some((path) => path.startsWith('evaluation/')), false);
    assert.equal(paths.some((path) => path.startsWith('.evaluation/')), false);
    assert.equal(paths.some((path) => path.endsWith('.pdf') || path.endsWith('.ndjson')), false);
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
});

test('immutable attempts cannot be replaced and the aggregate verifies the full artifact graph', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pagespatial-aggregate-'));
  try {
    const document = await createValidDocument();
    const page = document.pages[0];
    const documentRoot = join(directory, 'documents', 'fixture');
    const attemptRelative = join('documents', 'fixture', 'attempts', '000001', 'attempt.json');
    const attemptPath = join(directory, attemptRelative);
    const canonicalPath = join(documentRoot, 'pages', '000001.json');
    const envelope = {
      schemaVersion: 1, status: 'succeeded', runId: 'fixture', fingerprint: 'c'.repeat(64),
      corpusId: 'fixture-corpus', manifestHash: 'a'.repeat(64),
      dataset: { repoType: 'dataset', repoId: 'fixture/repo', revision: 'revision' },
      objectId: fixtureIdentity.documentId, path: 'raw/fixture.pdf',
      source: { sha256: fixtureIdentity.sha256, pageCount: 1 }, pageNumber: 1, labels: ['fixture'],
      backend: { actual: 'wasm', events: [] },
      runtime: {
        sessionId: 'fixture-session', startedAt: '2026-08-19T00:00:00.000Z', browser: 'Chromium', browserVersion: '1',
        executablePath: '/home/alice/company-tools/chrome', userAgent: null, gpu: null, warmupMs: 1, backend: 'wasm'
      },
      timings: { inspectorPageMs: 1, renderMs: 2, ocrMs: 12, pageTotalMs: 15 },
      memory: { nodeRssBytes: 1, browser: null }, goldMetrics: 'not_evaluated', pageSpatial: page
    };
    await atomicCreateJson(attemptPath, envelope);
    await assert.rejects(atomicCreateJson(attemptPath, { replaced: true }), { code: 'EEXIST' });
    await atomicWriteJson(canonicalPath, envelope);
    const state = {
      pageNumber: 1,
      status: 'resumed',
      attemptPath: attemptRelative,
      attemptSha256: await sha256File(attemptPath),
      outputSha256: await sha256File(canonicalPath)
    };
    const summaryPath = join(documentRoot, 'summary.json');
    await atomicWriteJson(summaryPath, {
      schemaVersion: 1, objectId: fixtureIdentity.documentId, path: 'raw/fixture.pdf', sha256: fixtureIdentity.sha256,
      pageCount: 1, selectedPages: [1], inspector: null, wallMs: 15, pages: [state]
    });
    const runPath = join(directory, 'invocations', 'first.json');
    await atomicWriteJson(runPath, {
      schemaVersion: 1, runId: 'fixture', status: 'completed',
      startedAt: '2026-08-19T00:00:00.000Z', endedAt: '2026-08-19T00:00:01.000Z',
      corpus: { corpusId: 'fixture-corpus', manifestPath: 'evaluation/corpus.v1.json', manifestHash: 'a'.repeat(64), dataset: { repoType: 'dataset', repoId: 'fixture/repo', revision: 'revision' }, accessScope: 'development-only' },
      implementation: { commit: 'd'.repeat(40), dirty: true, workspaceHash: 'b'.repeat(64), files: 1 },
      environment: {
        node: process.version, platform: process.platform, arch: process.arch,
        cpu: { model: 'fixture', logicalCores: 1 }, totalMemoryBytes: 1,
        browserSessions: []
      },
      packages: { pagespatial: '0.1.0' }, profile: { backendPolicy: 'wasm' },
      documents: [{
        objectId: fixtureIdentity.documentId,
        summary: 'documents/fixture/summary.json',
        sha256: await sha256File(summaryPath)
      }],
      totals: { documents: 1, pagesExpected: 1, pagesTerminal: 1, executed: 0, resumed: 1, succeeded: 1, failures: 0 },
      eventLogFailures: 0,
      goldMetrics: { ocrTextRecall: 'not_evaluated' }
    });
    await atomicWriteJson(join(directory, 'current.json'), {
      invocation: 'invocations/first.json',
      sha256: await sha256File(runPath)
    });
    const output = join(directory, 'aggregate.json');
    const aggregate = await generateBaselineSummary({ runRoot: directory, output });
    assert.deepEqual(aggregate.pages, { expected: 1, ocrCompleted: 1, pageSpatialSucceeded: 1, failedClosed: 0 });
    assert.equal(aggregate.artifactGraph.contentHashesVerified, true);
    assert.equal(JSON.stringify(aggregate).includes('/home/alice'), false);
    assert.equal(aggregate.environment.browserSessions[0].executableLabel, 'chrome');
    assert.deepEqual(aggregate.execution, { executed: 0, resumed: 1 });
    const secondRunPath = join(directory, 'invocations', 'second.json');
    await atomicCreateJson(secondRunPath, { status: 'aborted', documents: [], totals: { pagesTerminal: 0 } });
    await atomicWriteJson(join(directory, 'current.json'), {
      invocation: 'invocations/second.json',
      sha256: await sha256File(secondRunPath)
    });
    const historical = await generateBaselineSummary({ runRoot: directory, output, invocation: runPath });
    assert.equal(historical.privateRunSummaryPath, 'invocations/first.json');
    await assert.rejects(generateBaselineSummary({ runRoot: directory, output, invocation: secondRunPath }));
    await atomicWriteJson(attemptPath, { ...envelope, pageNumber: 2 });
    await assert.rejects(generateBaselineSummary({ runRoot: directory, output, invocation: runPath }), /Artifact hash mismatch/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('evaluation Vite server cannot expose repository or private files through /@fs/', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pagespatial-vite-security-'));
  const port = await availablePort();
  const routeMap = join(directory, 'routes.json');
  const assets = join(directory, 'assets');
  await mkdir(assets);
  await atomicWriteJson(routeMap, {});
  const child = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), '--config', join(root, 'evaluation/browser/vite.config.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      PAGESPATIAL_CORPUS_ROUTE_MAP: routeMap,
      PAGESPATIAL_CORPUS_OCR_ASSETS: assets,
      PAGESPATIAL_CORPUS_PORT: String(port)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  try {
    const deadline = Date.now() + 10_000;
    while (true) {
      if (child.exitCode !== null) throw new Error(`Vite exited: ${output}`);
      if (Date.now() > deadline) throw new Error(`Vite did not start: ${output}`);
      try {
        const ready = await fetch(`http://127.0.0.1:${port}/`);
        if (ready.ok) break;
      } catch {
        // The loopback listener is not ready yet.
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
    const response = await fetch(`http://127.0.0.1:${port}/@fs/${join(root, 'evaluation/corpus.v1.json')}`);
    assert.notEqual(response.status, 200);
    const privateResponse = await fetch(`http://127.0.0.1:${port}/@fs/${join(directory, 'secret.pdf')}`);
    assert.notEqual(privateResponse.status, 200);
  } finally {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolveExit) => child.once('exit', resolveExit)),
      new Promise((resolveDelay) => setTimeout(resolveDelay, 3_000))
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  }
});

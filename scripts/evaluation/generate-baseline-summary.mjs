#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pageSpatialSchema } from '../../dist/schema.js';
import { atomicWriteJson, sha256File } from './lib/atomic-json.mjs';
import { attemptEnvelopeSchema, documentSummarySchema, runInvocationSchema } from './lib/run-schema.mjs';

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!['--run-root', '--output', '--invocation'].includes(name) || !value || value.startsWith('--')) throw new Error(`Invalid aggregate argument ${name}.`);
    options[name.slice(2)] = resolve(value);
  }
  if (!options['run-root'] || !options.output) throw new Error('--run-root and --output are required.');
  return { runRoot: options['run-root'], output: options.output, invocation: options.invocation };
}

function inside(root, path) {
  const candidate = resolve(root, path);
  const rel = relative(root, candidate);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Artifact path escapes the run root.');
  return candidate;
}

async function readHashedJson(root, relativePath, expectedHash) {
  const path = inside(root, relativePath);
  const actual = await sha256File(path);
  if (actual !== expectedHash) throw new Error(`Artifact hash mismatch: ${relativePath}`);
  return { path, value: JSON.parse(await readFile(path, 'utf8')) };
}

function percentile(values, ratio) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function classifyFailure(envelope) {
  const message = envelope.failure?.message ?? '';
  if (/rotat/iu.test(message)) return 'unsupported-rotated-native-geometry';
  if (/outside|out.of.bounds|bounds/iu.test(message)) return 'native-geometry-out-of-bounds';
  if (envelope.status === 'timed_out') return 'timeout';
  if (envelope.status === 'aborted') return 'aborted';
  return envelope.failure?.stage ?? 'other';
}

export async function generateBaselineSummary({ runRoot, output, invocation }) {
  const root = resolve(runRoot);
  let runPath;
  let expectedRunHash;
  if (invocation) {
    runPath = inside(root, relative(root, resolve(invocation)));
  } else {
    const pointer = JSON.parse(await readFile(join(root, 'current.json'), 'utf8'));
    runPath = inside(root, pointer.invocation);
    expectedRunHash = pointer.sha256;
  }
  if (expectedRunHash && await sha256File(runPath) !== expectedRunHash) throw new Error('Current invocation pointer hash mismatch.');
  const run = JSON.parse(await readFile(runPath, 'utf8'));
  runInvocationSchema.parse(run);
  const runSha256 = await sha256File(runPath);
  const generatorSha256 = await sha256File(fileURLToPath(import.meta.url));
  const envelopes = [];
  for (const document of run.documents ?? []) {
    const { value: summary } = await readHashedJson(root, document.summary, document.sha256);
    documentSummarySchema.parse(summary);
    if (summary.objectId !== document.objectId) throw new Error('Document summary identity mismatch.');
    for (const page of summary.pages ?? []) {
      if (!page.attemptPath || !page.attemptSha256) throw new Error(`Page ${summary.objectId}:${page.pageNumber} lacks an immutable attempt reference.`);
      const { value: envelope } = await readHashedJson(root, page.attemptPath, page.attemptSha256);
      attemptEnvelopeSchema.parse(envelope);
      if (envelope.objectId !== summary.objectId || envelope.pageNumber !== page.pageNumber) throw new Error('Page attempt identity mismatch.');
      if (envelope.status !== (page.status === 'resumed' ? 'succeeded' : page.status)) throw new Error('Page attempt status mismatch.');
      if (['succeeded', 'resumed'].includes(page.status)) {
        pageSpatialSchema.parse(envelope.pageSpatial);
        if (page.outputSha256 !== page.attemptSha256) throw new Error('Accepted page and immutable successful attempt differ.');
      }
      envelopes.push({ state: page, envelope });
    }
  }
  if (envelopes.length !== run.totals?.pagesTerminal) throw new Error('Run terminal-page total does not match the artifact graph.');

  const accepted = envelopes.filter(({ state }) => ['succeeded', 'resumed'].includes(state.status));
  const failed = envelopes.length - accepted.length;
  if (accepted.length !== run.totals.succeeded || failed !== run.totals.failures) throw new Error('Run success/failure totals do not match the artifact graph.');
  const ocrCompleted = envelopes.filter(({ envelope }) => envelope.pageSpatial?.ocrObservations || envelope.partialEvidence?.ocrPage).length;
  const ocrTimes = envelopes.map(({ envelope }) => envelope.timings?.ocrMs).filter(Number.isFinite);
  const coverage = accepted.map(({ envelope }) => {
    const ocr = envelope.pageSpatial.ocrObservations.length;
    return ocr ? envelope.pageSpatial.sourceMatches.length / ocr : 0;
  });
  const backendCounts = Object.fromEntries([...new Set(envelopes.map(({ envelope }) => envelope.backend?.actual).filter(Boolean))]
    .sort().map((name) => [name, envelopes.filter(({ envelope }) => envelope.backend?.actual === name).length]));
  const failureGroups = new Map();
  for (const { envelope } of envelopes.filter(({ state }) => !['succeeded', 'resumed'].includes(state.status))) {
    const classification = classifyFailure(envelope);
    const group = failureGroups.get(classification) ?? { class: classification, pages: 0, objectIds: new Set(), pageNumbers: new Set() };
    group.pages += 1;
    group.objectIds.add(envelope.objectId);
    group.pageNumbers.add(envelope.pageNumber);
    failureGroups.set(classification, group);
  }

  const aggregate = {
    schemaVersion: 'pagespatial-development-baseline-summary-v2',
    generator: { version: 1, scriptSha256: generatorSha256, runImplementation: run.implementation },
    runId: run.runId,
    datasetRevision: run.corpus.dataset.revision,
    manifestSha256: run.corpus.manifestHash,
    workspaceSha256: run.implementation.workspaceHash,
    privateRunSummarySha256: runSha256,
    privateRunSummaryPath: relative(root, runPath),
    artifactGraph: { documents: run.documents.length, terminalPageAttempts: envelopes.length, contentHashesVerified: true },
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    environment: {
      ...run.environment,
      browserSessions: [...new Map([
        ...run.environment.browserSessions,
        ...(run.environment.sidecarSessions ?? []),
        ...envelopes.map(({ envelope }) => envelope.runtime).filter(Boolean)
      ].map((session) => [session.sessionId, session])).values()].map(({ executablePath, ...session }) => ({
        ...session,
        // Browser sessions carry an executable path; sidecar sessions (the
        // adopted witness era) identify themselves by launcher instead.
        executableLabel: executablePath ? basename(executablePath) : (session.launcher ?? session.kind ?? 'runtime')
      }))
    },
    execution: { executed: run.totals.executed, resumed: run.totals.resumed },
    documents: run.documents.length,
    pages: {
      expected: run.totals.pagesExpected,
      ocrCompleted,
      pageSpatialSucceeded: accepted.length,
      failedClosed: envelopes.length - accepted.length
    },
    backend: backendCounts,
    successfulPageEvidence: {
      nativeObservations: accepted.reduce((sum, { envelope }) => sum + envelope.pageSpatial.nativeObservations.length, 0),
      ocrObservations: accepted.reduce((sum, { envelope }) => sum + envelope.pageSpatial.ocrObservations.length, 0),
      sourceMatches: accepted.reduce((sum, { envelope }) => sum + envelope.pageSpatial.sourceMatches.length, 0),
      criticalConflicts: accepted.reduce((sum, { envelope }) => sum + envelope.pageSpatial.conflicts.length, 0),
      pagesRequiringEscalation: accepted.filter(({ envelope }) => envelope.pageSpatial.diagnostics.requiresEscalation).length
    },
    ocrTimingMs: {
      total: ocrTimes.reduce((sum, value) => sum + value, 0),
      p50: percentile(ocrTimes, 0.5),
      p95: percentile(ocrTimes, 0.95),
      max: ocrTimes.length ? Math.max(...ocrTimes) : null
    },
    associationCoverageDiagnostic: {
      pages: coverage.length,
      mean: coverage.length ? coverage.reduce((sum, value) => sum + value, 0) / coverage.length : null,
      p50: percentile(coverage, 0.5),
      min: coverage.length ? Math.min(...coverage) : null,
      max: coverage.length ? Math.max(...coverage) : null,
      isAccuracy: false
    },
    failures: [...failureGroups.values()].sort((a, b) => a.class.localeCompare(b.class)).map((group) => ({
      class: group.class,
      documents: group.objectIds.size,
      pages: group.pages,
      objectIds: [...group.objectIds].sort(),
      pageNumbers: [...group.pageNumbers].sort((a, b) => a - b),
      cases: envelopes
        .filter(({ state, envelope }) => !['succeeded', 'resumed'].includes(state.status) && classifyFailure(envelope) === group.class)
        .map(({ envelope }) => ({ objectId: envelope.objectId, pageNumber: envelope.pageNumber }))
        .sort((left, right) => left.objectId.localeCompare(right.objectId) || left.pageNumber - right.pageNumber)
    })),
    goldMetrics: 'not_evaluated'
  };
  await atomicWriteJson(output, aggregate);
  return aggregate;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const aggregate = await generateBaselineSummary(options);
  console.log(JSON.stringify({ output: options.output, runId: aggregate.runId, pages: aggregate.pages }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

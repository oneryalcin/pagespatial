#!/usr/bin/env node

/**
 * Score one complete 50-page CPU control against one complete 50-page GPU
 * candidate. Raw OCR evidence may differ. Adoption requires that no newly
 * incorrect, missing, or unresolved critical value enters trusted output.
 *
 * Usage:
 *   node scripts/evaluation/score_gpu_a2.mjs \
 *     --cpu .evaluation/.../cpu-repeat-1.json \
 *     --gpu .evaluation/.../gpu-repeat-1.json \
 *     [--adjudications evaluation/gpu-spike/a2-adjudications-v1.json] \
 *     --output .evaluation/.../a2-correctness.json
 */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  canonicalJson,
  stableDeterministicProjection
} from './lib/modal-comparator.mjs';
import { criticalTokenDifferences } from './score_gpu_merged_output.mjs';

export const SCHEMA_VERSION = 'pagespatial-gpu-a2-score-v1';
const EXPECTED_PAGES = 50;

function argument(name, { required = true } = {}) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  if (!required) return undefined;
  throw new Error(`${name} is required`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function blockingTypes(page) {
  return (page.diagnostics?.escalationReasons ?? [])
    .filter((reason) => reason.severity === 'blocking')
    .map((reason) => reason.type)
    .sort();
}

function ocrLines(page) {
  return (page.ocrObservations ?? []).map((observation) => ({
    text: observation.text,
    box: observation.box,
    score: observation.confidence ?? null
  }));
}

function crossEngineDeterministicProjection(page) {
  const projection = stableDeterministicProjection(page);
  if (projection.provenance) {
    // These fields truthfully identify the engine being compared. They are
    // expected to differ and are not deterministic document evidence.
    const { ocrAdapter, backend, configuration, ...shared } = projection.provenance;
    projection.provenance = shared;
  }
  return projection;
}

function runPageCount(run) {
  return run.page_count ?? run.pageCount;
}

function normalizeRun(run, label) {
  if (run?.status !== 'completed') throw new Error(`${label} is not terminal completed.`);
  if (runPageCount(run) !== EXPECTED_PAGES || !Array.isArray(run.pages) || run.pages.length !== EXPECTED_PAGES) {
    throw new Error(`${label} must contain exactly ${EXPECTED_PAGES} terminal pages.`);
  }
  if (run.pages_failed !== undefined && run.pages_failed !== 0) {
    throw new Error(`${label} reports failed terminal pages.`);
  }
  if (run.pages_ok !== undefined && run.pages_ok !== EXPECTED_PAGES) {
    throw new Error(`${label} reports an incorrect successful-page count.`);
  }

  const pages = run.pages.map((entry, index) => {
    const expected = index + 1;
    if (entry?.ok !== true || entry.pageNumber !== expected || entry.pageSpatial?.pageNumber !== expected) {
      throw new Error(`${label} page ${expected} is missing, failed, duplicated, or out of order.`);
    }
    if (typeof entry.pageSpatial.diagnostics?.requiresEscalation !== 'boolean' ||
        !Array.isArray(entry.pageSpatial.diagnostics?.escalationReasons)) {
      throw new Error(`${label} page ${expected} lacks a valid escalation state.`);
    }
    if (entry.pageSpatial.diagnostics.requiresEscalation !==
        (entry.pageSpatial.diagnostics.escalationReasons.length > 0)) {
      throw new Error(`${label} page ${expected} has an inconsistent escalation state.`);
    }
    return entry.pageSpatial;
  });
  const first = pages[0];
  const identity = {
    documentId: first.documentId,
    revisionId: first.revisionId,
    sha256: first.documentSha256,
    pageCount: runPageCount(run)
  };
  if (!identity.documentId || !identity.revisionId || !/^[0-9a-f]{64}$/u.test(identity.sha256)) {
    throw new Error(`${label} lacks a complete document identity.`);
  }
  for (const page of pages) {
    if (page.documentId !== identity.documentId || page.revisionId !== identity.revisionId ||
        page.documentSha256 !== identity.sha256) {
      throw new Error(`${label} page identities are inconsistent.`);
    }
  }
  const topSha = run.document_sha256 ?? run.document?.sha256;
  if (topSha !== undefined && topSha !== identity.sha256) {
    throw new Error(`${label} top-level document identity disagrees with its pages.`);
  }
  if (run.document) {
    const topIdentity = {
      documentId: run.document.documentId,
      revisionId: run.document.revisionId,
      sha256: run.document.sha256,
      pageCount: run.document.pageCount
    };
    if (!isDeepStrictEqual(topIdentity, identity)) {
      throw new Error(`${label} top-level document identity disagrees with its pages.`);
    }
  }
  return { identity, pages };
}

function adjudicationKey(pageNumber, side, difference) {
  return `${pageNumber}\u0000${side}\u0000${difference.token}\u0000${difference.occurrence}`;
}

function adjudicationIndex(adjudications, identity) {
  if (!adjudications) return new Map();
  if (adjudications.schemaVersion !== 'pagespatial-gpu-a2-adjudications-v1') {
    throw new Error(`Unsupported adjudication schema ${adjudications.schemaVersion}.`);
  }
  if (adjudications.documentSha256 !== identity.sha256 || !Array.isArray(adjudications.values)) {
    throw new Error('A2 adjudications do not match the scored document.');
  }
  const entries = new Map();
  for (const value of adjudications.values) {
    const key = `${value.pageNumber}\u0000${value.side}\u0000${value.token}\u0000${value.occurrence}`;
    if (entries.has(key)) throw new Error(`Duplicate adjudication ${key}.`);
    entries.set(key, value);
  }
  return entries;
}

function scoreDifference({ difference, side, pageNumber, trusted, adjudications, identity, used }) {
  const base = {
    token: difference.token,
    occurrence: difference.occurrence,
    observationBox: difference.box
  };
  if (!trusted) return { ...base, status: 'unreviewed-escalated', verdict: 'unreviewed' };
  const key = adjudicationKey(pageNumber, side, difference);
  const adjudication = adjudications.get(key);
  if (!adjudication) return { ...base, status: 'pending-source-adjudication', verdict: 'pending' };
  const allowed = side === 'candidate'
    ? ['correct', 'incorrect', 'unsure']
    : ['removed-incorrect', 'missing', 'unsure'];
  if (!allowed.includes(adjudication.verdict)) {
    throw new Error(`Unsupported ${side} adjudication verdict ${adjudication.verdict}.`);
  }
  const source = adjudication.source;
  if (source?.documentSha256 !== identity.sha256 || source?.pageNumber !== pageNumber ||
      typeof source?.observation !== 'string' || !source.observation.trim() ||
      !Array.isArray(source.observationBox) || source.observationBox.length !== 4 ||
      !source.observationBox.every((coordinate, index) =>
        Number.isFinite(coordinate) && Math.abs(coordinate - difference.box[index]) <= 0.01)) {
    throw new Error(`Adjudication ${key} is not bound to a source observation.`);
  }
  used.add(key);
  return {
    ...base,
    status: 'source-adjudicated',
    verdict: adjudication.verdict,
    source: source.observation
  };
}

export function evaluateGpuA2({ cpu, gpu, adjudications }) {
  const control = normalizeRun(cpu, 'CPU control');
  const candidate = normalizeRun(gpu, 'GPU candidate');
  if (!isDeepStrictEqual(control.identity, candidate.identity)) {
    throw new Error('CPU and GPU document identities differ.');
  }
  const reviews = adjudicationIndex(adjudications, control.identity);
  const usedReviews = new Set();
  const pages = [];

  for (let index = 0; index < EXPECTED_PAGES; index += 1) {
    const pageNumber = index + 1;
    const controlPage = control.pages[index];
    const candidatePage = candidate.pages[index];
    const controlLines = ocrLines(controlPage);
    const candidateLines = ocrLines(candidatePage);
    const differences = criticalTokenDifferences(controlLines, candidateLines);
    const controlBlocking = blockingTypes(controlPage);
    const candidateBlocking = blockingTypes(candidatePage);
    const clearedControlBlockingTypes = controlBlocking.filter((type) => !candidateBlocking.includes(type));
    const candidateTrusted = candidatePage.diagnostics.requiresEscalation === false;
    const candidateOnly = differences.candidateOnly.map((difference) => scoreDifference({
      difference, side: 'candidate', pageNumber, trusted: candidateTrusted,
      adjudications: reviews, identity: control.identity, used: usedReviews
    }));
    const controlOnly = differences.controlOnly.map((difference) => scoreDifference({
      difference, side: 'control', pageNumber, trusted: candidateTrusted,
      adjudications: reviews, identity: control.identity, used: usedReviews
    }));
    const deterministicExact = canonicalJson(crossEngineDeterministicProjection(controlPage))
      === canonicalJson(crossEngineDeterministicProjection(candidatePage));
    const rawEvidenceExact = canonicalJson(controlLines) === canonicalJson(candidateLines);
    if (!deterministicExact || !rawEvidenceExact || candidateOnly.length || controlOnly.length ||
        clearedControlBlockingTypes.length) {
      pages.push({
        pageNumber,
        candidateTrusted,
        deterministicExact,
        rawEvidenceExact,
        controlBlocking,
        candidateBlocking,
        clearedControlBlockingTypes,
        candidateOnly,
        controlOnly
      });
    }
  }

  const unusedReviews = [...reviews.keys()].filter((key) => !usedReviews.has(key));
  if (unusedReviews.length) throw new Error(`Adjudications did not match scored differences: ${unusedReviews.join(', ')}`);
  const allCandidate = pages.flatMap((page) => page.candidateOnly.map((difference) => ({ page, difference })));
  const allControl = pages.flatMap((page) => page.controlOnly.map((difference) => ({ page, difference })));
  const newlyIncorrect = allCandidate.filter(({ page, difference }) =>
    page.candidateTrusted && difference.verdict === 'incorrect');
  const missing = allControl.filter(({ page, difference }) =>
    page.candidateTrusted && difference.verdict === 'missing');
  const unresolved = [...allCandidate, ...allControl].filter(({ page, difference }) =>
    page.candidateTrusted && ['pending', 'unsure'].includes(difference.verdict));
  const pending = [...allCandidate, ...allControl].filter(({ difference }) => difference.verdict === 'pending');
  const deterministicDifferingPages = pages.filter((page) => !page.deterministicExact).map((page) => page.pageNumber);
  const clearedControlBlockingRoutes = pages
    .filter((page) => page.clearedControlBlockingTypes.length > 0)
    .map((page) => ({ pageNumber: page.pageNumber, types: page.clearedControlBlockingTypes }));
  const pass = newlyIncorrect.length === 0 && missing.length === 0 && unresolved.length === 0
    && deterministicDifferingPages.length === 0 && clearedControlBlockingRoutes.length === 0;

  return {
    schemaVersion: SCHEMA_VERSION,
    acceptanceRule: 'zero newly incorrect, missing, or unresolved critical values in trusted non-escalated output; raw OCR evidence differences are allowed',
    document: control.identity,
    terminalPages: EXPECTED_PAGES,
    summary: {
      pass,
      pendingSourceAdjudications: pending.length,
      newlyIncorrectTrustedValues: newlyIncorrect.length,
      missingTrustedValues: missing.length,
      unresolvedTrustedValues: unresolved.length,
      candidateOnlyCriticalValues: allCandidate.length,
      controlOnlyCriticalValues: allControl.length,
      rawEvidenceDifferingPages: pages.filter((page) => !page.rawEvidenceExact).length,
      deterministicDifferingPages,
      clearedControlBlockingRoutes
    },
    pages
  };
}

function readJson(path) {
  const bytes = readFileSync(path);
  return { bytes, value: JSON.parse(bytes) };
}

function main() {
  const cpuPath = resolve(argument('--cpu'));
  const gpuPath = resolve(argument('--gpu'));
  const outputPath = resolve(argument('--output'));
  const adjudicationsPath = argument('--adjudications', { required: false });
  const cpu = readJson(cpuPath);
  const gpu = readJson(gpuPath);
  const reviews = adjudicationsPath ? readJson(resolve(adjudicationsPath)) : undefined;
  const report = evaluateGpuA2({ cpu: cpu.value, gpu: gpu.value, adjudications: reviews?.value });
  report.inputs = {
    cpuSha256: sha256(cpu.bytes),
    gpuSha256: sha256(gpu.bytes),
    adjudicationsSha256: reviews ? sha256(reviews.bytes) : null
  };
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  const state = report.summary.pass ? 'PASS' : report.summary.pendingSourceAdjudications ? 'PENDING' : 'FAIL';
  console.log(`${state}: wrote ${outputPath}`);
  if (!report.summary.pass) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();

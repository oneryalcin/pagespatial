#!/usr/bin/env node
/**
 * Replay retained GPU OCR lines through PageSpatial's real native/OCR merge.
 *
 * This scorer answers a consumer-safety question, not engine equivalence:
 * may raw OCR change while every newly incorrect critical value remains out
 * of trusted, non-escalated output?
 *
 * Usage:
 *   npm run build
 *   node scripts/evaluation/score_gpu_merged_output.mjs \
 *     --control .evaluation/gpu-spike/2026-08-24/trt-controls-comparison-v1/c-hpi-small.json \
 *     --candidate .evaluation/gpu-spike/2026-08-24/trt-controls-comparison-v1/g-trt-small-fp32.json \
 *     --run-root .evaluation/runs/dev-v13-sidecar-2026-08-23 \
 *     --manifest .evaluation/gpu-spike/english-diagnostic-v1/manifest.json \
 *     --adjudications evaluation/gpu-spike/merged-output-production-adjudications-v1.json \
 *     --output .evaluation/gpu-spike/2026-08-24/merged-output-small-fp32-vs-chpi-v1.json
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildPageSpatial, criticalTokens, criticalTokensCompatible } from '../../dist/index.js';

export const SCHEMA_VERSION = 'pagespatial-gpu-merged-output-v1';

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required argument ${name}`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function tokenOccurrences(lines) {
  return lines.flatMap((line, lineIndex) => criticalTokens(line.text).map((token, tokenIndex) => ({
    token,
    lineIndex,
    tokenIndex,
    box: line.box
  })));
}

function boxPairScore(left, right) {
  const x1 = Math.max(left[0], right[0]);
  const y1 = Math.max(left[1], right[1]);
  const x2 = Math.min(left[2], right[2]);
  const y2 = Math.min(left[3], right[3]);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const leftArea = Math.max(0, left[2] - left[0]) * Math.max(0, left[3] - left[1]);
  const rightArea = Math.max(0, right[2] - right[0]) * Math.max(0, right[3] - right[1]);
  const overlap = intersection / Math.max(1, Math.min(leftArea, rightArea));
  const leftCenter = [(left[0] + left[2]) / 2, (left[1] + left[3]) / 2];
  const rightCenter = [(right[0] + right[2]) / 2, (right[1] + right[3]) / 2];
  const distanceSquared = (leftCenter[0] - rightCenter[0]) ** 2 + (leftCenter[1] - rightCenter[1]) ** 2;
  return { overlap, distanceSquared };
}

function cancelTokenPairs(left, right, leftMatched, rightMatched, compatible) {
  const pairs = [];
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    if (leftMatched.has(leftIndex)) continue;
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      if (rightMatched.has(rightIndex) || !compatible(left[leftIndex].token, right[rightIndex].token)) continue;
      pairs.push({ leftIndex, rightIndex, ...boxPairScore(left[leftIndex].box, right[rightIndex].box) });
    }
  }
  pairs.sort((a, b) => b.overlap - a.overlap
    || a.distanceSquared - b.distanceSquared
    || a.leftIndex - b.leftIndex
    || a.rightIndex - b.rightIndex);
  for (const pair of pairs) {
    if (leftMatched.has(pair.leftIndex) || rightMatched.has(pair.rightIndex)) continue;
    leftMatched.add(pair.leftIndex);
    rightMatched.add(pair.rightIndex);
  }
}

function addUnmatchedOccurrences(entries) {
  const occurrenceByToken = new Map();
  return entries.map((entry) => {
    const occurrence = occurrenceByToken.get(entry.token) ?? 0;
    occurrenceByToken.set(entry.token, occurrence + 1);
    return { ...entry, occurrence };
  });
}

export function criticalTokenDifferences(controlLines, candidateLines) {
  const control = tokenOccurrences(controlLines);
  const candidate = tokenOccurrences(candidateLines);
  const controlMatched = new Set();
  const candidateMatched = new Set();
  cancelTokenPairs(control, candidate, controlMatched, candidateMatched, (left, right) => left === right);
  cancelTokenPairs(control, candidate, controlMatched, candidateMatched, criticalTokensCompatible);
  return {
    controlOnly: addUnmatchedOccurrences(control.filter((_, index) => !controlMatched.has(index))),
    candidateOnly: addUnmatchedOccurrences(candidate.filter((_, index) => !candidateMatched.has(index)))
  };
}

function blockingTypes(page) {
  return page.diagnostics.escalationReasons
    .filter((reason) => reason.severity === 'blocking')
    .map((reason) => reason.type)
    .sort();
}

function pageStratum(basePage) {
  const nativeStarved = basePage.nativeObservations.length === 0
    || basePage.diagnostics.escalationReasons.some((reason) => reason.type === 'uncorroborated-ocr');
  return nativeStarved ? 'native-starved' : 'native-backed';
}

function scaleBox(box, scaleX, scaleY) {
  return [box[0] * scaleX, box[1] * scaleY, box[2] * scaleX, box[3] * scaleY];
}

function diagnosticOptions(basePage) {
  const thresholds = basePage.diagnostics.thresholds;
  return {
    lowOcrConfidence: thresholds.lowOcrConfidence,
    minimumRelationConfidence: thresholds.minimumRelationConfidence,
    maximumRelationAmbiguity: thresholds.maximumRelationAmbiguity,
    uncorroboratedOcrMinimumCount: thresholds.uncorroboratedOcrMinimumCount,
    uncorroboratedOcrMaximumCoverage: thresholds.uncorroboratedOcrMaximumCoverage
  };
}

export function rebuildPage({ record, lines, manifestPage, arm, repeat }) {
  const base = record.pageSpatial;
  const scaleX = base.geometry.width / manifestPage.pngWidth;
  const scaleY = base.geometry.height / manifestPage.pngHeight;
  const ocrObservations = lines.map((line, index) => ({
    id: `${arm}:${repeat}:${index}`,
    pageNumber: record.pageNumber,
    text: line.text,
    box: scaleBox(line.box, scaleX, scaleY),
    confidence: line.score,
    model: 'PP-OCRv6_small'
  }));
  return buildPageSpatial({
    document: {
      documentId: base.documentId,
      revisionId: base.revisionId,
      sha256: base.documentSha256,
      pageCount: record.source.pageCount
    },
    pageNumber: record.pageNumber,
    geometry: base.geometry,
    nativeObservations: base.nativeObservations,
    ocrObservations,
    unreadInkRegions: base.unreadInkRegions,
    secondOpinion: base.secondOpinion,
    provenance: {
      parserName: 'pagespatial-gpu-merged-output-eval',
      parserVersion: '1',
      runId: `${arm}:repeat-${repeat}`,
      createdAt: new Date(0).toISOString(),
      nativeAdapter: record.pageSpatial.provenance.nativeAdapter,
      renderer: record.pageSpatial.provenance.renderer,
      ocrAdapter: arm,
      backend: arm,
      configuration: { source: 'retained-gpu-lines', scaleX, scaleY }
    },
    diagnostics: diagnosticOptions(base)
  });
}

export function rebuildStoredPage(record) {
  const base = record.pageSpatial;
  return buildPageSpatial({
    document: {
      documentId: base.documentId,
      revisionId: base.revisionId,
      sha256: base.documentSha256,
      pageCount: record.source.pageCount
    },
    pageNumber: record.pageNumber,
    geometry: base.geometry,
    nativeObservations: base.nativeObservations,
    ocrObservations: base.ocrObservations,
    unreadInkRegions: base.unreadInkRegions,
    secondOpinion: base.secondOpinion,
    provenance: {
      parserName: 'pagespatial-gpu-merged-output-eval',
      parserVersion: '1',
      runId: 'baseline-merge-impact',
      createdAt: new Date(0).toISOString(),
      nativeAdapter: base.provenance.nativeAdapter,
      renderer: base.provenance.renderer,
      ocrAdapter: base.provenance.ocrAdapter,
      backend: base.provenance.backend,
      configuration: { source: 'retained-base-record' }
    },
    diagnostics: diagnosticOptions(base)
  });
}

export function scoreBaselineMergeImpact(baseRecords) {
  const pages = [...baseRecords.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([page, record]) => {
    const before = record.pageSpatial;
    const after = rebuildStoredPage(record);
    return {
      page,
      before: {
        nonEscalated: !before.diagnostics.requiresEscalation,
        blockingReasons: blockingTypes(before),
        criticalConflicts: before.diagnostics.criticalConflictCount,
        criticalOmissions: before.diagnostics.criticalOmissionCount
      },
      after: {
        nonEscalated: !after.diagnostics.requiresEscalation,
        blockingReasons: blockingTypes(after),
        criticalConflicts: after.diagnostics.criticalConflictCount,
        criticalOmissions: after.diagnostics.criticalOmissionCount
      }
    };
  });
  const changed = pages.filter((page) => JSON.stringify(page.before) !== JSON.stringify(page.after));
  const beforeBlocking = (page) => page.before.blockingReasons.length > 0;
  const afterBlocking = (page) => page.after.blockingReasons.length > 0;
  return {
    pages: pages.length,
    beforeNonEscalated: pages.filter((page) => page.before.nonEscalated).length,
    afterNonEscalated: pages.filter((page) => page.after.nonEscalated).length,
    newlyEscalated: pages.filter((page) => page.before.nonEscalated && !page.after.nonEscalated).map((page) => page.page),
    newlyNonEscalated: pages.filter((page) => !page.before.nonEscalated && page.after.nonEscalated).map((page) => page.page),
    blockingPagesBefore: pages.filter(beforeBlocking).length,
    blockingPagesAfter: pages.filter(afterBlocking).length,
    newlyBlocking: pages.filter((page) => !beforeBlocking(page) && afterBlocking(page)).map((page) => page.page),
    noLongerBlocking: pages.filter((page) => beforeBlocking(page) && !afterBlocking(page)).map((page) => page.page),
    criticalConflictsBefore: pages.reduce((sum, page) => sum + page.before.criticalConflicts, 0),
    criticalConflictsAfter: pages.reduce((sum, page) => sum + page.after.criticalConflicts, 0),
    changedPages: changed
  };
}

function sameBox(left, right, tolerance = 1.01) {
  return left.length === right.length && left.every((value, index) => Math.abs(value - right[index]) <= tolerance);
}

function summarizeStratum(rows, stratum) {
  const selected = rows.filter((row) => row.stratum === stratum);
  return {
    pages: selected.length,
    controlNonEscalated: selected.filter((row) => row.control.nonEscalated).length,
    candidateNonEscalated: selected.filter((row) => row.candidate.nonEscalated).length,
    newlyEscalated: selected.filter((row) => row.control.nonEscalated && !row.candidate.nonEscalated).length,
    newlyNonEscalated: selected.filter((row) => !row.control.nonEscalated && row.candidate.nonEscalated).length,
    candidateOnlyCriticalValues: selected.reduce((sum, row) => sum + row.candidateOnlyCritical.length, 0),
    controlOnlyCriticalValues: selected.reduce((sum, row) => sum + row.controlOnlyCritical.length, 0),
    incorrectCandidateValues: selected.reduce((sum, row) => sum
      + row.candidateOnlyCritical.filter((entry) => entry.verdict === 'incorrect').length, 0),
    incorrectTrustedValues: selected.reduce((sum, row) => sum
      + row.candidateOnlyCritical.filter((entry) => entry.verdict === 'incorrect' && row.candidate.nonEscalated).length, 0),
    unreviewedCandidateValues: selected.reduce((sum, row) => sum
      + row.candidateOnlyCritical.filter((entry) => entry.verdict === 'unreviewed').length, 0),
    unreviewedControlValues: selected.reduce((sum, row) => sum
      + row.controlOnlyCritical.filter((entry) => entry.verdict === 'unreviewed').length, 0),
    missingOrUnresolvedTrustedValues: selected.reduce((sum, row) => sum
      + row.controlOnlyCritical.filter((entry) => ['missing', 'unsure'].includes(entry.verdict)
        && row.candidate.nonEscalated).length, 0)
  };
}

function stableSummary(result) {
  return JSON.stringify({
    rows: result.pages.map((page) => ({
      page: page.page,
      stratum: page.stratum,
      control: page.control,
      candidate: page.candidate,
      candidateOnlyCritical: page.candidateOnlyCritical,
      controlOnlyCritical: page.controlOnlyCritical
    })),
    verdict: result.verdict
  });
}

export function evaluateMergedOutput({
  control,
  candidate,
  baseRecords,
  manifest,
  adjudications,
  adjudicationEvidenceHashes
}) {
  if (adjudications.schemaVersion !== 'pagespatial-gpu-merged-output-adjudications-v1') {
    throw new Error(`Unsupported adjudication schema ${adjudications.schemaVersion}`);
  }
  if (!control.arm?.name || !candidate.arm?.name) {
    throw new Error('Control and candidate must carry explicit arm.name provenance.');
  }
  if (control.repetitions.length !== candidate.repetitions.length || !control.repetitions.length) {
    throw new Error('Control and candidate must have the same non-zero repetition count.');
  }
  const manifestByPage = new Map(manifest.map((entry) => [entry.page, entry]));
  const adjudicationByKey = new Map(adjudications.values.map((entry) => [
    `${entry.page}\u0000${entry.side}\u0000${entry.token}\u0000${entry.occurrence}`,
    entry
  ]));
  if (adjudicationByKey.size !== adjudications.values.length) throw new Error('Duplicate adjudication key.');
  const observedAdjudications = new Set();
  const repetitions = [];

  for (let repeatIndex = 0; repeatIndex < control.repetitions.length; repeatIndex += 1) {
    const controlRepeat = control.repetitions[repeatIndex];
    const candidateRepeat = candidate.repetitions[repeatIndex];
    if (controlRepeat.repeat !== candidateRepeat.repeat) {
      throw new Error(`Control/candidate repeat identity mismatch at index ${repeatIndex}.`);
    }
    const controlByPage = new Map(controlRepeat.pages.map((page) => [page.page, page]));
    const candidateByPage = new Map(candidateRepeat.pages.map((page) => [page.page, page]));
    if (controlByPage.size !== controlRepeat.pages.length
      || candidateByPage.size !== candidateRepeat.pages.length
      || candidateByPage.size !== controlByPage.size) {
      throw new Error(`Control/candidate page set mismatch in repeat ${controlRepeat.repeat}.`);
    }
    const pages = [];

    for (const controlResult of [...controlRepeat.pages].sort((left, right) => left.page.localeCompare(right.page))) {
      const page = controlResult.page;
      const candidateResult = candidateByPage.get(page);
      const record = baseRecords.get(page);
      const manifestPage = manifestByPage.get(page);
      if (!candidateResult || !record || !manifestPage) throw new Error(`Missing candidate, base record, or manifest entry for ${page}.`);
      const controlPage = rebuildPage({
        record, lines: controlResult.lines, manifestPage, arm: control.arm.name, repeat: controlRepeat.repeat
      });
      const candidatePage = rebuildPage({
        record, lines: candidateResult.lines, manifestPage, arm: candidate.arm.name, repeat: candidateRepeat.repeat
      });
      const candidateIsTrusted = !candidatePage.diagnostics.requiresEscalation;
      const scoreDifference = (difference, side) => {
        const { token, occurrence, lineIndex } = difference;
        const key = `${page}\u0000${side}\u0000${token}\u0000${occurrence}`;
        const adjudication = adjudicationByKey.get(key);
        const sourcePage = side === 'candidate' ? candidatePage : controlPage;
        const sourceLines = side === 'candidate' ? candidateResult.lines : controlResult.lines;
        const sourceLine = sourceLines[lineIndex];
        const scaledSourceBox = scaleBox(
          sourceLine.box,
          record.pageSpatial.geometry.width / manifestPage.pngWidth,
          record.pageSpatial.geometry.height / manifestPage.pngHeight
        );
        const line = sourcePage.ocrObservations.find((observation) =>
          observation.text === sourceLine.text && sameBox(observation.box, scaledSourceBox));
        if (!line || !criticalTokens(line.text).includes(token)) {
          throw new Error(`${page}: ${side}-only token inventory lost its source observation.`);
        }
        if (!adjudication) {
          if (candidateIsTrusted) {
            throw new Error(`Unadjudicated ${side}-only critical value on trusted page ${page}: ${token} occurrence ${occurrence}.`);
          }
          return {
            token,
            occurrence,
            verdict: 'unreviewed',
            observationBox: line.box,
            sourceText: line.text,
            caughtByNativeConflict: false
          };
        }
        const allowedVerdicts = side === 'candidate'
          ? ['correct', 'incorrect', 'unsure']
          : ['removed-incorrect', 'missing', 'unsure'];
        if (!allowedVerdicts.includes(adjudication.verdict)) {
          throw new Error(`${page}: unsupported adjudication verdict ${adjudication.verdict}.`);
        }
        if (side === 'candidate' && adjudication.verdict === 'incorrect' && !adjudication.correctToken) {
          throw new Error(`${page}: incorrect adjudication requires correctToken.`);
        }
        if (side === 'control' && adjudication.verdict === 'removed-incorrect' && !adjudication.correctToken) {
          throw new Error(`${page}: removed-incorrect adjudication requires correctToken.`);
        }
        if (adjudication.inputSha256 !== manifestPage.sha256) {
          throw new Error(`${page}: adjudication input hash does not match frozen manifest.`);
        }
        if (!adjudication.adjudicationImage
          || adjudicationEvidenceHashes?.get(adjudication.adjudicationImage) !== adjudication.adjudicationImageSha256) {
          throw new Error(`${page}: adjudication evidence image hash does not match the retained file.`);
        }
        if (adjudication.documentSha256 !== record.pageSpatial.documentSha256) {
          throw new Error(`${page}: adjudication document hash does not match the base record.`);
        }
        if (!sameBox(line.box, scaleBox(
          adjudication.observationBox,
          record.pageSpatial.geometry.width / manifestPage.pngWidth,
          record.pageSpatial.geometry.height / manifestPage.pngHeight
        ))) {
          throw new Error(`${page}: adjudication box does not identify ${side}-only token ${token}.`);
        }
        const conflict = side === 'candidate'
          ? candidatePage.conflicts.find((entry) => entry.ocrId === line.id && entry.ocrCriticalTokens.includes(token))
          : undefined;
        const caughtByNativeConflict = Boolean(side === 'candidate' && conflict && adjudication.correctToken
          && conflict.nativeCriticalTokens.includes(adjudication.correctToken));
        observedAdjudications.add(key);
        return {
          token,
          occurrence,
          verdict: adjudication.verdict,
          correctToken: adjudication.correctToken ?? null,
          observationBox: line.box,
          sourceText: line.text,
          caughtByNativeConflict
        };
      };
      const tokenDifferences = criticalTokenDifferences(controlResult.lines, candidateResult.lines);
      const candidateOnlyCritical = tokenDifferences.candidateOnly
        .map((difference) => scoreDifference(difference, 'candidate'));
      const controlOnlyCritical = tokenDifferences.controlOnly
        .map((difference) => scoreDifference(difference, 'control'));
      const controlBlocking = blockingTypes(controlPage);
      const candidateBlocking = blockingTypes(candidatePage);
      pages.push({
        page,
        stratum: pageStratum(record.pageSpatial),
        control: {
          nonEscalated: !controlPage.diagnostics.requiresEscalation,
          blockingReasons: controlBlocking,
          criticalConflicts: controlPage.diagnostics.criticalConflictCount,
          criticalOmissions: controlPage.diagnostics.criticalOmissionCount
        },
        candidate: {
          nonEscalated: !candidatePage.diagnostics.requiresEscalation,
          blockingReasons: candidateBlocking,
          criticalConflicts: candidatePage.diagnostics.criticalConflictCount,
          criticalOmissions: candidatePage.diagnostics.criticalOmissionCount
        },
        candidateOnlyCritical,
        controlOnlyCritical
      });
    }

    const untrustedOrWrong = pages.flatMap((page) => page.candidateOnlyCritical.filter((entry) =>
      (entry.verdict === 'incorrect' || entry.verdict === 'unsure') && page.candidate.nonEscalated));
    const uncaughtNative = pages.flatMap((page) => page.candidateOnlyCritical.filter((entry) =>
      entry.verdict === 'incorrect' && entry.correctToken && !entry.caughtByNativeConflict));
    const missingOrUnresolved = pages.flatMap((page) => page.controlOnlyCritical.filter((entry) =>
      ['missing', 'unsure'].includes(entry.verdict) && page.candidate.nonEscalated));
    const clearedControlBlockingRoutes = pages.filter((page) =>
      page.control.blockingReasons.length > 0 && page.candidate.blockingReasons.length === 0);
    const verdict = {
      pass: untrustedOrWrong.length === 0
        && uncaughtNative.length === 0
        && missingOrUnresolved.length === 0
        && clearedControlBlockingRoutes.length === 0,
      incorrectOrUnresolvedTrustedValues: untrustedOrWrong.length,
      missingOrUnresolvedTrustedValues: missingOrUnresolved.length,
      incorrectValuesNotCaughtByNativeConflict: uncaughtNative.length,
      clearedControlBlockingRoutes: clearedControlBlockingRoutes.map((page) => page.page)
    };
    repetitions.push({
      repeat: candidateRepeat.repeat,
      pages,
      strata: {
        nativeBacked: summarizeStratum(pages, 'native-backed'),
        nativeStarved: summarizeStratum(pages, 'native-starved')
      },
      verdict
    });
  }

  const missingObserved = [...adjudicationByKey.keys()].filter((key) => !observedAdjudications.has(key));
  if (missingObserved.length) throw new Error(`Adjudications did not match retained output: ${missingObserved.join(', ')}`);
  const repeatConsistency = repetitions.every((result) => stableSummary(result) === stableSummary(repetitions[0]));
  return {
    schemaVersion: SCHEMA_VERSION,
    acceptanceRule: 'zero newly incorrect, missing, or unresolved critical values in trusted non-escalated output',
    adjudicationRule: 'every candidate-only or control-only value on a candidate non-escalated page is source-adjudicated; differences confined to escalated pages remain enumerated and unreviewed',
    stratumRule: 'frozen base page is native-starved when native is empty or diagnostics contains uncorroborated-ocr; otherwise native-backed',
    repeatConsistency,
    repetitions,
    verdict: {
      pass: repeatConsistency && repetitions.every((result) => result.verdict.pass),
      repeatConsistency,
      repeats: repetitions.length
    }
  };
}

export function loadBaseRecordEvidence(runRoot) {
  const records = new Map();
  const inputs = [];
  for (const document of readdirSync(join(runRoot, 'documents'))) {
    const pagesDir = join(runRoot, 'documents', document, 'pages');
    let pages;
    try { pages = readdirSync(pagesDir); } catch { continue; }
    for (const file of pages) {
      const bytes = readFileSync(join(pagesDir, file));
      const record = JSON.parse(bytes);
      if (record.pageSpatial) {
        const page = `${record.objectId}#${record.pageNumber}`;
        records.set(page, record);
        inputs.push({ page, sha256: sha256(bytes) });
      }
    }
  }
  inputs.sort((left, right) => left.page.localeCompare(right.page));
  return {
    records,
    evidence: {
      pages: inputs.length,
      aggregateSha256: sha256(Buffer.from(inputs.map((entry) => `${entry.page}\u0000${entry.sha256}`).join('\n'))),
      inputs
    }
  };
}

export function loadBaseRecords(runRoot) {
  return loadBaseRecordEvidence(runRoot).records;
}

function readJson(path) {
  const bytes = readFileSync(path);
  return { bytes, value: JSON.parse(bytes) };
}

function hashImplementation() {
  const distRoot = resolve('dist');
  const files = readdirSync(distRoot)
    .filter((file) => file.endsWith('.js'))
    .sort()
    .map((file) => ({ file: `dist/${file}`, sha256: sha256(readFileSync(join(distRoot, file))) }));
  return {
    scorer: sha256(readFileSync(fileURLToPath(import.meta.url))),
    distJsAggregateSha256: sha256(Buffer.from(files.map((entry) => `${entry.file}\u0000${entry.sha256}`).join('\n'))),
    distJsFiles: files,
    packageLock: sha256(readFileSync(resolve('package-lock.json'))),
    node: process.version,
    platform: process.platform,
    arch: process.arch
  };
}

function main() {
  const paths = {
    control: resolve(arg('--control')),
    candidate: resolve(arg('--candidate')),
    runRoot: resolve(arg('--run-root')),
    manifest: resolve(arg('--manifest')),
    adjudications: resolve(arg('--adjudications')),
    output: resolve(arg('--output'))
  };
  const control = readJson(paths.control);
  const candidate = readJson(paths.candidate);
  const manifest = readJson(paths.manifest);
  const adjudications = readJson(paths.adjudications);
  const base = loadBaseRecordEvidence(paths.runRoot);
  const baseRecords = base.records;
  const adjudicationEvidenceHashes = new Map(adjudications.value.values.map((entry) => {
    if (typeof entry.adjudicationImage !== 'string' || !entry.adjudicationImage) {
      throw new Error('Every adjudication must name its retained evidence image.');
    }
    const bytes = readFileSync(resolve(entry.adjudicationImage));
    return [entry.adjudicationImage, sha256(bytes)];
  }));
  const result = evaluateMergedOutput({
    control: control.value,
    candidate: candidate.value,
    baseRecords,
    manifest: manifest.value,
    adjudications: adjudications.value,
    adjudicationEvidenceHashes
  });
  result.baselineMergeImpact = scoreBaselineMergeImpact(baseRecords);
  result.inputs = {
    control: { file: basename(paths.control), sha256: sha256(control.bytes), arm: control.value.arm },
    candidate: { file: basename(paths.candidate), sha256: sha256(candidate.bytes), arm: candidate.value.arm },
    manifest: { file: basename(paths.manifest), sha256: sha256(manifest.bytes) },
    adjudications: { file: basename(paths.adjudications), sha256: sha256(adjudications.bytes) },
    baseRun: { name: basename(paths.runRoot), ...base.evidence },
    implementation: hashImplementation(),
    adjudicationEvidence: [...adjudicationEvidenceHashes.entries()]
      .map(([file, digest]) => ({ file, sha256: digest }))
      .sort((left, right) => left.file.localeCompare(right.file))
  };
  writeFileSync(paths.output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`${result.verdict.pass ? 'PASS' : 'FAIL'}: wrote ${paths.output}`);
  if (!result.verdict.pass) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();

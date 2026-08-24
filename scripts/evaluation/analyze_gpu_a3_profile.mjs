#!/usr/bin/env node

/**
 * Reduce one GPU A3 stage-profile run to a compact, fail-closed decision record.
 * Raw profiler events remain in the ignored evaluation archive; this artifact
 * records only the measurements needed to choose the next experiment.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SCHEMA_VERSION = 'pagespatial-gpu-a3-profile-analysis-v1';

const REQUIRED_STAGES = [
  'predict.total',
  'detector.total',
  'detector.backend',
  'detector.postprocess',
  'crop.total',
  'recognizer.total',
  'recognizer.preprocess.reisizenorm',
  'recognizer.preprocess.tobatch',
  'recognizer.backend',
  'recognizer.postprocess'
];

function round(value, digits = 3) {
  if (value === null || value === undefined) return null;
  return Number(Number(value).toFixed(digits));
}

function stageWall(summary, name) {
  const stage = summary?.[name];
  if (!stage || !Number.isFinite(stage.summedWallMs)) {
    throw new Error(`required stage ${name} is missing`);
  }
  return stage.summedWallMs;
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  if (ordered.length === 0) return null;
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function profileIdentities(run) {
  const identities = run.stageProfile?.identitiesByOwner;
  if (!Array.isArray(identities) || identities.length !== run.resources?.inferenceOwners) {
    throw new Error(`${run.runId} has incomplete profiler owner identities`);
  }
  for (const identity of identities) {
    if (identity.missingPaths?.length !== 0) {
      throw new Error(`${run.runId} has missing profiler paths: ${identity.missingPaths.join(', ')}`);
    }
  }
  return identities;
}

function summarizeRepeat(run) {
  if (run.status !== 'completed' || run.pageCount !== 50) {
    throw new Error(`${run.runId} is not a complete 50-page result`);
  }
  if (run.arm?.stageProfile !== true || !run.stageProfile) {
    throw new Error(`${run.runId} is not an A3 stage-profile result`);
  }
  profileIdentities(run);
  const summary = run.stageProfile.stageSummary;
  for (const stage of REQUIRED_STAGES) stageWall(summary, stage);

  const recognitionPreparationMs =
    stageWall(summary, 'recognizer.preprocess.read') +
    stageWall(summary, 'recognizer.preprocess.reisizenorm') +
    stageWall(summary, 'recognizer.preprocess.tobatch');
  const recognitionBackendMs = stageWall(summary, 'recognizer.backend');
  const recognitionPostprocessMs = stageWall(summary, 'recognizer.postprocess');
  const recognitionHostMs = recognitionPreparationMs + recognitionPostprocessMs;
  const detectorAndCropHostMs =
    stageWall(summary, 'detector.total') - stageWall(summary, 'detector.backend') +
    stageWall(summary, 'crop.total');
  const samples = run.gpuTelemetry?.samples ?? [];
  const utilization = samples.map((sample) => sample.gpuUtilPercent).filter(Number.isFinite);

  return {
    repeat: run.client?.repeat,
    runId: run.runId,
    containerId: run.client?.containerId,
    containerCold: run.method?.containerCold,
    controllerWallMs: round(run.timing.wallMs),
    controllerPagesPerS: round(run.timing.pagesPerS),
    methodWallMs: round(run.method.totalMethodMs),
    clientWallMs: round(run.client.spawnToResultS * 1000),
    serializedResultBytes: run.serializedResultBytes,
    gpuUtilization: {
      sampleCount: utilization.length,
      medianPercent: round(median(utilization)),
      maxPercent: round(utilization.length ? Math.max(...utilization) : null)
    },
    summedServiceMs: {
      predict: round(stageWall(summary, 'predict.total')),
      detectorBackend: round(stageWall(summary, 'detector.backend')),
      detectorPostprocess: round(stageWall(summary, 'detector.postprocess')),
      crop: round(stageWall(summary, 'crop.total')),
      recognitionPreparation: round(recognitionPreparationMs),
      recognitionBackend: round(recognitionBackendMs),
      recognitionPostprocess: round(recognitionPostprocessMs),
      recognitionHost: round(recognitionHostMs),
      detectorAndCropHost: round(detectorAndCropHostMs)
    },
    synchronousBackendOccupancyPercent: {
      recognition: round(run.stageProfile.backendOccupancy?.['recognizer.backend']?.occupancyPercent),
      combined: round(run.stageProfile.backendOccupancy?.combined?.occupancyPercent)
    }
  };
}

function correctnessSummary(path, expectedRepeat) {
  const score = JSON.parse(readFileSync(path, 'utf8'));
  if (score.schemaVersion !== 'pagespatial-gpu-a2-score-v1') {
    throw new Error(`${path} is not a GPU A2 score`);
  }
  return {
    repeat: expectedRepeat,
    pass: score.summary.pass,
    pendingSourceAdjudications: score.summary.pendingSourceAdjudications,
    newlyIncorrectTrustedValues: score.summary.newlyIncorrectTrustedValues,
    missingTrustedValues: score.summary.missingTrustedValues,
    unresolvedTrustedValues: score.summary.unresolvedTrustedValues,
    incorrectValuesNotCaughtByNativeConflict: score.summary.incorrectValuesNotCaughtByNativeConflict,
    deterministicDifferingPages: score.summary.deterministicDifferingPages
  };
}

export function analyzeProfileRuns(runs, correctness = []) {
  if (!Array.isArray(runs) || runs.length !== 4) {
    throw new Error('A3 analysis requires exactly four repeats');
  }
  const repeats = runs.map(summarizeRepeat).sort((left, right) => left.repeat - right.repeat);
  if (new Set(repeats.map((repeat) => repeat.repeat)).size !== 4) {
    throw new Error('A3 repeats are missing or duplicated');
  }

  const lifetimes = new Map();
  for (const repeat of repeats) {
    if (!repeat.containerId) throw new Error(`repeat ${repeat.repeat} lacks a container ID`);
    const values = lifetimes.get(repeat.containerId) ?? [];
    values.push(repeat);
    lifetimes.set(repeat.containerId, values);
  }
  const coldPattern = repeats.map((repeat) => repeat.containerCold);
  const validWarmWindow = lifetimes.size === 1 &&
    coldPattern[0] === true && coldPattern.slice(1).every((value) => value === false);
  const lifetimeGroups = [...lifetimes.entries()].map(([containerId, values]) => ({
    containerId,
    repeats: values.map((value) => value.repeat),
    coldPattern: values.map((value) => value.containerCold),
    warmRepeats: values.filter((value) => !value.containerCold).map((value) => value.repeat)
  }));
  const warmRepeats = repeats.filter((repeat) => !repeat.containerCold);
  if (warmRepeats.length === 0) throw new Error('A3 analysis has no warm repeat');
  const fastestWarm = warmRepeats.reduce((best, value) =>
    value.controllerWallMs < best.controllerWallMs ? value : best);
  const service = fastestWarm.summedServiceMs;
  const hostToBackendRatio = service.recognitionHost / service.recognitionBackend;
  const profileNamesRemovableBoundary = hostToBackendRatio > 1;

  return {
    schemaVersion: SCHEMA_VERSION,
    verdict: {
      validWarmWindow,
      benchmarkAggregationAllowed: validWarmWindow,
      rejectionReason: validWarmWindow ? null : 'container-replaced-during-four-repeat-window',
      profilerOverhead: validWarmWindow ? 'requires-uninstrumented-same-lifetime-control' : 'unresolved-due-container-replacement'
    },
    lifecycle: {
      distinctContainers: lifetimes.size,
      coldPattern,
      groups: lifetimeGroups,
      replacementCause: 'unproven-no-system-event-returned'
    },
    repeats,
    correctness,
    treatmentSelection: {
      evidenceRepeat: fastestWarm.repeat,
      evidenceRule: 'fastest-complete-warm-repeat-diagnostic-only',
      profileNamesRemovableBoundary,
      recognitionHostToSynchronousBackendRatio: round(hostToBackendRatio),
      selected: profileNamesRemovableBoundary
        ? 'bounded-recognition-prepare-backend-postprocess-pipeline'
        : 'none',
      rejected: [
        'larger-recognition-batch-alone-already-measured-no-material-gain',
        'more-whole-pipeline-owners-already-measured-cpu-contention'
      ],
      caveats: [
        'summed service times overlap across two owners and are not additive method wall time',
        'synchronous backend time includes copies native execution and synchronization',
        'backend occupancy is not GPU kernel occupancy',
        'the selected treatment still requires a stable paid warm control and treatment comparison'
      ]
    }
  };
}

function argument(name, { required = true } = {}) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  if (!required) return undefined;
  throw new Error(`${name} is required`);
}

function main() {
  const runDir = resolve(argument('--run-dir'));
  const correctnessDir = argument('--correctness-dir', { required: false });
  const output = resolve(argument('--output'));
  const files = readdirSync(runDir)
    .filter((name) => /^gpu-repeat-[1-4]\.json$/u.test(name))
    .sort();
  const runs = files.map((name) => JSON.parse(readFileSync(join(runDir, name), 'utf8')));
  const correctness = correctnessDir
    ? [1, 2, 3, 4].map((repeat) => correctnessSummary(
      join(resolve(correctnessDir), `score-repeat-${repeat}.json`), repeat
    ))
    : [];
  const analysis = analyzeProfileRuns(runs, correctness);
  writeFileSync(output, `${JSON.stringify(analysis, null, 2)}\n`);
  console.log(`${analysis.verdict.validWarmWindow ? 'VALID' : 'REJECTED'}: wrote ${output}`);
  if (!analysis.verdict.validWarmWindow) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}

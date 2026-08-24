import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzeProfileRuns } from '../scripts/evaluation/analyze_gpu_a3_profile.mjs';

function stage(ms, calls = 1) {
  return { calls, summedWallMs: ms };
}

function repeat(number, { containerId = 'one', cold = number === 1, wallMs = 1000 } = {}) {
  const stageSummary = {
    'predict.total': stage(1800),
    'detector.total': stage(300),
    'detector.backend': stage(50),
    'detector.postprocess': stage(120),
    'crop.total': stage(100),
    'recognizer.total': stage(1300),
    'recognizer.preprocess.read': stage(20),
    'recognizer.preprocess.reisizenorm': stage(400),
    'recognizer.preprocess.tobatch': stage(200),
    'recognizer.backend': stage(300),
    'recognizer.postprocess': stage(350)
  };
  const identity = { missingPaths: [] };
  return {
    schemaVersion: 'pagespatial-gpu-a2-result-v1',
    runId: `run-${number}`,
    status: 'completed',
    pageCount: 50,
    arm: { stageProfile: true },
    resources: { inferenceOwners: 2 },
    client: { repeat: number, containerId, spawnToResultS: wallMs / 1000 },
    method: { containerCold: cold, totalMethodMs: wallMs },
    timing: { wallMs, pagesPerS: 50000 / wallMs },
    serializedResultBytes: 100,
    gpuTelemetry: { samples: [{ gpuUtilPercent: 10 }, { gpuUtilPercent: 30 }] },
    stageProfile: {
      identitiesByOwner: [identity, identity],
      stageSummary,
      backendOccupancy: {
        'recognizer.backend': { occupancyPercent: 30 },
        combined: { occupancyPercent: 40 }
      }
    }
  };
}

test('analysis accepts one stable cold-then-warm container and selects the measured split', () => {
  const analysis = analyzeProfileRuns([1, 2, 3, 4].map((number) => repeat(number)));
  assert.equal(analysis.verdict.validWarmWindow, true);
  assert.equal(analysis.lifecycle.distinctContainers, 1);
  assert.equal(analysis.treatmentSelection.selected, 'bounded-recognition-prepare-backend-postprocess-pipeline');
  assert.equal(analysis.treatmentSelection.recognitionHostToSynchronousBackendRatio, 3.233);
});

test('analysis rejects a replacement container and keeps per-lifetime evidence separate', () => {
  const runs = [
    repeat(1),
    repeat(2),
    repeat(3, { containerId: 'two', cold: true, wallMs: 2000 }),
    repeat(4, { containerId: 'two', cold: false, wallMs: 1900 })
  ];
  const analysis = analyzeProfileRuns(runs);
  assert.equal(analysis.verdict.validWarmWindow, false);
  assert.equal(analysis.verdict.benchmarkAggregationAllowed, false);
  assert.equal(analysis.verdict.profilerOverhead, 'unresolved-due-container-replacement');
  assert.deepEqual(analysis.lifecycle.groups.map((group) => group.repeats), [[1, 2], [3, 4]]);
});

test('analysis fails closed when a required measured stage is absent', () => {
  const runs = [1, 2, 3, 4].map((number) => repeat(number));
  delete runs[0].stageProfile.stageSummary['recognizer.backend'];
  assert.throws(() => analyzeProfileRuns(runs), /required stage recognizer\.backend is missing/u);
});

test('analysis does not invent zero utilization when telemetry is absent', () => {
  const runs = [1, 2, 3, 4].map((number) => repeat(number));
  runs[1].gpuTelemetry.samples = [];
  const analysis = analyzeProfileRuns(runs);
  assert.equal(analysis.repeats[1].gpuUtilization.medianPercent, null);
  assert.equal(analysis.repeats[1].gpuUtilization.maxPercent, null);
});

#!/usr/bin/env node
/** Prove ordinary-method versus child-worker parity for one shared A2 core. */

import { isDeepStrictEqual } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { comparePages, evaluateComparison } from './lib/modal-comparator.mjs';

const workload = JSON.parse(readFileSync(
  new URL('../../evaluation/gpu-spike/a2-50page-v1.json', import.meta.url),
  'utf8',
));
const modelPins = JSON.parse(readFileSync(
  new URL('../../evaluation/gpu-spike/model-pins-v1.json', import.meta.url),
  'utf8',
));
const expectedDocument = {
  documentId: `sha256:${workload.output.sha256}`,
  revisionId: `sha256:${workload.output.sha256}`,
  sha256: workload.output.sha256,
  pageCount: workload.output.pageCount,
};
const expectedResources = {
  physicalCpuCores: 4,
  memoryMiB: 24576,
  gpu: 'L4',
  inferenceOwners: 2,
};
const expectedPatch = {
  sourceRevision: 'ffb64904d23708863ff5b8da312a5cbd52a7f462',
  patchSha256: 'b03632bbfae1372f21a2e31babbf72f8936943a0848ff3db853a2f1cd5216bd6',
};

function modelIdentity(model) {
  return model && {
    repo: model.repo,
    revision: model.revision,
    files: model.files,
  };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`${name} is required`);
  return process.argv[index + 1];
}

const load = (name) => JSON.parse(readFileSync(argument(name), 'utf8'));
const pages = (run) => run.pages.map((entry) => entry.pageSpatial);
const rate = (run) => Number.isFinite(run.method?.totalMethodMs) && run.method.totalMethodMs > 0
  ? 50 / (run.method.totalMethodMs / 1000)
  : null;
const deltaPercent = (left, right) => 100 * Math.abs(left - right) / left;

export function analyzeM1({ cold, before, childCold, childWarm, after }) {
  const runs = { cold, before, childCold, childWarm, after };
  const reasons = [];
  for (const [name, run] of Object.entries(runs)) {
    if (run.status !== 'completed' || run.pages?.length !== 50 ||
        run.pages.some((entry, index) => entry.ok !== true || entry.pageNumber !== index + 1)) {
      reasons.push(`${name} is not exactly 50 ordered successful terminal pages`);
    }
    if (run.backendAttestations?.length !== 2 ||
        run.backendAttestations.some((item) => item?.pass !== true)) {
      reasons.push(`${name} lacks two passing backend attestations`);
    }
    if (!Number.isFinite(run.method?.totalMethodMs) || run.method.totalMethodMs <= 0 ||
        !Number.isFinite(run.timing?.pagesPerS) || run.timing.pagesPerS <= 0) {
      reasons.push(`${name} lacks finite positive timing evidence`);
    }
    if (run.method?.processGroupClean !== true) {
      reasons.push(`${name} did not attest a clean controller process group`);
    }
  }

  const identities = [
    'document', 'arm', 'resources', 'modelVerification', 'deviceTruth',
    'ultraInferPatch',
  ];
  for (const field of identities) {
    if (!Object.values(runs).every((run) => isDeepStrictEqual(run[field], cold[field]))) {
      reasons.push(`${field} differs across launch boundaries`);
    }
  }
  if (!isDeepStrictEqual(cold.document, expectedDocument)) {
    reasons.push('document is not the exact frozen 50-page workload');
  }
  if (!isDeepStrictEqual(cold.resources, expectedResources)) {
    reasons.push('resources are not the fixed 4-core 24-GiB two-owner L4 shape');
  }
  const expectedModels = modelPins.models.tiny;
  if (!isDeepStrictEqual(modelIdentity(cold.modelVerification?.detector), expectedModels.detector) ||
      !isDeepStrictEqual(modelIdentity(cold.modelVerification?.recognizer), expectedModels.recognizer)) {
    reasons.push('model verification is not the exact pinned Tiny detector and recognizer');
  }
  if (!isDeepStrictEqual(cold.ultraInferPatch, expectedPatch)) {
    reasons.push('UltraInfer runtime patch identity is absent or incorrect');
  }
  if (cold.deviceTruth?.paddleDevice !== 'gpu:0' ||
      cold.deviceTruth?.cudaCompiled !== true ||
      cold.deviceTruth?.paddleCudaDeviceName !== 'NVIDIA L4' ||
      typeof cold.deviceTruth?.cudaVersion !== 'string' ||
      typeof cold.deviceTruth?.cudnnVersion !== 'string' ||
      !Array.isArray(cold.deviceTruth?.nvidiaSmiIdentity) ||
      cold.deviceTruth.nvidiaSmiIdentity.length < 1 ||
      !cold.deviceTruth.nvidiaSmiIdentity.every((line) =>
        typeof line === 'string' && line.includes('NVIDIA L4') && line.includes('GPU-'))) {
    reasons.push('device truth does not prove one CUDA-backed NVIDIA L4');
  }
  if (cold.arm?.tier !== 'tiny' || cold.arm?.recognitionBatchSize !== 1 ||
      cold.arm?.inferenceOwners !== 2 || cold.arm?.precision !== 'fp32' ||
      cold.arm?.stageProfile !== false || cold.arm?.nvtx !== false) {
    reasons.push('arm is not the fixed uninstrumented Tiny FP32 B1 O2 identity');
  }
  const nvtxProvenance = cold.instrumentation?.nvtx;
  if (nvtxProvenance?.enabled !== false || nvtxProvenance?.version !== '0.2.16' ||
      nvtxProvenance?.wheelSha256 !== '23f30fcaf68f53d1895282315cb35aed5f605d59aeb33e75e276545ff95c4af6' ||
      nvtxProvenance?.domain !== 'pagespatial.ocr' || cold.versions?.nvtx !== '0.2.16' ||
      typeof cold.versions?.tensorrt !== 'string') {
    reasons.push('uninstrumented arm lacks exact NVTX/runtime provenance');
  }
  if (!Object.values(runs).every((run) =>
    isDeepStrictEqual(run.instrumentation, cold.instrumentation) &&
    isDeepStrictEqual(run.versions, cold.versions))) {
    reasons.push('instrumentation or runtime provenance differs across boundaries');
  }

  if (cold.method?.containerCold !== true || before.method?.containerCold !== false ||
      after.method?.containerCold !== false || childCold.method?.containerCold !== true ||
      childWarm.method?.containerCold !== false) {
    reasons.push('cold/warm lifecycle pattern is invalid');
  }

  const ordinaryPids = new Set([cold, before, after].map((run) => run.method.ownerPid));
  const childPids = new Set([
    childCold.launch?.workerPid,
    childWarm.launch?.workerPid,
  ]);
  if (ordinaryPids.size !== 1) reasons.push('ordinary calls did not reuse one owner PID');
  if (childPids.size !== 1 || childPids.has(undefined)) {
    reasons.push('child calls did not reuse one worker PID');
  }
  if (childPids.has(cold.method.ownerPid)) reasons.push('child boundary reused the parent PID');
  if (childCold.launch?.boundary !== 'shared-core-child' ||
      childWarm.launch?.boundary !== 'shared-core-child' ||
      childCold.launch?.sequenceIndex !== 1 || childWarm.launch?.sequenceIndex !== 2 ||
      childCold.launch?.processTreeClean !== true || childWarm.launch?.processTreeClean !== true ||
      childCold.launch?.cleanupInterventions !== 0 || childWarm.launch?.cleanupInterventions !== 0) {
    reasons.push('child launch lifecycle or clean-tree evidence is invalid');
  }
  if (cold.client?.launchBoundary !== 'modal-method' ||
      before.client?.launchBoundary !== 'modal-method' ||
      after.client?.launchBoundary !== 'modal-method' ||
      childCold.client?.launchBoundary !== 'child-worker' ||
      childWarm.client?.launchBoundary !== 'child-worker') {
    reasons.push('recorded launch boundaries are invalid');
  }
  const containerIds = new Set(Object.values(runs).map((run) => run.client?.containerId));
  const appIds = new Set(Object.values(runs).map((run) => run.client?.appId));
  if (containerIds.size !== 1 || containerIds.has(undefined) ||
      appIds.size !== 1 || appIds.has(undefined)) {
    reasons.push('runs do not share one attributable container/app lifetime');
  }

  const nullComparison = comparePages(pages(before), pages(after));
  const nullTolerance = {
    criticalTokens: nullComparison.ocrScore.criticalTokens.symmetricDifference,
    rawLines: nullComparison.ocrScore.rawLines.differingLines,
  };
  const childComparison = comparePages(pages(before), pages(childWarm));
  const outputVerdict = evaluateComparison(childComparison, nullTolerance);
  if (!outputVerdict.pass) reasons.push(...outputVerdict.reasons.map((item) => `output: ${item}`));

  const beforeRate = rate(before);
  const afterRate = rate(after);
  const controlRate = beforeRate === null || afterRate === null
    ? null : (beforeRate + afterRate) / 2;
  const childWarmRate = rate(childWarm);
  const controlBracketDriftPercent = beforeRate === null || afterRate === null
    ? null : deltaPercent(beforeRate, afterRate);
  const launchBoundaryDriftPercent = controlRate === null || childWarmRate === null
    ? null : deltaPercent(controlRate, childWarmRate);
  if (controlBracketDriftPercent === null || launchBoundaryDriftPercent === null) {
    reasons.push('throughput cannot be derived from invalid timing');
  } else {
    if (controlBracketDriftPercent > 10) reasons.push('ordinary control bracket differs by more than 10%');
    if (launchBoundaryDriftPercent > 10) reasons.push('child launch boundary differs by more than 10%');
  }

  return {
    schemaVersion: 'pagespatial-gpu-instrumentation-m1-parity-v1',
    pass: reasons.length === 0,
    reasons,
    executionCore: 'gpu_a2_modal.A2ExecutionCore',
    identity: {
      arm: cold.arm,
      resources: cold.resources,
      modelVerification: cold.modelVerification,
      deviceTruth: cold.deviceTruth,
      ultraInferPatch: cold.ultraInferPatch,
      ordinaryOwnerPid: cold.method.ownerPid,
      childWorkerPid: childWarm.launch?.workerPid,
    },
    throughput: {
      ordinaryBeforePagesPerS: beforeRate,
      ordinaryAfterPagesPerS: afterRate,
      ordinaryBracketMeanPagesPerS: controlRate,
      childWarmPagesPerS: childWarmRate,
      controlBracketDriftPercent,
      launchBoundaryDriftPercent,
      maximumAllowedDriftPercent: 10,
    },
    output: { nullTolerance, nullComparison, childComparison, verdict: outputVerdict },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = analyzeM1({
    cold: load('--cold'),
    before: load('--before'),
    childCold: load('--child-cold'),
    childWarm: load('--child-warm'),
    after: load('--after'),
  });
  writeFileSync(argument('--output'), `${JSON.stringify(result, null, 1)}\n`);
  console.log(JSON.stringify({ pass: result.pass, reasons: result.reasons, throughput: result.throughput }, null, 1));
  if (!result.pass) process.exitCode = 1;
}

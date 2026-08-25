#!/usr/bin/env node
/** Prove ordinary-method versus child-worker parity for one shared A2 core. */

import { isDeepStrictEqual } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { comparePages, evaluateComparison } from './lib/modal-comparator.mjs';

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`${name} is required`);
  return process.argv[index + 1];
}

const load = (name) => JSON.parse(readFileSync(argument(name), 'utf8'));
const pages = (run) => run.pages.map((entry) => entry.pageSpatial);
const rate = (run) => 50 / (run.method.totalMethodMs / 1000);
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
  }

  const identities = ['arm', 'resources', 'modelVerification', 'deviceTruth', 'ultraInferPatch'];
  for (const field of identities) {
    if (!Object.values(runs).every((run) => isDeepStrictEqual(run[field], cold[field]))) {
      reasons.push(`${field} differs across launch boundaries`);
    }
  }
  if (cold.arm?.tier !== 'tiny' || cold.arm?.recognitionBatchSize !== 1 ||
      cold.arm?.inferenceOwners !== 2 || cold.arm?.precision !== 'fp32') {
    reasons.push('arm is not the fixed Tiny FP32 B1 O2 identity');
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
  const controlRate = (beforeRate + afterRate) / 2;
  const childWarmRate = rate(childWarm);
  const controlBracketDriftPercent = deltaPercent(beforeRate, afterRate);
  const launchBoundaryDriftPercent = deltaPercent(controlRate, childWarmRate);
  if (controlBracketDriftPercent > 10) reasons.push('ordinary control bracket differs by more than 10%');
  if (launchBoundaryDriftPercent > 10) reasons.push('child launch boundary differs by more than 10%');

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

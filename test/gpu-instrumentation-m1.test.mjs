import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createValidDocument } from './fixture.mjs';
import { analyzeM1 } from '../scripts/evaluation/analyze_gpu_instrumentation_m1.mjs';

const modalSource = readFileSync(new URL('../scripts/evaluation/gpu_a2_modal.py', import.meta.url), 'utf8');
const workerSource = readFileSync(new URL('../scripts/evaluation/gpu_a2_trace_worker.py', import.meta.url), 'utf8');
const launcherSource = readFileSync(new URL('../scripts/evaluation/run_gpu_instrumentation.py', import.meta.url), 'utf8');

function run(page, { pid = 10, childPid, rate = 2 } = {}) {
  const pages = Array.from({ length: 50 }, (_, index) => ({
    pageNumber: index + 1,
    ok: true,
    pageSpatial: { ...structuredClone(page), pageNumber: index + 1 },
  }));
  return {
    status: 'completed',
    pages,
    arm: { tier: 'tiny', precision: 'fp32', recognitionBatchSize: 1, inferenceOwners: 2 },
    resources: { physicalCpuCores: 4, memoryMiB: 24576, gpu: 'L4', inferenceOwners: 2 },
    modelVerification: { exact: true },
    deviceTruth: { gpuUuid: 'GPU-test' },
    ultraInferPatch: { sourceRevision: 'fixed', patchSha256: 'fixed' },
    backendAttestations: [{ pass: true }, { pass: true }],
    method: { ownerPid: pid, totalMethodMs: 50_000 / rate },
    ...(childPid === undefined ? {} : {
      launch: { workerPid: childPid, boundary: 'shared-core-child' },
    }),
  };
}

test('M1 uses one execution core instead of copying the page loop', () => {
  assert.match(modalSource, /class A2ExecutionCore:/u);
  assert.match(modalSource, /return self\.core\.parse_document\(payload\)/u);
  assert.match(workerSource, /from gpu_a2_modal import A2ExecutionCore/u);
  assert.match(workerSource, /core\.parse_document\(_payload\(request\)\)/u);
  assert.doesNotMatch(workerSource, /ThreadPoolExecutor|gpu_a2_controller/u);
});

test('M1 paid launcher fixes the arm and closes the exact experiment app', () => {
  const reservation = launcherSource.indexOf('reserve(ledger, "M1-PARITY")');
  const paidRun = launcherSource.indexOf('M1_SCRIPT,');
  assert.ok(reservation >= 0 && paidRun > reservation);
  assert.match(launcherSource, /PAGESPATIAL_A2_MODEL_TIER": "tiny"/u);
  assert.match(launcherSource, /PAGESPATIAL_A2_RECOGNITION_BATCH_SIZE": "1"/u);
  assert.match(launcherSource, /PAGESPATIAL_A2_INFERENCE_OWNERS": "2"/u);
  assert.match(launcherSource, /PAGESPATIAL_A2_NVTX": "1"/u);
  assert.match(launcherSource, /app_id = stop_exact_app\(app_name\)/u);
});

test('M1 analyzer passes exact same-core output within the 10% launch gate', async () => {
  const page = (await createValidDocument()).pages[0];
  const result = analyzeM1({
    cold: run(page),
    before: run(page, { rate: 2 }),
    childCold: run(page, { childPid: 20, rate: 1 }),
    childWarm: run(page, { childPid: 20, rate: 2.05 }),
    after: run(page, { rate: 2.02 }),
  });
  assert.equal(result.pass, true, result.reasons.join('; '));
  assert.equal(result.output.verdict.pass, true);
});

test('M1 analyzer fails closed on terminal reconciliation or identity drift', async () => {
  const page = (await createValidDocument()).pages[0];
  const base = run(page);
  const missing = run(page, { childPid: 20 });
  missing.pages.pop();
  const drifted = run(page, { childPid: 20 });
  drifted.arm.recognitionBatchSize = 8;
  const result = analyzeM1({
    cold: base,
    before: run(page),
    childCold: missing,
    childWarm: drifted,
    after: run(page),
  });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join('; '), /not exactly 50|arm differs/u);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../scripts/evaluation/run_gpu_a2_experiment.py', import.meta.url), 'utf8');

test('paid A2 launcher exposes E1 only and reserves before deploy/run', () => {
  assert.match(source, /reserve\(ledger, "E1-CPU"\)/u);
  assert.match(source, /reserve\(ledger, "E1-GPU"\)/u);
  assert.doesNotMatch(source, /reserve\(ledger, "E2-GPU"\)/u);
  assert.ok(source.indexOf('reserve(ledger, "E1-CPU")') < source.indexOf('["modal", "deploy"'));
  assert.ok(source.indexOf('reserve(ledger, "E1-GPU")') < source.indexOf('"modal", "run"'));
});

test('paid A2 launcher requires clean source and exact app cleanup', () => {
  assert.match(source, /paid A2 runs require a clean committed worktree/u);
  assert.match(source, /modal", "app", "stop", "--yes", app_id/u);
  assert.match(source, /remaining\.get\("state"\) != "stopped"/u);
  assert.match(source, /finally:/u);
  assert.match(source, /complete_without_app/u);
  assert.match(source, /time\.monotonic\(\) \+ 120/u);
  assert.match(source, /did not stop cleanly after bounded reap/u);
  assert.doesNotMatch(source, /gpu_a2_modal\.py", "--"/u);
});

test('paid A2 launcher can reuse only a complete current CPU control', () => {
  assert.match(source, /--cpu-evidence/u);
  assert.match(source, /validate_cpu_evidence/u);
  assert.match(source, /\[True, False, False, False\]/u);
  assert.match(source, /CPU_CONTROL_PATHS/u);
  assert.match(source, /"git", "diff", "--quiet"/u);
  assert.match(source, /CPU production paths changed after the reused evidence revision/u);
  assert.match(source, /result\.get\("image_pin_revision"\) != image_pin_revision\(\)/u);
});

test('E2 is locked behind all four correctness reports and a 2x warm speed gate', () => {
  assert.match(source, /for repeat in range\(1, 5\)/u);
  assert.match(source, /"minimum": 2\.0/u);
  assert.match(source, /"technicalGatePass": correctness_pass and speedup >= 2\.0/u);
  assert.match(source, /pending-closed-interval-reconciliation/u);
  assert.match(source, /"advanceToE2": False/u);
  assert.match(source, /E2 remains locked/u);
});

test('paid GPU work starts only after native evidence is precomputed on CPU', () => {
  assert.match(source, /precompute_gpu_a2_native\.mjs/u);
  assert.match(source, /native-evidence-v1\.json/u);
  assert.ok(source.indexOf('precompute_native_evidence(args.out_dir)') < source.indexOf('gpu = run_gpu('));
  assert.match(source, /--native-evidence-path/u);
});

test('paid A2 launcher varies only the predeclared tier and recognition batch grids', () => {
  assert.match(source, /--model-tier/u);
  assert.match(source, /choices=\("tiny", "small"\)/u);
  assert.match(source, /PAGESPATIAL_A2_MODEL_TIER/u);
  assert.match(source, /choices=\(1, 2, 4\)/u);
  assert.match(source, /--recognition-batch-size/u);
  assert.match(source, /choices=\(1, 4, 8\)/u);
  assert.match(source, /PAGESPATIAL_A2_RECOGNITION_BATCH_SIZE/u);
  assert.match(source, /gpu-\{model_tier\}-b\{recognition_batch_size\}/u);
});

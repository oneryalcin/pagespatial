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
});

test('E2 is locked behind all four correctness reports and a 2x warm speed gate', () => {
  assert.match(source, /for repeat in range\(1, 5\)/u);
  assert.match(source, /"minimum": 2\.0/u);
  assert.match(source, /"technicalGatePass": correctness_pass and speedup >= 2\.0/u);
  assert.match(source, /pending-closed-interval-reconciliation/u);
  assert.match(source, /"advanceToE2": False/u);
  assert.match(source, /E2 remains locked/u);
});

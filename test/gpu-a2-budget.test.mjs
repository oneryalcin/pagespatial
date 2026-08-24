import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../scripts/evaluation/gpu_a2_budget.py', import.meta.url), 'utf8');

test('A2 budget ledger pins workspace and operational buffer', () => {
  assert.match(source, /REQUIRED_PROFILE = "desia"/u);
  assert.match(source, /OWNER_CEILING_USD = 75\.0/u);
  assert.match(source, /OPERATIONAL_STOP_USD = 75\.0/u);
  assert.match(source, /ledger\["ownerCeilingUsd"\] = OWNER_CEILING_USD/u);
});

test('A2 budget exposure retains unreconciled reservations', () => {
  assert.match(source, /"completed-unposted"/u);
  assert.match(source, /posted \+ reserved_exposure\(ledger\) \+ worst_case_usd/u);
  assert.match(source, /partial positive billing row/u);
  assert.match(source, /operator-attested closed billing interval/u);
  assert.match(source, /complete_without_app/u);
  assert.match(source, /This only removes the live serialization lock; it never releases money/u);
});

test('A2 reservations are fixed by stage and atomically claimed', () => {
  assert.match(source, /STAGE_BOUNDS/u);
  assert.match(source, /"E1-CPU"/u);
  assert.match(source, /"E1-GPU"/u);
  assert.match(source, /"E1-GPU": \{[\s\S]*?"worstCaseUsd": 3\.0/u);
  assert.match(source, /"A3-PAIRED-GPU": \{[\s\S]*?"worstCaseUsd": 2\.75/u);
  assert.match(source, /"calls": 5/u);
  assert.match(source, /"buildAndIdleAllowanceUsd": 0\.78392/u);
  assert.doesNotMatch(source, /--worst-case-usd/u);
  assert.match(source, /fcntl\.flock/u);
  assert.match(source, /match\.get\("status"\) != "reserved"/u);
});

test('A2 budget refuses parallel experiment apps', () => {
  assert.match(source, /paid launch serialization refused/u);
  assert.match(source, /modal", "app", "list", "--json"/u);
});

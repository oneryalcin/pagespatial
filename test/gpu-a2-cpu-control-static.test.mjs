import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../scripts/evaluation/run_gpu_a2_cpu_control.py', import.meta.url), 'utf8');

test('A2 CPU runner pins adopted control resources and terminal count', () => {
  assert.match(source, /"cpu": 4\.0/u);
  assert.match(source, /"memory_mib": 24576/u);
  assert.match(source, /"workers": 4/u);
  assert.match(source, /EXPECTED_PAGES = 50/u);
});

test('A2 CPU runner cannot stop unrelated apps and always verifies drain', () => {
  assert.match(source, /startswith\("pagespatial-gpu-a2-"\)/u);
  assert.match(source, /finally:\n        stop_and_verify\(args\.app\)/u);
  assert.match(source, /CPU control app did not drain/u);
});

test('A2 CPU control requires reservation, no retries, and four-call warm proof', () => {
  assert.match(source, /validate_reservation\(args\.ledger, args\.reservation, "E1-CPU"\)/u);
  assert.match(source, /with_options\(\n            retries=0, max_containers=1/u);
  assert.match(source, /args\.repeats != 4/u);
  assert.match(source, /\[True, False, False, False\]/u);
  assert.match(source, /container_snapshot/u);
  assert.match(source, /Backend::OPENVINO/u);
  assert.match(source, /engine_evidence\.get\("source"\) != "log-derived \(child stderr\)"/u);
  assert.match(source, /result\["modelVerification"\]/u);
});

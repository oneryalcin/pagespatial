import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../scripts/evaluation/gpu_a2_modal.py', import.meta.url), 'utf8');

test('A2 Modal arm is one bounded L4 owner with no retries', () => {
  assert.match(source, /gpu=GPU_TYPE/u);
  assert.match(source, /max_containers=1/u);
  assert.match(source, /min_containers=0/u);
  assert.match(source, /retries=0/u);
  assert.match(source, /METHOD_TIMEOUT_S = 1200/u);
});

test('A2 Modal arm is only qualified Small FP32 with batch one', () => {
  assert.match(source, /"tier": "small"/u);
  assert.match(source, /"precision": "fp32"/u);
  assert.match(source, /"recognitionBatchSize": 1/u);
  assert.match(source, /"deploymentProfile": "en-gpu"/u);
  assert.doesNotMatch(source, /"tier": "tiny"/u);
  assert.doesNotMatch(source, /"precision": "fp16"/u);
});

test('A2 runner enforces spend and repeat bounds before remote work', () => {
  const reservationCheck = source.indexOf('validate_reservation(_ledger_path, _reservation_id, "E1-GPU")');
  const paidImageImport = source.indexOf('from gpu_spike_trt_modal import');
  assert.ok(reservationCheck >= 0 && reservationCheck < paidImageImport);
  assert.match(source, /if repeats != 4/u);
  assert.match(source, /\[True, False, False, False\]/u);
  assert.match(source, /"containerId": snapshot\["container_id"\]/u);
  assert.match(source, /len\(set\(container_ids\)\) != 1/u);
  assert.match(source, /MAX_RESULT_BYTES = 64 \* 1024 \* 1024/u);
  assert.match(source, /ResultTooLarge/u);
});

test('A2 controller owns and drains the complete process group', () => {
  assert.match(source, /start_new_session=True/u);
  assert.match(source, /os\.killpg/u);
  assert.match(source, /processGroupClean/u);
});

test('A2 image pins Node archive hash and uses uv-based TensorRT image', () => {
  assert.match(source, /NODE_LINUX_X64_SHA256/u);
  assert.match(source, /sha256sum -c/u);
  assert.match(source, /trt_image/u);
});

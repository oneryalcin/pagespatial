#!/usr/bin/env node
// M0 smoke test: prove the Modal JS dispatch chain end to end, including
// recovery by a process that did not spawn the call.
//
// The API surface is already verified against modal@0.9.0's type
// definitions (ClsInstance.method -> Function_.spawn -> FunctionCall,
// FunctionCallService.fromId). What this script proves is different and
// cannot be read off a .d.ts: that deployment, authentication,
// argument/result serialization, and CROSS-RESTART recovery actually work
// against a live deployed app.
//
// Two phases, deliberately two processes — a single process holding the
// FunctionCall object in memory would prove nothing about recovery.
//
//   node modal-spawn-smoke.mjs spawn   ./smoke-state.json
//   node modal-spawn-smoke.mjs recover ./smoke-state.json
//
// Env: MODAL_APP_NAME, MODAL_CLS_NAME, MODAL_METHOD_NAME, plus whatever
// credentials the Modal client resolves (~/.modal.toml or MODAL_TOKEN_*).

import { readFileSync, writeFileSync } from 'node:fs';

const APP = process.env.MODAL_APP_NAME ?? 'pagespatial-parse-internal';
const CLS = process.env.MODAL_CLS_NAME ?? 'ParseService';
const METHOD = process.env.MODAL_METHOD_NAME ?? 'parse_document';

const [, , phase, statePath = './smoke-state.json'] = process.argv;

const fail = (message) => { console.error(`FAIL: ${message}`); process.exit(1); };

// Imported lazily so `--help` and arg errors do not require the dependency.
const modalClient = async () => {
  let modal;
  try {
    modal = await import('modal');
  } catch {
    fail('`modal` is not installed. npm i modal@0.9.0 (pin it — 0.9.0 is pre-1.0).');
  }
  return modal;
};

if (phase === 'spawn') {
  const modal = await modalClient();
  const cls = await modal.cls.fromName(APP, CLS);
  const instance = await cls.instance({});
  const method = instance.method(METHOD);

  // The payload shape is the deployed method's business, not this
  // script's. Keep it minimal and let a rejection be a legible failure
  // rather than something this script pretends to understand.
  const payload = JSON.parse(process.env.MODAL_SMOKE_PAYLOAD ?? '{}');

  const call = await method.spawn([payload]);
  if (!call?.functionCallId) fail('spawn() returned no functionCallId.');

  writeFileSync(statePath, JSON.stringify({
    functionCallId: call.functionCallId,
    app: APP, cls: CLS, method: METHOD,
    spawnedByPid: process.pid,
  }, null, 2));

  console.log(`spawned  callId=${call.functionCallId}  pid=${process.pid}`);
  console.log(`state written to ${statePath}`);
  console.log(`now run:  node ${process.argv[1]} recover ${statePath}`);
  process.exit(0);
}

if (phase === 'recover') {
  const modal = await modalClient();
  let state;
  try {
    state = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    fail(`could not read ${statePath}. Run the spawn phase first.`);
  }
  if (state.spawnedByPid === process.pid) {
    fail('same pid as the spawning process — this proves nothing about recovery.');
  }

  const call = await modal.functionCalls.fromId(state.functionCallId);

  // Poll without blocking, exactly as the reconciler will: timeoutMs 0
  // throws while the call is still running, and that is the normal path,
  // not an error condition.
  const deadline = Date.now() + Number(process.env.MODAL_SMOKE_TIMEOUT_MS ?? 900_000);
  for (;;) {
    try {
      const result = await call.get({ timeoutMs: 0 });
      console.log(`recovered  callId=${state.functionCallId}  pid=${process.pid} (spawned by ${state.spawnedByPid})`);
      console.log(`result keys: ${Object.keys(result ?? {}).join(', ') || '(non-object result)'}`);
      console.log('PASS: a process that did not spawn the call retrieved its result.');
      process.exit(0);
    } catch (error) {
      if (Date.now() > deadline) fail(`timed out waiting for ${state.functionCallId}: ${error?.message ?? error}`);
      // Still running. Any other error class surfaces on the next timeout.
      process.stdout.write('.');
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
}

console.error(`usage: ${process.argv[1]} <spawn|recover> [statePath]`);
process.exit(2);

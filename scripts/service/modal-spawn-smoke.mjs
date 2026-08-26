#!/usr/bin/env node
// M0 smoke test: prove the Modal JS dispatch chain against a LIVE deployed
// app, including recovery by a process that did not spawn the call.
//
// The API surface is already settled by inspection of modal@0.9.0's type
// definitions. What this proves is what a .d.ts cannot:
//
//   1. deployment + authentication actually work;
//   2. a JS Uint8Array serializes into the Python `bytes` that
//      validate_input() demands  <-- the real unknown;
//   3. a FunctionCall survives a process restart via fromId().
//
// Two phases, deliberately two processes: a single process holding the
// FunctionCall object in memory proves nothing about recovery.
//
//   node modal-spawn-smoke.mjs spawn   ./smoke-state.json
//   node modal-spawn-smoke.mjs recover ./smoke-state.json
//
// Env: MODAL_APP_NAME (default pagespatial-parse-internal),
//      MODAL_CLS_NAME (default ParseContainer — the deployed class),
//      MODAL_METHOD_NAME (default parse_document),
//      plus credentials resolved by the Modal client (~/.modal.toml).

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const APP = process.env.MODAL_APP_NAME ?? 'pagespatial-parse-internal';
const CLS = process.env.MODAL_CLS_NAME ?? 'ParseContainer';
const METHOD = process.env.MODAL_METHOD_NAME ?? 'parse_document';
const SCHEMA_VERSION = '0.6.0'; // must equal modal_app.py SCHEMA_VERSION

const [, , phase, statePath = './smoke-state.json'] = process.argv;
const fail = (message) => { console.error(`FAIL: ${message}`); process.exit(1); };

// `modal` exports no client singleton — cls/functions/functionCalls are
// ModalClient INSTANCE properties. `import('modal').cls` is undefined.
const connect = async () => {
  let mod;
  try {
    mod = await import('modal');
  } catch {
    fail('`modal` is not installed. It is pinned in package.json — run `npm ci`.');
  }
  return { client: new mod.ModalClient(), FunctionTimeoutError: mod.FunctionTimeoutError };
};

// Smallest structurally valid one-page PDF. Inline, so the smoke test has
// no corpus dependency and never ships a customer document to Modal.
const minimalPdf = () => {
  // /Length is COMPUTED: a hardcoded value drifts the moment the content
  // stream is edited, and poppler only warns rather than failing.
  const content = 'BT /F1 12 Tf 20 100 Td (PageSpatial M0) Tj ET';
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (const object of objects) { offsets.push(pdf.length); pdf += object; }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, 'latin1'));
};

if (phase === 'spawn') {
  const { client } = await connect();
  const pdfBytes = minimalPdf();
  const sha256 = createHash('sha256').update(pdfBytes).digest('hex');

  // The COMPLETE payload validate_input() requires (modal_app.py:190).
  // An incomplete one is rejected before any Node work, which would make
  // this test prove nothing.
  const payload = {
    request_id: `m0-smoke-${sha256.slice(0, 12)}`,
    schema_version: SCHEMA_VERSION,
    enrichment: 'off',
    pdf_bytes: pdfBytes,   // <-- must arrive as Python bytes
    expected_sha256: sha256,
  };

  const cls = await client.cls.fromName(APP, CLS);
  const instance = await cls.instance({});
  const call = await instance.method(METHOD).spawn([payload]);
  if (!call?.functionCallId) fail('spawn() returned no functionCallId.');

  writeFileSync(statePath, JSON.stringify({
    functionCallId: call.functionCallId,
    app: APP, cls: CLS, method: METHOD, sha256,
    spawnedByPid: process.pid,
  }, null, 2));

  console.log(`spawned  callId=${call.functionCallId}  pid=${process.pid}  sha=${sha256.slice(0, 12)}`);
  console.log(`now run (fresh process):  node ${process.argv[1]} recover ${statePath}`);
  process.exit(0);
}

if (phase === 'recover') {
  const { client, FunctionTimeoutError } = await connect();
  let state;
  try {
    state = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    fail(`could not read ${statePath}. Run the spawn phase first.`);
  }
  if (state.spawnedByPid === process.pid) {
    fail('same pid as the spawning process — that would prove nothing about recovery.');
  }

  const call = await client.functionCalls.fromId(state.functionCallId);
  const deadline = Date.now() + Number(process.env.MODAL_SMOKE_TIMEOUT_MS ?? 900_000);

  for (;;) {
    try {
      const result = await call.get({ timeoutMs: 0 });
      console.log(`\nrecovered  callId=${state.functionCallId}  pid=${process.pid} (spawned by ${state.spawnedByPid})`);
      console.log(`result keys: ${Object.keys(result ?? {}).join(', ') || '(non-object result)'}`);
      console.log('PASS: a process that did not spawn the call retrieved its result.');
      process.exit(0);
    } catch (error) {
      // ONLY a timeout means "still running". Auth, lookup, application
      // and serialization failures must surface immediately — masking them
      // as "still running" hides a typo'd app name for fifteen minutes.
      if (!(error instanceof FunctionTimeoutError)) {
        fail(`${error?.constructor?.name ?? 'Error'}: ${error?.message ?? error}`);
      }
      if (Date.now() > deadline) fail(`timed out waiting for ${state.functionCallId}`);
      process.stdout.write('.');
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
}

console.error(`usage: ${process.argv[1]} <spawn|recover> [statePath]`);
process.exit(2);

#!/usr/bin/env node
// One live vertical M1 qualification:
//   Postgres row -> JS Modal spawn -> R2 parse result -> reconciler -> accepted row.
//
// Run from the repository root after deploying the app:
//   node --env-file=.env scripts/service/qualify-m1-reconciler.mjs
//
// This uses an in-process Postgres only for the qualification ledger. Native
// concurrency is covered separately by service/api/test/accept-race.test.mjs.

import { createHash, randomUUID } from 'node:crypto';
import { DeleteObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { PGlite } from '@electric-sql/pglite';
import { dispatchJob } from '../../service/api/src/dispatcher.mjs';
import { createModalCalls } from '../../service/api/src/modal-calls.mjs';
import { migrate } from '../../service/api/src/migrate.mjs';
import { createR2ResultStore, r2ClientFromConfig } from '../../service/api/src/r2-results.mjs';
import { reconcileOnce } from '../../service/api/src/reconciler.mjs';

const required = [
  'R2_CONTROL_ENDPOINT', 'R2_CONTROL_ACCESS_KEY_ID', 'R2_CONTROL_SECRET_ACCESS_KEY',
  'R2_INPUT_BUCKET', 'R2_RESULTS_BUCKET',
];
for (const name of required) {
  if (!process.env[name]) throw new Error(`${name} is required`);
}
const appName = process.env.MODAL_APP_NAME ?? 'pagespatial-parse-m1-reconcile-dev';
const timeoutMs = Number(process.env.M1_RECONCILE_TIMEOUT_MS ?? 900_000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('invalid M1_RECONCILE_TIMEOUT_MS');

function minimalPdf() {
  const content = 'BT /F1 12 Tf 20 100 Td (PageSpatial M1 reconciler) Tj ET';
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
}

const db = await PGlite.create();
const r2 = r2ClientFromConfig({
  endpoint: process.env.R2_CONTROL_ENDPOINT,
  accessKeyId: process.env.R2_CONTROL_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_CONTROL_SECRET_ACCESS_KEY,
});
const inputBucket = process.env.R2_INPUT_BUCKET;
const resultsBucket = process.env.R2_RESULTS_BUCKET;
const resultStore = createR2ResultStore({ client: r2, bucket: resultsBucket });
const modalCalls = createModalCalls({ appName });
let inputKey;
let resultPrefix;

try {
  await migrate(db);
  const userId = (await db.query(
    `INSERT INTO users (email, status) VALUES ($1, 'active') RETURNING id`,
    [`m1-live-${randomUUID()}@example.test`],
  )).rows[0].id;
  const pdf = minimalPdf();
  const digest = createHash('sha256').update(pdf).digest('hex');
  const jobId = randomUUID();
  inputKey = `inputs/${jobId}.pdf`;
  resultPrefix = `results/${jobId}/`;
  await r2.send(new PutObjectCommand({
    Bucket: inputBucket, Key: inputKey, Body: pdf, ContentType: 'application/pdf',
  }));
  await db.query(
    `INSERT INTO jobs (
       id, user_id, state, input_uri, input_digest, input_bytes,
       unit_price_micros, upload_expires_at, queued_at
     ) VALUES ($1, $2, 'queued', $3, $4, $5, 1000,
               now() + interval '1 hour', now())`,
    [jobId, userId, `r2://${inputBucket}/${inputKey}`, digest, pdf.byteLength],
  );

  const dispatched = await dispatchJob({ db, modalCalls, inputBucket, jobId });
  if (dispatched.kind !== 'dispatched') {
    throw new Error(`dispatch did not land: ${JSON.stringify(dispatched)}`);
  }

  const deadline = Date.now() + timeoutMs;
  let terminal;
  while (Date.now() < deadline) {
    await reconcileOnce({ db, modalCalls, resultStore, inputBucket });
    terminal = (await db.query('SELECT * FROM jobs WHERE id = $1', [jobId])).rows[0];
    if (terminal.state === 'succeeded' || terminal.state === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  if (terminal?.state !== 'succeeded' || !terminal.accepted_attempt_id
      || terminal.pages_actual !== 1 || !terminal.retention_expires_at) {
    throw new Error(`job did not reach verified success: ${JSON.stringify(terminal ?? null)}`);
  }
  const accepted = (await db.query(
    'SELECT * FROM job_attempts WHERE id = $1', [terminal.accepted_attempt_id],
  )).rows[0];
  if (accepted.state !== 'succeeded' || accepted.result_uri !== terminal.result_uri) {
    throw new Error('accepted attempt and job result disagree');
  }
  console.log(JSON.stringify({
    verdict: 'PASS', appName, jobId,
    attemptId: terminal.accepted_attempt_id,
    pages: terminal.pages_actual,
    resultDigest: terminal.result_digest,
    retentionExpiresAt: new Date(terminal.retention_expires_at).toISOString(),
  }, null, 2));
} finally {
  if (inputKey) {
    await r2.send(new DeleteObjectCommand({ Bucket: inputBucket, Key: inputKey })).catch(() => {});
  }
  if (resultPrefix) {
    const listed = await r2.send(new ListObjectsV2Command({
      Bucket: resultsBucket, Prefix: resultPrefix,
    })).catch(() => ({ Contents: [] }));
    for (const object of listed.Contents ?? []) {
      if (object.Key) {
        await r2.send(new DeleteObjectCommand({ Bucket: resultsBucket, Key: object.Key }))
          .catch(() => {});
      }
    }
  }
  r2.destroy();
  await db.close();
}

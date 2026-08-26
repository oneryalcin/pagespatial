import { createServer } from 'node:http';
import { once } from 'node:events';
import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { issueApiKey } from '../src/api-keys.mjs';
import { createApiHandler } from '../src/http.mjs';
import { migrate } from '../src/migrate.mjs';

const SHA = 'a'.repeat(64);
let db;
let userId;
let server;
let base;
let apiKey;

before(async () => { db = await PGlite.create(); });

beforeEach(async () => {
  await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  userId = (await db.query(
    "INSERT INTO users (email, status) VALUES ('http@example.test','active') RETURNING id",
  )).rows[0].id;
  apiKey = (await issueApiKey(db, { userId, name: 'http test' })).secret;
  const pool = {
    async connect() { return { query: (...args) => db.query(...args), release() {} }; },
  };
  const handler = createApiHandler({
    db,
    pool,
    inputStore: {
      bucket: 'inputs',
      async createUploadGrant() {
        return {
          method: 'PUT', url: 'https://upload.invalid/signed',
          expires_at: '2026-08-26T12:00:00.000Z',
          headers: { 'content-type': 'application/pdf' },
        };
      },
      async head() { return { bytes: 589, contentType: 'application/pdf' }; },
    },
    resultStore: { bucket: 'results' },
    createRequestId: () => '11111111-1111-4111-8111-111111111111',
  });
  server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  server.close();
  await once(server, 'close');
});

test('HTTP vertical slice submits, replays, finalizes, and reports status', async () => {
  const submit = () => fetch(`${base}/v1/jobs`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'idempotency-key': 'http-1',
    },
    body: JSON.stringify({ input_sha256: SHA }),
  });
  const first = await submit();
  const firstBody = await first.json();
  assert.equal(first.status, 201);
  assert.equal(firstBody.job.state, 'uploading');
  assert.equal(firstBody.upload.method, 'PUT');

  const replay = await submit();
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).job.id, firstBody.job.id);

  const finalized = await fetch(`${base}/v1/jobs/${firstBody.job.id}/finalize`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(finalized.status, 202);
  assert.equal((await finalized.json()).job.state, 'queued');

  const status = await fetch(`${base}/v1/jobs/${firstBody.job.id}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  assert.equal(status.status, 200);
  assert.equal((await status.json()).job.state, 'queued');
});

test('HTTP rejects extra fields with the one error envelope', async () => {
  const response = await fetch(`${base}/v1/jobs`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'idempotency-key': 'http-2',
    },
    body: JSON.stringify({ input_sha256: SHA, extra: true }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: {
      code: 'invalid_request',
      message: 'Request fields must equal: input_sha256.',
      request_id: '11111111-1111-4111-8111-111111111111',
    },
  });
});

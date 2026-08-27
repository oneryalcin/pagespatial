import { createServer } from 'node:http';
import { once } from 'node:events';
import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { PGlite } from '@electric-sql/pglite';
import { authenticateApiKey, issueApiKey } from '../src/api-keys.mjs';
import { createApiHandler } from '../src/http.mjs';
import { migrate } from '../src/migrate.mjs';

const SHA = 'a'.repeat(64);
let db;
let userId;
let server;
let base;
let apiKey;
let authFailure;
let logs;
let logThrows;
let healthDependencies;

before(async () => { db = await PGlite.create(); });

test('HTTP handler refuses to start without its canonical host', () => {
  assert.throws(() => createApiHandler({}), /apiHost is required/u);
});

beforeEach(async () => {
  authFailure = null;
  logs = [];
  logThrows = false;
  healthDependencies = {
    r2_input: async () => {},
    r2_results: async () => {},
    modal: async () => {},
  };
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
    apiHost: '127.0.0.1',
    appHost: 'app.test',
    appOrigin: 'https://app.test',
    authenticateAccess: async () => ({ userId, email: 'http@example.test' }),
    authenticate(authorization) {
      if (authFailure) throw authFailure;
      return authenticateApiKey(db, authorization);
    },
    log: { error(...args) { if (logThrows) throw new Error('logger failed'); logs.push(args); } },
    createRequestId: () => '11111111-1111-4111-8111-111111111111',
    healthDependencies,
  });
  server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

test('health keeps Postgres readiness and reports optional dependencies separately', async () => {
  healthDependencies.r2_results = async () => { throw new Error('secret provider detail'); };
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: 'ready',
    degraded: { r2_input: false, r2_results: true, modal: false },
  });
});

test('HTTP authentication failures advertise Bearer authentication', async () => {
  const response = await fetch(`${base}/v1/jobs/00000000-0000-4000-8000-000000000000`);
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('www-authenticate'), 'Bearer');
  const rendered = inspect(logs, { depth: 10 });
  assert.match(rendered, /authentication_required/u);
  assert.match(rendered, /job_status/u);
  assert.match(rendered, /GET/u);
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

test('HTTP admission failure includes Retry-After', async () => {
  for (let index = 0; index < 5; index += 1) {
    const response = await fetch(`${base}/v1/jobs`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'idempotency-key': `admission-${index}`,
      },
      body: JSON.stringify({ input_sha256: SHA }),
    });
    assert.equal(response.status, 201);
  }
  const rejected = await fetch(`${base}/v1/jobs`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'idempotency-key': 'admission-rejected',
    },
    body: JSON.stringify({ input_sha256: SHA }),
  });
  assert.equal(rejected.status, 429);
  assert.equal(rejected.headers.get('retry-after'), '60');
  assert.equal((await rejected.json()).error.code, 'admission_limit');
  assert.match(inspect(logs, { depth: 10 }), /admission_limit/u);
});

test('HTTP logs unexpected failure without leaking provider text', async () => {
  authFailure = new Error('https://r2.invalid/object?X-Amz-Signature=secret');
  const response = await fetch(`${base}/v1/jobs/00000000-0000-4000-8000-000000000000`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  assert.equal(response.status, 503);
  assert.deepEqual((await response.json()).error, {
    code: 'service_unavailable',
    message: 'Service is temporarily unavailable.',
    request_id: '11111111-1111-4111-8111-111111111111',
  });
  const serialized = inspect(logs, { depth: 10 });
  assert.match(serialized, /api_request_failed/u);
  assert.doesNotMatch(serialized, /Signature|secret|r2\.invalid/u);
});

test('HTTP failure response survives a poisonous error and broken logger', async () => {
  authFailure = Object.defineProperty({}, 'cause', {
    get() { throw new Error('poisoned error'); },
  });
  logThrows = true;
  const response = await fetch(`${base}/v1/jobs/00000000-0000-4000-8000-000000000000`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'service_unavailable');
});

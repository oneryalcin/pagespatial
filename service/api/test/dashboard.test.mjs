import { request as httpRequest } from 'node:http';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { PGlite } from '@electric-sql/pglite';
import { errors } from 'jose';
import { ApiError } from '../src/api-errors.mjs';
import { issueApiKey } from '../src/api-keys.mjs';
import { createApiHandler } from '../src/http.mjs';
import { migrate } from '../src/migrate.mjs';

let db;
let userId;
let server;
let port;
let logs;
let uploadedJobs;

before(async () => { db = await PGlite.create(); });

beforeEach(async () => {
  logs = [];
  uploadedJobs = new Set();
  await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  userId = (await db.query(
    "INSERT INTO users (email, status) VALUES ('dashboard@example.test','active') RETURNING id",
  )).rows[0].id;
  const pool = {
    async connect() { return { query: (...args) => db.query(...args), release() {} }; },
  };
  const handler = createApiHandler({
    db,
    pool,
    inputStore: {
      bucket: 'inputs',
      uploadOrigin: 'https://input.r2.test',
      async createUploadGrant({ jobId }) {
        return {
          method: 'PUT',
          url: `https://input.r2.test/inputs/${jobId}.pdf?signature=secret`,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          headers: { 'content-type': 'application/pdf' },
        };
      },
      async head({ jobId }) {
        return uploadedJobs.has(jobId)
          ? { bytes: 1024, contentType: 'application/pdf' } : null;
      },
    },
    resultStore: {
      bucket: 'results',
      async createDownloadGrant({ key }) {
        return { download_url: `https://download.test/${key}?signature=secret` };
      },
    },
    apiHost: 'api.test',
    appHost: 'app.test',
    appOrigin: 'https://app.test',
    log: { error(...args) { logs.push(args); } },
    async authenticateAccess(jwt) {
      if (jwt === 'unavailable') {
        throw new ApiError(503, 'service_unavailable', 'Service is temporarily unavailable.', {
          cause: new Error('https://r2.invalid/object?X-Amz-Signature=secret'),
        });
      }
      if (jwt === 'unknown-key') {
        throw new ApiError(403, 'forbidden', 'Access denied.', {
          cause: new errors.JWKSNoMatchingKey(),
        });
      }
      if (jwt !== 'valid') throw new ApiError(403, 'forbidden', 'Access denied.');
      return { userId, email: 'dashboard@example.test' };
    },
  });
  server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  port = server.address().port;
});

afterEach(async () => {
  server.close();
  await once(server, 'close');
});

function request(path, { method = 'GET', host = 'app.test', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1', port, path, method,
      headers: { host, ...headers, ...(body ? { 'content-length': Buffer.byteLength(body) } : {}) },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const access = { 'cf-access-jwt-assertion': 'valid' };
const form = {
  ...access,
  origin: 'https://app.test',
  'content-type': 'application/x-www-form-urlencoded',
};
const browserJson = {
  ...access,
  origin: 'https://app.test',
  'content-type': 'application/json',
};

async function seedJob({
  owner = userId, state = 'uploading', pages = null, cost = null,
  failureCode = null, retained = true,
} = {}) {
  const row = (await db.query(
    `INSERT INTO jobs (
       user_id, state, input_uri, input_digest, input_bytes,
       pages_actual, unit_price_micros, estimated_cost_micros,
       error, failure_code, created_at, queued_at, completed_at,
       upload_expires_at, retention_expires_at
     ) VALUES (
       $1, CASE WHEN $2 = 'succeeded' THEN 'uploading' ELSE $2 END,
       'r2://inputs/inputs/pending.pdf', repeat('a', 64),
       CASE WHEN $2 = 'uploading' THEN NULL ELSE 1024 END,
       $3, 1000, $4, CASE WHEN $2 = 'failed' THEN 'private detail' ELSE NULL END,
       $5, now() - interval '10 minutes',
       CASE WHEN $2 IN ('queued','dispatched','succeeded','failed')
         THEN now() - interval '9 minutes' ELSE NULL END,
       CASE WHEN $2 IN ('succeeded','failed') THEN now() - interval '1 minute' ELSE NULL END,
       now() + interval '50 minutes',
       CASE WHEN $2 = 'succeeded' THEN now() + ($6::boolean::integer * interval '2 days')
         ELSE NULL END
     ) RETURNING *`,
    [owner, state, pages, cost, failureCode, retained],
  )).rows[0];
  if (state !== 'succeeded') return row;
  const attempt = (await db.query(
    `INSERT INTO job_attempts (
       job_id, modal_call_id, state, result_uri, result_digest, pages,
       dispatched_at, completed_at
     ) VALUES ($1::uuid, 'call-' || $1::text, 'succeeded',
       'r2://results/results/' || $1::text || '/attempt/result.json',
       repeat('b', 64), $2, now() - interval '8 minutes', now() - interval '1 minute')
     RETURNING id, result_uri, result_digest`,
    [row.id, pages],
  )).rows[0];
  return (await db.query(
    `UPDATE jobs SET state = 'succeeded', accepted_attempt_id = $2,
                     result_uri = $3, result_digest = $4
      WHERE id = $1 RETURNING *`,
    [row.id, attempt.id, attempt.result_uri, attempt.result_digest],
  )).rows[0];
}

test('dashboard creates, lists, and revokes a key without redisclosing its secret', async () => {
  await issueApiKey(db, { userId, name: '<existing>' });
  const listed = await request('/keys', { headers: access });
  assert.equal(listed.status, 200);
  assert.equal(listed.headers['cache-control'], 'no-store');
  assert.match(listed.headers['content-security-policy'], /default-src 'none'/u);
  assert.match(listed.body, /&lt;existing&gt;/u);
  assert.doesNotMatch(listed.body, /<existing>/u);

  const created = await request('/keys', {
    method: 'POST', headers: form, body: 'name=automation',
  });
  assert.equal(created.status, 201);
  const secret = created.body.match(/ps_live_[A-Za-z0-9_-]{43}/u)?.[0];
  assert.ok(secret);

  const afterCreate = await request('/keys', { headers: access });
  assert.doesNotMatch(afterCreate.body, new RegExp(secret, 'u'));
  const keyId = (await db.query(
    "SELECT id FROM api_keys WHERE user_id = $1 AND name = 'automation'",
    [userId],
  )).rows[0].id;
  const revoked = await request(`/keys/${keyId}/revoke`, {
    method: 'POST', headers: form,
  });
  assert.equal(revoked.status, 303);
  assert.equal(revoked.headers.location, '/keys');
  assert.ok((await db.query('SELECT revoked_at FROM api_keys WHERE id = $1', [keyId])).rows[0].revoked_at);
});

test('dashboard jobs and usage show only tenant-owned, truthful terminal data', async () => {
  const succeeded = await seedJob({ state: 'succeeded', pages: 12, cost: 12_000 });
  const failed = await seedJob({ state: 'failed', failureCode: 'invalid_pdf' });
  const uploading = await seedJob();
  const foreign = (await db.query(
    "INSERT INTO users (email, status) VALUES ('foreign-jobs@example.test','active') RETURNING id",
  )).rows[0];
  const foreignJob = await seedJob({ owner: foreign.id });

  const jobs = await request('/jobs', { headers: access });
  assert.equal(jobs.status, 200);
  assert.match(jobs.body, /Documents submitted through the dashboard or API/u);
  assert.match(jobs.body, /Waiting for upload/u);
  assert.match(jobs.body, /Succeeded/u);
  assert.match(jobs.body, /Failed/u);
  assert.match(jobs.body, /\$0\.012/u);
  assert.match(jobs.body, /It is not an invoice or a measured per-job cloud bill/u);
  assert.match(jobs.body, new RegExp(succeeded.id.slice(0, 8), 'u'));
  assert.match(jobs.body, new RegExp(failed.id.slice(0, 8), 'u'));
  assert.match(jobs.body, new RegExp(uploading.id.slice(0, 8), 'u'));
  assert.doesNotMatch(jobs.body, new RegExp(foreignJob.id.slice(0, 8), 'u'));
  assert.doesNotMatch(jobs.body, /private detail/u);

  const active = await request('/jobs?state=active&date=all&page=1', { headers: access });
  assert.equal(active.status, 200);
  assert.match(active.body, new RegExp(uploading.id.slice(0, 8), 'u'));
  assert.doesNotMatch(active.body, new RegExp(succeeded.id.slice(0, 8), 'u'));

  const usage = await request('/usage', { headers: access });
  assert.equal(usage.status, 200);
  assert.match(usage.body, />12</u);
  assert.match(usage.body, /\$0\.012/u);
  assert.doesNotMatch(usage.body, /private detail/u);
});

test('dashboard job detail keeps internals private and grants only retained owned results', async () => {
  const succeeded = await seedJob({ state: 'succeeded', pages: 3, cost: 3000 });
  const detail = await request(`/jobs/${succeeded.id}`, { headers: access });
  assert.equal(detail.status, 200);
  assert.match(detail.body, new RegExp(succeeded.id, 'u'));
  assert.match(detail.body, /Download JSON result/u);
  assert.match(detail.body, /Submitted.*UTC/us);
  assert.match(detail.body, /Input SHA-256/u);
  assert.doesNotMatch(detail.body, /modal_call_id|accepted_attempt_id|r2:\/\//u);

  const grant = await request(`/jobs/${succeeded.id}/result`, { headers: access });
  assert.equal(grant.status, 303);
  assert.match(grant.headers.location, /^https:\/\/download\.test\//u);
  assert.doesNotMatch(grant.body, /signature=secret/u);

  const expired = await seedJob({ state: 'succeeded', pages: 1, cost: 1000, retained: false });
  assert.match((await request(`/jobs/${expired.id}`, { headers: access })).body, /Result expired/u);
  assert.equal((await request(`/jobs/${expired.id}/result`, { headers: access })).status, 410);

  const foreign = (await db.query(
    "INSERT INTO users (email, status) VALUES ('foreign-detail@example.test','active') RETURNING id",
  )).rows[0];
  const foreignJob = await seedJob({ owner: foreign.id });
  assert.equal((await request(`/jobs/${foreignJob.id}`, { headers: access })).status, 404);
});

test('dashboard browser upload reuses the job plane without exposing credentials', async () => {
  const page = await request('/jobs/new', { headers: access });
  assert.equal(page.status, 200);
  assert.match(page.body, /Submit a PDF/u);
  assert.match(page.body, /dashboard-upload\.js/u);
  assert.match(page.headers['content-security-policy'], /script-src 'self'/u);
  assert.match(
    page.headers['content-security-policy'],
    /connect-src 'self' https:\/\/input\.r2\.test/u,
  );
  assert.doesNotMatch(page.body, /ps_live_|R2_API_|SECRET_ACCESS/u);

  const script = await request('/assets/dashboard-upload.js', { headers: access });
  assert.equal(script.status, 200);
  assert.match(script.headers['content-type'], /^text\/javascript/u);
  assert.match(script.body, /crypto\.subtle\.digest/u);
  assert.match(script.body, /XMLHttpRequest/u);
  assert.doesNotMatch(script.body, /api[_-]?key|authorization/iu);

  const created = await request('/jobs', {
    method: 'POST',
    headers: { ...browserJson, 'idempotency-key': 'browser-attempt-1' },
    body: JSON.stringify({ input_sha256: 'c'.repeat(64) }),
  });
  assert.equal(created.status, 201);
  const createdBody = JSON.parse(created.body);
  assert.equal(createdBody.job.state, 'uploading');
  assert.equal(createdBody.upload.method, 'PUT');
  assert.deepEqual(createdBody.upload.headers, { 'content-type': 'application/pdf' });
  assert.match(createdBody.upload.url, /^https:\/\/input\.r2\.test\//u);
  assert.doesNotMatch(created.body, /access_key|secret_access|ps_live_/iu);

  const replayed = await request('/jobs', {
    method: 'POST',
    headers: { ...browserJson, 'idempotency-key': 'browser-attempt-1' },
    body: JSON.stringify({ input_sha256: 'c'.repeat(64) }),
  });
  assert.equal(replayed.status, 200);
  assert.equal(JSON.parse(replayed.body).job.id, createdBody.job.id);

  const incomplete = await request(`/jobs/${createdBody.job.id}/finalize`, {
    method: 'POST', headers: browserJson, body: '{}',
  });
  assert.equal(incomplete.status, 409);
  assert.equal(JSON.parse(incomplete.body).error.code, 'upload_incomplete');

  uploadedJobs.add(createdBody.job.id);
  const finalized = await request(`/jobs/${createdBody.job.id}/finalize`, {
    method: 'POST', headers: browserJson, body: '{}',
  });
  assert.equal(finalized.status, 202);
  assert.equal(JSON.parse(finalized.body).job.state, 'queued');
  assert.equal((await request(`/jobs/${createdBody.job.id}`, { headers: access })).status, 200);
});

test('dashboard browser upload rejects CSRF and cross-tenant finalization', async () => {
  const missingOrigin = await request('/jobs', {
    method: 'POST',
    headers: { ...access, 'content-type': 'application/json', 'idempotency-key': 'missing-origin' },
    body: JSON.stringify({ input_sha256: 'd'.repeat(64) }),
  });
  assert.equal(missingOrigin.status, 403);
  assert.equal(JSON.parse(missingOrigin.body).error.code, 'forbidden');

  const foreign = (await db.query(
    "INSERT INTO users (email, status) VALUES ('foreign-upload@example.test','active') RETURNING id",
  )).rows[0];
  const foreignJob = await seedJob({ owner: foreign.id });
  uploadedJobs.add(foreignJob.id);
  const response = await request(`/jobs/${foreignJob.id}/finalize`, {
    method: 'POST', headers: browserJson, body: '{}',
  });
  assert.equal(response.status, 404);
  assert.equal(JSON.parse(response.body).error.code, 'not_found');
});

test('dashboard has a no-JavaScript guide, fixed pagination, and strict filters', async () => {
  for (let index = 0; index < 26; index += 1) await seedJob();
  const first = await request('/jobs?date=all', { headers: access });
  assert.equal(first.status, 200);
  assert.match(first.body, /Page 1 of 2/u);
  assert.match(first.body, /page=2/u);
  const second = await request('/jobs?date=all&page=2', { headers: access });
  assert.equal(second.status, 200);
  assert.match(second.body, /Page 2 of 2/u);
  assert.equal((await request('/jobs?state=unknown', { headers: access })).status, 400);
  assert.equal((await request('/jobs?date=all&page=3', { headers: access })).status, 404);

  const guide = await request('/guide', { headers: access });
  assert.equal(guide.status, 200);
  assert.match(guide.body, /sha256sum document\.pdf/u);
  assert.match(guide.body, /api\.pagespatial\.dev/u);
  assert.doesNotMatch(guide.body, /<script/iu);

  const styles = await request('/dashboard.css', { headers: access });
  assert.equal(styles.status, 200);
  assert.match(styles.headers['content-type'], /^text\/css/u);
  assert.match(styles.body, /--wall: #e9e4d8/u);
  assert.match(styles.body, /font-family: "Newsreader"/u);

  const logo = await request('/assets/pagespatial-logo.png', { headers: access });
  assert.equal(logo.status, 200);
  assert.match(logo.headers['content-type'], /^image\/png/u);
  assert.ok(logo.body.length > 1000);

  const font = await request('/assets/fonts/instrument-sans-400.ttf', { headers: access });
  assert.equal(font.status, 200);
  assert.match(font.headers['content-type'], /^font\/ttf/u);
  assert.ok(font.body.length > 1000);
});

test('dashboard uses an explicit revoke confirmation and preserves revocation time', async () => {
  const issued = await issueApiKey(db, { userId, name: 'Production' });
  const confirm = await request(`/keys/${issued.key.id}/revoke`, { headers: access });
  assert.equal(confirm.status, 200);
  assert.match(confirm.body, /Revoke API key\?/u);
  assert.match(confirm.body, /Production/u);
  assert.ok((await db.query('SELECT revoked_at FROM api_keys WHERE id = $1', [issued.key.id])).rows[0].revoked_at == null);
});

test('dashboard rejects forged identity, foreign Origin, extra fields, and foreign keys', async () => {
  assert.equal((await request('/keys', {
    headers: { 'cf-access-authenticated-user-email': 'dashboard@example.test' },
  })).status, 403);
  assert.equal((await request('/keys', {
    method: 'POST', headers: { ...form, origin: 'https://evil.test' }, body: 'name=x',
  })).status, 403);
  assert.equal((await request('/keys', {
    method: 'POST', headers: access, body: 'name=x',
  })).status, 403);
  assert.equal((await request('/keys', {
    method: 'POST', headers: form, body: 'name=x&extra=y',
  })).status, 400);
  assert.equal((await request('/keys', {
    method: 'POST', headers: form, body: 'name=%FF',
  })).status, 400);
  assert.equal((await request('/keys', {
    method: 'POST', headers: form, body: `name=${'x'.repeat(4097)}`,
  })).status, 400);
  assert.equal((await request('/keys', {
    method: 'POST', headers: form, body: `name=${encodeURIComponent('🚀'.repeat(64))}`,
  })).status, 201);
  assert.equal((await request('/keys', {
    method: 'POST', headers: form, body: `name=${encodeURIComponent('🚀'.repeat(65))}`,
  })).status, 400);

  const foreign = (await db.query(
    "INSERT INTO users (email, status) VALUES ('other@example.test','active') RETURNING id",
  )).rows[0];
  const foreignKey = await issueApiKey(db, { userId: foreign.id, name: 'foreign' });
  assert.equal((await request(`/keys/${foreignKey.key.id}/revoke`, {
    method: 'POST', headers: form,
  })).status, 404);
  const serialized = inspect(logs, { depth: 10 });
  assert.match(serialized, /foreign_origin/u);
  assert.match(serialized, /missing_origin/u);
  assert.doesNotMatch(serialized, /evil\.test/u);
});

test('dashboard logs provider failure without leaking its message', async () => {
  const response = await request('/keys', {
    headers: { 'cf-access-jwt-assertion': 'unavailable' },
  });
  assert.equal(response.status, 503);
  assert.doesNotMatch(response.body, /Signature|secret|r2\.invalid/u);
  const serialized = inspect(logs, { depth: 10 });
  assert.match(serialized, /dashboard_request_failed/u);
  assert.doesNotMatch(serialized, /Signature|secret|r2\.invalid/u);
});

test('dashboard reports a concurrent owner suspension as forbidden', async () => {
  await db.query("UPDATE users SET status = 'suspended' WHERE id = $1", [userId]);
  const response = await request('/keys', {
    method: 'POST', headers: form, body: 'name=valid',
  });
  assert.equal(response.status, 403);
  assert.doesNotMatch(response.body, /Key name/u);
  assert.match(inspect(logs, { depth: 10 }), /dashboard_request_rejected/u);
});

test('dashboard logs an unknown signing key without turning it into 503', async () => {
  const response = await request('/keys', {
    headers: { 'cf-access-jwt-assertion': 'unknown-key' },
  });
  assert.equal(response.status, 403);
  const rendered = inspect(logs, { depth: 10 });
  assert.match(rendered, /ERR_JWKS_NO_MATCHING_KEY/u);
  assert.match(rendered, /keys_list/u);
});

test('API and dashboard hosts expose only their own routes', async () => {
  assert.equal((await request('/keys', { host: 'api.test', headers: access })).status, 404);
  assert.equal((await request('/v1/jobs', { host: 'app.test', headers: access })).status, 404);
  assert.equal((await request('/keys', { host: 'wrong.test', headers: access })).status, 421);
});

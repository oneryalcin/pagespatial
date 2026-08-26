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

before(async () => { db = await PGlite.create(); });

beforeEach(async () => {
  logs = [];
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
    inputStore: { bucket: 'inputs' },
    resultStore: { bucket: 'results' },
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

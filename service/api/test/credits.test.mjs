import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { acceptAttempt } from '../src/accept.mjs';
import {
  loadCreditSummary, provisionAccessUser, requestMoreCredits,
} from '../src/credits.mjs';
import { createOrReplayJob } from '../src/jobs.mjs';
import { migrate } from '../src/migrate.mjs';

const SHA = 'a'.repeat(64);
let db;
let pool;

before(async () => { db = await PGlite.create(); });

beforeEach(async () => {
  await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  pool = {
    async connect() {
      return { query: (...args) => db.query(...args), release() {} };
    },
  };
});

test('verified self-signup creates one active account and one trial grant', async () => {
  const values = await Promise.all([
    provisionAccessUser(db, {
      email: 'new@example.test', allowSelfSignup: true, trialPages: 100,
    }),
    provisionAccessUser(db, {
      email: 'new@example.test', allowSelfSignup: true, trialPages: 100,
    }),
  ]);
  assert.equal(new Set(values).size, 1);
  const userId = values[0];
  assert.ok(userId);
  assert.deepEqual(await loadCreditSummary(db, { userId }), {
    granted: 100, used: 0, reserved: 0, available: 100, requestPending: false,
  });
  assert.equal(Number((await db.query(
    'SELECT count(*) FROM credit_grants WHERE user_id = $1', [userId],
  )).rows[0].count), 1);

  const statements = [];
  const observed = {
    query(...args) {
      statements.push(args[0]);
      return db.query(...args);
    },
  };
  assert.equal(await provisionAccessUser(observed, {
    email: 'new@example.test', allowSelfSignup: true, trialPages: 100,
  }), userId);
  assert.equal(statements.length, 1);
  assert.doesNotMatch(statements[0], /INSERT|UPDATE/iu);
});

test('unknown identities stay closed when self-signup is disabled', async () => {
  assert.equal(await provisionAccessUser(db, {
    email: 'closed@example.test', allowSelfSignup: false,
  }), null);
  assert.equal(Number((await db.query('SELECT count(*) FROM users')).rows[0].count), 0);
});

test('admission reserves available pages exactly and replay survives exhaustion', async () => {
  const userId = (await db.query(
    "INSERT INTO users (email, status) VALUES ('credits@example.test','active') RETURNING id",
  )).rows[0].id;
  await db.query(
    `INSERT INTO credit_grants (user_id, pages, source, reference)
     VALUES ($1, 250, 'manual', 'test-grant')`, [userId],
  );
  const submit = (idempotencyKey) => createOrReplayJob({
    pool, userId, idempotencyKey, inputSha256: SHA, inputBucket: 'inputs',
  });

  const first = await submit('first');
  const second = await submit('second');
  assert.equal(Number(first.row.reserved_pages), 200);
  assert.equal(Number(second.row.reserved_pages), 50);
  assert.equal((await submit('first')).created, false);
  await assert.rejects(
    submit('third'),
    (error) => error.status === 402 && error.code === 'credits_exhausted',
  );

  await db.query(
    `UPDATE jobs SET state = 'failed', failure_code = 'processing_failed',
                     completed_at = now()
      WHERE id = $1`,
    [first.row.id],
  );
  const replacement = await submit('replacement');
  assert.equal(Number(replacement.row.reserved_pages), 200);
});

test('successful work spends actual pages and releases the unused reservation', async () => {
  const userId = await provisionAccessUser(db, {
    email: 'actual@example.test', allowSelfSignup: true, trialPages: 100,
  });
  const created = await createOrReplayJob({
    pool, userId, idempotencyKey: 'actual', inputSha256: SHA, inputBucket: 'inputs',
  });
  await db.query(
    `UPDATE jobs SET state = 'queued', queued_at = now(), input_bytes = 589
      WHERE id = $1`, [created.row.id],
  );
  const attempt = (await db.query(
    `INSERT INTO job_attempts (job_id, state) VALUES ($1, 'dispatching') RETURNING id`,
    [created.row.id],
  )).rows[0];
  assert.deepEqual(await acceptAttempt(db, {
    jobId: created.row.id,
    attemptId: attempt.id,
    status: 'completed',
    resultUri: 'r2://results/result.json',
    resultDigest: 'b'.repeat(64),
    pages: 4,
    resultCreatedAt: new Date('2026-09-01T12:00:00Z'),
  }), { recorded: true, won: true });
  assert.deepEqual(await loadCreditSummary(db, { userId }), {
    granted: 100, used: 4, reserved: 0, available: 96, requestPending: false,
  });
});

test('credit requests are idempotent while one request is pending', async () => {
  const userId = await provisionAccessUser(db, {
    email: 'request@example.test', allowSelfSignup: true,
  });
  const first = await requestMoreCredits(db, { userId });
  const replay = await requestMoreCredits(db, { userId });
  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.equal(replay.id, first.id);
  assert.equal((await loadCreditSummary(db, { userId })).requestPending, true);
});

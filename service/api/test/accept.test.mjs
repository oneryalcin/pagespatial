// The crash window. This is the scenario three adversarial review passes
// kept finding bugs in, so it is tested against a real Postgres (PGlite,
// in-process -- no service container) rather than a mock.
//
// Each test asserts ONE failure reason.

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { acceptAttempt, markDispatchUnknown, failAttempt } from '../src/accept.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(join(here, '..', 'migrations', '001_job_plane.sql'), 'utf8');

let db;
let userId;

before(async () => { db = await PGlite.create(); });

beforeEach(async () => {
  await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await db.exec(migration);
  const { rows } = await db.query(
    `INSERT INTO users (email, status) VALUES ('m1@example.test','active') RETURNING id`,
  );
  userId = rows[0].id;
});

const newJob = async (state = 'queued') => {
  const { rows } = await db.query(
    `INSERT INTO jobs (user_id, state, input_uri, input_digest, input_bytes,
                       unit_price_micros, upload_expires_at)
     VALUES ($1, $2, 'r2://inputs/doc.pdf', $3, 589, 1000, now() + interval '1 hour')
     RETURNING id`,
    [userId, state, 'a'.repeat(64)],
  );
  return rows[0].id;
};

const newAttempt = async (jobId, state = 'dispatching') => {
  const { rows } = await db.query(
    `INSERT INTO job_attempts (job_id, state) VALUES ($1, $2) RETURNING id`,
    [jobId, state],
  );
  return rows[0].id;
};

const job = async (id) => (await db.query('SELECT * FROM jobs WHERE id = $1', [id])).rows[0];
const attempt = async (id) => (await db.query('SELECT * FROM job_attempts WHERE id = $1', [id])).rows[0];

// ---------------------------------------------------------------------------
// The exact crash-window ordering:
//   A spawned -> api dies before call id persists -> reconciler mints B
//   -> B succeeds and becomes authoritative -> A returns LATE -> A must lose
// ---------------------------------------------------------------------------

test('a late attempt does not displace the accepted result', async () => {
  const jobId = await newJob();
  const a = await newAttempt(jobId);

  await markDispatchUnknown(db, a);                       // api died mid-dispatch
  const b = await newAttempt(jobId);                      // reconciler mints a NEW id

  const bWon = await acceptAttempt(db, {
    jobId, attemptId: b, resultUri: `r2://results/${jobId}/${b}/exec-b.json`,
    resultDigest: 'b'.repeat(64), pages: 9,
  });
  assert.equal(bWon, true, 'B should win the empty slot');

  // A finally returns, with a perfectly valid result of its own.
  const aWon = await acceptAttempt(db, {
    jobId, attemptId: a, resultUri: `r2://results/${jobId}/${a}/exec-a.json`,
    resultDigest: 'c'.repeat(64), pages: 9,
  });

  assert.equal(aWon, false, 'A must lose: the slot was already filled');
});

test('every job-level result field still comes from the winner', async () => {
  const jobId = await newJob();
  const a = await newAttempt(jobId);
  await markDispatchUnknown(db, a);
  const b = await newAttempt(jobId);

  await acceptAttempt(db, {
    jobId, attemptId: b, resultUri: `r2://results/${jobId}/${b}/exec-b.json`,
    resultDigest: 'b'.repeat(64), pages: 9,
  });
  await acceptAttempt(db, {
    jobId, attemptId: a, resultUri: `r2://results/${jobId}/${a}/exec-a.json`,
    resultDigest: 'c'.repeat(64), pages: 42,
  });

  const j = await job(jobId);
  assert.deepEqual(
    {
      accepted: j.accepted_attempt_id,
      uri: j.result_uri,
      digest: j.result_digest,
      pages: j.pages_actual,
      cost: Number(j.estimated_cost_micros),
    },
    {
      accepted: b,
      uri: `r2://results/${jobId}/${b}/exec-b.json`,
      digest: 'b'.repeat(64),
      pages: 9,
      cost: 9000, // unit_price_micros(1000) * pages(9) -- never A's 42
    },
  );
});

test("the loser's own result object stays recorded at its own key", async () => {
  const jobId = await newJob();
  const a = await newAttempt(jobId);
  await markDispatchUnknown(db, a);
  const b = await newAttempt(jobId);

  await acceptAttempt(db, { jobId, attemptId: b, resultUri: 'r2://b', resultDigest: 'b'.repeat(64), pages: 9 });
  await acceptAttempt(db, { jobId, attemptId: a, resultUri: 'r2://a', resultDigest: 'c'.repeat(64), pages: 9 });

  // Losing is not failing. The attempt succeeded; it lost a race.
  const loser = await attempt(a);
  assert.deepEqual(
    { state: loser.state, uri: loser.result_uri },
    { state: 'succeeded', uri: 'r2://a' },
  );
});

test('dispatch_unknown is terminal and is never re-spawned under its own id', async () => {
  const jobId = await newJob();
  const a = await newAttempt(jobId);
  await markDispatchUnknown(db, a);

  // A second reconciler tick must not walk it back to 'dispatching'.
  await markDispatchUnknown(db, a);

  assert.equal((await attempt(a)).state, 'dispatch_unknown');
});

test('a failing attempt does not fail a job another attempt may still win', async () => {
  const jobId = await newJob();
  const a = await newAttempt(jobId);
  const b = await newAttempt(jobId, 'dispatched'); // still outstanding

  const failed = await failAttempt(db, { jobId, attemptId: a, error: 'RemoteError: boom' });

  assert.equal(failed, false, 'the job must stay open while B is outstanding');
});

test('a late success flips a terminally failed job (deliberate)', async () => {
  const jobId = await newJob();
  const a = await newAttempt(jobId);
  await failAttempt(db, { jobId, attemptId: a, error: 'RemoteError: boom' });
  assert.equal((await job(jobId)).state, 'failed', 'precondition: job is terminally failed');

  const b = await newAttempt(jobId);
  const bWon = await acceptAttempt(db, {
    jobId, attemptId: b, resultUri: 'r2://b', resultDigest: 'b'.repeat(64), pages: 3,
  });

  assert.equal(bWon, true, 'a good result must not be orphaned by an earlier failure');
});

test('the accepted slot survives concurrent installs', async () => {
  const jobId = await newJob();
  const a = await newAttempt(jobId);
  const b = await newAttempt(jobId);

  const results = await Promise.all([
    acceptAttempt(db, { jobId, attemptId: a, resultUri: 'r2://a', resultDigest: 'a'.repeat(64), pages: 1 }),
    acceptAttempt(db, { jobId, attemptId: b, resultUri: 'r2://b', resultDigest: 'b'.repeat(64), pages: 1 }),
  ]);

  assert.equal(results.filter(Boolean).length, 1, 'exactly one install may succeed');
});

// ---------------------------------------------------------------------------
// Schema invariants that the API depends on
// ---------------------------------------------------------------------------

test('a job cannot be created without a 64-hex input digest', async () => {
  await assert.rejects(
    db.query(
      `INSERT INTO jobs (user_id, state, input_uri, input_digest, unit_price_micros, upload_expires_at)
       VALUES ($1,'uploading','r2://x','not-a-digest',1000, now())`,
      [userId],
    ),
    /input_digest/,
  );
});

test('an over-cap upload is rejected by the database, not just the API', async () => {
  await assert.rejects(
    db.query(
      `INSERT INTO jobs (user_id, state, input_uri, input_digest, input_bytes,
                         unit_price_micros, upload_expires_at)
       VALUES ($1,'uploading','r2://x',$2, 94371841, 1000, now())`,
      [userId, 'a'.repeat(64)],
    ),
    /input_bytes/,
    '90 MiB is the qualified MAX_INPUT_BYTES',
  );
});

test('one idempotency key cannot create two jobs for a user', async () => {
  const insert = () => db.query(
    `INSERT INTO jobs (user_id, idempotency_key, state, input_uri, input_digest,
                       unit_price_micros, upload_expires_at)
     VALUES ($1,'key-1','uploading','r2://x',$2,1000, now())`,
    [userId, 'a'.repeat(64)],
  );
  await insert();
  await assert.rejects(insert(), /jobs_idempotency/);
});

test('two users may reuse the same idempotency key', async () => {
  const { rows } = await db.query(
    `INSERT INTO users (email, status) VALUES ('other@example.test','active') RETURNING id`,
  );
  const insert = (uid) => db.query(
    `INSERT INTO jobs (user_id, idempotency_key, state, input_uri, input_digest,
                       unit_price_micros, upload_expires_at)
     VALUES ($1,'shared-key','uploading','r2://x',$2,1000, now())`,
    [uid, 'a'.repeat(64)],
  );
  await insert(userId);
  await insert(rows[0].id); // must not collide: the index is (user_id, key)
});

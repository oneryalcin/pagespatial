// The crash window. This is the scenario adversarial review passes kept
// finding bugs in, so it is tested against a real Postgres (PGlite,
// in-process -- no service container) rather than a mock.
//
// SCOPE LIMIT, stated because a green test that proves less than it claims
// is worse than no test: PGlite runs Postgres in single-user mode and
// SERIALIZES queries on one connection. Measured: two concurrent
// `pg_sleep(1)` calls via Promise.all take 2002 ms, not ~1000 ms. So
// nothing here demonstrates true concurrency. The genuine two-connection
// race lives in accept-race.test.mjs and needs PAGESPATIAL_TEST_DATABASE_URL.
//
// Each test asserts ONE failure reason.

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../src/migrate.mjs';
import {
  acceptAttempt as acceptAttemptRaw,
  failAttempt, markDispatched, markDispatchUnknown, settleExhaustedJob,
} from '../src/accept.mjs';

const acceptAttempt = (database, input) =>
  acceptAttemptRaw(database, {
    status: 'completed',
    resultCreatedAt: new Date('2026-08-26T12:00:00Z'),
    compactResultUri: 'r2://compact',
    compactResultDigest: 'd'.repeat(64),
    compactResultBytes: 123,
    ...input,
  });

let db;
let userId;

before(async () => { db = await PGlite.create(); });

beforeEach(async () => {
  await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db); // the real runner, not a hand-rolled exec
  const { rows } = await db.query(
    `INSERT INTO users (email, status) VALUES ('m1@example.test','active') RETURNING id`,
  );
  userId = rows[0].id;
});

const newUser = async (email) =>
  (await db.query(`INSERT INTO users (email, status) VALUES ($1,'active') RETURNING id`, [email]))
    .rows[0].id;

const newJob = async (owner = userId, state = 'queued') => {
  const { rows } = await db.query(
    `INSERT INTO jobs (user_id, state, input_uri, input_digest, input_bytes,
                       unit_price_micros, upload_expires_at)
     VALUES ($1, $2, 'r2://inputs/doc.pdf', $3, 589, 1000, now() + interval '1 hour')
     RETURNING id`,
    [owner, state, 'a'.repeat(64)],
  );
  return rows[0].id;
};

const newAttempt = async (jobId, state = 'dispatching') => {
  const prior = (await db.query(
    'SELECT id FROM job_attempts WHERE job_id = $1 ORDER BY created_at, id LIMIT 1',
    [jobId],
  )).rows[0]?.id ?? null;
  const { rows } = await db.query(
    `INSERT INTO job_attempts (job_id, state, replaces_attempt_id, failure_code)
     VALUES ($1, $2, $3,
             CASE WHEN $2::text = 'failed' THEN 'processing_failed' ELSE NULL END)
     RETURNING id`,
    [jobId, state, prior],
  );
  return rows[0].id;
};

const job = async (id) => (await db.query('SELECT * FROM jobs WHERE id = $1', [id])).rows[0];
const attempt = async (id) => (await db.query('SELECT * FROM job_attempts WHERE id = $1', [id])).rows[0];

test('markDispatched rejects a missing or blank Modal call id', async () => {
  const jobId = await newJob();
  const attemptId = await newAttempt(jobId);
  for (const modalCallId of [null, undefined, '', '   ']) {
    await assert.rejects(
      markDispatched(db, { jobId, attemptId, modalCallId }),
      /modalCallId must be a non-empty string/,
    );
  }
  assert.equal((await attempt(attemptId)).state, 'dispatching');
});

test('the schema forbids dispatched state without a Modal call id', async () => {
  const jobId = await newJob();
  const attemptId = await newAttempt(jobId);
  await assert.rejects(
    db.query(`UPDATE job_attempts SET state = 'dispatched' WHERE id = $1`, [attemptId]),
    /job_attempts_dispatched_has_call_id/,
  );
});

test('the schema enforces the one-hour upload window on both sides', async () => {
  await assert.rejects(
    db.query(
      `INSERT INTO jobs (user_id, input_uri, input_digest, unit_price_micros, upload_expires_at)
       VALUES ($1, 'r2://inputs/late.pdf', $2, 1000, now() + interval '61 minutes')`,
      [userId, 'a'.repeat(64)],
    ),
    /jobs_upload_window_bounded/,
  );
  await assert.rejects(
    db.query(
      `INSERT INTO jobs (user_id, input_uri, input_digest, unit_price_micros, upload_expires_at)
       VALUES ($1, 'r2://inputs/past.pdf', $2, 1000, now())`,
      [userId, 'a'.repeat(64)],
    ),
    /jobs_upload_window_bounded/,
  );
});

test('acceptAttempt rejects a failed parser result before any write', async () => {
  const jobId = await newJob();
  const attemptId = await newAttempt(jobId);
  await markDispatchUnknown(db, { jobId, attemptId });
  await assert.rejects(
    acceptAttemptRaw(db, {
      jobId, attemptId, status: 'failed', resultUri: 'r2://failed',
      resultDigest: 'a'.repeat(64), pages: 0,
    }),
    /status must equal completed/,
  );
  assert.equal((await attempt(attemptId)).state, 'dispatch_unknown');
  assert.equal((await job(jobId)).state, 'queued');
});

test('acceptAttempt cannot complete an upload that was never finalized', async () => {
  const jobId = await newJob(userId, 'uploading');
  const attemptId = await newAttempt(jobId);
  await markDispatchUnknown(db, { jobId, attemptId });
  const result = await acceptAttempt(db, {
    jobId, attemptId, resultUri: 'r2://result',
    resultDigest: 'a'.repeat(64), pages: 1,
  });
  assert.deepEqual(result, { recorded: false, won: false });
  assert.equal((await attempt(attemptId)).state, 'dispatch_unknown');
  assert.equal((await job(jobId)).state, 'uploading');
});

// ---------------------------------------------------------------------------
// The crash-window ordering:
//   A spawned -> api dies before call id persists -> reconciler mints B
//   -> B succeeds and becomes authoritative -> A returns LATE -> A must lose
// ---------------------------------------------------------------------------

test('a late attempt does not displace the accepted result', async () => {
  const jobId = await newJob();
  const a = await newAttempt(jobId);
  await markDispatchUnknown(db, { jobId, attemptId: a });
  const b = await newAttempt(jobId);

  const bResult = await acceptAttempt(db, {
    jobId, attemptId: b, resultUri: 'r2://b', resultDigest: 'b'.repeat(64), pages: 9,
  });
  assert.equal(bResult.won, true, 'B should win the empty slot');

  const aResult = await acceptAttempt(db, {
    jobId, attemptId: a, resultUri: 'r2://a', resultDigest: 'c'.repeat(64), pages: 9,
  });
  assert.equal(aResult.won, false, 'A must lose: the slot was already filled');
});

test('every job-level result field still comes from the winner', async () => {
  const jobId = await newJob();
  const a = await newAttempt(jobId);
  await markDispatchUnknown(db, { jobId, attemptId: a });
  const b = await newAttempt(jobId);

  await acceptAttempt(db, { jobId, attemptId: b, resultUri: 'r2://b', resultDigest: 'b'.repeat(64), pages: 9 });
  await acceptAttempt(db, { jobId, attemptId: a, resultUri: 'r2://a', resultDigest: 'c'.repeat(64), pages: 42 });

  const j = await job(jobId);
  assert.deepEqual(
    { accepted: j.accepted_attempt_id, uri: j.result_uri, digest: j.result_digest,
      pages: j.pages_actual, cost: Number(j.estimated_cost_micros) },
    { accepted: b, uri: 'r2://b', digest: 'b'.repeat(64),
      pages: 9, cost: 9000 }, // 1000 * 9 -- never A's 42
  );
});

test('acceptance anchors result access to R2 LastModified, not observation time', async () => {
  const jobId = await newJob();
  const a = await newAttempt(jobId);
  const created = new Date('2026-08-20T03:04:05Z');

  await acceptAttempt(db, {
    jobId, attemptId: a, resultUri: 'r2://result',
    resultDigest: 'b'.repeat(64), pages: 1, resultCreatedAt: created,
  });

  const j = await job(jobId);
  assert.equal(new Date(j.retention_expires_at).toISOString(), '2026-08-22T03:04:05.000Z');
});

test('acceptance refuses an invalid R2 LastModified timestamp', async () => {
  const jobId = await newJob();
  const a = await newAttempt(jobId);
  await assert.rejects(
    acceptAttemptRaw(db, {
      jobId, attemptId: a, status: 'completed', resultUri: 'r2://result',
      resultDigest: 'b'.repeat(64), pages: 1, resultCreatedAt: 'not-a-date',
    }),
    /resultCreatedAt must be a valid R2 LastModified timestamp/,
  );
});

test('acceptance refuses success without a complete compact companion', async () => {
  const jobId = await newJob();
  const a = await newAttempt(jobId);
  await assert.rejects(
    acceptAttemptRaw(db, {
      jobId, attemptId: a, status: 'completed', resultUri: 'r2://result',
      resultDigest: 'b'.repeat(64), pages: 1,
      resultCreatedAt: new Date('2026-08-20T03:04:05Z'),
    }),
    /valid compact result companion is required/,
  );
  assert.equal((await attempt(a)).state, 'dispatching');
});

test('database forbids a partial compact companion', async () => {
  const jobId = await newJob();
  await assert.rejects(
    db.query('UPDATE jobs SET compact_result_uri = $2 WHERE id = $1', [jobId, 'r2://compact']),
    /jobs_compact_result_complete/,
  );
});

test("the loser's own result stays recorded at its own key", async () => {
  const jobId = await newJob();
  const a = await newAttempt(jobId);
  await markDispatchUnknown(db, { jobId, attemptId: a });
  const b = await newAttempt(jobId);

  await acceptAttempt(db, { jobId, attemptId: b, resultUri: 'r2://b', resultDigest: 'b'.repeat(64), pages: 9 });
  await acceptAttempt(db, { jobId, attemptId: a, resultUri: 'r2://a', resultDigest: 'c'.repeat(64), pages: 9 });

  // Losing is not failing: the attempt succeeded, it lost a race.
  const loser = await attempt(a);
  assert.deepEqual({ state: loser.state, uri: loser.result_uri }, { state: 'succeeded', uri: 'r2://a' });
});

// ---------------------------------------------------------------------------
// Ownership -- an attempt must never be adjudicated onto another job
// ---------------------------------------------------------------------------

test('an attempt cannot be accepted onto a different job', async () => {
  const jobA = await newJob(userId);
  const jobB = await newJob(await newUser('other@example.test'));
  const attemptOfA = await newAttempt(jobA);

  const result = await acceptAttempt(db, {
    jobId: jobB, attemptId: attemptOfA, resultUri: 'r2://x', resultDigest: 'd'.repeat(64), pages: 5,
  });

  assert.equal(result.recorded, false, 'a cross-job pair must record nothing');
});

test('a cross-job accept leaves the victim job untouched', async () => {
  const jobA = await newJob(userId);
  const jobB = await newJob(await newUser('victim@example.test'));
  const attemptOfA = await newAttempt(jobA);

  await acceptAttempt(db, {
    jobId: jobB, attemptId: attemptOfA, resultUri: 'r2://x', resultDigest: 'd'.repeat(64), pages: 5,
  });

  const j = await job(jobB);
  assert.deepEqual(
    { accepted: j.accepted_attempt_id, uri: j.result_uri, state: j.state },
    { accepted: null, uri: null, state: 'queued' },
  );
});

test('a cross-job accept does not mark the foreign attempt succeeded', async () => {
  const jobA = await newJob(userId);
  const jobB = await newJob(await newUser('v2@example.test'));
  const attemptOfA = await newAttempt(jobA);

  await acceptAttempt(db, {
    jobId: jobB, attemptId: attemptOfA, resultUri: 'r2://x', resultDigest: 'd'.repeat(64), pages: 5,
  });

  assert.equal((await attempt(attemptOfA)).state, 'dispatching');
});

test('an attempt cannot be failed onto a different job', async () => {
  const jobA = await newJob(userId);
  const jobB = await newJob(await newUser('v3@example.test'));
  const attemptOfA = await newAttempt(jobA);

  const result = await failAttempt(db, { jobId: jobB, attemptId: attemptOfA, error: 'boom' });

  assert.equal(result.jobFailed, false, 'a foreign attempt must not fail another job');
});

test('a foreign failure cannot settle or stamp an independently exhausted job', async () => {
  const jobA = await newJob(userId);
  const jobB = await newJob(await newUser('v3-exhausted@example.test'), 'dispatched');
  const attemptOfA = await newAttempt(jobA);
  const attemptOfB = await newAttempt(jobB, 'failed');
  await db.query(
    `UPDATE job_attempts SET completed_at = now(), error = 'real B error' WHERE id = $1`,
    [attemptOfB],
  );

  await failAttempt(db, { jobId: jobB, attemptId: attemptOfA, error: 'foreign A error' });

  const j = await job(jobB);
  assert.deepEqual({ state: j.state, error: j.error }, { state: 'dispatched', error: null });
});

test('the schema itself forbids installing a foreign attempt', async () => {
  const jobA = await newJob(userId);
  const jobB = await newJob(await newUser('v4@example.test'));
  const attemptOfA = await newAttempt(jobA);

  // Even bypassing accept.mjs entirely, the composite FK must refuse.
  await assert.rejects(
    db.query('UPDATE jobs SET accepted_attempt_id = $2 WHERE id = $1', [jobB, attemptOfA]),
    /jobs_accepted_attempt/,
  );
});

// ---------------------------------------------------------------------------
// Idempotence -- one Modal call may execute twice (retries=1)
// ---------------------------------------------------------------------------

test('a duplicate completion for one attempt does not overwrite its result', async () => {
  const jobId = await newJob();
  const a = await newAttempt(jobId);

  await acceptAttempt(db, { jobId, attemptId: a, resultUri: 'r2://exec-1', resultDigest: 'b'.repeat(64), pages: 9 });
  // The same call executed twice; each execution minted its OWN key, so
  // the second report carries a different uri.
  await acceptAttempt(db, { jobId, attemptId: a, resultUri: 'r2://exec-2', resultDigest: 'c'.repeat(64), pages: 9 });

  assert.equal((await attempt(a)).result_uri, 'r2://exec-1',
    'the attempt row must keep describing the object the job points at');
});

test('a duplicate completion is reported as not recorded', async () => {
  const jobId = await newJob();
  const a = await newAttempt(jobId);
  await acceptAttempt(db, { jobId, attemptId: a, resultUri: 'r2://exec-1', resultDigest: 'b'.repeat(64), pages: 9 });

  const second = await acceptAttempt(db, {
    jobId, attemptId: a, resultUri: 'r2://exec-2', resultDigest: 'c'.repeat(64), pages: 9,
  });

  assert.equal(second.recorded, false);
});

// ---------------------------------------------------------------------------
// Terminal semantics
// ---------------------------------------------------------------------------

test('dispatch_unknown is never walked back to dispatching', async () => {
  const jobId = await newJob();
  const a = await newAttempt(jobId);
  await markDispatchUnknown(db, { jobId, attemptId: a });
  await markDispatchUnknown(db, { jobId, attemptId: a }); // a second reconciler tick

  assert.equal((await attempt(a)).state, 'dispatch_unknown');
});

test('a job is not failed while a dispatch_unknown attempt may still be running', async () => {
  const jobId = await newJob();
  const unknown = await newAttempt(jobId);
  await markDispatchUnknown(db, { jobId, attemptId: unknown });
  const b = await newAttempt(jobId);

  const result = await failAttempt(db, { jobId, attemptId: b, error: 'RemoteError: boom' });

  assert.equal(result.jobFailed, false,
    'Modal may still be running the unknown call, and its result may be in R2');
});

test('a job is not failed while another attempt is outstanding', async () => {
  const jobId = await newJob();
  const a = await newAttempt(jobId);
  const outstanding = await newAttempt(jobId);
  await markDispatched(db, {
    jobId, attemptId: outstanding, modalCallId: 'fc-outstanding',
  });

  const result = await failAttempt(db, { jobId, attemptId: a, error: 'boom' });

  assert.equal(result.jobFailed, false);
});

test('a job fails once its last attempt fails', async () => {
  const jobId = await newJob();
  const a = await newAttempt(jobId);

  const result = await failAttempt(db, { jobId, attemptId: a, error: 'RemoteError: boom' });

  assert.equal(result.jobFailed, true);
});

test('settlement repairs a crash after the attempt failure was recorded', async () => {
  const jobId = await newJob(userId, 'dispatched');
  const a = await newAttempt(jobId, 'failed');
  await db.query(
    `UPDATE job_attempts
        SET completed_at = now(), error = 'worker died'
      WHERE id = $1`,
    [a],
  );

  const repaired = await settleExhaustedJob(db, { jobId, error: 'worker died' });

  assert.equal(repaired, true);
  assert.equal((await job(jobId)).state, 'failed');
});

test('a terminal failed job is never resurrected by a late success', async () => {
  const jobId = await newJob();
  const a = await newAttempt(jobId);
  await failAttempt(db, { jobId, attemptId: a, error: 'RemoteError: boom' });
  assert.equal((await job(jobId)).state, 'failed', 'precondition');

  const late = await newAttempt(jobId);
  const result = await acceptAttempt(db, {
    jobId, attemptId: late, resultUri: 'r2://late', resultDigest: 'e'.repeat(64), pages: 3,
  });

  assert.equal(result.won, false, 'clients stop polling terminal jobs; the answer must not change');
});

test('a late success is still recorded truthfully on its own attempt', async () => {
  const jobId = await newJob();
  const a = await newAttempt(jobId);
  await failAttempt(db, { jobId, attemptId: a, error: 'boom' });
  const late = await newAttempt(jobId);
  await acceptAttempt(db, { jobId, attemptId: late, resultUri: 'r2://late', resultDigest: 'e'.repeat(64), pages: 3 });

  const row = await attempt(late);
  assert.deepEqual({ state: row.state, uri: row.result_uri }, { state: 'succeeded', uri: 'r2://late' });
});

// ---------------------------------------------------------------------------
// Dispatch bookkeeping
// ---------------------------------------------------------------------------

test('dispatched_at stays null until a call id actually lands', async () => {
  const jobId = await newJob();
  const a = await newAttempt(jobId);

  assert.equal((await attempt(a)).dispatched_at, null,
    'a row born dispatching has not been dispatched');
});

test('markDispatched records the call id and the time together', async () => {
  const jobId = await newJob();
  const a = await newAttempt(jobId);
  await markDispatched(db, { jobId, attemptId: a, modalCallId: 'fc-01ABC' });

  const row = await attempt(a);
  assert.equal(row.modal_call_id === 'fc-01ABC' && row.dispatched_at !== null, true);
});

test('markDispatched advances the job and attempt in one statement', async () => {
  const jobId = await newJob();
  const attemptId = await newAttempt(jobId);
  await markDispatched(db, { jobId, attemptId, modalCallId: 'fc-job-state' });
  assert.equal((await job(jobId)).state, 'dispatched');
  assert.equal((await attempt(attemptId)).state, 'dispatched');
});

test('one Modal call id cannot belong to two attempts', async () => {
  const jobId = await newJob();
  const a = await newAttempt(jobId);
  const b = await newAttempt(jobId);
  await markDispatched(db, { jobId, attemptId: a, modalCallId: 'fc-dup' });

  await assert.rejects(
    markDispatched(db, { jobId, attemptId: b, modalCallId: 'fc-dup' }),
    /job_attempts_call/,
  );
});

// ---------------------------------------------------------------------------
// Schema invariants the API depends on
// ---------------------------------------------------------------------------

test('a job cannot be created without a 64-hex input digest', async () => {
  await assert.rejects(
    db.query(
      `INSERT INTO jobs (user_id, state, input_uri, input_digest, unit_price_micros, upload_expires_at)
       VALUES ($1,'uploading','r2://x','not-a-digest',1000, now() + interval '1 hour')`, [userId]),
    /input_digest/,
  );
});

test('an over-cap upload is rejected by the database, not just the API', async () => {
  await assert.rejects(
    db.query(
      `INSERT INTO jobs (user_id, state, input_uri, input_digest, input_bytes,
                         unit_price_micros, upload_expires_at)
       VALUES ($1,'uploading','r2://x',$2, 94371841, 1000, now() + interval '1 hour')`, [userId, 'a'.repeat(64)]),
    /input_bytes/, '90 MiB is the qualified MAX_INPUT_BYTES',
  );
});

test('one idempotency key cannot create two jobs for a user', async () => {
  const insert = () => db.query(
    `INSERT INTO jobs (user_id, idempotency_key, state, input_uri, input_digest,
                       unit_price_micros, upload_expires_at)
     VALUES ($1,'key-1','uploading','r2://x',$2,1000, now() + interval '1 hour')`, [userId, 'a'.repeat(64)]);
  await insert();
  await assert.rejects(insert(), /jobs_idempotency/);
});

test('two users may reuse the same idempotency key', async () => {
  const other = await newUser('shared@example.test');
  const insert = (uid) => db.query(
    `INSERT INTO jobs (user_id, idempotency_key, state, input_uri, input_digest,
                       unit_price_micros, upload_expires_at)
     VALUES ($1,'shared-key','uploading','r2://x',$2,1000, now() + interval '1 hour')`, [uid, 'a'.repeat(64)]);
  await insert(userId);
  await insert(other); // must not collide: the index is (user_id, key)
});

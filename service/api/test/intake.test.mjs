import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { acceptAttempt } from '../src/accept.mjs';
import { authenticateApiKey, issueApiKey } from '../src/api-keys.mjs';
import { migrate } from '../src/migrate.mjs';
import {
  createOrReplayJob, finalizeJob, jobView, ownedJob, resultGrant,
} from '../src/jobs.mjs';
import { dispatchQueuedOnce } from '../src/queued-dispatcher.mjs';

const SHA = 'a'.repeat(64);
let db;
let pool;
let userId;

before(async () => { db = await PGlite.create(); });

beforeEach(async () => {
  await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  userId = (await db.query(
    "INSERT INTO users (email, status) VALUES ('m2@example.test','active') RETURNING id",
  )).rows[0].id;
  pool = {
    async connect() {
      return { query: (...args) => db.query(...args), release() {} };
    },
  };
});

const submit = (overrides = {}) => createOrReplayJob({
  pool, userId, idempotencyKey: 'request-1', inputSha256: SHA,
  inputBucket: 'inputs', ...overrides,
});

test('API keys are stored hashed and authenticate an active user', async () => {
  const issued = await issueApiKey(db, { userId, name: 'development' });
  assert.match(issued.secret, /^ps_live_[A-Za-z0-9_-]{43}$/u);
  const stored = (await db.query('SELECT * FROM api_keys WHERE id = $1', [issued.key.id])).rows[0];
  assert.notEqual(stored.hash, issued.secret);
  assert.equal(stored.prefix, issued.secret.slice(0, 16));
  assert.deepEqual(
    await authenticateApiKey(db, `Bearer ${issued.secret}`),
    { userId, keyId: issued.key.id },
  );
  assert.deepEqual(
    await authenticateApiKey(db, `bearer ${issued.secret}`),
    { userId, keyId: issued.key.id },
  );
  await assert.rejects(
    authenticateApiKey(db, `Bearer ${issued.secret.slice(0, -1)}x`),
    (error) => error.status === 401 && error.code === 'authentication_required',
  );
});

test('API keys can be issued only to active users', async () => {
  const invited = (await db.query(
    "INSERT INTO users (email, status) VALUES ('invited@example.test','invited') RETURNING id",
  )).rows[0];
  await assert.rejects(
    issueApiKey(db, { userId: invited.id, name: 'inert key' }),
    /active user does not exist/u,
  );
});

test('submission creates one uploading job and exact replay returns it', async () => {
  const first = await submit();
  const replay = await submit();
  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.equal(replay.row.id, first.row.id);
  assert.equal(first.row.input_uri, `r2://inputs/inputs/${first.row.id}.pdf`);
  assert.equal(
    new Date(first.row.upload_expires_at).getTime() - new Date(first.row.created_at).getTime(),
    60 * 60 * 1000,
  );
});

test('idempotency mismatch wins over admission rejection', async () => {
  const original = await submit();
  for (let index = 0; index < 4; index += 1) {
    await submit({ idempotencyKey: `fill-${index}` });
  }
  const replay = await submit();
  assert.equal(replay.created, false);
  assert.equal(replay.row.id, original.row.id);
  await assert.rejects(
    submit({ inputSha256: 'b'.repeat(64) }),
    (error) => error.status === 422 && error.code === 'idempotency_mismatch',
  );
  await assert.rejects(
    submit({ idempotencyKey: 'over-limit' }),
    (error) => error.status === 429 && error.code === 'admission_limit',
  );
});

test('finalize distinguishes retryable absence from terminal upload defects', async () => {
  const missing = await submit({ idempotencyKey: 'missing' });
  await assert.rejects(finalizeJob({
    db, userId, jobId: missing.row.id,
    inputStore: { async head() { return null; } },
  }), (error) => error.status === 409 && error.code === 'upload_incomplete');
  assert.equal((await ownedJob(db, { userId, jobId: missing.row.id })).state, 'uploading');

  const expired = await submit({ idempotencyKey: 'expired' });
  await assert.rejects(finalizeJob({
    db, userId, jobId: expired.row.id,
    now: new Date(expired.row.upload_expires_at),
    inputStore: { async head() { throw new Error('must not inspect expired upload'); } },
  }), (error) => error.status === 410 && error.code === 'upload_expired');

  const wrongType = await submit({ idempotencyKey: 'wrong-type' });
  await assert.rejects(finalizeJob({
    db, userId, jobId: wrongType.row.id,
    inputStore: { async head() { return { bytes: 589, contentType: 'text/plain' }; } },
  }), (error) => error.status === 422 && error.code === 'invalid_upload');

  const oversized = await submit({ idempotencyKey: 'oversized' });
  await assert.rejects(finalizeJob({
    db, userId, jobId: oversized.row.id,
    inputStore: {
      async head() { return { bytes: 90 * 1024 * 1024 + 1, contentType: 'application/pdf' }; },
    },
  }), (error) => error.status === 413 && error.code === 'input_too_large');
});

test('finalize verifies object metadata and queues idempotently', async () => {
  const created = await submit();
  const inputStore = {
    async head() { return { bytes: 589, contentType: 'application/pdf' }; },
  };
  const first = await finalizeJob({
    db, inputStore, userId, jobId: created.row.id,
  });
  const replay = await finalizeJob({
    db, inputStore, userId, jobId: created.row.id,
  });
  assert.equal(first.status, 202);
  assert.equal(first.row.state, 'queued');
  assert.equal(replay.row.state, 'queued');
  assert.equal(Number(first.row.input_bytes), 589);
});

test('finalize reports the state won by a concurrent finalizer', async () => {
  const created = await submit({ idempotencyKey: 'finalize-race' });
  let injected = false;
  const racingDb = {
    async query(sql, values) {
      const result = await db.query(sql, values);
      if (!injected && sql.includes('SELECT * FROM jobs WHERE id = $1 AND user_id = $2')) {
        injected = true;
        await db.query(
          "UPDATE jobs SET state = 'queued', queued_at = now() WHERE id = $1",
          [created.row.id],
        );
      }
      return result;
    },
  };
  const result = await finalizeJob({
    db: racingDb,
    userId,
    jobId: created.row.id,
    now: new Date(created.row.upload_expires_at),
    inputStore: { async head() { throw new Error('expired path must not inspect storage'); } },
  });
  assert.equal(result.status, 202);
  assert.equal(result.row.state, 'queued');
});

test('queued sweep closes the finalize crash window with one initial attempt', async () => {
  const created = await submit();
  await finalizeJob({
    db, userId, jobId: created.row.id,
    inputStore: { async head() { return { bytes: 589, contentType: 'application/pdf' }; } },
  });
  const spawned = [];
  const modalCalls = {
    async spawn(payload) {
      spawned.push(payload);
      return { callId: 'fc-one' };
    },
  };
  const first = await dispatchQueuedOnce({
    db, modalCalls, inputBucket: 'inputs',
  });
  const second = await dispatchQueuedOnce({
    db, modalCalls, inputBucket: 'inputs',
  });
  assert.equal(first[0].outcome.kind, 'dispatched');
  assert.deepEqual(second, []);
  assert.equal(spawned.length, 1);
  assert.equal((await ownedJob(db, { userId, jobId: created.row.id })).state, 'dispatched');
});

test('invalid upload becomes a typed terminal job without exposing detail', async () => {
  const created = await submit();
  await assert.rejects(
    finalizeJob({
      db, userId, jobId: created.row.id,
      inputStore: { async head() { return { bytes: 0, contentType: 'application/pdf' }; } },
    }),
    (error) => error.code === 'invalid_upload',
  );
  const stored = await ownedJob(db, { userId, jobId: created.row.id });
  assert.equal(stored.failure_code, 'invalid_upload');
  const view = jobView({ ...stored, error: 'private parser secret' });
  assert.deepEqual(view.error, {
    code: 'invalid_upload', message: 'Uploaded object is not a valid PDF upload.',
  });
  assert.doesNotMatch(JSON.stringify(view), /private parser secret/u);
});

test('result grant signs only the accepted object before retention expiry', async () => {
  const created = await submit();
  await db.query("UPDATE jobs SET state = 'queued', queued_at = now() WHERE id = $1", [created.row.id]);
  const attemptId = (await db.query(
    'INSERT INTO job_attempts (job_id) VALUES ($1) RETURNING id', [created.row.id],
  )).rows[0].id;
  const accepted = await acceptAttempt(db, {
    jobId: created.row.id,
    attemptId,
    status: 'completed',
    resultUri: `r2://results/results/${created.row.id}/${attemptId}/e.json`,
    resultDigest: 'b'.repeat(64),
    pages: 1,
    resultCreatedAt: new Date(),
  });
  assert.deepEqual(accepted, { recorded: true, won: true });
  const seen = [];
  const grant = await resultGrant({
    db, userId, jobId: created.row.id,
    resultStore: {
      bucket: 'results',
      async createDownloadGrant(value) { seen.push(value); return { download_url: 'signed' }; },
    },
  });
  assert.equal(grant.download_url, 'signed');
  assert.equal(seen[0].key, `results/${created.row.id}/${attemptId}/e.json`);
});

test('database rejects failed rows without a machine-readable code', async () => {
  const created = await submit();
  await assert.rejects(
    db.query("UPDATE jobs SET state = 'failed' WHERE id = $1", [created.row.id]),
    /jobs_failed_has_code/u,
  );
});

test('database rejects succeeded jobs without an accepted result', async () => {
  const created = await submit();
  await assert.rejects(
    db.query(
      `UPDATE jobs SET state = 'succeeded', pages_actual = 1,
                       result_uri = $2, result_digest = $3,
                       retention_expires_at = now() + interval '2 days', completed_at = now()
        WHERE id = $1`,
      [created.row.id, 'r2://results/forged.json', 'b'.repeat(64)],
    ),
    /jobs_succeeded_has_accepted_result/u,
  );
});

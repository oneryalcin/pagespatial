import { createHash, randomUUID } from 'node:crypto';
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { createValidDocument, fixtureIdentity } from '../../../test/fixture.mjs';
import { migrate } from '../src/migrate.mjs';
import { reconcileAttempt } from '../src/reconciler.mjs';

const INPUT_BUCKET = 'inputs';
const RESULTS_BUCKET = 'results';
const INPUT_DIGEST = fixtureIdentity.sha256;
let db;
let userId;
let pageSpatial;

before(async () => {
  db = await PGlite.create();
  pageSpatial = (await createValidDocument()).pages[0];
});

beforeEach(async () => {
  await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  userId = (await db.query(
    `INSERT INTO users (email, status) VALUES ($1, 'active') RETURNING id`,
    [`reconcile-${randomUUID()}@example.test`],
  )).rows[0].id;
});

async function job() {
  return (await db.query(
    `INSERT INTO jobs (
       user_id, state, input_uri, input_digest, input_bytes,
       unit_price_micros, upload_expires_at, queued_at
     ) VALUES ($1, 'queued', $2, $3, 589, 1000,
               now() + interval '1 hour', now()) RETURNING *`,
    [userId, `r2://${INPUT_BUCKET}/inputs/job.pdf`, INPUT_DIGEST],
  )).rows[0];
}

async function attempt(jobId, state = 'dispatched', callId = `fc-${randomUUID()}`) {
  return (await db.query(
    `INSERT INTO job_attempts (
       job_id, state, modal_call_id, dispatched_at, created_at
     ) VALUES ($1, $2, $3, CASE WHEN $3::text IS NULL THEN NULL ELSE now() END,
               now() - interval '20 minutes') RETURNING *`,
    [jobId, state, state === 'dispatched' ? callId : null],
  )).rows[0];
}

function objectFor(jobRow, attemptId, executionId = 'a'.repeat(32)) {
  const parseResult = {
    request_id: attemptId,
    document_sha256: INPUT_DIGEST,
    page_count: 1,
    status: 'completed',
    pages: [{
      pageNumber: 1, ok: true, pageSpatial,
      attempts: 1, rssBytes: 1, stageTimingsMs: {}, wallMs: 1,
    }],
    pages_ok: 1,
    pages_failed: 0,
    failure: null,
    timing: {}, retry: {}, resources: {}, app_name: 'test',
    adapter_revision: 'test', image_pin_revision: 'test',
  };
  const envelope = {
    schema_version: 1,
    job_id: jobRow.id,
    attempt_id: attemptId,
    execution_id: executionId,
    input_key: 'inputs/job.pdf',
    input_sha256: INPUT_DIGEST,
    parse_result: parseResult,
  };
  const bytes = new Uint8Array(Buffer.from(JSON.stringify(envelope)));
  const key = `results/${jobRow.id}/${attemptId}/${executionId}.json`;
  const digest = createHash('sha256').update(bytes).digest('hex');
  const pointer = {
    job_id: jobRow.id, attempt_id: attemptId, execution_id: executionId,
    document_sha256: INPUT_DIGEST,
    result_uri: `r2://${RESULTS_BUCKET}/${key}`,
    result_key: key, result_digest: digest, result_bytes: bytes.byteLength,
    page_count: 1, status: 'completed', timing: {},
  };
  return { key, bytes, pointer, lastModified: new Date('2026-08-20T12:00:00Z') };
}

function fakeStore(objects = new Map()) {
  return {
    bucket: RESULTS_BUCKET,
    objects,
    async listAttemptResults({ jobId, attemptId }) {
      const prefix = `results/${jobId}/${attemptId}/`;
      return [...objects.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, lastModified: value.lastModified }))
        .sort((a, b) => a.key.localeCompare(b.key));
    },
    async readResult({ key }) {
      const found = objects.get(key);
      if (!found) throw new Error(`missing ${key}`);
      return { bytes: found.bytes, lastModified: found.lastModified };
    },
  };
}

const modal = (outcomes = new Map()) => ({
  spawned: [],
  async spawn(payload) {
    this.spawned.push(payload);
    return { callId: `fc-spawn-${this.spawned.length}` };
  },
  async inspect(callId) { return outcomes.get(callId) ?? { kind: 'pending' }; },
});

const row = async (table, id) =>
  (await db.query(`SELECT * FROM ${table} WHERE id = $1`, [id])).rows[0];

test('completed Modal output is not accepted until its R2 bytes validate', async () => {
  const j = await job();
  const a = await attempt(j.id);
  const object = objectFor(j, a.id);
  const store = fakeStore(new Map([[object.key, object]]));
  const calls = modal(new Map([[a.modal_call_id, { kind: 'completed', output: object.pointer }]]));

  const outcome = await reconcileAttempt({
    db, modalCalls: calls, resultStore: store, inputBucket: INPUT_BUCKET, attemptId: a.id,
  });

  assert.deepEqual(outcome, { kind: 'completed', recorded: true, won: true });
  const accepted = await row('jobs', j.id);
  assert.equal(accepted.accepted_attempt_id, a.id);
  assert.equal(new Date(accepted.retention_expires_at).toISOString(), '2026-08-22T12:00:00.000Z');
});

test('a returned status=failed value is rejected and fails only after R2 is checked', async () => {
  const j = await job();
  const a = await attempt(j.id);
  const object = objectFor(j, a.id);
  const bad = { ...object.pointer, status: 'failed' };
  const calls = modal(new Map([[a.modal_call_id, { kind: 'completed', output: bad }]]));
  const outcome = await reconcileAttempt({
    db, modalCalls: calls, resultStore: fakeStore(), inputBucket: INPUT_BUCKET,
    attemptId: a.id,
  });
  assert.equal(outcome.kind, 'failed');
  assert.match(outcome.error, /status must be completed/);
  assert.equal((await row('job_attempts', a.id)).state, 'failed');
});

test('Modal failure checks R2 and recovers a valid completed object first', async () => {
  const j = await job();
  const a = await attempt(j.id);
  const object = objectFor(j, a.id);
  const calls = modal(new Map([[a.modal_call_id, { kind: 'failed', error: 'RemoteError: lost' }]]));
  const outcome = await reconcileAttempt({
    db, modalCalls: calls,
    resultStore: fakeStore(new Map([[object.key, object]])),
    inputBucket: INPUT_BUCKET, attemptId: a.id,
  });
  assert.deepEqual(outcome, { kind: 'recovered', recorded: true, won: true });
});

test('Modal failure becomes permanent only after R2 has no valid result', async () => {
  const j = await job();
  const a = await attempt(j.id);
  const calls = modal(new Map([[a.modal_call_id, { kind: 'failed', error: 'RemoteError: boom' }]]));
  const outcome = await reconcileAttempt({
    db, modalCalls: calls, resultStore: fakeStore(), inputBucket: INPUT_BUCKET,
    attemptId: a.id,
  });
  assert.equal(outcome.kind, 'failed');
  assert.equal((await row('jobs', j.id)).state, 'failed');
});

test('an unavailable Modal result with no R2 object remains retryable', async () => {
  const j = await job();
  const a = await attempt(j.id);
  const calls = modal(new Map([[a.modal_call_id, { kind: 'unavailable', error: 'network' }]]));
  const outcome = await reconcileAttempt({
    db, modalCalls: calls, resultStore: fakeStore(), inputBucket: INPUT_BUCKET,
    attemptId: a.id,
  });
  assert.equal(outcome.kind, 'unavailable');
  assert.equal((await row('job_attempts', a.id)).state, 'dispatched');
});

test('an unknown attempt creates and dispatches at most one replacement', async () => {
  const j = await job();
  const a = await attempt(j.id, 'dispatch_unknown');
  const calls = modal();
  const options = {
    db, modalCalls: calls, resultStore: fakeStore(), inputBucket: INPUT_BUCKET,
    attemptId: a.id, unknownWaitMs: 0,
  };
  const first = await reconcileAttempt(options);
  const second = await reconcileAttempt(options);
  assert.equal(first.kind, 'replacement_dispatched');
  assert.equal(second.kind, 'replacement_exists');
  assert.equal(calls.spawned.length, 1);
});

test('a queued job can have only one independent initial attempt', async () => {
  const j = await job();
  const first = await db.query(
    'INSERT INTO job_attempts (job_id) VALUES ($1) RETURNING id', [j.id],
  );
  await assert.rejects(
    db.query('INSERT INTO job_attempts (job_id) VALUES ($1)', [j.id]),
    /job_attempts_one_initial/,
  );
  assert.equal(first.rows.length, 1);
  assert.equal(
    Number((await db.query('SELECT count(*) FROM job_attempts WHERE job_id = $1', [j.id])).rows[0].count),
    1,
  );
});

test('crash-window replacement wins and the original late result cannot displace it', async () => {
  const j = await job();
  const original = await attempt(j.id, 'dispatch_unknown');
  const store = fakeStore();
  const calls = modal();

  const replacementOutcome = await reconcileAttempt({
    db, modalCalls: calls, resultStore: store, inputBucket: INPUT_BUCKET,
    attemptId: original.id, unknownWaitMs: 0,
  });
  const replacementId = replacementOutcome.attemptId;
  const replacement = await row('job_attempts', replacementId);
  const winner = objectFor(j, replacementId, 'b'.repeat(32));
  store.objects.set(winner.key, winner);
  calls.inspect = async () => ({ kind: 'completed', output: winner.pointer });
  const won = await reconcileAttempt({
    db, modalCalls: calls, resultStore: store, inputBucket: INPUT_BUCKET,
    attemptId: replacementId,
  });
  assert.equal(won.won, true);

  const late = objectFor(j, original.id, 'c'.repeat(32));
  store.objects.set(late.key, late);
  const lost = await reconcileAttempt({
    db, modalCalls: calls, resultStore: store, inputBucket: INPUT_BUCKET,
    attemptId: original.id, unknownWaitMs: 0,
  });
  assert.equal(lost.won, false);

  const final = await row('jobs', j.id);
  assert.equal(final.accepted_attempt_id, replacementId);
  assert.equal((await row('job_attempts', original.id)).state, 'succeeded');
  assert.equal((await row('job_attempts', replacement.id)).state, 'succeeded');
  assert.deepEqual([...store.objects.keys()].sort(), [late.key, winner.key].sort());
});

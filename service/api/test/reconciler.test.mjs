import { createHash, randomUUID } from 'node:crypto';
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { createValidDocument, fixtureIdentity } from '../../../test/fixture.mjs';
import { COMPACT_PAGE_SCHEMA_VERSION, projectCompactPage } from '../../../dist/index.js';
import { migrate } from '../src/migrate.mjs';
import { reconcileAttempt, reconcileOnce } from '../src/reconciler.mjs';

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
       job_id, state, modal_call_id, dispatched_at, created_at, failure_code
     ) VALUES ($1, $2, $3, CASE WHEN $3::text IS NULL THEN NULL ELSE now() END,
               now() - interval '20 minutes',
               CASE WHEN $2::text = 'failed' THEN 'processing_failed' ELSE NULL END)
     RETURNING *`,
    [jobId, state, state === 'dispatched' ? callId : null],
  )).rows[0];
}

function objectFor(jobRow, attemptId, executionId = 'a'.repeat(32)) {
  const envelope = {
    schema_version: 1,
    job_id: jobRow.id,
    attempt_id: attemptId,
    execution_id: executionId,
    input_sha256: INPUT_DIGEST,
    page_count: 1,
    pages: [{ page_number: 1, ok: true, page_spatial: pageSpatial }],
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
  const compactEnvelope = {
    schema_version: COMPACT_PAGE_SCHEMA_VERSION,
    representation: 'compact',
    job_id: jobRow.id,
    attempt_id: attemptId,
    input_sha256: INPUT_DIGEST,
    page_count: 1,
    pages: [{ page_number: 1, ok: true, page_compact: projectCompactPage(pageSpatial) }],
  };
  const compactBytes = new Uint8Array(Buffer.from(JSON.stringify(compactEnvelope)));
  const compactKey = `results/${jobRow.id}/${attemptId}/${executionId}.compact.json`;
  const compactDigest = createHash('sha256').update(compactBytes).digest('hex');
  Object.assign(pointer, {
    compact_result_uri: `r2://${RESULTS_BUCKET}/${compactKey}`,
    compact_result_key: compactKey,
    compact_result_digest: compactDigest,
    compact_result_bytes: compactBytes.byteLength,
  });
  const lastModified = new Date('2026-08-20T12:00:00Z');
  return {
    key, bytes, pointer, lastModified,
    compact: { key: compactKey, bytes: compactBytes, lastModified },
  };
}

function fakeStore(objects = new Map()) {
  const expanded = new Map(objects);
  for (const value of objects.values()) {
    if (value.compact) expanded.set(value.compact.key, value.compact);
  }
  return {
    bucket: RESULTS_BUCKET,
    objects: expanded,
    async listAttemptResults({ jobId, attemptId }) {
      const prefix = `results/${jobId}/${attemptId}/`;
      return [...expanded.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .filter(([key]) => !key.endsWith('.compact.json'))
        .map(([key, value]) => ({ key, lastModified: value.lastModified }))
        .sort((a, b) => a.key.localeCompare(b.key));
    },
    async readResult({ key }) {
      const found = expanded.get(key);
      if (!found) throw new Error(`missing ${key}`);
      return { bytes: found.bytes, lastModified: found.lastModified };
    },
  };
}

function storeResult(store, value) {
  store.objects.set(value.key, value);
  store.objects.set(value.compact.key, value.compact);
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

test('a pre-migration attempt accepts its legacy evidence-only pointer', async () => {
  const j = await job();
  const a = await attempt(j.id);
  await db.query('UPDATE job_attempts SET requires_compact = false WHERE id = $1', [a.id]);
  const stored = objectFor(j, a.id);
  for (const field of [
    'compact_result_uri', 'compact_result_key',
    'compact_result_digest', 'compact_result_bytes',
  ]) delete stored.pointer[field];
  const store = fakeStore(new Map([[stored.key, stored]]));
  store.objects.delete(stored.compact.key);
  const calls = modal(new Map([[a.modal_call_id, { kind: 'completed', output: stored.pointer }]]));
  const outcome = await reconcileAttempt({
    db, modalCalls: calls, resultStore: store,
    inputBucket: INPUT_BUCKET, attemptId: a.id,
  });
  assert.deepEqual(outcome, { kind: 'completed', recorded: true, won: true });
  const accepted = await row('jobs', j.id);
  assert.equal(accepted.compact_result_uri, null);
});

test('a pre-migration attempt recovers from an evidence-only R2 object', async () => {
  const j = await job();
  const a = await attempt(j.id);
  await db.query('UPDATE job_attempts SET requires_compact = false WHERE id = $1', [a.id]);
  const stored = objectFor(j, a.id);
  const store = fakeStore(new Map([[stored.key, stored]]));
  store.objects.delete(stored.compact.key);
  const calls = modal(new Map([[a.modal_call_id, { kind: 'failed', error: 'old worker lost output' }]]));
  const outcome = await reconcileAttempt({
    db, modalCalls: calls, resultStore: store,
    inputBucket: INPUT_BUCKET, attemptId: a.id,
  });
  assert.deepEqual(outcome, { kind: 'recovered', recorded: true, won: true });
});

test('a returned status=failed value is rejected and fails only after R2 is checked', async () => {
  const j = await job();
  const a = await attempt(j.id);
  const failure = {
    job_id: j.id,
    attempt_id: a.id,
    document_sha256: INPUT_DIGEST,
    status: 'failed',
    failure_code: 'page_limit_exceeded',
    failure_detail: 'document has too many pages',
    timing: {},
  };
  const calls = modal(new Map([[a.modal_call_id, { kind: 'completed', output: failure }]]));
  const outcome = await reconcileAttempt({
    db, modalCalls: calls, resultStore: fakeStore(), inputBucket: INPUT_BUCKET,
    attemptId: a.id,
  });
  assert.equal(outcome.kind, 'failed');
  assert.match(outcome.error, /too many pages/);
  assert.equal((await row('job_attempts', a.id)).state, 'failed');
  assert.equal((await row('job_attempts', a.id)).failure_code, 'page_limit_exceeded');
  assert.equal((await row('jobs', j.id)).failure_code, 'page_limit_exceeded');
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

test('an R2 read failure is retryable and never becomes a permanent attempt failure', async () => {
  const j = await job();
  const a = await attempt(j.id);
  const object = objectFor(j, a.id);
  const store = fakeStore(new Map([[object.key, object]]));
  store.readResult = async () => { throw new TypeError('fetch failed'); };
  const calls = modal(new Map([[a.modal_call_id, { kind: 'failed', error: 'RemoteError' }]]));
  await assert.rejects(
    reconcileAttempt({
      db, modalCalls: calls, resultStore: store,
      inputBucket: INPUT_BUCKET, attemptId: a.id,
    }),
    /fetch failed/,
  );
  assert.equal((await row('job_attempts', a.id)).state, 'dispatched');
});

test('a completed Modal pointer plus an R2 transport failure stays retryable', async () => {
  const j = await job();
  const a = await attempt(j.id);
  const object = objectFor(j, a.id);
  const store = fakeStore();
  store.readResult = async () => { throw new TypeError('fetch failed'); };
  const calls = modal(new Map([[
    a.modal_call_id, { kind: 'completed', output: object.pointer },
  ]]));
  await assert.rejects(
    reconcileAttempt({
      db, modalCalls: calls, resultStore: store,
      inputBucket: INPUT_BUCKET, attemptId: a.id,
    }),
    /fetch failed/,
  );
  assert.equal((await row('job_attempts', a.id)).state, 'dispatched');
});

test('a completed Modal pointer with a missing compact companion stays retryable', async () => {
  const j = await job();
  const a = await attempt(j.id);
  const object = objectFor(j, a.id);
  const store = fakeStore(new Map([[object.key, object]]));
  store.objects.delete(object.compact.key);
  const calls = modal(new Map([[a.modal_call_id, { kind: 'completed', output: object.pointer }]]));
  await assert.rejects(
    reconcileAttempt({
      db, modalCalls: calls, resultStore: store,
      inputBucket: INPUT_BUCKET, attemptId: a.id,
    }),
    /missing/,
  );
  assert.equal((await row('job_attempts', a.id)).state, 'dispatched');
});

test('an invalid compact companion cannot be accepted', async () => {
  const j = await job();
  const a = await attempt(j.id);
  const object = objectFor(j, a.id);
  object.compact.bytes = new Uint8Array(Buffer.from('{}'));
  const store = fakeStore(new Map([[object.key, object]]));
  const calls = modal(new Map([[a.modal_call_id, { kind: 'completed', output: object.pointer }]]));
  const outcome = await reconcileAttempt({
    db, modalCalls: calls, resultStore: store,
    inputBucket: INPUT_BUCKET, attemptId: a.id,
  });
  assert.equal(outcome.kind, 'failed');
  assert.equal((await row('jobs', j.id)).state, 'failed');
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
  assert.equal((await row('job_attempts', a.id)).state, 'dispatch_unknown');
  assert.equal(calls.spawned.length, 1);
});

test('an uncertain replacement cannot grow a third attempt', async () => {
  const j = await job();
  const original = await attempt(j.id, 'dispatch_unknown');
  const calls = modal();
  const store = fakeStore();
  const first = await reconcileAttempt({
    db, modalCalls: calls, resultStore: store, inputBucket: INPUT_BUCKET,
    attemptId: original.id, unknownWaitMs: 0,
  });
  const replacementId = first.attemptId;
  await db.query(
    `UPDATE job_attempts
        SET state = 'dispatch_unknown', modal_call_id = NULL, dispatched_at = NULL
      WHERE id = $1`,
    [replacementId],
  );
  const exhausted = await reconcileAttempt({
    db, modalCalls: calls, resultStore: store, inputBucket: INPUT_BUCKET,
    attemptId: replacementId, unknownWaitMs: 0,
  });
  assert.equal(exhausted.kind, 'failed');
  assert.match(exhausted.error, /replacement limit exhausted/);
  assert.equal(
    Number((await db.query('SELECT count(*) FROM job_attempts WHERE job_id = $1', [j.id])).rows[0].count),
    2,
  );
  assert.equal((await row('jobs', j.id)).state, 'dispatched');
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
  storeResult(store, winner);
  calls.inspect = async () => ({ kind: 'completed', output: winner.pointer });
  const won = await reconcileAttempt({
    db, modalCalls: calls, resultStore: store, inputBucket: INPUT_BUCKET,
    attemptId: replacementId,
  });
  assert.equal(won.won, true);

  const late = objectFor(j, original.id, 'c'.repeat(32));
  storeResult(store, late);
  const lost = await reconcileAttempt({
    db, modalCalls: calls, resultStore: store, inputBucket: INPUT_BUCKET,
    attemptId: original.id, unknownWaitMs: 0,
  });
  assert.equal(lost.won, false);

  const final = await row('jobs', j.id);
  assert.equal(final.accepted_attempt_id, replacementId);
  assert.equal((await row('job_attempts', original.id)).state, 'succeeded');
  assert.equal((await row('job_attempts', replacement.id)).state, 'succeeded');
  assert.deepEqual(
    [...store.objects.keys()].sort(),
    [late.key, late.compact.key, winner.key, winner.compact.key].sort(),
  );
});

test('a paid original result can rescue the job after its replacement fails', async () => {
  const j = await job();
  const original = await attempt(j.id, 'dispatch_unknown');
  const store = fakeStore();
  const calls = modal();

  const created = await reconcileAttempt({
    db, modalCalls: calls, resultStore: store, inputBucket: INPUT_BUCKET,
    attemptId: original.id, unknownWaitMs: 0,
  });
  const replacement = await row('job_attempts', created.attemptId);
  calls.inspect = async (callId) => callId === replacement.modal_call_id
    ? { kind: 'failed', error: 'RemoteError: replacement OOM' }
    : { kind: 'pending' };
  const replacementFailure = await reconcileAttempt({
    db, modalCalls: calls, resultStore: store, inputBucket: INPUT_BUCKET,
    attemptId: replacement.id,
  });
  assert.equal(replacementFailure.kind, 'failed');
  assert.equal((await row('jobs', j.id)).state, 'dispatched');

  const paidResult = objectFor(j, original.id, 'f'.repeat(32));
  storeResult(store, paidResult);
  const rescued = await reconcileAttempt({
    db, modalCalls: calls, resultStore: store, inputBucket: INPUT_BUCKET,
    attemptId: original.id, unknownWaitMs: 0,
  });
  assert.equal(rescued.kind, 'recovered');
  assert.equal(rescued.won, true);
  assert.equal((await row('jobs', j.id)).state, 'succeeded');
});

test('one malformed attempt fails permanently without blocking a healthy sibling', async () => {
  const poisonedJob = await job();
  await db.query('UPDATE jobs SET input_uri = $2 WHERE id = $1', [
    poisonedJob.id, 'r2://old-bucket/inputs/stale.pdf',
  ]);
  const poisoned = await attempt(poisonedJob.id);
  const healthyJob = await job();
  const healthy = await attempt(healthyJob.id);
  const object = objectFor(healthyJob, healthy.id);
  const store = fakeStore(new Map([[object.key, object]]));
  const calls = modal(new Map([
    [healthy.modal_call_id, { kind: 'completed', output: object.pointer }],
  ]));

  const result = await reconcileOnce({
    db, modalCalls: calls, resultStore: store, inputBucket: INPUT_BUCKET,
    now: new Date(Date.now() + 1_000), pollIntervalMs: 1,
  });
  assert.equal(result.outcomes.length, 2);
  assert.equal((await row('job_attempts', poisoned.id)).state, 'failed');
  assert.equal((await row('jobs', healthyJob.id)).state, 'succeeded');
});

test('one transient R2 failure does not block another attempt in the same pass', async () => {
  const firstJob = await job();
  const first = await attempt(firstJob.id);
  const firstObject = objectFor(firstJob, first.id, 'd'.repeat(32));
  const healthyJob = await job();
  const healthy = await attempt(healthyJob.id);
  const healthyObject = objectFor(healthyJob, healthy.id, 'e'.repeat(32));
  const store = fakeStore(new Map([
    [firstObject.key, firstObject], [healthyObject.key, healthyObject],
  ]));
  const read = store.readResult;
  store.readResult = async ({ key }) => {
    if (key === firstObject.key) throw new Error('ETIMEDOUT');
    return read({ key });
  };
  const calls = modal(new Map([
    [first.modal_call_id, { kind: 'failed', error: 'RemoteError' }],
    [healthy.modal_call_id, { kind: 'completed', output: healthyObject.pointer }],
  ]));

  const result = await reconcileOnce({
    db, modalCalls: calls, resultStore: store, inputBucket: INPUT_BUCKET,
    now: new Date(Date.now() + 1_000), pollIntervalMs: 1,
  });
  assert.equal(
    result.outcomes.find((entry) => entry.attemptId === first.id).outcome.kind,
    'retryable_error',
  );
  assert.equal((await row('job_attempts', first.id)).state, 'dispatched');
  assert.equal((await row('jobs', healthyJob.id)).state, 'succeeded');
});

test('deadline sweep terminates abandoned upload, orphan queue, and pending call', async () => {
  const now = new Date('2026-08-26T12:00:00Z');
  const uploading = (await db.query(
    `INSERT INTO jobs (
       user_id, state, input_uri, input_digest, input_bytes,
       unit_price_micros, created_at, upload_expires_at
     ) VALUES ($1, 'uploading', 'r2://inputs/inputs/upload.pdf', $2, 1, 1000,
               $3, $4) RETURNING id`,
    [userId, INPUT_DIGEST, '2026-08-26T10:00:00Z', '2026-08-26T11:00:00Z'],
  )).rows[0];
  const orphan = await job();
  await db.query('UPDATE jobs SET queued_at = $2 WHERE id = $1', [
    orphan.id, '2026-08-25T11:00:00Z',
  ]);
  const pendingJob = await job();
  await db.query('UPDATE jobs SET queued_at = $2 WHERE id = $1', [
    pendingJob.id, '2026-08-25T11:00:00Z',
  ]);
  const pending = await attempt(pendingJob.id);

  const result = await reconcileOnce({
    db, modalCalls: modal(), resultStore: fakeStore(), inputBucket: INPUT_BUCKET,
    now,
  });
  assert.deepEqual(result.maintenance.deadlines, { jobs: 3, attempts: 1 });
  for (const id of [uploading.id, orphan.id, pendingJob.id]) {
    assert.equal((await row('jobs', id)).state, 'failed');
  }
  assert.equal((await row('job_attempts', pending.id)).state, 'failed');
});

test('reconciler repairs a crash between attempt failure and job settlement', async () => {
  const j = await job();
  const a = await attempt(j.id, 'failed');
  await db.query(
    `UPDATE job_attempts SET completed_at = now(), error = 'recorded before crash' WHERE id = $1`,
    [a.id],
  );
  const result = await reconcileOnce({
    db, modalCalls: modal(), resultStore: fakeStore(), inputBucket: INPUT_BUCKET,
    now: new Date(Date.now() + 1_000),
  });
  assert.equal(result.maintenance.settledBefore, 1);
  assert.equal((await row('jobs', j.id)).state, 'failed');
});

test('due-time rotation prevents a small LIMIT from starving newer attempts', async () => {
  const attempts = [];
  for (let i = 0; i < 3; i += 1) {
    const j = await job();
    attempts.push(await attempt(j.id));
  }
  const now = new Date(Date.now() + 1_000);
  const options = {
    db, modalCalls: modal(), resultStore: fakeStore(), inputBucket: INPUT_BUCKET,
    now, limit: 2, pollIntervalMs: 60_000,
  };
  const first = await reconcileOnce(options);
  const second = await reconcileOnce(options);
  assert.equal(first.outcomes.length, 2);
  assert.equal(second.outcomes.length, 1);
  assert.deepEqual(
    new Set([...first.outcomes, ...second.outcomes].map((entry) => entry.attemptId)),
    new Set(attempts.map((entry) => entry.id)),
  );
});

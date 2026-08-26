// The one thing PGlite cannot test.
//
// PGlite runs Postgres in single-user mode and serializes queries on one
// connection -- measured: two concurrent `pg_sleep(1)` calls take 2002 ms,
// not ~1000 ms. So a `Promise.all` there proves nothing about a race; it is
// a sequential test wearing a concurrent costume.
//
// This file opens TWO real connections and makes them collide on the
// `accepted_attempt_id IS NULL` fence, which is the whole adjudication
// mechanism. It also proves the migration runner works against a real
// server -- PGlite's dialect is close but it is not the deployment target.
//
// Skipped unless PAGESPATIAL_TEST_DATABASE_URL points at a scratch database.
// Even there, the test creates and drops only its own random schema; it never
// modifies `public`.
//
// To run:
//
//   docker run --rm -d -p 5433:5432 -e POSTGRES_PASSWORD=x --name pg-m1 postgres:16
//   PAGESPATIAL_TEST_DATABASE_URL=postgres://postgres:x@localhost:5433/postgres \
//     npm test --workspace=@pagespatial/api

import { randomUUID } from 'node:crypto';
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate, migrationFiles } from '../src/migrate.mjs';
import { acceptAttempt as acceptAttemptRaw, failAttempt } from '../src/accept.mjs';
import { reconcileOnce } from '../src/reconciler.mjs';

const acceptAttempt = (database, input) =>
  acceptAttemptRaw(database, {
    status: 'completed', resultCreatedAt: new Date('2026-08-26T12:00:00Z'), ...input,
  });

const URL = process.env.PAGESPATIAL_TEST_DATABASE_URL;

describe('native Postgres', {
  skip: URL ? false : 'PAGESPATIAL_TEST_DATABASE_URL not set',
}, () => {
  let a; // two independent connections, not two calls on one
  let b;
  const schema = `pagespatial_test_${randomUUID().replaceAll('-', '')}`;
  const quotedSchema = `"${schema}"`; // generated from hex only

  before(async () => {
    a = new pg.Client({ connectionString: URL });
    b = new pg.Client({ connectionString: URL });
    await a.connect();
    await b.connect();
    await a.query(`CREATE SCHEMA ${quotedSchema}`);
    await a.query(`SET search_path TO ${quotedSchema}`);
    await b.query(`SET search_path TO ${quotedSchema}`);
    await migrate(a);
  });

  after(async () => {
    await b?.end();
    if (a) await a.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
    await a?.end();
  });

  const fixture = async () => {
    const { rows: u } = await a.query(
      `INSERT INTO users (email, status) VALUES ($1,'active') RETURNING id`,
      [`race-${Date.now()}-${Math.random()}@example.test`],
    );
    const { rows: j } = await a.query(
      `INSERT INTO jobs (user_id, state, input_uri, input_digest, unit_price_micros, upload_expires_at)
       VALUES ($1,'queued','r2://in',$2,1000, now() + interval '1 hour') RETURNING id`,
      [u[0].id, 'a'.repeat(64)],
    );
    const mk = async (replacesAttemptId = null) => (await a.query(
      `INSERT INTO job_attempts (
         job_id, state, modal_call_id, dispatched_at, replaces_attempt_id
       ) VALUES ($1, 'dispatched', $2, now(), $3) RETURNING id`,
      [j[0].id, `fc-${randomUUID()}`, replacesAttemptId],
    )).rows[0].id;
    const one = await mk();
    return { jobId: j[0].id, one, two: await mk(one) };
  };

  test('the migration applies cleanly to a fresh server', async () => {
    const { rows } = await a.query(
      `SELECT count(*)::int AS n FROM pg_tables
        WHERE schemaname = $1
          AND tablename IN ('users','api_keys','jobs','job_attempts','schema_migrations')`,
      [schema],
    );
    assert.equal(rows[0].n, 5);
  });

  test('re-running the migration is a no-op', async () => {
    const result = await migrate(a);
    assert.deepEqual(result, { applied: [], pending: [] });
  });

  test('two fresh replicas serialize migration startup', async () => {
    const left = new pg.Client({ connectionString: URL });
    const right = new pg.Client({ connectionString: URL });
    const raceSchema = `pagespatial_migrate_${randomUUID().replaceAll('-', '')}`;
    const quoted = `"${raceSchema}"`;
    await left.connect();
    await right.connect();
    try {
      await left.query(`CREATE SCHEMA ${quoted}`);
      await left.query(`SET search_path TO ${quoted}`);
      await right.query(`SET search_path TO ${quoted}`);
      const [one, two] = await Promise.all([migrate(left), migrate(right)]);
      assert.equal(one.applied.length + two.applied.length, migrationFiles().length,
        'every migration file must be applied exactly once in total');
      assert.deepEqual(
        [one.pending.length, two.pending.length], [0, 0],
      );
    } finally {
      await right.end();
      await left.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
      await left.end();
    }
  });

  test('one reconciler session excludes another replica', async () => {
    await a.query('SELECT pg_advisory_lock(731945822)');
    try {
      const result = await reconcileOnce({ db: b });
      assert.deepEqual(result, { acquired: false, outcomes: [] });
    } finally {
      await a.query('SELECT pg_advisory_unlock(731945822)');
    }
  });

  test('exactly one of two racing installs wins', async () => {
    const { jobId, one, two } = await fixture();

    // Genuinely concurrent: separate connections, separate backends.
    const [r1, r2] = await Promise.all([
      acceptAttempt(a, { jobId, attemptId: one, resultUri: 'r2://1', resultDigest: '1'.repeat(64), pages: 4 }),
      acceptAttempt(b, { jobId, attemptId: two, resultUri: 'r2://2', resultDigest: '2'.repeat(64), pages: 7 }),
    ]);

    assert.equal([r1.won, r2.won].filter(Boolean).length, 1);
  });

  test('both racing attempts are still recorded truthfully', async () => {
    const { jobId, one, two } = await fixture();

    const [r1, r2] = await Promise.all([
      acceptAttempt(a, { jobId, attemptId: one, resultUri: 'r2://1', resultDigest: '1'.repeat(64), pages: 4 }),
      acceptAttempt(b, { jobId, attemptId: two, resultUri: 'r2://2', resultDigest: '2'.repeat(64), pages: 7 }),
    ]);

    // Losing is not failing: both really completed.
    assert.equal(r1.recorded && r2.recorded, true);
  });

  test("the job's cost matches the winner's page count, not the loser's", async () => {
    const { jobId, one, two } = await fixture();

    const [r1] = await Promise.all([
      acceptAttempt(a, { jobId, attemptId: one, resultUri: 'r2://1', resultDigest: '1'.repeat(64), pages: 4 }),
      acceptAttempt(b, { jobId, attemptId: two, resultUri: 'r2://2', resultDigest: '2'.repeat(64), pages: 7 }),
    ]);

    const { rows } = await a.query(
      'SELECT pages_actual, estimated_cost_micros FROM jobs WHERE id = $1', [jobId]);
    const expected = r1.won ? 4 : 7;
    assert.deepEqual(
      { pages: rows[0].pages_actual, cost: Number(rows[0].estimated_cost_micros) },
      { pages: expected, cost: expected * 1000 },
    );
  });

  test('two concurrent final failures settle the job', async () => {
    const { jobId, one, two } = await fixture();

    const [r1, r2] = await Promise.all([
      failAttempt(a, { jobId, attemptId: one, error: 'worker one failed' }),
      failAttempt(b, { jobId, attemptId: two, error: 'worker two failed' }),
    ]);

    assert.equal(r1.recorded && r2.recorded, true);
    assert.equal([r1.jobFailed, r2.jobFailed].filter(Boolean).length, 1,
      'exactly one settlement changes the job to failed');
    const { rows } = await a.query(
      `SELECT j.state,
              (SELECT count(*)::int FROM job_attempts x
                WHERE x.job_id = j.id AND x.state = 'failed') AS failed_attempts
         FROM jobs j WHERE j.id = $1`,
      [jobId],
    );
    assert.deepEqual(rows[0], { state: 'failed', failed_attempts: 2 });
  });
});

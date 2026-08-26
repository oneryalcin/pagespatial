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
// Skipped unless DATABASE_URL points at a scratch database. To run:
//
//   docker run --rm -d -p 5433:5432 -e POSTGRES_PASSWORD=x --name pg-m1 postgres:16
//   DATABASE_URL=postgres://postgres:x@localhost:5433/postgres \
//     npm test --workspace=@pagespatial/api

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { migrate } from '../src/migrate.mjs';
import { acceptAttempt } from '../src/accept.mjs';

const URL = process.env.DATABASE_URL;

describe('native Postgres', { skip: URL ? false : 'DATABASE_URL not set' }, () => {
  let a; // two independent connections, not two calls on one
  let b;

  before(async () => {
    a = new pg.Client({ connectionString: URL });
    b = new pg.Client({ connectionString: URL });
    await a.connect();
    await b.connect();
    await a.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(a);
  });

  after(async () => {
    await a?.end();
    await b?.end();
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
    const mk = async () => (await a.query(
      `INSERT INTO job_attempts (job_id, state) VALUES ($1,'dispatched') RETURNING id`,
      [j[0].id],
    )).rows[0].id;
    return { jobId: j[0].id, one: await mk(), two: await mk() };
  };

  test('the migration applies cleanly to a fresh server', async () => {
    const { rows } = await a.query(
      `SELECT count(*)::int AS n FROM pg_tables
        WHERE schemaname='public'
          AND tablename IN ('users','api_keys','jobs','job_attempts','schema_migrations')`,
    );
    assert.equal(rows[0].n, 5);
  });

  test('re-running the migration is a no-op', async () => {
    const result = await migrate(a);
    assert.deepEqual(result, { applied: [], pending: [] });
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
});

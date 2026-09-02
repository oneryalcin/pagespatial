import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { migrate, migrationFiles } from '../src/migrate.mjs';
import { reconcileOnce } from '../src/reconciler.mjs';

test('migration refuses a pool because its advisory lock is session-scoped', async () => {
  const pool = new pg.Pool({ connectionString: 'postgres://unused.invalid/database' });
  try {
    await assert.rejects(
      migrate(pool),
      /requires one checked-out pg.Client, not pg.Pool/,
    );
    assert.equal(pool.totalCount, 0, 'the guard must fire before checking out a connection');
  } finally {
    await pool.end();
  }
});

test('reconciler refuses a pool because its advisory lock is session-scoped', async () => {
  const pool = new pg.Pool({ connectionString: 'postgres://unused.invalid/database' });
  try {
    await assert.rejects(
      reconcileOnce({ db: pool }),
      /requires one checked-out pg.Client, not pg.Pool/,
    );
    assert.equal(pool.totalCount, 0);
  } finally {
    await pool.end();
  }
});

test('migration lock covers the complete run and releases after failure', async () => {
  const db = await PGlite.create();
  try {
    await migrate(db);
    await db.query(
      `UPDATE schema_migrations SET sha256 = $2 WHERE name = $1`,
      ['001_job_plane.sql', '0'.repeat(64)],
    );

    const queries = [];
    const observed = {
      query: (...args) => {
        queries.push(args[0]);
        return db.query(...args);
      },
      exec: (...args) => db.exec(...args),
    };
    await assert.rejects(migrate(observed), /different checksum/);
    assert.match(queries[0], /pg_advisory_lock/);
    assert.match(queries.at(-1), /pg_advisory_unlock/);
  } finally {
    await db.close();
  }
});

test('compact migration preserves old attempts and requires pairs for new attempts', async () => {
  const db = await PGlite.create();
  try {
    const migrations = migrationFiles();
    for (const migration of migrations.slice(0, -1)) await db.exec(migration.sql);
    const userId = (await db.query(
      `INSERT INTO users (email, status) VALUES ('legacy@example.test', 'active') RETURNING id`,
    )).rows[0].id;
    const jobId = (await db.query(
      `INSERT INTO jobs (user_id, state, input_uri, input_digest, input_bytes,
                         unit_price_micros, upload_expires_at)
       VALUES ($1, 'queued', 'r2://inputs/legacy.pdf', $2, 589, 1000,
               now() + interval '1 hour') RETURNING id`,
      [userId, 'a'.repeat(64)],
    )).rows[0].id;
    const oldAttempt = (await db.query(
      'INSERT INTO job_attempts (job_id) VALUES ($1) RETURNING id', [jobId],
    )).rows[0].id;
    await db.exec(migrations.at(-1).sql);
    const oldFlag = (await db.query(
      'SELECT requires_compact FROM job_attempts WHERE id = $1', [oldAttempt],
    )).rows[0].requires_compact;
    const newFlag = (await db.query(
      'INSERT INTO job_attempts (job_id, replaces_attempt_id) VALUES ($1, $2) RETURNING requires_compact',
      [jobId, oldAttempt],
    )).rows[0].requires_compact;
    assert.equal(oldFlag, false);
    assert.equal(newFlag, true);
  } finally {
    await db.close();
  }
});

test('reconciler preserves its primary failure when advisory unlock also fails', async () => {
  let query = 0;
  const db = {
    async query() {
      query += 1;
      if (query === 1) return { rows: [{ acquired: true }] };
      if (query === 2) throw new Error('primary database failure');
      throw new Error('secondary unlock failure');
    },
  };
  await assert.rejects(
    reconcileOnce({ db }),
    /primary database failure/,
  );
});

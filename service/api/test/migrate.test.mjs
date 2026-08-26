import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { migrate } from '../src/migrate.mjs';
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

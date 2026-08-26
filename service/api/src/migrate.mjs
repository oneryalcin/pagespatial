#!/usr/bin/env node
// Migration runner. Numbered .sql files, applied in order, each recorded
// once. No framework: the schema is four tables.
//
//   node src/migrate.mjs            apply pending migrations
//   node src/migrate.mjs --status   list applied / pending, apply nothing
//
// Reads DATABASE_URL. Each migration runs inside a transaction together
// with its bookkeeping insert, so a failure applies nothing and leaves no
// half-recorded state.

import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const MIGRATION_LOCK_ID = 731945821;

const LEDGER = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name        text PRIMARY KEY,
    sha256      text NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now()
  )`;

export function migrationFiles(dir = MIGRATIONS) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(dir, name), 'utf8');
      return { name, sql, sha256: createHash('sha256').update(sql).digest('hex') };
    });
}

/**
 * Apply pending migrations. `db` is anything with .query() — a pg client or
 * a PGlite instance — so the runner itself is testable without a server.
 */
async function migrateLocked(db, { dryRun = false, log = () => {} } = {}) {
  // A migration file holds many statements. `query()` uses the extended
  // protocol, which accepts exactly one -- node-postgres happens to fall
  // back to simple-query for a parameterless string, PGlite does not. Rather
  // than depend on that difference (and so test a different code path than
  // production runs), use the driver's explicit multi-statement call when
  // it has one.
  const exec = typeof db.exec === 'function' ? (sql) => db.exec(sql) : (sql) => db.query(sql);

  await db.query(LEDGER);
  const { rows } = await db.query('SELECT name, sha256 FROM schema_migrations');
  const applied = new Map(rows.map((r) => [r.name, r.sha256]));
  const pending = [];

  for (const m of migrationFiles()) {
    const seen = applied.get(m.name);
    if (seen === undefined) { pending.push(m); continue; }
    // An applied migration whose bytes changed is an editing mistake, not
    // a migration. Refuse rather than silently diverge from the database
    // the file claims to describe.
    if (seen !== m.sha256) {
      throw new Error(
        `${m.name} was already applied with a different checksum ` +
        `(recorded ${seen.slice(0, 12)}, file ${m.sha256.slice(0, 12)}). ` +
        `Add a new migration instead of editing an applied one.`,
      );
    }
    log(`  ok      ${m.name}`);
  }

  if (dryRun) {
    for (const m of pending) log(`  pending ${m.name}`);
    return { applied: [], pending: pending.map((m) => m.name) };
  }

  const done = [];
  for (const m of pending) {
    await db.query('BEGIN');
    try {
      await exec(m.sql);
      await db.query(
        'INSERT INTO schema_migrations (name, sha256) VALUES ($1, $2)',
        [m.name, m.sha256],
      );
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      throw new Error(`${m.name} failed: ${error.message}`);
    }
    log(`  applied ${m.name}`);
    done.push(m.name);
  }
  return { applied: done, pending: [] };
}

/** Serialize the complete read/check/apply sequence across API replicas.
 * The lock is session-scoped, so every exit path must release it. */
export async function migrate(db, options = {}) {
  if (db instanceof pg.Pool) {
    throw new TypeError('migrate requires one checked-out pg.Client, not pg.Pool');
  }
  await db.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
  try {
    return await migrateLocked(db, options);
  } finally {
    await db.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
  }
}

// --- CLI ---------------------------------------------------------------
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set.');
    process.exit(2);
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const result = await migrate(client, {
      dryRun: process.argv.includes('--status'),
      log: (line) => console.log(line),
    });
    if (!result.applied.length && !result.pending.length) console.log('  up to date');
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

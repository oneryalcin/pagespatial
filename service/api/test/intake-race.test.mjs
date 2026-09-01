import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../src/migrate.mjs';
import { createOrReplayJob } from '../src/jobs.mjs';

const url = process.env.PAGESPATIAL_TEST_DATABASE_URL;

test('native Postgres admission is exact across independent connections', {
  skip: !url && 'PAGESPATIAL_TEST_DATABASE_URL not set',
}, async () => {
  const schema = `m2_intake_${process.pid}`;
  const bootstrap = new pg.Client({ connectionString: url });
  await bootstrap.connect();
  await bootstrap.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({
    connectionString: url,
    max: 12,
    connectionTimeoutMillis: 2_000,
    options: `-c search_path=${schema}`,
  });
  const admin = await pool.connect();
  try {
    await migrate(admin);
    const userId = (await admin.query(
      "INSERT INTO users (email, status) VALUES ('race@example.test','active') RETURNING id",
    )).rows[0].id;
    await admin.query(
      `INSERT INTO credit_grants (user_id, pages, source, reference)
       VALUES ($1, 2000, 'manual', 'test-fixture')`, [userId],
    );
    const outcomes = await Promise.allSettled(Array.from({ length: 12 }, (_, index) =>
      createOrReplayJob({
        pool,
        userId,
        idempotencyKey: `race-${index}`,
        inputSha256: 'a'.repeat(64),
        inputBucket: 'inputs',
      })));
    assert.equal(outcomes.filter((value) => value.status === 'fulfilled').length, 5);
    assert.equal(outcomes.filter(
      (value) => value.status === 'rejected' && value.reason?.code === 'admission_limit',
    ).length, 7);
    assert.equal(Number((await admin.query(
      "SELECT count(*) FROM jobs WHERE state IN ('uploading','queued','dispatched')",
    )).rows[0].count), 5);

    const replayUser = (await admin.query(
      "INSERT INTO users (email, status) VALUES ('same-key@example.test','active') RETURNING id",
    )).rows[0].id;
    await admin.query(
      `INSERT INTO credit_grants (user_id, pages, source, reference)
       VALUES ($1, 2000, 'manual', 'test-fixture')`, [replayUser],
    );
    const replays = await Promise.all(Array.from({ length: 12 }, () =>
      createOrReplayJob({
        pool,
        userId: replayUser,
        idempotencyKey: 'same-key',
        inputSha256: 'b'.repeat(64),
        inputBucket: 'inputs',
      })));
    assert.equal(replays.filter((value) => value.created).length, 1);
    assert.equal(new Set(replays.map((value) => value.row.id)).size, 1);
    assert.equal(Number((await admin.query(
      'SELECT count(*) FROM jobs WHERE user_id = $1 AND idempotency_key = $2',
      [replayUser, 'same-key'],
    )).rows[0].count), 1);
  } finally {
    admin.release();
    await pool.end();
    await bootstrap.query(`DROP SCHEMA ${schema} CASCADE`);
    await bootstrap.end();
  }
});

test('native Postgres rolls back a failed admission and reuses the pool', {
  skip: !url && 'PAGESPATIAL_TEST_DATABASE_URL not set',
}, async () => {
  const schema = `m2_rollback_${process.pid}`;
  const bootstrap = new pg.Client({ connectionString: url });
  await bootstrap.connect();
  await bootstrap.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({
    connectionString: url,
    max: 1,
    connectionTimeoutMillis: 2_000,
    options: `-c search_path=${schema}`,
  });
  try {
    const admin = await pool.connect();
    await migrate(admin);
    const userId = (await admin.query(
      "INSERT INTO users (email, status) VALUES ('rollback@example.test','active') RETURNING id",
    )).rows[0].id;
    await admin.query(
      `INSERT INTO credit_grants (user_id, pages, source, reference)
       VALUES ($1, 2000, 'manual', 'test-fixture')`, [userId],
    );
    admin.release();

    await assert.rejects(createOrReplayJob({
      pool,
      userId: randomUUID(),
      idempotencyKey: 'missing-owner',
      inputSha256: 'a'.repeat(64),
      inputBucket: 'inputs',
    }), /foreign key|job owner does not exist/iu);

    const created = await createOrReplayJob({
      pool,
      userId,
      idempotencyKey: 'after-rollback',
      inputSha256: 'a'.repeat(64),
      inputBucket: 'inputs',
    });
    assert.equal(created.created, true);
    assert.equal(created.row.user_id, userId);
  } finally {
    await pool.end();
    await bootstrap.query(`DROP SCHEMA ${schema} CASCADE`);
    await bootstrap.end();
  }
});

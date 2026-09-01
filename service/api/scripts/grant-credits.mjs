#!/usr/bin/env node
import pg from 'pg';

const [, , emailArgument, pagesArgument, ...noteParts] = process.argv;
const email = emailArgument?.trim().toLowerCase();
const pages = Number(pagesArgument);
if (!process.env.DATABASE_URL || !email || !email.includes('@')
    || !Number.isSafeInteger(pages) || pages < 1) {
  console.error('Usage: DATABASE_URL=... node scripts/grant-credits.mjs EMAIL POSITIVE_PAGES [NOTE]');
  process.exit(2);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [email]);
  const account = (await client.query(
    `SELECT id FROM users WHERE email = $1 AND status = 'active'`, [email],
  )).rows[0];
  if (!account) throw new Error('active account not found');
  const request = (await client.query(
    `SELECT id FROM credit_requests
      WHERE user_id = $1 AND status = 'pending'
      ORDER BY created_at
      LIMIT 1 FOR UPDATE`,
    [account.id],
  )).rows[0];
  if (!request) throw new Error('pending credit request not found');
  const reference = `manual-request:${request.id}`;
  await client.query(
    `INSERT INTO credit_grants (user_id, pages, source, reference, note)
     VALUES ($1, $2, 'manual', $3, $4)`,
    [account.id, pages, reference, noteParts.join(' ').trim() || null],
  );
  await client.query(
    `UPDATE credit_requests SET status = 'approved', resolved_at = now()
      WHERE id = $1 AND user_id = $2 AND status = 'pending'`,
    [request.id, account.id],
  );
  await client.query('COMMIT');
  console.log(JSON.stringify({ email, pages, reference }));
} catch (error) {
  await client.query('ROLLBACK');
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await client.end();
}

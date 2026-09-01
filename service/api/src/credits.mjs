import { ApiError } from './api-errors.mjs';

export const DEFAULT_TRIAL_PAGES = 100;
export const MAX_PAGES_PER_JOB = 200;

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

/** Activate an invited account or create a verified alpha account.
 *
 * Each step is idempotent. A failure between account creation and the grant
 * makes this login fail closed; the next login repairs the missing grant.
 * The common active-user path is read-only.
 */
export async function provisionAccessUser(db, {
  email, allowSelfSignup = false, trialPages = DEFAULT_TRIAL_PAGES,
}) {
  positiveInteger(trialPages, 'trialPages');
  let account = (await db.query(
    `SELECT id, status,
            EXISTS (
              SELECT 1 FROM credit_grants
               WHERE user_id = users.id AND reference = 'alpha-trial-v1'
            ) AS has_trial
       FROM users WHERE email = $1`,
    [email],
  )).rows[0];
  if (account?.status === 'suspended') return null;
  if (account?.status === 'invited') {
    account = (await db.query(
      `UPDATE users SET status = 'active'
        WHERE id = $1 AND status = 'invited'
        RETURNING id, status`,
      [account.id],
    )).rows[0] ?? (await db.query(
      `SELECT id, status,
              EXISTS (
                SELECT 1 FROM credit_grants
                 WHERE user_id = users.id AND reference = 'alpha-trial-v1'
              ) AS has_trial
         FROM users WHERE email = $1 AND status = 'active'`, [email],
    )).rows[0];
  } else if (!account && allowSelfSignup) {
    account = (await db.query(
      `INSERT INTO users (email, status) VALUES ($1, 'active')
       ON CONFLICT (email) DO NOTHING
       RETURNING id, status`,
      [email],
    )).rows[0] ?? (await db.query(
      `SELECT id, status,
              EXISTS (
                SELECT 1 FROM credit_grants
                 WHERE user_id = users.id AND reference = 'alpha-trial-v1'
              ) AS has_trial
         FROM users WHERE email = $1 AND status = 'active'`, [email],
    )).rows[0];
  }
  if (account?.status !== 'active') return null;
  if (!account.has_trial) {
    await db.query(
      `INSERT INTO credit_grants (user_id, pages, source, reference, note)
       VALUES ($1, $2, 'trial', 'alpha-trial-v1', 'Initial alpha allowance')
       ON CONFLICT (user_id, reference) DO NOTHING`,
      [account.id, trialPages],
    );
  }
  return account.id;
}

export async function loadCreditSummary(db, { userId }) {
  const { rows } = await db.query(
    `SELECT
       coalesce((SELECT sum(pages) FROM credit_grants WHERE user_id = $1), 0)::bigint AS granted,
       coalesce((SELECT sum(pages_actual) FROM jobs
                  WHERE user_id = $1 AND state = 'succeeded'), 0)::bigint AS used,
       coalesce((SELECT sum(reserved_pages) FROM jobs
                  WHERE user_id = $1
                    AND state IN ('uploading','queued','dispatched')), 0)::bigint AS reserved,
       EXISTS (SELECT 1 FROM credit_requests
                WHERE user_id = $1 AND status = 'pending') AS request_pending`,
    [userId],
  );
  const row = rows[0];
  const granted = Number(row.granted);
  const used = Number(row.used);
  const reserved = Number(row.reserved);
  return {
    granted,
    used,
    reserved,
    available: Math.max(0, granted - used - reserved),
    requestPending: row.request_pending,
  };
}

export async function requestMoreCredits(db, { userId }) {
  const { rows } = await db.query(
    `INSERT INTO credit_requests (user_id)
     SELECT $1 WHERE EXISTS (
       SELECT 1 FROM users WHERE id = $1 AND status = 'active'
     )
     ON CONFLICT (user_id) WHERE status = 'pending' DO NOTHING
     RETURNING id`,
    [userId],
  );
  if (rows[0]) return { created: true, id: rows[0].id };
  const existing = await db.query(
    `SELECT id FROM credit_requests
      WHERE user_id = $1 AND status = 'pending'`,
    [userId],
  );
  if (existing.rows[0]) return { created: false, id: existing.rows[0].id };
  throw new ApiError(403, 'forbidden', 'Access denied.');
}

export function assertTrialPages(value) {
  return positiveInteger(value, 'trialPages');
}

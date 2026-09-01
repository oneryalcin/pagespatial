import { loadCreditSummary } from './credits.mjs';

const PAGE_SIZE = 25;

const STATE_FILTERS = Object.freeze({
  all: null,
  active: ['uploading', 'queued', 'dispatched'],
  succeeded: ['succeeded'],
  failed: ['failed'],
});

const DATE_WINDOWS_MS = Object.freeze({
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  all: null,
});

export function parseJobsQuery(searchParams) {
  const state = searchParams.get('state') ?? 'all';
  const date = searchParams.get('date') ?? '7d';
  const pageText = searchParams.get('page') ?? '1';
  if (!Object.hasOwn(STATE_FILTERS, state)
      || !Object.hasOwn(DATE_WINDOWS_MS, date)
      || !/^[1-9][0-9]*$/u.test(pageText)) {
    throw new TypeError('invalid jobs query');
  }
  const page = Number(pageText);
  if (!Number.isSafeInteger(page)) throw new TypeError('invalid jobs query');
  return { state, date, page };
}

function dateCutoff(date, now) {
  const duration = DATE_WINDOWS_MS[date];
  return duration == null ? null : new Date(now.getTime() - duration);
}

function jobsWhere({ userId, state, date, now }) {
  const values = [userId];
  const clauses = ['user_id = $1'];
  const states = STATE_FILTERS[state];
  if (states) {
    values.push(states);
    clauses.push(`state = ANY($${values.length}::text[])`);
  }
  const cutoff = dateCutoff(date, now);
  if (cutoff) {
    values.push(cutoff.toISOString());
    clauses.push(`created_at >= $${values.length}::timestamptz`);
  }
  return { sql: clauses.join(' AND '), values };
}

export async function loadJobsPage(db, {
  userId, state = 'all', date = '7d', page = 1, now = new Date(),
}) {
  const where = jobsWhere({ userId, state, date, now });
  const offset = (page - 1) * PAGE_SIZE;
  const [rowsResult, countResult, summaryResult] = await Promise.all([
    db.query(
      `SELECT * FROM jobs
        WHERE ${where.sql}
        ORDER BY created_at DESC, id DESC
        LIMIT ${PAGE_SIZE} OFFSET $${where.values.length + 1}`,
      [...where.values, offset],
    ),
    db.query(`SELECT count(*)::integer AS count FROM jobs WHERE ${where.sql}`, where.values),
    db.query(
      `SELECT count(*)::integer AS documents,
              coalesce(sum(pages_actual) FILTER (WHERE state = 'succeeded'), 0)::bigint AS pages,
              coalesce(sum(estimated_cost_micros)
                FILTER (WHERE state = 'succeeded'), 0)::bigint AS cost
         FROM jobs
        WHERE user_id = $1
          AND ($2::timestamptz IS NULL OR created_at >= $2::timestamptz)`,
      [userId, dateCutoff(date, now)?.toISOString() ?? null],
    ),
  ]);
  const total = countResult.rows[0]?.count ?? 0;
  return {
    rows: rowsResult.rows,
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    pageSize: PAGE_SIZE,
    summary: summaryResult.rows[0],
  };
}

export async function loadUsagePage(db, { userId, now = new Date() }) {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [summaryResult, dailyResult, credits] = await Promise.all([
    db.query(
      `SELECT count(*)::integer AS documents,
              coalesce(sum(pages_actual), 0)::bigint AS pages,
              coalesce(sum(estimated_cost_micros), 0)::bigint AS cost
         FROM jobs
        WHERE user_id = $1 AND state = 'succeeded' AND completed_at >= $2`,
      [userId, monthStart.toISOString()],
    ),
    db.query(
      `SELECT (completed_at AT TIME ZONE 'UTC')::date::text AS day,
              count(*)::integer AS documents,
              coalesce(sum(pages_actual), 0)::bigint AS pages,
              coalesce(sum(estimated_cost_micros), 0)::bigint AS cost
         FROM jobs
        WHERE user_id = $1 AND state = 'succeeded' AND completed_at >= $2
        GROUP BY day
        ORDER BY day DESC`,
      [userId, monthStart.toISOString()],
    ),
    loadCreditSummary(db, { userId }),
  ]);
  return {
    monthStart,
    summary: summaryResult.rows[0],
    days: dailyResult.rows,
    credits,
  };
}

export const DASHBOARD_PAGE_SIZE = PAGE_SIZE;

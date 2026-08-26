const OPEN_ATTEMPT_STATES = "('dispatching','dispatch_unknown','dispatched')";

const validDate = (value, label) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${label} must be a valid date`);
  return date;
};

/**
 * Fail expired uploads and jobs that have exceeded their complete processing
 * deadline. Attempts and their job become terminal in one SQL statement.
 */
export async function sweepJobDeadlines(
  db, { now = new Date(), jobTimeoutMs = 24 * 60 * 60 * 1000 } = {},
) {
  const current = validDate(now, 'now');
  if (!Number.isSafeInteger(jobTimeoutMs) || jobTimeoutMs < 1) {
    throw new TypeError('jobTimeoutMs must be a positive integer');
  }
  const cutoff = new Date(current.getTime() - jobTimeoutMs);
  const { rows } = await db.query(
    `WITH expired AS MATERIALIZED (
       SELECT id,
              CASE
                WHEN state = 'uploading' THEN 'upload window expired'
                WHEN queued_at IS NULL THEN 'queued job has no queued_at deadline anchor'
                ELSE 'processing deadline exceeded'
              END AS reason
         FROM jobs
        WHERE (state = 'uploading' AND upload_expires_at <= $1::timestamptz)
           OR (state IN ('queued','dispatched')
               AND (queued_at IS NULL OR queued_at <= $2::timestamptz))
     ), failed_attempts AS (
       UPDATE job_attempts a
          SET state = 'failed', error = expired.reason, completed_at = $1::timestamptz
         FROM expired
        WHERE a.job_id = expired.id
          AND a.state IN ${OPEN_ATTEMPT_STATES}
       RETURNING a.id
     ), failed_jobs AS (
       UPDATE jobs j
          SET state = 'failed', error = expired.reason, completed_at = $1::timestamptz
         FROM expired
        WHERE j.id = expired.id
          AND j.state IN ('uploading','queued','dispatched')
       RETURNING j.id
     )
     SELECT (SELECT count(*) FROM failed_jobs) AS jobs,
            (SELECT count(*) FROM failed_attempts) AS attempts`,
    [current.toISOString(), cutoff.toISOString()],
  );
  return { jobs: Number(rows[0].jobs), attempts: Number(rows[0].attempts) };
}

/** Repair a crash after an attempt failure but before derived job settlement. */
export async function settleExhaustedJobs(db, { now = new Date() } = {}) {
  const current = validDate(now, 'now');
  const { rowCount } = await db.query(
    `UPDATE jobs j
        SET state = 'failed',
            error = COALESCE(j.error, 'all attempts failed'),
            completed_at = $1::timestamptz
      WHERE j.state IN ('queued','dispatched')
        AND j.accepted_attempt_id IS NULL
        AND EXISTS (SELECT 1 FROM job_attempts a WHERE a.job_id = j.id)
        AND NOT EXISTS (
              SELECT 1 FROM job_attempts a
               WHERE a.job_id = j.id AND a.state <> 'failed'
            )`,
    [current.toISOString()],
  );
  return rowCount;
}

export async function deferAttempt(db, { attemptId, now = new Date(), delayMs = 60_000 }) {
  const current = validDate(now, 'now');
  if (!Number.isSafeInteger(delayMs) || delayMs < 1) {
    throw new TypeError('delayMs must be a positive integer');
  }
  await db.query(
    `UPDATE job_attempts
        SET reconcile_after = $2::timestamptz
      WHERE id = $1 AND state IN ${OPEN_ATTEMPT_STATES}`,
    [attemptId, new Date(current.getTime() + delayMs).toISOString()],
  );
}


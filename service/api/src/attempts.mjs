const OPEN_JOB_STATES = "('queued','dispatched')";

/** Create the initial attempt, or the one allowed replacement for an unknown attempt. */
export async function createAttempt(db, { jobId, replacesAttemptId = null }) {
  const { rows } = await db.query(
    `INSERT INTO job_attempts (job_id, replaces_attempt_id)
     SELECT j.id, prior.id
       FROM jobs j
       LEFT JOIN job_attempts prior
         ON prior.id = $2::uuid AND prior.job_id = j.id
      WHERE j.id = $1
        AND j.state IN ${OPEN_JOB_STATES}
        AND j.accepted_attempt_id IS NULL
        AND (
          ($2::uuid IS NULL AND prior.id IS NULL)
          OR ($2::uuid IS NOT NULL
              AND prior.state = 'dispatch_unknown'
              -- One uncertain dispatch may get one replacement. A second
              -- uncertain dispatch reaches a terminal failure instead of
              -- growing an unbounded replacement chain.
              AND prior.replaces_attempt_id IS NULL)
        )
        AND NOT EXISTS (
          SELECT 1 FROM job_attempts replacement
           WHERE replacement.replaces_attempt_id = $2::uuid
        )
     ON CONFLICT DO NOTHING
     RETURNING id, job_id, replaces_attempt_id, state, created_at`,
    [jobId, replacesAttemptId],
  );
  return rows[0] ?? null;
}

/** Return an existing replacement, or atomically create the sole replacement. */
export async function getOrCreateReplacement(db, { jobId, attemptId }) {
  const existing = await db.query(
    `SELECT id, job_id, replaces_attempt_id, state, created_at
       FROM job_attempts
      WHERE job_id = $1 AND replaces_attempt_id = $2`,
    [jobId, attemptId],
  );
  if (existing.rows[0]) return { created: false, attempt: existing.rows[0] };
  const attempt = await createAttempt(db, { jobId, replacesAttemptId: attemptId });
  if (attempt) return { created: true, attempt };
  const raced = await db.query(
    `SELECT id, job_id, replaces_attempt_id, state, created_at
       FROM job_attempts
      WHERE job_id = $1 AND replaces_attempt_id = $2`,
    [jobId, attemptId],
  );
  return raced.rows[0] ? { created: false, attempt: raced.rows[0] } : null;
}

export async function getAttempt(db, attemptId) {
  const { rows } = await db.query(
    `SELECT a.id AS attempt_id, a.job_id, a.state AS attempt_state,
            a.modal_call_id, a.created_at AS attempt_created_at,
            a.replaces_attempt_id,
            j.state AS job_state, j.input_uri, j.input_digest, j.reserved_pages,
            j.queued_at, j.accepted_attempt_id
       FROM job_attempts a
       JOIN jobs j ON j.id = a.job_id
      WHERE a.id = $1`,
    [attemptId],
  );
  return rows[0] ?? null;
}

export async function listOpenAttempts(db, { limit = 32, now = new Date() } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
    throw new TypeError('reconcile limit must be an integer from 1 to 256');
  }
  const current = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(current.getTime())) throw new TypeError('reconcile now must be a valid date');
  const { rows } = await db.query(
    `SELECT a.id
      FROM job_attempts a
      WHERE a.state IN ('dispatching','dispatch_unknown','dispatched')
        AND a.reconcile_after <= $2::timestamptz
      ORDER BY a.reconcile_after, a.id
      LIMIT $1`,
    [limit, current.toISOString()],
  );
  return rows.map((row) => row.id);
}

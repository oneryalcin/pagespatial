// Adjudication: deciding which attempt's result is authoritative.
//
// This is the smallest and most load-bearing piece of the job plane.
// Dispatch is at-least-once, so a job can legitimately have two attempts
// producing two valid results. Exactly one may be installed, and a late
// ("zombie") attempt must never displace an already-installed one.
//
// The race is settled by the DATABASE, in one conditional update, not by
// application logic that reads and then writes -- a read-then-write leaves
// a window in which two reconciler ticks both observe NULL.

/**
 * Install `attempt` as the authoritative result for its job, if and only if
 * no attempt has been installed yet.
 *
 * Returns true when this attempt won, false when it lost. Losing is a
 * NORMAL outcome, not an error: the attempt's result object stays at its
 * own execution key and is removed later by retention.
 */
export async function acceptAttempt(db, { jobId, attemptId, resultUri, resultDigest, pages }) {
  // The attempt row is marked succeeded regardless of whether it wins the
  // adjudication -- it did succeed; it simply lost the race. Conflating
  // "lost" with "failed" would make the attempts table lie about what
  // happened.
  await db.query(
    `UPDATE job_attempts
        SET state = 'succeeded', result_uri = $2, result_digest = $3,
            pages = $4, completed_at = now()
      WHERE id = $1`,
    [attemptId, resultUri, resultDigest, pages],
  );

  // First writer wins. `accepted_attempt_id IS NULL` is the whole fence.
  //
  // Note this deliberately does NOT carry `AND state <> 'failed'`: a late
  // success is allowed to flip a terminally-failed job to succeeded. That
  // is the better outcome for the user, and the alternative would orphan a
  // perfectly good result in storage. It is a decision, not an oversight.
  const { rows } = await db.query(
    `UPDATE jobs
        SET accepted_attempt_id = $2,
            result_uri          = $3,
            result_digest       = $4,
            -- $5 is cast on both uses: without it Postgres tries to infer
            -- one type for a parameter that appears as both an integer
            -- column and a bigint multiplicand, and refuses.
            pages_actual        = $5::integer,
            estimated_cost_micros = unit_price_micros * $5::bigint,
            state               = 'succeeded',
            error               = NULL,
            completed_at        = now()
      WHERE id = $1
        AND accepted_attempt_id IS NULL
      RETURNING id`,
    [jobId, attemptId, resultUri, resultDigest, pages],
  );

  return rows.length === 1;
}

/**
 * Mark an attempt as having been dispatched into an unknown state: the
 * spawn may or may not have reached Modal, and its call id never landed.
 *
 * TERMINAL for this attempt. The reconciler mints a NEW attempt rather
 * than re-spawning this one -- reusing the id would point two Modal calls
 * at one result prefix, which is the exact thing per-execution keys exist
 * to prevent.
 */
export async function markDispatchUnknown(db, attemptId) {
  await db.query(
    `UPDATE job_attempts
        SET state = 'dispatch_unknown', completed_at = now()
      WHERE id = $1 AND state = 'dispatching'`,
    [attemptId],
  );
}

/**
 * Record a failed attempt. Fails the JOB only when no result has been
 * accepted and no other attempt is still outstanding -- otherwise a slow
 * loser would fail a job that another attempt is about to win.
 */
export async function failAttempt(db, { jobId, attemptId, error }) {
  await db.query(
    `UPDATE job_attempts
        SET state = 'failed', error = $2, completed_at = now()
      WHERE id = $1`,
    [attemptId, error],
  );

  const { rows } = await db.query(
    `UPDATE jobs
        SET state = 'failed', error = $2, completed_at = now()
      WHERE id = $1
        AND accepted_attempt_id IS NULL
        AND NOT EXISTS (
              SELECT 1 FROM job_attempts
               WHERE job_id = $1
                 AND state IN ('dispatching','dispatched')
            )
      RETURNING id`,
    [jobId, error],
  );

  return rows.length === 1;
}

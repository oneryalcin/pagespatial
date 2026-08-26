// Adjudication: deciding which attempt's result is authoritative.
//
// This is the smallest and most load-bearing piece of the job plane.
// Dispatch is at-least-once, so a job can legitimately have two attempts
// producing two valid results. Exactly one may be installed, and a late
// ("zombie") attempt must never displace an already-installed one.
//
// THREE properties, each enforced by SQL rather than by control flow:
//
//   1. ATOMIC. Each operation is ONE data-modifying statement. An earlier
//      draft issued two awaits; a crash between them left an attempt
//      marked succeeded while the job had no accepted attempt -- and since
//      the open-attempt index does not cover 'succeeded', no reconciler
//      sweep would ever find it. A CTE is atomic by construction and needs
//      no transaction framework.
//
//   2. OWNERSHIP-BOUND. Every write matches BOTH id and job_id. Scoping the
//      attempt update by id alone would let a mismatched pair install job
//      A's result onto job B -- across a tenant boundary. The composite
//      foreign key on (accepted_attempt_id, id) makes that unrepresentable
//      in the schema too; this is the belt to that's braces.
//
//   3. IDEMPOTENT. `completed_at IS NULL` guards every completion. One
//      Modal call may execute more than once (retries=1), and each
//      execution mints its own result key -- so a second report for the
//      SAME attempt carries a DIFFERENT uri. Without this guard it would
//      overwrite the attempt row while the job still pointed at the first
//      result, leaving the two records describing different objects.

/**
 * Install `attempt` as the authoritative result for its job, if and only if
 * the attempt belongs to that job, has not already completed, and no
 * attempt has been installed yet.
 *
 * @returns {{recorded: boolean, won: boolean}}
 *   `recorded` false means the attempt did not belong to this job, or had
 *   already completed (a duplicate report). `won` false means the attempt
 *   completed truthfully but lost the race -- a NORMAL outcome, not an
 *   error: its result object stays at its own execution key and is removed
 *   later by retention.
 */
export async function acceptAttempt(db, { jobId, attemptId, resultUri, resultDigest, pages }) {
  const { rows } = await db.query(
    `WITH owned AS (
       UPDATE job_attempts
          SET state = 'succeeded', result_uri = $3, result_digest = $4,
              pages = $5::integer, completed_at = now()
        WHERE id = $2 AND job_id = $1 AND completed_at IS NULL
       RETURNING id, job_id
     ),
     won AS (
       UPDATE jobs j
          SET accepted_attempt_id   = owned.id,
              result_uri            = $3,
              result_digest         = $4,
              pages_actual          = $5::integer,
              -- $5 is cast on both uses: Postgres otherwise tries to infer
              -- one type for a parameter appearing as both an integer
              -- column and a bigint multiplicand, and refuses.
              estimated_cost_micros = j.unit_price_micros * $5::bigint,
              state                 = 'succeeded',
              error                 = NULL,
              completed_at          = now()
         FROM owned
        WHERE j.id = owned.job_id
          AND j.accepted_attempt_id IS NULL
          -- A terminal job stays terminal. See the migration's note: a
          -- late success must not resurrect a job a client has already
          -- seen fail and may have resubmitted or reported onward.
          AND j.state <> 'failed'
       RETURNING j.id
     )
     SELECT (SELECT count(*) FROM owned) AS recorded,
            (SELECT count(*) FROM won)   AS won`,
    [jobId, attemptId, resultUri, resultDigest, pages],
  );

  return { recorded: Number(rows[0].recorded) === 1, won: Number(rows[0].won) === 1 };
}

/**
 * Record a failed attempt, and fail the JOB only when nothing else could
 * still produce a result.
 *
 * @returns {{recorded: boolean, jobFailed: boolean}}
 */
export async function failAttempt(db, { jobId, attemptId, error }) {
  const { rows } = await db.query(
    `WITH owned AS (
       UPDATE job_attempts
          SET state = 'failed', error = $3, completed_at = now()
        WHERE id = $2 AND job_id = $1 AND completed_at IS NULL
       RETURNING id, job_id
     ),
     failed AS (
       UPDATE jobs j
          SET state = 'failed', error = $3, completed_at = now()
         FROM owned
        WHERE j.id = owned.job_id
          AND j.accepted_attempt_id IS NULL
          AND NOT EXISTS (
                SELECT 1 FROM job_attempts o
                 WHERE o.job_id = owned.job_id
                   AND o.id <> owned.id
                   -- 'dispatch_unknown' COUNTS as outstanding. It is
                   -- terminal for DISPATCH -- the reconciler never
                   -- re-spawns that id -- but Modal may still be running
                   -- the call, and its result may still be sitting in R2.
                   -- Failing the job here is what forced the earlier
                   -- (rejected) design to let a late success un-fail it.
                   -- The reconciler resolves dispatch_unknown to failed
                   -- once the uncertainty deadline passes AND storage has
                   -- been checked; only then can the job fail.
                   AND o.state IN ('dispatching','dispatched','dispatch_unknown')
              )
       RETURNING j.id
     )
     SELECT (SELECT count(*) FROM owned)  AS recorded,
            (SELECT count(*) FROM failed) AS job_failed`,
    [jobId, attemptId, error],
  );

  return {
    recorded: Number(rows[0].recorded) === 1,
    jobFailed: Number(rows[0].job_failed) === 1,
  };
}

/**
 * Record that a spawn reached Modal and its call id landed.
 */
export async function markDispatched(db, { jobId, attemptId, modalCallId }) {
  const { rowCount } = await db.query(
    `UPDATE job_attempts
        SET state = 'dispatched', modal_call_id = $3, dispatched_at = now()
      WHERE id = $2 AND job_id = $1 AND state = 'dispatching'`,
    [jobId, attemptId, modalCallId],
  );
  return rowCount === 1;
}

/**
 * Mark an attempt as dispatched into an unknown state: the spawn may or
 * may not have reached Modal, and its call id never landed.
 *
 * Terminal for DISPATCH -- the reconciler mints a NEW attempt rather than
 * re-spawning this one, because reusing the id would point two Modal calls
 * at one result prefix, the exact thing per-execution keys prevent. It is
 * NOT terminal for adjudication: see `failAttempt`.
 */
export async function markDispatchUnknown(db, { jobId, attemptId }) {
  const { rowCount } = await db.query(
    `UPDATE job_attempts
        SET state = 'dispatch_unknown'
      WHERE id = $2 AND job_id = $1 AND state = 'dispatching'`,
    [jobId, attemptId],
  );
  return rowCount === 1;
}

// Adjudication: deciding which attempt's result is authoritative.
//
// This is the smallest and most load-bearing piece of the job plane.
// Dispatch is at-least-once, so a job can legitimately have two attempts
// producing two valid results. Exactly one may be installed, and a late
// ("zombie") attempt must never displace an already-installed one.
//
// THREE properties, each enforced by SQL rather than by optimistic reads:
//
//   1. ACCEPTANCE IS ATOMIC. Acceptance is ONE data-modifying statement. An
//      earlier draft issued two awaits; a crash between them left an attempt
//      marked succeeded while the job had no accepted attempt -- and since
//      the open-attempt index does not cover 'succeeded', no reconciler sweep
//      would ever find it. A CTE closes that invisible crash window.
//
//      Failure is different: an attempt failure is a fact, while job failure
//      is derived from ALL attempts. They are two idempotent operations. The
//      caller settles immediately and the reconciler repeats settlement, so
//      a crash between them is visible and repairable.
//
//   2. OWNERSHIP-BOUND. Every write matches BOTH id and job_id. Scoping the
//      attempt update by id alone would let a mismatched pair install job
//      A's result onto job B -- across a tenant boundary. The composite
//      foreign key on (accepted_attempt_id, id) makes that unrepresentable
//      in the schema too; this is the belt to the query's braces.
//
//   3. IDEMPOTENT. `completed_at IS NULL` guards every completion. One
//      Modal call may execute more than once (retries=1), and each
//      execution mints its own result key -- so a second report for the
//      SAME attempt carries a DIFFERENT uri. Without this guard it would
//      overwrite the attempt row while the job still pointed at the first
//      result, leaving the two records describing different objects.

import { assertFailureCode } from './failure-codes.mjs';

/**
 * Install `attempt` as the authoritative result for its job, if and only if
 * the attempt belongs to that job, has not already completed, the parser
 * reported `completed`, and the upload reached the dispatch lifecycle.
 * Exactly one eligible attempt may be installed as the job result.
 *
 * @returns {{recorded: boolean, won: boolean}}
 *   `recorded` false means the attempt did not belong to this job, or had
 *   already completed (a duplicate report). `won` false means the attempt
 *   completed truthfully but lost the race -- a NORMAL outcome, not an
 *   error: its result object stays at its own execution key and is removed
 *   later by retention.
 */
export async function acceptAttempt(
  db,
  {
    jobId, attemptId, status, resultUri, resultDigest,
    compactResultUri, compactResultDigest, compactResultBytes,
    pages, resultCreatedAt, requiresCompact = true,
  },
) {
  if (status !== 'completed') {
    throw new TypeError('status must equal completed before an attempt can be accepted');
  }
  const createdAt = resultCreatedAt instanceof Date
    ? resultCreatedAt
    : new Date(resultCreatedAt);
  if (Number.isNaN(createdAt.getTime())) {
    throw new TypeError('resultCreatedAt must be a valid R2 LastModified timestamp');
  }
  if (requiresCompact && (typeof compactResultUri !== 'string' || !compactResultUri
      || !/^[0-9a-f]{64}$/.test(compactResultDigest)
      || !Number.isSafeInteger(compactResultBytes) || compactResultBytes < 1
      || compactResultBytes > 128 * 1024 * 1024)) {
    throw new TypeError('a valid compact result companion is required');
  }
  const { rows } = await db.query(
    `WITH owned AS (
       UPDATE job_attempts a
          SET state = 'succeeded', result_uri = $3, result_digest = $4,
              compact_result_uri = $8, compact_result_digest = $9,
              compact_result_bytes = $10::bigint,
              pages = $5::integer, completed_at = now()
         FROM jobs source_job
        WHERE a.id = $2 AND a.job_id = $1 AND a.completed_at IS NULL
          AND source_job.id = a.job_id
          -- Record a late execution truthfully after another attempt won or
          -- the job failed, but never complete work for an upload that was
          -- not finalized into the dispatch lifecycle.
          AND source_job.state IN ('queued', 'dispatched', 'succeeded', 'failed')
          AND $6::text = 'completed'
          AND (a.requires_compact = false OR (
            $8::text IS NOT NULL AND $9::text IS NOT NULL AND $10::bigint IS NOT NULL
          ))
       RETURNING a.id, a.job_id
     ),
     won AS (
       UPDATE jobs j
          SET accepted_attempt_id   = owned.id,
              result_uri            = $3,
              result_digest         = $4,
              compact_result_uri    = $8,
              compact_result_digest = $9,
              compact_result_bytes  = $10::bigint,
              pages_actual          = $5::integer,
              -- $5 is cast on both uses: Postgres otherwise tries to infer
              -- one type for a parameter appearing as both an integer
              -- column and a bigint multiplicand, and refuses.
              estimated_cost_micros = j.unit_price_micros * $5::bigint,
              state                 = 'succeeded',
              error                 = NULL,
              completed_at          = now(),
              -- Anchor API access to R2's lifecycle clock, not to when a
              -- delayed reconciler happened to observe the completion.
              retention_expires_at  = $7::timestamptz + interval '2 days'
         FROM owned
        WHERE j.id = owned.job_id
          AND j.accepted_attempt_id IS NULL
          -- A terminal job stays terminal. See the migration's note: a
          -- late success must not resurrect a job a client has already
          -- seen fail and may have resubmitted or reported onward.
          AND j.state IN ('queued', 'dispatched')
       RETURNING j.id
     )
     SELECT (SELECT count(*) FROM owned) AS recorded,
            (SELECT count(*) FROM won)   AS won`,
    [
      jobId, attemptId, resultUri, resultDigest, pages, status, createdAt.toISOString(),
      compactResultUri, compactResultDigest, compactResultBytes,
    ],
  );

  return { recorded: Number(rows[0].recorded) === 1, won: Number(rows[0].won) === 1 };
}

/**
 * Record a failed attempt, and fail the JOB only when nothing else could
 * still produce a result.
 *
 * @returns {{recorded: boolean, jobFailed: boolean}}
 */
export async function failAttempt(
  db, { jobId, attemptId, error, failureCode = 'processing_failed' },
) {
  assertFailureCode(failureCode);
  const { rows } = await db.query(
    `WITH owned AS (
       SELECT id FROM job_attempts WHERE id = $2 AND job_id = $1
     ),
     recorded AS (
       UPDATE job_attempts a
          SET state = 'failed', error = $3, failure_code = $4,
              completed_at = now()
         FROM owned
        WHERE a.id = owned.id AND a.completed_at IS NULL
       RETURNING a.id
     )
     SELECT EXISTS (SELECT 1 FROM owned)    AS owned,
            EXISTS (SELECT 1 FROM recorded) AS recorded`,
    [jobId, attemptId, error, failureCode],
  );

  // A mismatched id pair must not even trigger derived-state settlement on
  // the supplied job; otherwise it could stamp a foreign error onto an
  // independently exhausted job.
  if (!rows[0].owned) return { recorded: false, jobFailed: false };

  // Always settle, including after a duplicate report. A previous process
  // may have recorded this attempt and died before deriving the job state.
  const jobFailed = await settleExhaustedJob(db, { jobId, error, failureCode });
  return { recorded: rows[0].recorded, jobFailed };
}

/**
 * Fail a job when every one of its attempts is definitively failed.
 *
 * This is deliberately independent and idempotent. `failAttempt` invokes it
 * immediately, and the reconciler invokes it again for dispatched jobs. That
 * makes a crash after recording an attempt failure recoverable without locks
 * or a transaction framework.
 */
// Known, accepted imprecision: when several attempts failed for different
// reasons, the job keeps whichever error belonged to the caller that won the
// settle. The job-level `error` is a summary, not a transcript -- per-attempt
// errors stay on their own rows.
export async function settleExhaustedJob(
  db, { jobId, error, failureCode = 'processing_failed' },
) {
  assertFailureCode(failureCode);
  const { rowCount } = await db.query(
    `UPDATE jobs j
        SET state = 'failed', error = $2, failure_code = $3,
            completed_at = now()
      WHERE j.id = $1
        AND j.state IN ('queued','dispatched')
        AND j.accepted_attempt_id IS NULL
        -- Do not fail an empty job merely because it has no open attempts.
        AND EXISTS (
              SELECT 1 FROM job_attempts a WHERE a.job_id = j.id
            )
        -- dispatch_unknown remains non-failed until the reconciler's bounded
        -- wait expires AND R2 has been checked. Only then may it be changed to
        -- failed and permit this settlement.
        AND NOT EXISTS (
              SELECT 1 FROM job_attempts a
               WHERE a.job_id = j.id AND a.state <> 'failed'
            )`,
    [jobId, error, failureCode],
  );
  return rowCount === 1;
}

/**
 * Record that a spawn reached Modal and its call id landed.
 */
export async function markDispatched(db, { jobId, attemptId, modalCallId }) {
  if (typeof modalCallId !== 'string' || modalCallId.trim() === '') {
    throw new TypeError('modalCallId must be a non-empty string');
  }
  const { rows } = await db.query(
    `WITH marked AS (
       UPDATE job_attempts
          SET state = 'dispatched', modal_call_id = $3, dispatched_at = now()
        WHERE id = $2 AND job_id = $1
          AND state IN ('dispatching','dispatch_unknown')
          AND completed_at IS NULL
          AND $3::text IS NOT NULL AND btrim($3::text) <> ''
       RETURNING job_id
     ), job_state AS (
       UPDATE jobs j SET state = 'dispatched'
         FROM marked
        WHERE j.id = marked.job_id AND j.state = 'queued'
       RETURNING j.id
     )
     SELECT EXISTS (SELECT 1 FROM marked) AS recorded`,
    [jobId, attemptId, modalCallId],
  );
  return rows[0].recorded;
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

-- M1 dispatcher/reconciler invariants. Migration 001 is sealed; add new
-- constraints here rather than editing its recorded checksum.

ALTER TABLE jobs
  ADD CONSTRAINT jobs_upload_window_bounded
  CHECK (
    upload_expires_at > created_at
    AND upload_expires_at <= created_at + interval '1 hour'
  );

ALTER TABLE jobs
  ADD CONSTRAINT jobs_succeeded_has_retention
  CHECK (state <> 'succeeded' OR retention_expires_at IS NOT NULL);

-- A dispatch_unknown attempt may cause exactly one replacement attempt.
-- The ownership-bound composite FK makes a cross-job replacement
-- unrepresentable, matching the accepted-attempt boundary in migration 001.
ALTER TABLE job_attempts ADD COLUMN replaces_attempt_id uuid;

ALTER TABLE job_attempts
  ADD CONSTRAINT job_attempts_replaces_same_job
  FOREIGN KEY (replaces_attempt_id, job_id)
  REFERENCES job_attempts(id, job_id);

CREATE UNIQUE INDEX job_attempts_one_replacement
  ON job_attempts(replaces_attempt_id)
  WHERE replaces_attempt_id IS NOT NULL;

-- Retried API requests must not create two independent first attempts while
-- the job is still queued. Any later attempt must explicitly replace the one
-- dispatch whose outcome is unknown.
CREATE UNIQUE INDEX job_attempts_one_initial
  ON job_attempts(job_id)
  WHERE replaces_attempt_id IS NULL;

CREATE INDEX job_attempts_reconcile_open
  ON job_attempts(created_at, id)
  WHERE state IN ('dispatching','dispatch_unknown','dispatched');

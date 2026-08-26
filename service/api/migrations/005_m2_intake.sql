-- M2 public intake: typed failures and exact admission indexes.
--
-- Raw error text is operator detail. Public responses project only from the
-- closed failure_code vocabulary, so a restart never has to parse an
-- exception message to reconstruct API state.
--
-- Correction to the historical comment in 001: dispatch_unknown is bounded,
-- but remains harvestable until the job deadline. It is not terminal for the
-- attempt because a late original execution may be the only successful one.

ALTER TABLE jobs ADD COLUMN failure_code text;
ALTER TABLE job_attempts ADD COLUMN failure_code text;

UPDATE jobs SET failure_code = 'processing_failed' WHERE state = 'failed';
UPDATE job_attempts SET failure_code = 'processing_failed' WHERE state = 'failed';

ALTER TABLE jobs
  ADD CONSTRAINT jobs_failure_code_known
  CHECK (failure_code IS NULL OR failure_code IN (
    'upload_expired', 'invalid_upload', 'input_digest_mismatch',
    'input_too_large', 'invalid_pdf', 'page_limit_exceeded',
    'processing_deadline_exceeded', 'dispatch_failed', 'processing_failed'
  )),
  ADD CONSTRAINT jobs_failed_has_code
  CHECK ((state = 'failed') = (failure_code IS NOT NULL)),
  ADD CONSTRAINT jobs_succeeded_has_accepted_result
  CHECK (
    state <> 'succeeded'
    OR (
      accepted_attempt_id IS NOT NULL
      AND result_uri IS NOT NULL
      AND result_digest ~ '^[0-9a-f]{64}$'
      AND pages_actual IS NOT NULL
      AND completed_at IS NOT NULL
      AND retention_expires_at IS NOT NULL
    )
  );

ALTER TABLE job_attempts
  ADD CONSTRAINT job_attempts_failure_code_known
  CHECK (failure_code IS NULL OR failure_code IN (
    'upload_expired', 'invalid_upload', 'input_digest_mismatch',
    'input_too_large', 'invalid_pdf', 'page_limit_exceeded',
    'processing_deadline_exceeded', 'dispatch_failed', 'processing_failed'
  )),
  ADD CONSTRAINT job_attempts_failed_has_code
  CHECK ((state = 'failed') = (failure_code IS NOT NULL));

ALTER TABLE users
  ADD CONSTRAINT users_email_canonical
  CHECK (email = lower(btrim(email)) AND email <> '');

DROP INDEX jobs_active;

CREATE INDEX jobs_active_global ON jobs(id)
  WHERE state IN ('uploading','queued','dispatched');

CREATE INDEX jobs_active_user ON jobs(user_id, id)
  WHERE state IN ('uploading','queued','dispatched');

CREATE INDEX jobs_dispatch_queued ON jobs(queued_at, id)
  WHERE state = 'queued' AND accepted_attempt_id IS NULL;

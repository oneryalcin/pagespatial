-- A dispatched attempt must be recoverable by its Modal call id. Terminal
-- attempts may legitimately have no call id when an execution is recovered
-- from R2 after dispatch_unknown.

ALTER TABLE job_attempts
  ADD CONSTRAINT job_attempts_modal_call_id_nonblank
  CHECK (modal_call_id IS NULL OR btrim(modal_call_id) <> '');

ALTER TABLE job_attempts
  ADD CONSTRAINT job_attempts_dispatched_has_call_id
  CHECK (state <> 'dispatched' OR modal_call_id IS NOT NULL);

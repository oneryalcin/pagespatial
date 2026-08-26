-- Every open attempt must eventually get a turn, even when an older attempt
-- remains pending. The reconciler moves each processed row's due time forward
-- instead of repeatedly selecting the same oldest LIMIT-sized prefix.
ALTER TABLE job_attempts
  ADD COLUMN reconcile_after timestamptz NOT NULL DEFAULT now();

DROP INDEX job_attempts_reconcile_open;

CREATE INDEX job_attempts_reconcile_due
  ON job_attempts(reconcile_after, id)
  WHERE state IN ('dispatching','dispatch_unknown','dispatched');


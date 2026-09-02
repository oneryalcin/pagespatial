-- A successful result is an immutable evidence/compact pair. Existing rows
-- remain valid during the retention-window rollout; all new acceptances write
-- the three compact fields atomically with the existing evidence fields.

ALTER TABLE jobs
  ADD COLUMN compact_result_uri text,
  ADD COLUMN compact_result_digest text,
  ADD COLUMN compact_result_bytes bigint,
  ADD CONSTRAINT jobs_compact_result_complete CHECK (
    (compact_result_uri IS NULL AND compact_result_digest IS NULL AND compact_result_bytes IS NULL)
    OR
    (compact_result_uri IS NOT NULL AND compact_result_digest IS NOT NULL AND compact_result_bytes IS NOT NULL)
  ),
  ADD CONSTRAINT jobs_compact_result_digest_valid CHECK (
    compact_result_digest IS NULL OR compact_result_digest ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT jobs_compact_result_bytes_bounded CHECK (
    compact_result_bytes IS NULL OR compact_result_bytes BETWEEN 1 AND 134217728
  );

ALTER TABLE job_attempts
  ADD COLUMN requires_compact boolean,
  ADD COLUMN compact_result_uri text,
  ADD COLUMN compact_result_digest text,
  ADD COLUMN compact_result_bytes bigint,
  ADD CONSTRAINT job_attempts_compact_result_complete CHECK (
    (compact_result_uri IS NULL AND compact_result_digest IS NULL AND compact_result_bytes IS NULL)
    OR
    (compact_result_uri IS NOT NULL AND compact_result_digest IS NOT NULL AND compact_result_bytes IS NOT NULL)
  ),
  ADD CONSTRAINT job_attempts_compact_result_digest_valid CHECK (
    compact_result_digest IS NULL OR compact_result_digest ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT job_attempts_compact_result_bytes_bounded CHECK (
    compact_result_bytes IS NULL OR compact_result_bytes BETWEEN 1 AND 134217728
  );

-- Attempts dispatched by the previous worker contract must remain harvestable.
-- The migration runner holds its advisory lock while this backfill and default
-- switch occur, so each attempt is unambiguously legacy or pair-required.
UPDATE job_attempts SET requires_compact = false;
ALTER TABLE job_attempts ALTER COLUMN requires_compact SET DEFAULT true;
ALTER TABLE job_attempts ALTER COLUMN requires_compact SET NOT NULL;

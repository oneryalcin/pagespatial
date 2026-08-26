-- M1 job plane: the ledger and the adjudication record.
--
-- Modal owns the execution queue and the autoscaler. These tables own job
-- IDENTITY, TENANCY and ADJUDICATION -- which attempt's result is the
-- authoritative one. They are deliberately NOT a work queue: the #105
-- pull-worker design was withdrawn because a scale-to-zero worker cannot
-- poll for work (docs/design/2026-08-26-service-control-plane.md).

CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL UNIQUE,
  status      text NOT NULL DEFAULT 'invited'
              CHECK (status IN ('invited', 'active', 'suspended')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  prefix        text NOT NULL UNIQUE,   -- shown in the dashboard; never secret
  hash          text NOT NULL,          -- SHA-256 of the key. NOT bcrypt: the key is
                                        -- 256 bits of generated entropy, so a slow
                                        -- hash defends nothing and would be a
                                        -- per-request DoS vector.
  name          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
CREATE INDEX api_keys_user ON api_keys(user_id) WHERE revoked_at IS NULL;

CREATE TABLE jobs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES users(id),
  idempotency_key       text,

  -- 'dispatched', never 'running': .spawn() only enqueues, and a call may
  -- sit in Modal's queue with nothing executing. Claiming 'running' would
  -- assert something the control plane cannot observe.
  state                 text NOT NULL DEFAULT 'uploading'
                        CHECK (state IN ('uploading','queued','dispatched','succeeded','failed')),

  input_uri             text NOT NULL,
  -- REQUIRED at submit. The service never witnesses the uploaded bytes
  -- (presigned PUTs are signed UNSIGNED-PAYLOAD), so finalize can only
  -- check existence and size. The WORKER is the digest gate.
  input_digest          text NOT NULL CHECK (input_digest ~ '^[0-9a-f]{64}$'),
  input_bytes           bigint CHECK (input_bytes > 0 AND input_bytes <= 94371840),
  -- 90 MiB, matching the qualified MAX_INPUT_BYTES.

  pages_actual          integer CHECK (pages_actual >= 0),
  -- Stamped at CREATION, not at render time: the rate in force when the
  -- user submitted. Changing the config rate must never rewrite history.
  unit_price_micros     bigint NOT NULL,
  estimated_cost_micros bigint,  -- unit_price_micros * pages_actual, at completion

  accepted_attempt_id   uuid,
  result_uri            text,
  result_digest         text,
  error                 text,

  created_at            timestamptz NOT NULL DEFAULT now(),
  queued_at             timestamptz,
  completed_at          timestamptz,
  -- Two deadlines, never one overloaded column: an upload deadline and a
  -- retention deadline mean different things, and conflating them invites
  -- a sweeper that deletes live jobs.
  upload_expires_at     timestamptz NOT NULL,
  retention_expires_at  timestamptz
);

-- A replay of the same key returns the original job; a replay carrying a
-- DIFFERENT body is a client bug and must 422 (enforced in the API).
CREATE UNIQUE INDEX jobs_idempotency ON jobs(user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX jobs_user_recent ON jobs(user_id, created_at DESC);
CREATE INDEX jobs_sweep_uploading ON jobs(upload_expires_at) WHERE state = 'uploading';
CREATE INDEX jobs_active ON jobs(state) WHERE state IN ('queued','dispatched');

CREATE TABLE job_attempts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id         uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  modal_call_id  text,

  -- 'dispatch_unknown' is TERMINAL for this attempt. The API cannot commit
  -- Postgres and spawn a Modal call atomically, so a crash in between
  -- leaves an attempt whose call id never landed. The reconciler mints a
  -- NEW attempt rather than re-spawning this one: reusing the id would
  -- point two Modal calls at one result prefix and destroy the very
  -- property the execution-key scheme exists to provide.
  state          text NOT NULL DEFAULT 'dispatching'
                 CHECK (state IN ('dispatching','dispatch_unknown','dispatched','succeeded','failed')),

  result_uri     text,
  result_digest  text,
  pages          integer,
  dispatched_at  timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz,
  error          text
);

CREATE INDEX job_attempts_job ON job_attempts(job_id);
CREATE INDEX job_attempts_open ON job_attempts(state)
  WHERE state IN ('dispatching','dispatch_unknown','dispatched');

ALTER TABLE jobs ADD CONSTRAINT jobs_accepted_attempt
  FOREIGN KEY (accepted_attempt_id) REFERENCES job_attempts(id);

-- The accepted result is installed by ONE conditional update:
--
--   UPDATE jobs SET accepted_attempt_id = $1, ...
--    WHERE id = $2 AND accepted_attempt_id IS NULL;
--
-- First writer wins, adjudicated by the database rather than by
-- application logic that reads then writes. Two consequences, both
-- deliberate and neither accidental:
--
--   1. The accepted result is NOT REPRODUCIBLE. Two attempts parse the
--      same bytes, but this engine's output is not bit-stable across
--      containers (~+/-4 gold tokens, sidecar adoption ceremony). Both
--      results are valid and either may win, so nothing may "verify by
--      re-parsing" against result_digest -- that check would fail
--      legitimately.
--   2. A late attempt CAN flip a job from 'failed' to 'succeeded' after
--      the user has already seen 'failed'. That is the better outcome and
--      is chosen on purpose; the alternative (AND state <> 'failed')
--      would leave a good result orphaned in storage.

-- Alpha self-signup and page credits.
--
-- Credits are pages, not money. Grants are append-only; succeeded jobs spend
-- their actual page count, while active jobs reserve their enforced page
-- limit. This keeps admission exact without a mutable balance row.

CREATE TABLE credit_grants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pages       integer NOT NULL CHECK (pages > 0),
  source      text NOT NULL CHECK (source IN ('trial', 'manual')),
  reference   text NOT NULL,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, reference)
);
CREATE INDEX credit_grants_user ON credit_grants(user_id, created_at DESC);

CREATE TABLE credit_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'approved', 'declined')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz,
  CHECK ((status = 'pending') = (resolved_at IS NULL))
);
CREATE UNIQUE INDEX credit_requests_one_pending
  ON credit_requests(user_id) WHERE status = 'pending';

ALTER TABLE jobs ADD COLUMN reserved_pages integer;
UPDATE jobs
   SET reserved_pages = CASE
     WHEN pages_actual BETWEEN 1 AND 200 THEN pages_actual
     ELSE 200
   END;
ALTER TABLE jobs
  ALTER COLUMN reserved_pages SET NOT NULL,
  ALTER COLUMN reserved_pages SET DEFAULT 200,
  ADD CONSTRAINT jobs_reserved_pages_bounded
    CHECK (reserved_pages BETWEEN 1 AND 200),
  ADD CONSTRAINT jobs_succeeded_within_reservation
    CHECK (state <> 'succeeded' OR pages_actual <= reserved_pages);

-- Existing accounts begin this era with the full trial allowance remaining;
-- historical succeeded pages are included in the migration grant so they do
-- not consume a policy that did not exist when those jobs ran.
INSERT INTO credit_grants (user_id, pages, source, reference, note)
SELECT u.id,
       100 + coalesce(sum(j.pages_actual) FILTER (WHERE j.state = 'succeeded'), 0)::integer,
       'trial',
       'alpha-trial-v1',
       'Initial alpha allowance; historical usage excluded'
  FROM users u
  LEFT JOIN jobs j ON j.user_id = u.id
 GROUP BY u.id;

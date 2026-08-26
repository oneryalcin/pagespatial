# Contract: M2 public intake, identity, and admission

**Status:** proposed for one cold review; implementation has not started  
**Parent design:** `docs/design/2026-08-26-service-control-plane.md`  
**Issues:** #76 and #87  
**Baseline:** M1 job plane through PR #109 (`c54e813`)

## Purpose

M1 proved the difficult execution path: Postgres identity, Modal dispatch,
immutable R2 results, at-least-once recovery, and one authoritative result.
M2 gives that path a small public front door.

This document is an HTTP and security contract. It does not redesign the
architecture. Modal remains the execution queue and autoscaler. Postgres
remains the ledger and adjudicator. R2 remains the byte store.

## Non-goals

- no second queue, worker lease protocol, or compute-provider abstraction;
- no SPA, organizations, teams, SSO, Stripe, webhooks, or user cancellation;
- no enrichment for external callers;
- no progressive page, SVG, or cursor endpoints;
- no browser PDF-upload page in M2; API clients hash and upload;
- no attempt to provide a processing ETA.

## Fixed deployment shape

```text
Browser ── Access ── app.<domain> ──┐
                                    ├── one Node API ── managed Postgres
API client ── API key ─ api.<domain>┘       │
                                             ├── R2 input/results buckets
                                             └── Modal .spawn()
```

Both hostnames reach the same Node process through one remotely managed
Cloudflare Tunnel. The origin has no public inbound port. A single VPS and
tunnel connector are sufficient for the invite-only v1; this makes no HA
claim. A second connector on the same VPS would not remove the VPS failure
domain.

Route families are bound to an exact configured hostname. Dashboard routes
exist only on `app.<domain>`; API routes exist only on `api.<domain>`. Reject
an unknown `Host` with `421 Misdirected Request`.

## Invariants

1. The API never receives PDF bytes. It signs one-object R2 operations.
2. A job is not dispatchable until finalize observes the input object and its
   size is within 90 MiB.
3. The worker, not finalize, is the SHA-256 authority.
4. Every job lookup is scoped by the authenticated `user_id`; a foreign id is
   indistinguishable from a missing id.
5. One idempotency key creates at most one job for one user.
6. A returned object or Modal value is not success until its status, identity,
   schema, digest, and size are validated.
7. Public status does not invent a `running` state or an ETA.
8. Presigned URLs are bearer credentials. They authorize one operation on one
   object and have short, bounded lifetimes.
9. No database transaction spans R2, Modal, or another network call.
10. A committed `queued` job always has a retryable path to dispatch after an
    API crash.

## Authentication boundaries

### Dashboard identity

Cloudflare Access protects `app.<domain>` with one-time PIN login restricted
to invited email addresses. The origin still verifies the
`Cf-Access-Jwt-Assertion` JWT using Cloudflare's remote JWKS, the configured
issuer, and the application AUD. It never trusts
`Cf-Access-Authenticated-User-Email`.

Use `jose` and a cached remote JWK set. Key rotation is handled by JWKS lookup;
do not pin a leaf signing key in `.env`.

The JWT email is trimmed and converted to lowercase before lookup. M2 adds a
database constraint and unique index that make canonical lowercase email
identity unambiguous. The first valid login changes `invited` to `active`;
`active` remains valid and `suspended` is rejected. A valid Access identity
without a matching row receives `403`.

State-changing dashboard requests require an exact
`Origin: https://app.<domain>` match. Cloudflare Access does not remove CSRF.

### API identity

`api.<domain>` is not Access-protected. It accepts only:

```http
Authorization: Bearer ps_live_<secret>
```

The secret contains 32 cryptographically random bytes encoded as base64url
without padding. Store only SHA-256 plus an eight-character clear prefix. Look
up by prefix, compare the full digest with `timingSafeEqual`, and reject
revoked keys or suspended users. A key never appears in a URL, log, or error
message.

Authentication failures return `401` with `WWW-Authenticate: Bearer`.
Authorization failures do not reveal another tenant's resource.

### Minimal key bootstrap

M2 includes only the UI needed to bootstrap machine access:

- `GET /keys` — list name, prefix, created time, last-used time, revoked time;
- `POST /keys` — create a named key and show plaintext exactly once;
- `POST /keys/:id/revoke` — idempotently revoke an owned key.

These routes require the verified Access JWT and exact Origin on mutations.
The jobs, usage, and account pages remain M3.

## Public data containers

Names below describe the wire format. Implementation may use plain frozen
objects plus validators; a TypeScript conversion is not required.

```text
JobState = uploading | queued | dispatched | succeeded | failed

JobView = {
  id: UUID,
  state: JobState,
  processing_profile: "parse-v1",
  input_sha256: lowercase-hex-64,
  input_bytes: integer | null,
  pages: integer | null,
  estimated_cost_micros: integer | null,
  created_at: RFC3339,
  queued_at: RFC3339 | null,
  completed_at: RFC3339 | null,
  processing_deadline_at: RFC3339 | null,
  retention_expires_at: RFC3339 | null,
  outcome_uncertain: boolean,
  error: { code: string, message: string } | null
}

UploadGrant = {
  method: "PUT",
  url: string,
  expires_at: RFC3339,
  headers: { "content-type": "application/pdf" }
}

ErrorResponse = {
  error: {
    code: string,
    message: string,
    request_id: UUID
  }
}
```

All API responses include `X-Request-Id`. Unknown request fields are rejected.
Unknown response fields must be ignored by clients.

`processing_deadline_at` is derived as `queued_at + 24 hours`; it is not a
new column. `outcome_uncertain` is also derived, not a database state. It is
true when an attempt is `dispatch_unknown`, or when an attempt remains
`dispatching` beyond the reconciler's ten-minute uncertainty wait. This
distinguishes “the authoritative outcome is unknown” from a claim that a
container is running.

## API contract

Every `/v1` route requires an API key. Every job query includes both job id
and authenticated user id in one accessor. Cross-tenant access returns `404`.

### `POST /v1/jobs`

Required headers:

```http
Authorization: Bearer ...
Idempotency-Key: <1..128 visible ASCII characters>
Content-Type: application/json
```

Request:

```json
{
  "input_sha256": "64 lowercase hexadecimal characters"
}
```

M2 has one fixed processing profile, `parse-v1`, so no profile selector is
accepted. The idempotency fingerprint is therefore the input SHA-256. Add a
stored profile to the fingerprint only when a second caller-selectable profile
exists.

The client computes SHA-256 before submission. M2 does not hide that cost:
CLI clients read the file once to hash and once to upload. A future browser
uploader may use a streaming hash implementation if measurement justifies it.

New job response: `201 Created` with `JobView` and `UploadGrant`. The input key
is `inputs/{job_id}.pdf`; it is not returned separately.

Replay rules:

- same user, key, and digest: `200` with the original job;
- if the original is still `uploading` and before `upload_expires_at`, include
  a newly signed PUT whose expiry does not exceed that original deadline;
- if the original is terminal, return that terminal job;
- same user and key with a different digest: `422 idempotency_mismatch`;
- never create a replacement job for a reused key.

### Direct R2 upload

The client performs the signed `PUT` with the exact `Content-Type` header from
`UploadGrant`. The URL can be replayed until it expires; integrity therefore
comes from the worker's digest check, not from uniqueness of the PUT.

The input bucket is private and has the two-day lifecycle rule required by the
parent design. Browser callers additionally require an explicit R2 CORS rule
for `https://app.<domain>`; M2 has no browser uploader, so this rule is not a
release prerequisite yet.

### `POST /v1/jobs/:id/finalize`

Request body is empty. Finalize reads the object with the control-plane input
credential and checks:

- the owned job exists and is `uploading`;
- `upload_expires_at` is still in the future;
- the exact input object exists;
- `Content-Length` is from 1 byte through 90 MiB;
- stored `Content-Type` is `application/pdf`.

Finalize cannot verify SHA-256 and must not claim to. On success, one database
transaction records `input_bytes`, `queued_at`, and `state='queued'`.

Responses:

- `202` — newly queued, or already queued/dispatched;
- `200` — already terminal; return the terminal job without resurrection;
- `409 upload_incomplete` — object not yet visible; retry within the window;
- `410 upload_expired` — upload deadline passed;
- `413 input_too_large` — object exceeds 90 MiB and the job becomes `failed`;
- `422 invalid_upload` — zero bytes or wrong content type and the job becomes
  `failed`.

Repeated finalize is idempotent. It never dispatches inside its database
transaction.

### Dispatch after finalize

After commit, finalize may request an immediate best-effort dispatch, but
correctness cannot depend on that call. A process crash can occur after
`state='queued'` commits and before `dispatchJob()` begins.

Therefore the API process runs a bounded queued-job sweep:

1. select at most 32 `queued` jobs with no initial attempt, oldest first;
2. call the existing `dispatchJob()` for each;
3. rely on the database's one-initial-attempt constraint to resolve replica
   races;
4. isolate errors per job and retry on the next sweep.

Run it at startup and every five seconds. Do not hold a database transaction
or advisory lock while calling Modal. A crash after attempt creation is
already handled by M1's `dispatching`/`dispatch_unknown` reconciler path.

This sweep starts work; it is not another queue. Modal still owns queued
execution and autoscaling.

### `GET /v1/jobs/:id`

Returns `200 JobView`. It never claims `running` because Modal `.spawn()` only
proves enqueue. It provides no ETA.

For terminal failure, expose a stable public error code and safe message.
Attempt rows and raw Modal/R2 exception strings remain operator data.

### `GET /v1/jobs/:id/result`

Only a tenant-owned `succeeded` job with an accepted result and
`now < retention_expires_at` can receive a URL.

Response `200`:

```json
{
  "schema_version": 1,
  "download_url": "https://...",
  "expires_at": "RFC3339",
  "content_type": "application/json"
}
```

The GET URL lasts five minutes or until `retention_expires_at`, whichever is
sooner. It authorizes only the accepted R2 object. Treat it as a bearer token
and never log its query string.

Uploading, queued, or dispatched jobs use `409 result_not_ready`; a failed job
uses `409 job_failed`; an expired accepted result uses `410 result_expired`;
a foreign id uses `404`.

## Public result format

M2 deliberately returns the existing validated envelope directly from R2:

```text
ResultEnvelopeV1 = {
  schema_version: 1,
  job_id: UUID,
  attempt_id: UUID,
  execution_id: lowercase-hex-32,
  input_key: string,
  input_sha256: lowercase-hex-64,
  parse_result: PageSpatialParseResult
}
```

This is a public, versioned provenance envelope, not an accidental leak.

- `schema_version`, `job_id`, `input_sha256`, and `parse_result` are stable v1
  fields.
- `attempt_id`, `execution_id`, and `input_key` are opaque provenance. They
  reveal retry identity and a private naming convention, but grant no bucket
  access.
- Clients must ignore unknown top-level fields.
- The presigned URL grants access only to this object.

Returning only `parse_result` would require proxying up to 128 MiB through the
VPS or publishing and retaining a second transformed object. Hiding harmless
opaque identifiers does not justify either path.

## Admission control

Active jobs are `uploading`, `queued`, and `dispatched`. Uploading counts: it
has already consumed a job identity and an R2 write grant.

Initial limits:

- five active jobs per user;
- 100 active jobs globally;
- `429 admission_limit` with `Retry-After: 60` when either limit is reached.

The global value is derived, not guessed. The one-container qualification
measured 0.599 terminal pages/s. With a 24-hour deadline, 200-page maximum,
and 50% safety factor:

```text
floor(86,400 seconds × 0.599 pages/s × 0.50 / 200 pages/job)
= 129 jobs
```

Round down to 100. At the all-maximum-pages extreme, the qualified rate drains
100 jobs in about 9.3 hours, leaving roughly 14.7 hours for cold start,
retries, shared-host variance, and recovery. This is an overload fuse, not a
throughput promise. Deployment startup refuses a configured cap above the
derived bound for its qualified `max_containers` setting unless a new measured
rate updates the bound.

Admission is one short Postgres transaction on one checked-out `pg.PoolClient`:

```text
BEGIN
SET LOCAL statement_timeout = '5s'
SELECT pg_advisory_xact_lock(<fixed admission lock id>)
recheck idempotency
count global active jobs
count this user's active jobs
insert uploading job or choose 429
COMMIT
release PoolClient
```

One fixed transaction-scoped lock is enough because it serializes the only
operation that can create active jobs; both limits are then exact. It is held
for database work only. Presigning happens after commit. Do not use
session-scoped `pg_advisory_lock`, and do not issue `BEGIN` through
`pool.query()`.

The idempotency check occurs before admission rejection. A replay returns its
existing job even when the service is currently full.

M2 adds a partial `(user_id)` index for active jobs. The existing state-only
partial index supports the global count; the new index keeps the per-user
count bounded without scanning that user's history.

## R2 credentials

Keep four narrow roles, all outside source control:

| holder | input bucket | results bucket |
|---|---|---|
| Modal input credential | read | none |
| Modal result credential | none | read/write |
| API input credential | read/write for HEAD and presigned PUT | none |
| API result credential | none | read for validation and presigned GET |

The results token cannot read or modify customer inputs. The input worker
token cannot overwrite inputs. M2's live gate repeats the denial probes; the
table is a required capability, not documentation-only intent.

Both dedicated buckets carry the two-day age-based lifecycle policy before a
real user is invited.

## Error rules

Public error codes are stable strings. Messages contain no SQL, Modal, R2,
bucket, attempt, execution, stack, or credential details.

Minimum codes:

```text
authentication_required
forbidden
not_found
invalid_request
idempotency_mismatch
admission_limit
upload_incomplete
upload_expired
input_too_large
invalid_upload
result_not_ready
job_failed
result_expired
service_unavailable
```

Unexpected dependency failures return `503 service_unavailable`, never a
permanent job transition unless the existing lifecycle logic proves one.

## Runtime and health

One Node process owns:

- the HTTP listener;
- a `pg.Pool` for requests;
- the five-second queued-job dispatch sweep;
- the existing reconciler interval, each pass using one checked-out client;
- graceful shutdown that stops accepting HTTP, stops timers, waits for the
  current bounded pass, then closes the pool.

`GET /health` is unauthenticated and returns no identifiers. Readiness requires
Postgres and both R2 roles to be reachable. Modal reachability is reported as
a separate degraded field because a transient Modal control-plane failure must
not prevent clients from reading existing job status or result URLs.

## Acceptance matrix

### Local and native-Postgres gates

1. New submit returns one job and one bounded PUT grant.
2. Same idempotency key and digest returns the same job in every lifecycle
   state, including terminal states.
3. Same key with another digest returns 422 and creates no row.
4. Concurrent same-key submissions on independent Postgres connections create
   one job.
5. Concurrent submissions cannot exceed five active jobs for one user or 100
   globally. This test uses native Postgres, not PGlite concurrency.
6. Admission replays succeed while the fuse is full.
7. Missing object remains retryable; expired, empty, wrong-type, and oversized
   uploads take the specified transitions.
8. Finalize is idempotent.
9. Kill the API after finalize commits but before immediate dispatch; the
   queued sweep creates exactly one initial attempt and the job completes.
10. Kill after attempt creation; the existing M1 uncertainty path recovers it.
11. A worker digest mismatch fails visibly and publishes no result.
12. `outcome_uncertain` appears only from the derived attempt condition and
    carries the 24-hour deadline.
13. Every job and key route gives user B 404 for user A's identifier.
14. Revoked keys, suspended users, malformed keys, query-string keys, and
    missing keys fail authentication.
15. A forged Access email header on `api.<domain>` cannot reach dashboard or
    key-management routes.
16. Access JWT validation checks signature, issuer, audience, expiry, and
    invited canonical email. JWKS rotation is exercised with two keys.
17. Dashboard mutations reject absent or foreign Origin.
18. Result URLs name only the accepted object, expire within five minutes,
    stop at retention expiry, and return the byte-identical validated public
    envelope.
19. Public errors and logs contain no presigned query string, key secret,
    bucket credential, or internal exception.

### Live M2 gate

Run one invited-user path through the actual Tunnel, Access, managed
Postgres, R2, and Modal deployment:

```text
Access login → create key → submit → PUT → finalize → queued sweep
→ Modal parse → reconcile → poll succeeded → GET public envelope
```

Also run: forged Access header, tenant-B 404, idempotent replay, admission
429, wrong digest, expired upload, result-expiry refusal, and the four R2
credential denial probes.

Do not call M2 complete from component tests alone.

## Implementation order

1. **M2.1 internal vertical slice:** submit, presign, finalize, queued sweep,
   status, result; use a seeded internal user and key.
2. **M2.2 identity:** key issue/revoke, API-key middleware, tenant accessors,
   idempotency, Access JWT verification, minimal key page.
3. **M2.3 overload:** exact admission transaction, 429, derived uncertainty,
   safe public errors and logs.
4. **M2.4 live deployment:** domain, Tunnel, Access policy, managed Postgres,
   R2 lifecycle rules, and the live gate.

M3 starts only after this path is live. M3 adds presentation, not another job
lifecycle.

## External references

- Cloudflare, [Validate JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- Cloudflare, [Publish a self-hosted application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)
- Cloudflare R2, [Presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- PostgreSQL, [Advisory locks](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS)
- PageSpatial, `docs/trials/2026-08-23-modal-qualification.md`

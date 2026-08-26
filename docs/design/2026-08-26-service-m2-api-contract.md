# Contract: M2 public intake, identity, and admission

**Status:** revised after cold review; implementation has not started
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
an unknown `Host` with `421 Misdirected Request`. A valid hostname with a route
from the other family returns `404`; in particular, `/keys` on
`api.<domain>` is not an authentication challenge and cannot reach dashboard
code.

## Invariants

1. The API never receives PDF bytes. It signs one-object R2 operations.
2. A job is not dispatchable until finalize observes the input object and its
   size is within 90 MiB.
3. The worker, not finalize, is the SHA-256 authority.
4. Every public job lookup is scoped by the authenticated `user_id`; a foreign
   id is indistinguishable from a missing id. Internal reconciliation may look
   up an attempt by id because it has no user request or public response.
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

M2 has no invitation admin UI. The owner invites the first and later users by
adding the canonical email to the Cloudflare Access allow policy and inserting
one `users(status='invited')` row with the migration-supplied operator command.
Removing either grant denies login. This manual two-step is acceptable for the
invite-only release and is exercised before the live gate.

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
The jobs, usage, and account pages remain M3. M2 does not invent a per-user key
quota before observed misuse or a product tier requires one.

These are server-rendered form routes, not a second JSON API. Their wire
contract is deliberately small:

```text
GET  /keys
  -> 200 text/html; charset=utf-8

POST /keys
  Content-Type: application/x-www-form-urlencoded
  body: name=<1..64 UTF-8 characters>
  -> 201 text/html; charset=utf-8 showing the secret once

POST /keys/:id/revoke
  Content-Type: application/x-www-form-urlencoded
  body: empty
  -> 303 Location: /keys

name = trimmed UTF-8 string, 1..64 characters
```

Unknown form fields are rejected. Form bodies are capped at 4 KiB. Every page
carries `Cache-Control: no-store`, `Content-Security-Policy: default-src
'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'`, and
HTML-escapes stored values. The plaintext secret appears only in the creation
response. Revoke returns `404` for a foreign id and is idempotent for an
already-revoked owned key.

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
  error: { code: string, message: string } | null
}

JobResponse = { job: JobView }

SubmitResponse = {
  job: JobView,
  upload: UploadGrant | null
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

ResultGrantResponse = {
  result: {
    schema_version: 1,
    download_url: string,
    expires_at: RFC3339,
    content_type: "application/json"
  }
}
```

All API responses include `X-Request-Id`. Unknown request fields are rejected.
Unknown response fields must be ignored by clients.

Every unsuccessful `/v1` response uses `ErrorResponse`; it never returns a
bare string, HTML, provider body, or stack. Dashboard form errors are escaped
HTML and follow the status codes specified above.

`processing_deadline_at` is derived as `queued_at + 24 hours`; it is not a
new column. Dispatch uncertainty stays operator telemetry. A client cannot act
on it differently from any other non-terminal job: it polls until terminal or
deadline. Do not expose reconciler attempt states as permanent public API.

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

New job response: `201 Created` with `SubmitResponse`. The input key is
`inputs/{job_id}.pdf`; it is not returned separately.

The upload/finalize window is exactly one hour from job creation:
`upload_expires_at = created_at + interval '1 hour'`. The presigned PUT expires
no later than that timestamp. The existing database constraint remains the
authority for the upper bound.

Replay rules:

- same user, key, and digest: `200 SubmitResponse` with the original job;
- if the original is still `uploading` and before `upload_expires_at`, include
  a newly signed PUT whose expiry does not exceed that original deadline;
- if the original is terminal, return that terminal job;
- same user and key with a different digest: `422 idempotency_mismatch`;
- never create a replacement job for a reused key.

If presigning fails after the uploading row commits, return
`503 service_unavailable`. A replay of the same idempotency key regenerates the
grant while the original upload window remains open; it does not create a
second job.

### Direct R2 upload

The client performs the signed `PUT` with the exact `Content-Type` header from
`UploadGrant`. The URL can be replayed until it expires; integrity therefore
comes from the worker's digest check, not from uniqueness of the PUT.

The input bucket is private and has the two-day lifecycle rule required by the
parent design. Browser callers additionally require an explicit R2 CORS rule
for `https://app.<domain>`; M2 has no browser uploader, so this rule is not a
release prerequisite yet.

### `POST /v1/jobs/:id/finalize`

The request body is the empty JSON object `{}`; any field is rejected.
Finalize reads the object with the control-plane input
credential and checks:

- the owned job exists and is `uploading`;
- `upload_expires_at` is still in the future;
- the exact input object exists;
- `Content-Length` is from 1 byte through 90 MiB;
- stored `Content-Type` is `application/pdf`.

Finalize cannot verify SHA-256 and must not claim to. On success, one database
transaction records `input_bytes`, `queued_at`, and `state='queued'`.

Responses:

- `202 JobResponse` — newly queued, or already queued/dispatched;
- `200 JobResponse` — already terminal; return the terminal job without
  resurrection;
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

1. select at most eight `queued` jobs with no initial attempt, oldest first;
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

Returns `200 JobResponse`. It never claims `running` because Modal `.spawn()`
only proves enqueue. It provides no ETA.

For terminal failure, expose a stable public error code and safe message.
Attempt rows and raw Modal/R2 exception strings remain operator data.

### `GET /v1/jobs/:id/result`

Only a tenant-owned `succeeded` job with an accepted result and
`now < retention_expires_at` can receive a URL.

Response `200 ResultGrantResponse`:

```json
{"result":{"schema_version":1,"download_url":"https://...","expires_at":"RFC3339","content_type":"application/json"}}
```

The GET URL lasts five minutes or until `retention_expires_at`, whichever is
sooner. It authorizes only the accepted R2 object. Treat it as a bearer token
and never log its query string.

Uploading, queued, or dispatched jobs use `409 result_not_ready`; a failed job
uses `409 job_failed`; an expired accepted result uses `410 result_expired`;
a foreign id uses `404`.

## Public result format

The current worker envelope is an internal diagnostic record. It includes
Modal call/input identifiers, image and adapter revisions, resource and timing
details, and raw exception messages on failed pages. It is not a public API.

Before its single R2 PUT, `parse_object` constructs and validates this closed
public projection:

```text
PublicResultEnvelopeV1 = {
  schema_version: 1,
  job_id: UUID,
  attempt_id: UUID,
  execution_id: lowercase-hex-32,
  input_sha256: lowercase-hex-64,
  page_count: integer,
  pages: PublicPageResult[]
}

PublicPageResult =
  | {
      page_number: positive integer,
      ok: true,
      page_spatial: PageSpatial
    }
  | {
      page_number: positive integer,
      ok: false,
      failure: {
        code: "page_failed",
        message: "Page could not be parsed."
      }
    }
}
```

`PageSpatial` is the canonical exported type and runtime schema in
`src/types.ts`; M2 does not duplicate it. The envelope and both page variants
reject additional fields. `page_count` is 1..200 and equals `pages.length`;
pages are ordered, contiguous, and numbered 1 through `page_count`; and a
successful entry's `page_spatial.pageNumber` equals its `page_number`. The
published PageSpatial schema validates every nested successful record.

M2 deliberately has one safe failed-page code. The current parser has no
proven typed, user-actionable taxonomy for render, OCR, decoding, and worker
failures. Inventing one from exception strings would be false precision.
Additional codes require typed failure sources plus a client action that
differs from “inspect the page or retry the document.”

`attempt_id` and `execution_id` are PageSpatial's opaque fencing provenance;
they are retained so the reconciler can bind bytes to the immutable R2 key.
They are not Modal function or input identifiers. The projection excludes the
operational timing, RSS measurements, exception classes, stack traces, and raw
exception messages.

The worker validates this projection before upload. The reconciler validates
the same exact schema, key identity, job/attempt/execution identity, digest,
and size before acceptance. A failed parse returns no pointer and uploads no
public object. Failed pages inside an otherwise completed document use only
the stable safe failure above.

This remains one object and one presigned download. There is no VPS result
proxy and no second transformed object. M2.1 must compare the successful
`page_spatial` values against `parse_document` with the existing stable
comparator and derived control tolerance; transport success alone is not
qualification.

This intentionally couples the public result schema to the Modal worker: a
format change requires a worker deploy, and old schema-versioned objects can
coexist for at most their two-day retention window. M2.1 changes both
`deploy/modal/modal_app.py` and `service/api/src/result-contract.mjs`, then adds
a dated supersession note to
`docs/trials/2026-08-26-service-m1-object-qualification.md`. The M1 transport
and parser evidence remains valid; its stored-envelope shape does not qualify
the M2 public projection.

The public object is not the operator log. `FunctionCall.get()` continues to
return a small validated pointer plus page count, digest, timing, and typed
failure code. Required accounting fields are stamped in Postgres; structured
operational details go to service logs. M2 makes no promise of a durable
per-job success-timing archive. Raw failure detail may remain in the private
ledger/logs, but it is never used to derive a public code and never enters the
public object.

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
throughput promise. M2 hard-codes 100 as the maximum. It is not raised from a
larger `max_containers` value because fleet linearity has not been measured.
Changing it requires a new measured sustained rate and a contract update.

Admission is one short Postgres transaction on one checked-out `pg.PoolClient`:

```text
client = await pool.connect() with a 2-second checkout deadline
try:
  BEGIN
  SET LOCAL statement_timeout = '5s'
  SELECT pg_advisory_xact_lock(<fixed admission lock id>)
  recheck idempotency
  count global active jobs
  count this user's active jobs
  insert uploading job or choose 429
  COMMIT
catch error:
  try ROLLBACK
  if rollback fails: release client as destroyed
  rethrow the original error
finally:
  release the client normally only if rollback/commit left it usable
```

One fixed transaction-scoped lock is enough because it serializes the only
operation that can create active jobs; both limits are then exact. It is held
for database work only. Presigning happens after commit. Do not use
session-scoped `pg_advisory_lock`, and do not issue `BEGIN` through
`pool.query()`.

The idempotency check occurs before admission rejection. A replay returns its
existing job even when the service is currently full.

The current `jobs_active` index covers only `queued` and `dispatched`, so it is
not sufficient. M2 adds both a global and per-user partial index whose
predicate is exactly `state IN ('uploading','queued','dispatched')`. The
admission counts use that same predicate. A native-Postgres failure-injection
test throws after acquiring the lock, then proves a second admission through
the same pool does not hang and observes no uncommitted row.

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

M2 adds nullable `failure_code` columns to both `jobs` and `job_attempts` with
a closed database `CHECK` vocabulary:

```text
upload_expired | invalid_upload | input_digest_mismatch | input_too_large |
invalid_pdf | page_limit_exceeded | processing_deadline_exceeded |
dispatch_failed | processing_failed
```

The migration backfills existing failed rows as `processing_failed`, then
requires every failed job to have a code and every non-failed job to have none.
An attempt failure records its code and private diagnostic text atomically.
Crash-repair settlement derives the job code from the typed attempt code, not
from diagnostic text. Deadline and upload sweeps set their known code directly;
all unknown worker/provider failures become `processing_failed`. No code path
classifies a raw exception message.

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
input_digest_mismatch
invalid_pdf
page_limit_exceeded
processing_deadline_exceeded
dispatch_failed
processing_failed
result_not_ready
job_failed
result_expired
service_unavailable
```

Unexpected dependency failures return `503 service_unavailable`, never a
permanent job transition unless the existing lifecycle logic proves one.

Every `/v1` error uses `ErrorResponse` with this status mapping:

| code | HTTP status |
|---|---:|
| `authentication_required` | 401 |
| `forbidden` | 403 |
| `not_found` | 404 |
| `invalid_request` | 400 |
| `idempotency_mismatch` | 422 |
| `admission_limit` | 429 plus `Retry-After: 60` |
| `upload_incomplete` | 409 |
| `upload_expired` | 410 |
| `input_too_large` | 413 |
| `invalid_upload` | 422 |
| `result_not_ready` | 409 |
| `job_failed` | 409 |
| `result_expired` | 410 |
| `service_unavailable` | 503 |

Malformed JSON, wrong content type, an extra JSON field, and an out-of-range
header or field all use `400 invalid_request`. Dashboard form validation uses
escaped `400 text/html`; Origin/CSRF rejection uses escaped `403 text/html`;
a foreign key id uses escaped `404 text/html`. These pages expose no provider
or database text.

Terminal `JobView.error` is a closed projection. It never returns the stored
internal error string:

| proven internal condition | public code | public message |
|---|---|---|
| upload window expires before finalize | `upload_expired` | `Upload was not finalized before its deadline.` |
| finalized upload is empty or has the wrong media type | `invalid_upload` | `Uploaded object is not a valid PDF upload.` |
| uploaded bytes disagree with declared digest | `input_digest_mismatch` | `Uploaded PDF did not match the declared SHA-256.` |
| input exceeds 90 MiB | `input_too_large` | `PDF exceeds the 90 MiB limit.` |
| zero-byte, wrong-type, malformed, or unreadable PDF | `invalid_pdf` | `Input is not a supported PDF.` |
| document exceeds 200 pages | `page_limit_exceeded` | `PDF exceeds the 200-page limit.` |
| 24-hour processing deadline expires | `processing_deadline_exceeded` | `Document did not finish before its processing deadline.` |
| all dispatch attempts definitively fail | `dispatch_failed` | `Document could not be started.` |
| any other terminal internal failure | `processing_failed` | `Document processing failed.` |

Transient Postgres, R2, or Modal faults are request-level
`service_unavailable` or remain retryable internal state; their provider text
never becomes `JobView.error`. Safe mapping is tested with unknown exception
text to prove the generic fallback.

## Runtime and health

One Node process owns:

- the HTTP listener;
- a `pg.Pool` for requests;
- the five-second queued-job dispatch sweep;
- the existing reconciler interval, each pass using one checked-out client;
- graceful shutdown that stops accepting HTTP, stops timers, waits for the
  current bounded pass, then closes the pool.

“Bounded” means an enforced logical deadline, not an optimistic SDK timeout:

| operation | initial deadline | timeout result |
|---|---:|---|
| pool checkout | 2 s | request/pass fails retryably |
| SQL statement | 5 s | transaction rolls back |
| one R2 HEAD/LIST/GET | 10 s | retryable; never proves absence |
| Modal method lookup or spawn | 30 s | spawn becomes `dispatch_unknown`; lookup retries |
| Modal call inspection | 10 s | retryable/unavailable |
| one attempt reconciliation | 30 s | deferred to the next pass |
| one whole background pass | 45 s | stop starting items; release lock/client |
| graceful shutdown | 60 s | close clients and exit |

The queued dispatcher and reconciler each process at most eight rows per pass,
not 32, so one pass has useful work within the 45-second bound. R2 calls use an
`AbortSignal`. Where the Modal JS SDK cannot cancel an in-flight operation, a
deadline stops awaiting its result; any later resolution is ignored by that
pass. A timed-out spawn is ambiguous and therefore takes the existing
`dispatch_unknown` path, never a definitive failure.

Never-resolving fake R2 and Modal dependencies are acceptance tests: the pass
must return by its deadline, release its checked-out client and advisory lock,
and reconcile a healthy row on the next pass. Shutdown has the same bounded
test. These values are safety limits, not latency SLOs.

`GET /health` is unauthenticated and returns no identifiers. Readiness requires
Postgres because every useful request needs the ledger. R2 input, R2 result,
and Modal reachability are separate degraded fields: a transient dependency
failure must not remove replicas that can still serve job status. Routes that
need a degraded dependency return `503 service_unavailable`; status reads
continue.

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
12. Dispatch uncertainty remains operator-only; public status exposes only
    state and the 24-hour processing deadline.
13. Every job and key route gives user B 404 for user A's identifier.
14. Revoked keys, suspended users, malformed keys, query-string keys, and
    missing keys fail authentication.
15. A forged Access email header on `api.<domain>` receives 404 on dashboard
    and key-management routes; an unknown Host receives 421.
16. Access JWT validation checks signature, issuer, audience, expiry, and
    invited canonical email. JWKS rotation is exercised with two keys.
17. Dashboard mutations reject absent or foreign Origin.
18. Result URLs name only the accepted object, expire within five minutes,
    stop at retention expiry, and return the byte-identical validated public
    projection. Mutation tests prove Modal ids, revisions, timing, resources,
    raw exception text, and input keys cannot enter it.
19. Public errors and logs contain no presigned query string, key secret,
    bucket credential, or internal exception.
20. Every route's literal success and error container matches this contract;
    extra request fields are rejected.
21. A failure after the admission lock rolls back and leaves the pooled
    connection reusable; this is exercised on native Postgres.
22. Never-resolving Modal and R2 fakes cannot hold a pass, advisory lock, or
    checked-out connection past the declared deadlines.

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

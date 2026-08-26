# Design: service control plane — accounts, API keys, dashboard

**Status:** design, awaiting implementation · **Date:** 2026-08-26
**Scope:** one workstream, three shippable milestones
**Issues:** owns the account/dashboard layer of #76; subsumes #87 items 1–4;
**does not** implement #105 — see [Why not #105](#why-not-105-yet)
**Audience:** the engineer picking this up — read
[principles](../principles.md) and [workstreams](../workstreams.md) first.

## Why now

The parse engine is qualified — `deploy/modal/` passed 12/12 and
CPU/OpenVINO is the adopted default. What does not exist is a way for
anyone outside the owner's Modal workspace to use it: a caller today needs
workspace credentials and calls `.spawn()` directly.

This specifies the smallest layer that turns a qualified engine into a
service a named user can call: an account, an API key, a job ledger that
survives restart, and a dashboard showing what ran and what it cost.

**The engine is not in scope.** Nothing here changes parsing, OCR, the
record schema, or the merge.

## Why not #105 yet

An earlier draft of this document built #105's provider-neutral
architecture: a Postgres queue, pull-based workers, a lease/heartbeat
protocol, and a public worker-control API. **It was rejected in review, and
correctly.**

The fatal defect: a pull-based worker at `min_containers=0` cannot poll for
work, because no container is running to poll. Nothing starts it. The only
fix is for the API to tell Modal to start something — and once you are
dispatching, the lease protocol on top is a second queue layered over
Modal's already-qualified one.

The deeper error was importing an abstraction ahead of its second
implementation. #105 is written for a future with AWS Spot workers; the
board itself records Spot as "only a measured cost candidate." **Pull-based
workers stay parked in #105 until a second compute provider is genuinely
earned.** Modal is the queue and the autoscaler.

(For the record: the pull design is not *impossible* — a permanently warm
or cron-scheduled poller would run it. It forfeits scale-to-zero, which is
the property that made Modal the right choice.)

## Out of scope, deliberately

SSO/SAML, organisations and teams, payment collection, webhooks,
progressive/SSE page streaming, the Flex tier, Kubernetes, Redis, SQS, an
ORM, a pricing table, provider abstraction, and any client-side framework.
Self-serve signup is out: **v1 is invite-only** (owner decision,
2026-08-26), which removes email verification, bot defence, and free-tier
abuse quotas from the critical path.

Enrichment stays **off** for external callers — it spends real money per
page against the owner's Gemini key and there is no per-caller spend cap.

---

## Architecture

```text
                    Internet
                       │
        Cloudflare Access (dashboard) / Tunnel (API)
                       │  outbound-only origin connection
        ┌──────────────┴────────────── VPS ──────────────┐
        │   api (Node, server-rendered HTML) — STATELESS  │
        └──────┬──────────────────────┬──────────────────┘
               │                      │
        managed Postgres              │
        (vendor PITR)                 │
               │                      │
               │ modal.cls.fromName   │ presigned S3
               │   .spawn()           │
        ┌──────┴────────┐      ┌──────┴──────┐
        │ Modal CPU     │─────►│  R2 bucket  │
        │ parse_object  │      └─────────────┘
        └───────────────┘
```

**Workers never call back to the VPS.** Results go to R2; the API polls
`FunctionCall.get({timeoutMs: 0})`. Combined with Cloudflare Tunnel's
outbound-only origin connection, **the box exposes no inbound public
ports at all.**

The existing `service/` is demoted from "the service" to the worker's
engine — unchanged, reachable only on loopback inside the worker container.
The new public API simply has no `pdfPath` route; no special build is
needed to remove one.

### Verified: the JS SDK supports this

Confirmed against the shipped `modal@0.9.0` type definitions (not the main
branch — this is what `npm install` gives you):

```
ClsInstance.method(name: string): Function_            index.d.ts:6658
Function_.spawn(args?, kwargs?): Promise<FunctionCall>
FunctionCall.functionCallId: string                    readonly
FunctionCallService.fromId(id): Promise<FunctionCall>
FunctionCall.get(params?) / .cancel(params?)
```

`parse_document` is a `@modal.method()` on a Cls (`ParseContainer`), so this
chain is the one that matters: `fromName → instance() → method() → spawn()
→ functionCallId → persist → fromId() → get()`.

Note `cls`, `functions`, and `functionCalls` are **`ModalClient` instance
properties**; the package exports no client singleton, so `new
ModalClient()` is required.

**`modal@0.9.0` is pre-1.0.** Accept the churn risk knowingly, and pin the
version. `scripts/service/modal-spawn-smoke.mjs` (M0 below) proves
deployment, auth, serialization, and cross-restart recovery — the API
surface itself is already settled.

---

## Data model

Four tables. `pg` with hand-written SQL, numbered `.sql` migrations, ~30
line runner.

```sql
users(id, email unique, status, created_at)
api_keys(id, user_id, prefix, hash, name, created_at, last_used_at, revoked_at)
jobs(id, user_id, idempotency_key, state, input_uri, input_digest,
     input_bytes, pages_actual, unit_price_micros, estimated_cost_micros,
     accepted_attempt_id, result_uri, result_digest, error,
     created_at, queued_at, completed_at,
     upload_expires_at, retention_expires_at)
job_attempts(id, job_id, modal_call_id, state, result_uri, result_digest,
             pages, dispatched_at, completed_at, error)
```

`jobs.state`: `uploading | queued | dispatched | succeeded | failed`.

**`dispatched`, not `running`.** `.spawn()` only enqueues; the call may sit
in Modal's queue with nothing executing. Claiming `running` would assert
something the control plane cannot observe. There is no `cancelled` state —
see [Why cancellation is not in v1](#why-cancellation-is-not-in-v1).
`job_attempts.state`: `dispatching | dispatch_unknown | dispatched |
succeeded | failed`.

`(user_id, idempotency_key)` unique where not null. A replay carrying a
**different body** is a client bug, not a retry: return **422**, never the
original job.

`jobs` carries **two** deadline columns, not one overloaded `expires_at`:
`upload_expires_at` (while `uploading`) and `retention_expires_at` (once
terminal). One column with two meanings invites sweeper bugs that delete
live jobs.

**No `usage_events` table.** Usage is 1:1 with jobs, so a second table is
redundant until refunds or adjustments exist. **No `pricing` table** — the
rate is a config constant.

What survives from the earlier draft is the property that actually mattered:
**the rate is resolved at write time and stamped onto the row**
(`unit_price_micros` on `jobs`). If the rate lived only in config and the
dashboard multiplied at render time, changing the price would silently
rewrite every historical figure. Money is integer micros; never floats.

---

## Job lifecycle

### Upload finalization

A presigned PUT happens out-of-band, so a job must not be queued before its
object is verified to exist.

```text
POST /v1/jobs        → job row: uploading, random UNIQUE object key
                       (unique, not immutable — a presigned PUT can be
                       replayed until it expires; the worker's digest
                       check is what protects integrity),
                       client-supplied input_digest REQUIRED,
                       presigned PUT returned
client PUTs bytes    → directly to R2
POST /v1/jobs/:id/finalize
                     → HEAD the object: EXISTENCE and SIZE only
                     → transaction: state=queued
```

**Finalize cannot verify the content digest, and must not claim to.**
Ordinary presigned R2/S3 PUT URLs are signed with `UNSIGNED-PAYLOAD`, so
the service never witnesses the bytes; `HEAD` returns existence, size, and
stored metadata, and an `ETag` that is only an MD5 for single-part uploads.
None of that is an independently computed SHA-256 over content the service
has read.

**The digest gate is the worker**: it downloads, computes SHA-256, and
compares against the client's claimed value before parsing. A mismatch
fails the job. (`validate_input` already enforces exactly this contract
today via `expected_sha256`.) Specifying a signed R2 checksum upload
contract instead is possible, but it must then be specified and tested —
not implied by an unqualified "HEAD verifies the digest".

**A maximum upload size is stated and enforced at finalize.** The
qualified engine caps input at 90 MiB (`MAX_INPUT_BYTES`), so that is the
cap; nothing otherwise stops a multi-gigabyte PUT that a worker then pulls
into a 24 GiB container alongside other work. Finalize rejects anything
larger and marks the job failed.

The per-user concurrency cap needs a named enforcement point: a
count-of-active-jobs check at submit races under concurrent submissions.
Take a per-user advisory lock, or accept documented slight overage — but
say which.

Abandoned `uploading` rows are swept on their `upload_expires_at`.

### Dispatch, and its one honest seam

**The API cannot atomically commit Postgres state and spawn a Modal call.**
A crash after Modal accepts but before `modal_call_id` reaches Postgres
leaves an attempt with no call ID. This is a dual-write, and there is no
way to remove it short of the worker-control protocol this design
deliberately rejects.

The answer is not leases. It is immutable attempts plus honest semantics:

```text
job ──► attempt row created with immutable attempt_id
          └── modal .spawn()
                └── modal_call_id persisted when available
                     └── (crash here) attempt stays dispatch_unknown
```

**Every `.spawn()` gets a NEW attempt id. An attempt id is never reused.**
This is not a detail — reusing an attempt for a re-dispatch would point two
Modal calls at the same result key and destroy the exact property the
immutable-key scheme exists to provide. An attempt whose call id never
landed goes to `dispatch_unknown` and stays there; after a bounded wait the
reconciler mints a *different* attempt and dispatches that one. The
uncertain call may still be running, and that is accepted.

**Dispatch is at-least-once. Stated as a property, not a footnote:**

- duplicate computation is possible;
- every **execution** writes to a key it mints itself,
  `results/{job_id}/{attempt_id}/{execution_id}.json`, and returns that URI
  through `FunctionCall.get()`;
- exactly one attempt is installed as `jobs.accepted_attempt_id` in a
  transaction, and installation is the only thing that makes a result
  authoritative;
- **a stale attempt does not overwrite the accepted result**, because each
  execution writes only to a key it minted itself. Note this is a
  by-construction guarantee, not a capability one: the worker holds bucket
  credentials and *could* technically write elsewhere. It is first-party
  code, which makes that acceptable — but the weaker claim is the true one;
- cost accounting records actual completed attempts where observable.

**A unique key is not automatically an immutable one.** The Cls is
deployed with `retries=1` (`modal_app.py:420`), so a single FunctionCall
can execute twice — and both executions would receive the *same*
`result_put_url` if the control plane minted it. A per-attempt key is
therefore not enough.

The execution mints its own key and reports it back. Abandoned execution
objects are harmless and retention removes them. The alternative — a signed
conditional `PUT` with `If-None-Match: *` plus a defined
already-exists behaviour — is workable but strictly more machinery for the
same guarantee.

This matters because with a single shared `result_uri`, a zombie holding a
valid presigned PUT overwrites a good result: the database fence rejects
its *completion* while its *bytes* have already landed.

### Reconciler

One background loop in the api process, advisory-locked so replicas do not
double-run:

- attempts stuck in `dispatch_unknown` past a bounded wait → mint a **new**
  attempt and dispatch that (never re-spawn the same attempt id);
- attempts with a call ID → `fromId(id).get({timeoutMs: 0})`, install
  terminal results, record failures;
- `uploading` and expired rows → sweep;
- retention expiry.

**Modal outputs expire 7 days after completion**, after which `get()`
returns an expired response. Two consequences:

1. The reconciler must observe completions inside that window. At this
   scale it trivially does, but a multi-day outage is then a real recovery
   event, not a nuisance.
2. **`modal@0.9.0` exports no `OutputExpiredError`** — the Python SDK has
   one, the JS SDK does not (verified against the shipped type
   definitions). So the reconciler *cannot* reliably distinguish expired
   from failed by error class. This promotes the design's own backstop from
   incidental to primary: because keys are
   `results/{job_id}/{attempt_id}/{execution_id}.json`, **a result whose
   Modal output expired is still recoverable by R2 prefix LIST.** Recover
   from storage, not from the call.

M0 must therefore record which error classes actually arrive from
`get({timeoutMs: 0})` — pending, expired, and function-failed must be
distinguishable before the reconciler's terminal-state logic can be
written, and a pre-1.0 SDK is exactly where that taxonomy churns.

---

## `parse_object`: pointer mode

Today's `parse_document(payload: dict) -> dict` takes PDF bytes and returns
the complete record (`deploy/modal/modal_app.py:568`). Pointer mode:

```python
parse_object(job_id, attempt_id, expected_sha256, input_key, result_prefix) -> dict
```

**No presigned URLs cross the worker boundary.** An earlier draft passed
`input_get_url` and `result_put_url`, which was self-contradictory: a
presigned PUT is bound to one fixed key, so an execution handed one cannot
mint its own — the very thing `retries=1` forces it to do. And a presigned
GET has a fixed expiry, while `.spawn()` can sit queued behind a capped
`max_containers` for hours before executing twice; the input URL would have
had to outlive queue wait plus both executions or fail with download errors
that look like transport bugs.

Both problems dissolve with one mechanism instead of two. The worker holds
**least-privilege R2 credentials via a Modal secret** — read on the inputs
bucket, write on the results bucket. It downloads `input_key`, verifies
SHA-256 against `expected_sha256`, parses, mints
`{result_prefix}/{execution_id}.json`, writes it, and returns the URI,
digest, page count, and timing through `FunctionCall.get()`.

The control plane then presigns **only client-facing URLs** — browser
upload and result download. Presigned URLs and worker credentials stop
being two overlapping answers to the same question.

This also dissolves the qualified 64 MiB serialized-result cap, since the
record no longer crosses the method boundary.

### Focused transport qualification

Pointer mode is not a free swap — it changes transport failure behaviour,
digest verification, memory profile, result publication, and duplicate-write
behaviour. But if `parse_object` is a thin transport wrapper around an
unchanged parsing core, a **focused** qualification suffices:

1. records identical to `parse_document` after removing volatile fields
   (`nativeObservations[].font` is volatile identity — see the Modal
   qualification's spec amendment);
2. input digest verified after download;
3. result digest recorded;
4. large input and large result exercised;
5. download/upload failures visible and bounded;
6. Modal retry behaviour exercised;
7. no meaningful parsing-throughput regression.

**Repeat the full 12/12 only if** the parsing engine, warm-container
lifecycle, process management, or retry semantics change. They do not here.

---

## Authentication

**Dashboard: Cloudflare Access**, one-time PIN against the invited email
list, additional identity providers later. This deletes `login_tokens`,
custom sessions, the email provider, and most future SSO migration work.

The earlier draft called a custom magic-link flow "well-trodden." That was
wrong, and the concrete reason is worth recording so it is not re-argued:
**email scanners prefetch links and consume single-use tokens before the
user clicks.** Add revocable server-side sessions, CSRF on key
creation/revocation, session rotation, and login throttling, and it is
clearly more code than adopting Access. The app still keeps a `users` row
mapped from the verified Access identity.

**API callers: application-owned keys**, `ps_live_<32 bytes base62>`.
Machines cannot answer an OTP challenge, so the API hostname is *not*
Access-protected; the key is the boundary. Store SHA-256 plus an 8-char
clear prefix for display; show plaintext exactly once; look up by prefix,
then constant-time compare.

**Both hostnames terminate at the same Node process, so Access identity
must come from the verified JWT — never a header.** If the app trusted
`Cf-Access-Authenticated-User-Email`, any request to the *unprotected* API
hostname could forge a dashboard identity and reach another user's key
creation and revocation. The app verifies the `Cf-Access-Jwt-Assertion`
signature against Cloudflare's public keys **and** the Access AUD tag, and
every dashboard route requires it.

**Access does not delete CSRF.** An earlier draft listed CSRF among the
costs of the rejected magic-link flow, implying Access removed it. It does
not: the dashboard is cookie-authenticated (`CF_Authorization`), so
state-changing routes stay exposed unless that cookie's `SameSite`
provably blocks cross-site POSTs — an unverified vendor cookie attribute is
not a security argument. Dashboard mutations check the `Origin` header.
That is about five lines.

**SHA-256 is correct here and bcrypt would be a bug.** The key is 256 bits
of generated entropy, not a human-chosen password, so a slow hash defends
nothing — and a deliberately slow hash on every API request is a
self-inflicted denial-of-service vector.

## Why cancellation is not in v1

An earlier draft claimed `FunctionCall.cancel()` made user-facing
cancellation "nearly free". **It does not.** `cancel()` is a primitive; the
product feature additionally needs a race-safe terminal database
transition, refusal of results that arrive after it, handling of attempts
whose call id was lost, cleanup of already-uploaded execution objects, and
defined billing semantics for partial work.

No user requirement needs it. `cancelled` is removed from the state
machine; `cancel()` stays available as an **operator tool** for stopping a
runaway call.

## Tenant isolation

Every job read is filtered by `user_id`, enforced structurally: one accessor
takes `user_id`, and no code path fetches a job by id alone. Cross-tenant
reads return **404, not 403** — 403 confirms the id exists and turns the
endpoint into an enumeration oracle.

*Acceptance:* a test asserting user B receives 404 on every one of user A's
routes.

## Cost display

The placeholder is **$0.001/page**, and it is labelled **estimated usage
cost**, never "billing" — there is no payment, credit, or reservation
system, and submission reserves nothing.

**The placeholder is honest about what it is.** The qualification publishes
three per-page costs, and which one you compare against changes the answer:
**$572/M** gauntlet-inclusive ($0.000572/terminal page, all failure arms),
**~$440/M** across steady arms, **~$300/M** single-container 100-call
billed. All are boot/idle-inclusive; none is a measured warm-fleet
marginal. So $0.001/page is **1.7×–3.3× measured parse compute**, before
Postgres, storage, and the VPS. Quote the range, never a single multiple.

**Stamp the rate at job creation; multiply at completion.**
`unit_price_micros` is written when the job row is created, because that is
the rate in force when the user submitted. `estimated_cost_micros` is
written at completion as `unit_price_micros × pages_actual`, because page
count is unknown until the PDF opens. Saying only "resolved at write time"
left which write ambiguous.

## Dashboard

Server-rendered HTML from the api process. No SPA, no bundler, no build
step — four pages do not justify adding a compilation stage to CI.

1. **Jobs** — timeline, newest first: state, pages, duration, estimated
   cost; filter by state and date.
2. **Usage** — per-day pages and estimated spend, month-to-date, with the
   placeholder caveat rendered on the page, not buried in docs.
3. **API keys** — create (plaintext once), name, prefix, last used, revoke.
4. **Account** — email, invite status, sign out.

### No progressive page endpoints in v1

`GET /v1/jobs/:id` returns status and summary; a completed job gets one
short-lived result-download URL. No page cursor, page route, or SVG route.

The precise reason: one `result_uri` does not make page endpoints
*impossible* — the API could load and slice the completed JSON. What is
impossible is **progressive availability during parsing**, because the
Modal call publishes only at document completion. `reconstructSvg()` (#51)
and per-page routes exist in `service/` and stay deliberately unexposed
until a consumer needs them.

## Durability

**The VPS holds no state.** Postgres is managed (owner decision,
2026-08-26); the ledger lives with a vendor that provides point-in-time
recovery, and R2 holds every document and result.

An earlier draft ran Postgres on the box in Compose. Its weakest line was
"VPS disk loss loses everything since the last backup, RPO ≤ 24h" — and
the fix for that was a nightly `pg_dump`, a separate-credential setup, and
a restore-testing obligation, all of which are ongoing work that does not
advance the product. Managed Postgres deletes all three and converts VPS
disk loss into **re-provision from the `.env` backup**. RPO drops from
≤24h to the vendor's PITR window.

The VPS remains a single point of *availability*: if it is down,
submissions fail and **in-flight Modal calls still complete** — results
land in R2 and are reconciled on restart.

- **RPO: vendor PITR window. RTO ≤ 1h**, bounded by re-provisioning a
  stateless box.
- The one irreplaceable secret is now the `.env` (database URL, R2 keys,
  Modal token, Access AUD). Back it up **outside** the VPS; without it a
  rebuild cannot reach its own data.
- Uploaded PDFs never touch VPS disk.
- Modal secrets hold the worker's R2 credentials; nothing committed.
- Structured logs carrying job id and user id. `/health` covers Postgres
  and R2 reachability, not just process liveness.

Compose on the box is now just `api` — and with Cloudflare Tunnel, not
even Caddy.

---

## Milestones

### M0 — spawn smoke test *(prerequisite, hours)*

`scripts/service/modal-spawn-smoke.mjs`: `Cls.method().spawn()` → persist
call ID → **restart the Node process** → `functionCalls.fromId()` → get the
result.

*Acceptance:* a **verified-good** result recovered by a process that did not
spawn the call. `_result()` returns `status: "failed"` without raising
(`modal_app.py:736`), so "an object came back" is not success — assert
`status === "completed"`, matching `request_id` and `document_sha256`,
`page_count === 1`, `pages_ok === 1`, and no `failure`.

Also record the **error taxonomy**: which classes arrive from
`get({timeoutMs: 0})` for pending vs expired vs function-failed. The
reconciler cannot be written without this, and JS has no
`OutputExpiredError`.

This validates deployment, auth, `Uint8Array → Python bytes`
serialization, and cross-restart recovery — not the API surface, which is
already settled by type inspection.

### M0 RESULT: PASS (2026-08-26)

Run on the `desia` workspace as `pagespatial-m0-smoke`
(`PAGESPATIAL_MAX_CONTAINERS=1`, adapter rev `2010a55`). All eight
assertions passed on `fc-01M0XQPE868D0DV5X5ECZ0RB0T`.

**`Uint8Array` → Python `bytes` works, byte-exact.** This was the real
unknown. `validate_input` requires `isinstance(pdf_bytes, (bytes,
bytearray))` *and* recomputes SHA-256 server-side; both passed, so the JS
SDK delivers the payload without corruption. No base64 wrapper is needed.

**Cross-restart recovery works.** `functionCalls.fromId()` in a process
that never held the original `FunctionCall` object retrieved the result.

**Error taxonomy — 2 of 3 resolved** (second probe, deliberate
`expected_sha256` mismatch):

| outcome | JS error class |
|---|---|
| pending | `FunctionTimeoutError` |
| function-failed | `RemoteError`, message carrying the Python repr |
| output expired | **UNKNOWN** — needs a 7-day-old call |

The gap is consequential. Since `modal@0.9.0` has no `OutputExpiredError`,
if expiry also surfaces as `RemoteError` then the reconciler **cannot**
distinguish "expired" from "failed" by class, and would mark recoverable
work permanently failed. **This makes the R2 prefix LIST backstop
mandatory, not optional** — recover from storage, not from the call. Treat
that as settled; do not spend a week re-deriving it.

**Timing, n=1, stated as such:**

```
service_ready_ms : 98108   (cold boot)
parse_ms         :  2393   (589-byte 1-page PDF)
total_method_ms  :  2395   (EXCLUDES boot)
```

The 98.1 s cold boot is **above the 70–88 s range** recorded in the M1
linux verification. One observation, on a first call against a
freshly-built image in a different workspace, so it may carry
first-pull overhead — it does **not** refute the documented range, but the
control plane should budget cold start at ~100 s rather than 88 s, and a
real distribution is owed before any latency promise is made to a user.

The app was stopped after the run (0 tasks).

### M1 — job plane

Schema and migrations, R2 wiring, presigned upload + finalize, `parse_object`
and its focused qualification, dispatch, attempts, reconciler.

*Acceptance:* a job inserted by raw SQL is dispatched, parsed, its result
lands at its own execution key, and the row reaches `succeeded` with
`pages_actual` and `accepted_attempt_id` set.

Killing the api mid-dispatch must satisfy the guarantee the system can
actually make — **not** "leaves no orphan", which is false: a crash after
Modal accepts but before it returns the id creates a call nothing can
recover. The guarantee is:

> Unknown work may continue and duplicate computation, but it cannot
> corrupt or replace the authoritative result.

Test it: kill the api mid-dispatch, let the reconciler mint a second
attempt, then allow the original call to complete. The job must hold
exactly one `accepted_attempt_id`, and the losing execution's bytes must
still sit untouched at their own key.

### M2 — identity

Cloudflare Access + Tunnel, invite list, `users` mapping, API key
issue/revoke, key auth on `/v1/jobs`. Public surface: presigned intake,
`Idempotency-Key`, 429 + `Retry-After` (#87 items 1–4).

*Acceptance:* an invited user logs in, creates a key, submits a PDF, polls
to completion. User B gets 404 on all of user A's routes. A replayed
`Idempotency-Key` returns the original job rather than parsing twice, while
a replay with a different body gets 422. **A request to the API hostname
carrying a forged `Cf-Access-Authenticated-User-Email` header gets 401 on
every dashboard route.**

### M3 — dashboard

The four pages, plus cost stamping at completion.

*Acceptance:* a completed job appears with pages, duration, and estimated
cost; month-to-date equals the sum over that user's jobs; changing the
config rate does not alter any already-written job row.

**Plus one recovery drill.** With managed Postgres there is no `pg_dump` to
test, but the claim "the VPS is disposable" is still untested until someone
proves it: re-provision the api container from the `.env` alone and serve
the dashboard against the live database.

## Open questions for the owner

1. **Retention default** for result objects and uploaded PDFs. 30 days
   assumed.
2. **Per-user concurrency cap.** A flat 5 is assumed; per-tier implies tiers
   exist, which implies #105's Standard/Flex lands first.
3. **Domain** — needed for Cloudflare Access and Tunnel, external lead time,
   blocks M2.

## Corrections to earlier claims in this document's history

- The **pull-worker/lease architecture is withdrawn**; it could not start a
  scale-to-zero worker.
- "The lease token is the idempotency mechanism" was **wrong** — it is a
  fencing token, and it never protected result *objects*, only database
  completions.
- The VPS break-even was quoted as "~110k pages/month." That is an
  **unmeasured extrapolation**; against the three published costs it spans
  **~84k–160k**, and quoting a midpoint violates the house rule that every
  number states what it measures.
- "MinIO is a one-variable swap" **overstated** S3 compatibility: CORS,
  checksum, signing, and conditional-write behaviour would each need
  verification.
- A per-**attempt** result key was described as immutable. It is not:
  `retries=1` means one FunctionCall can execute twice against the same
  URL. The key must be minted per **execution**.
- Re-dispatching a `dispatch_unknown` attempt under its own id was
  specified, which would have pointed two calls at one key — defeating the
  immutability property this design depends on.
- "Killing the api mid-dispatch leaves no orphan" was **false**; the
  guarantee is that unknown work cannot corrupt the authoritative result.
- Finalize was said to verify the client's digest. Presigned PUTs are
  signed `UNSIGNED-PAYLOAD`, so **the service never sees the bytes**; the
  worker is the digest gate.
- `FunctionCall.cancel()` was called "nearly free" user-facing
  cancellation. It is a primitive, not the feature.
- `running` was **not observable** after `.spawn()` — a call may be queued
  with nothing executing. The state is `dispatched`.
- `parse_object(job_id, attempt_id, input_get_url, result_put_url)`
  **contradicted this document's own key scheme**: a presigned PUT is bound
  to one key, so an execution handed one cannot mint its own. Presigned
  URLs no longer cross the worker boundary at all.
- "A stale attempt **physically cannot** write to another attempt's key"
  was too strong once the worker holds bucket credentials. It is a
  by-construction guarantee.
- Adopting Cloudflare Access was said to remove CSRF. It does not — the
  dashboard remains cookie-authenticated.
- The input object key was called **immutable**; it is unique. A presigned
  PUT can be replayed until expiry.
- `retries=1` is at `modal_app.py:420`, not 421.
- Postgres was specified **self-hosted on the VPS**, which forced a
  `pg_dump` cron, separate backup credentials, a restore-testing
  obligation, and RPO ≤ 24h. Managed Postgres deletes all four (owner
  decision, 2026-08-26) and makes the box stateless.

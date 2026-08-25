# Design: service control plane — accounts, API keys, dashboard

**Status:** design, awaiting implementation · **Date:** 2026-08-26
**Scope:** one workstream, three shippable milestones
**Issues:** owns the account/dashboard layer of #76; subsumes #87 items 1–4;
implements the queue half of #105
**Audience:** the engineer picking this up — read
[principles](../principles.md) and [workstreams](../workstreams.md) first.

## Why now, and what changed

The parse engine is qualified. `deploy/modal/` passed its 12/12
qualification and CPU/OpenVINO is the adopted default. What does not exist
is a way for anyone outside the owner's Modal workspace to use it: today a
caller must have workspace credentials and call `.spawn()` directly.

This document specifies the smallest layer that turns a qualified engine
into a service a named user can actually call: an account, an API key, a
job ledger that survives a restart, and a dashboard that shows what was
run and what it cost.

**The engine is not in scope.** Nothing here changes parsing, OCR, the
record schema, or the merge. This is the front door.

## Out of scope, deliberately

SSO/SAML, organisations and teams, payment collection, webhooks,
SSE/WebSocket progress, the Flex tier, Kubernetes, and any client-side
framework. Each is recorded here so it is not rediscovered as an
oversight. Self-serve signup is out: **v1 is invite-only** (owner
decision, 2026-08-26), which removes email verification, bot defence, and
free-tier abuse quotas from the critical path.

Enrichment stays **off** for external callers. It spends real money per
page against the owner's Gemini key, and there is no per-caller spend cap
yet. Turning it on is gated on the cost model below becoming real.

---

## Architecture

Three processes. The existing `service/` is demoted from "the service" to
"the worker's engine" — it keeps its HTTP shape, but only a worker ever
talks to it, over loopback inside the worker container.

| process | runs where | owns | state |
|---|---|---|---|
| **api** | VPS | dashboard, auth, job intake, worker-control | stateless |
| **worker** | Modal CPU | lease loop + existing parse pipeline | ephemeral |
| **sweeper** | cron inside api, advisory-locked | lease reclaim, retention | stateless |

```text
                     ┌──────────── VPS (Docker Compose) ────────────┐
   browser ─────────►│  caddy (auto-TLS)                            │
   API client ──────►│    ├── api  (Node)                           │
                     │    └── postgres  (named volume)              │
                     └───────────────┬──────────────────────────────┘
                                     │ authenticated HTTPS
                                     │ (worker bearer token)
                     ┌───────────────┴──────────────┐
                     │  Modal CPU workers           │
                     │  lease → parse → PUT result  │
                     └───────────────┬──────────────┘
                                     │ presigned S3 URLs
                              ┌──────┴──────┐
                              │  R2 bucket  │  PDFs in, results out
                              └─────────────┘
```

### Why the workers are not on the VPS

A worker pair needs ~2.7 GB (cgroup-measured, M1 container; 10.9 GB for
four). The control-plane box runs Postgres, api, and Caddy in 4 GB and has
nothing left. Modal also scales to zero, and at ~$440/M pages it stays
cheaper than a dedicated worker VPS below roughly 110k pages/month.

**This is a deployment choice, not an architecture choice.** A worker is
anything holding a valid worker token that can call `POST /internal/lease`.
Adding a worker VPS later — for volume economics, or to hide Modal's
70–88 s cold start behind one always-warm worker — means running the same
drainer container elsewhere and pointing it at the same URL. No schema,
API, or dashboard change.

### Why object storage is not on the VPS

R2 rather than MinIO on the same box. Self-hosting the control plane is
cheap; self-hosting *durable* object storage means owning replication and
the disk holding customer PDFs — on the machine that is exposed to the
public internet. R2 has no egress fees, which matters because Modal
workers download every input.

Write against the S3 API, configured by endpoint URL. MinIO then remains a
one-variable swap if the posture ever changes.

---

## Data model

Five tables. `pg` with hand-written SQL; no ORM. Migrations are numbered
`.sql` files applied by a ~30-line runner — the schema is small enough that
a migration framework costs more than it returns.

```sql
users(id, email unique, status, created_at)
api_keys(id, user_id, prefix, hash, name, created_at, last_used_at, revoked_at)
jobs(id, user_id, idempotency_key, state, input_uri, input_digest,
     pages_estimated, pages_actual, priority, available_at,
     lease_token, lease_until, worker_id, attempts, error,
     result_uri, result_digest, created_at, completed_at, expires_at)
usage_events(id, job_id, user_id, pages, unit_price_micros,
             total_micros, tier, occurred_at)
login_tokens(hash, email, expires_at, used_at)
```

`state` is `queued | leased | succeeded | failed | cancelled`.
`(user_id, idempotency_key)` is unique where the key is not null.

## Queue contract

Postgres is the queue. The entire lease is one statement:

```sql
UPDATE jobs SET state='leased', lease_token=gen_random_uuid(),
  lease_until=now()+interval '10 min', worker_id=$1, attempts=attempts+1
WHERE id = (SELECT id FROM jobs WHERE state='queued' AND available_at<=now()
            ORDER BY priority DESC, created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
RETURNING *;
```

The worker receives the job plus a presigned GET for the input and a
presigned PUT for the result. It parses, uploads, then calls
`POST /internal/jobs/:id/complete` with its `lease_token`.

**The lease token is the idempotency mechanism.** A worker that stalls
past `lease_until` has its job reclaimed by the sweeper and re-queued with
a fresh token; when the zombie eventually reports, its stale token is
rejected and its result discarded. Without this, a slow worker and its
replacement both write results and the last writer wins silently.

Terminal failure after N attempts records `error` and stops. No retry
storm, no dead-letter queue — a failed job is a row with a reason.

## Authentication

Three distinct credentials. They must not share a code path.

**Users (dashboard): magic link.** No passwords. A password flow needs an
email sender for reset anyway, so magic link needs strictly *less* code and
stores no credential that can leak. `login_tokens` holds a hash, single
use, short expiry. Session is a signed httpOnly cookie. SSO later attaches
to the same `users` row as an additional identity provider.

**API callers: `ps_live_<32 bytes base62>`.** Store SHA-256 of the key plus
an 8-character clear prefix for display. Show the plaintext exactly once,
at creation. Look up by prefix, then constant-time compare the hash.

**SHA-256 here is correct, and bcrypt would be a bug.** The key is 256 bits
of generated entropy, not a human-chosen password, so there is nothing for
a slow hash to defend. A deliberately slow hash on every API request is a
self-inflicted denial-of-service vector.

**Workers: a rotatable bearer token**, separate from user keys, scoped to
`/internal/*` only. Modal egress IPs are not stable, so there is no IP
allowlist to fall back on — the token is the only boundary, and it gets
its own rate limit and its own rotation procedure.

## Tenant isolation

Every read of a job or result is filtered by `user_id`. This is enforced
structurally: a single accessor takes `user_id` and there is no code path
that fetches a job by id alone. A cross-tenant fetch returns **404, not
403** — 403 confirms the id exists and turns the endpoint into an
enumeration oracle.

Acceptance is a test that asserts user B receives 404 for every one of user
A's job, page, result, and SVG routes.

**`pdfPath` mode is compiled out of the public build**, not env-gated. It
is an arbitrary server-file read and a file-existence oracle (#76). An env
flag is one misconfiguration away from being on.

## Cost and usage

There is no cost model yet. The placeholder is **$0.001/page** — but the
placeholder discipline matters more than the number.

**Resolve the price at write time and stamp it onto the row.** A `pricing`
table carries the rate with an effective-from date; `usage_events` stores
the resolved `unit_price_micros` alongside the total. If the rate instead
lived in code and the dashboard multiplied at render time, then the day the
price changes, every historical figure silently changes with it. This is
the same era-discipline the evaluation baselines already use, and it is far
cheaper to establish now than to retrofit.

Money is integer micros (millionths of a dollar). Never floats.

**The placeholder is honest about what it is.** The qualification
(`2026-08-23-modal-qualification`) publishes three per-page costs, and which
one you compare against changes the answer: **$572/M** gauntlet-inclusive
($0.000572/terminal page, all failure arms included), **~$440/M** across the
steady arms, **~$300/M** for the single-container 100-call billed arm. All
three are boot/idle-inclusive and none is a measured warm-fleet marginal
cost.

So $0.001/page is **1.7×–3.3× measured parse compute**, before Postgres,
storage, and the always-on VPS. That is a plausible order of magnitude,
**not a price**, and the dashboard must label it as such until real unit
economics land. Quote the range, never a single multiple.

**Billing happens at completion, not submission.** Page count is unknown
until the PDF opens. Submit reserves against a cap; completion writes the
usage event with `pages_actual`.

## Dashboard

Server-rendered HTML from the api process. No SPA, no bundler, no build
step — it is four pages, and a client-side framework would add a
compilation stage to CI for no user-visible gain.

1. **Jobs** — timeline, newest first: state, pages, duration, cost, filter
   by state and date range.
2. **Usage** — per-day pages and spend, month-to-date total, with the
   placeholder-pricing caveat rendered on the page, not buried in docs.
3. **API keys** — create (plaintext shown once), name, prefix, last used,
   revoke.
4. **Account** — email, invite status, sign out.

## Trust boundary and operational obligations

The VPS is the single point of failure for the control plane. If it is
down, workers cannot lease and **jobs stall — they are not lost**, provided
the Postgres volume survives. This is accepted for v1 and stated here so it
is a known property rather than a discovery.

Consequently:

- **Backups are the primary operational obligation.** The job ledger and
  usage events are the only state here that cannot be rebuilt from
  elsewhere. `pg_dump` to R2 on a cron, and a **tested restore** — an
  untested backup is decoration.
- Uploaded PDFs never touch VPS disk (presigned direct-to-storage), which
  keeps customer documents off the internet-facing box.
- Secrets live in a `.env` on the box and in Modal secrets on the worker
  side; neither is committed.
- Structured request logs with job id and user id. `/health` covers
  Postgres reachability and R2 reachability, not just process liveness.

---

## Milestones

Ordered by risk, not by visibility. A is the part that can go wrong; B and
C are well-trodden and are meaningless without it.

### M1 — job plane

Postgres schema and migrations, R2 wiring, presigned upload/download,
job lifecycle, worker-control API, sweeper, and a Modal drainer wrapping
the existing pipeline.

*Acceptance:* a job submitted with a raw SQL insert is leased by a Modal
worker, parsed, its result lands in R2, and the row reaches `succeeded`
with `pages_actual` set. Killing the worker mid-parse causes reclaim and a
successful retry. A stale `lease_token` completion is rejected.

### M2 — identity

Invite creation, magic-link login, sessions, API key issue/revoke, and key
auth on `/v1/jobs`. Public `/v1` surface hardened: streaming intake removed
in favour of presigned URLs, `Idempotency-Key`, 429 + `Retry-After`,
`includePages=false` and `afterPage=N` (#87 items 1–4, 6).

*Acceptance:* an invited user logs in, creates a key, submits a PDF through
the public API, and polls it to completion. User B receives 404 on every
one of user A's routes. A replayed `Idempotency-Key` returns the original
job rather than parsing twice.

### M3 — dashboard

The four pages above, plus the `pricing` table and usage-event write on
completion.

*Acceptance:* a completed job appears on the timeline with pages, duration,
and cost; the usage page's month-to-date total equals the sum of
`usage_events.total_micros` for that user; changing the pricing row does not
alter any already-written event.

## Open questions for the owner

1. **Retention default.** How long do result objects and uploaded PDFs live
   before the sweeper expires them? 30 days is the assumed default until
   told otherwise.
2. **Per-user concurrency cap.** A single cap (e.g. 5 concurrent jobs) is
   assumed; the alternative is per-tier, which implies tiers exist, which
   implies #105's Standard/Flex split lands first.
3. **Domain and email sender.** Both are external dependencies with lead
   time; naming them early avoids blocking M2.

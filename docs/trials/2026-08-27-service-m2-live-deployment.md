# M2 live control-plane deployment

**Date:** 2026-08-27

**Branch baseline:** `a7e1f13` plus `service/m2-live-deployment`

**Contract:** `docs/design/2026-08-26-service-m2-api-contract.md`

**Decision:** PASS for an invite-only, parse-only v1

## Scope

This trial connects the already-tested M1 job plane and M2 HTTP/identity
components through real public infrastructure. It does not qualify enrichment,
billing, organizations, progressive page delivery, or a second compute
provider.

The deployed path is:

```text
browser -> Cloudflare Access -> app.pagespatial.dev --+
                                                      +-> Tunnel -> API -> Postgres 18
API key client -------------> api.pagespatial.dev ----+                  |
                                                                         +-> R2
                                                                         +-> Modal CPU worker
```

The VPS runs three isolated Compose services: API, PostgreSQL 18, and
`cloudflared`. Neither the API nor Postgres publishes a host port. Existing
unrelated VPS applications were not modified.

The owner chose PostgreSQL 18 on the VPS for this first value-proof instead of
managed Postgres. This is cheaper and sufficient for the gate, but it is a
single point of failure. The result is not an HA or managed-database claim.

## Positive path

One invited user authenticated with Cloudflare Access one-time PIN, created an
API key, and ran the full public path:

```text
submit -> presigned PUT -> finalize -> queued dispatch -> Modal parse
-> reconcile -> succeeded -> presigned GET -> validate public envelope
```

| Measurement | Result |
| --- | --- |
| Input | World Bank fixture, 3 pages, 139 KiB |
| Job id | `3c987239-4505-4e3d-91ff-fe9c21bc4278` |
| Submit-to-result elapsed | 143,480 ms, including cold start |
| Page outcomes | 3/3 `ok` |
| Public-envelope validation | PASS with production `validateStoredResult` |
| Public top-level fields | `attempt_id`, `execution_id`, `input_sha256`, `job_id`, `page_count`, `pages`, `schema_version` |
| Estimated cost field | 3,000 USD micros; placeholder price, not measured billed compute |

The created key was revoked after the run. The same secret then returned 401.

## Negative and recovery matrix

| Case | Required observation | Result |
| --- | --- | --- |
| Cross-tenant job read | 404 | PASS |
| Idempotent replay | original job returned | PASS |
| Admission fuse | 429 with `Retry-After: 60` | PASS |
| Upload expiry | expired upload refused | PASS |
| Result expiry | download grant refused | PASS |
| Forged Access email header | no dashboard access | PASS |
| API key in query string | rejected | PASS |
| Suspended owner | rejected | PASS |
| Wrong input digest | typed `input_digest_mismatch` | PASS |

The expiry test initially attempted to backdate only `upload_expires_at` and
correctly hit the database constraint that ties it to `created_at`. The final
test backdated both fields while preserving the invariant and then observed the
required public behavior.

## R2 trust boundary

The final live matrix used four independent roles:

| Role | Input bucket | Result bucket | Result |
| --- | --- | --- | --- |
| Modal input | GET only | denied | PASS |
| Modal result | denied | GET and PUT | PASS |
| API input | GET and PUT | denied | PASS |
| API result | denied | GET only | PASS |

The first live API probe found that the API result role had reused the worker's
read/write result credential. Startup separation checked identities and buckets
but could not prove provider ACLs. A new account token scoped to read-only on
the result bucket replaced it. The API container was recreated and the entire
matrix was rerun; all allowed and denied operations then passed. This is why
the live denial probes remain required.

Both input and result buckets have two-day lifecycle rules. The PostgreSQL
backup bucket has a seven-day rule.

## Database recovery evidence

A manual `pg_dump -Fc` archive was uploaded off-site, downloaded byte-exact,
and restored into a temporary PostgreSQL database. The restored database had
five migrations and two jobs. Archive size was 18,584 bytes; SHA-256 was
`d757d45837b63039081718ba2d7b9387879151c0112ba4814c6f7a3c698cd699`.

This proves the restore procedure once. It does not prove scheduled backups,
an RPO, an RTO, or VPS failover. Until a schedule exists, the current RPO is
unbounded. Backup automation remains required before the service carries
valuable production history.

## Final state and limits

- Public health returned `ready`; R2 input, R2 result, and Modal degradation
  flags were all false.
- The R2 flags came from live provider calls. After the first successful Modal
  lookup, `degraded.modal: false` means the process retains a previously
  obtained method handle; it is not a fresh Modal reachability measurement.
  Spawn and inspection failures remain the authoritative runtime signal.
- API and PostgreSQL containers were healthy, the Tunnel connector was
  running, and no host ports were published.
- Temporary users, keys, and jobs were removed. Probe objects were deleted.
- The live job's retention timestamp was restored to the future.
- The qualification API key was revoked.
- Modal remains scale-to-zero, so an idle burst can pay roughly 70–102 seconds
  of observed cold readiness.
- Parsing is capped at 90 MiB input and 200 pages. Results and inputs expire
  after up to two days.
- The service is invite-only and parse-only. Enrichment remains off.

M2 is therefore demonstrated as a working public invite-only control plane,
not merely as independently tested components. M3 may improve presentation; it
must not introduce another job lifecycle.

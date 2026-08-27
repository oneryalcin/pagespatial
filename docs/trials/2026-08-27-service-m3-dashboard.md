# M3 customer dashboard deployment

**Date:** 2026-08-27

**Implementation:** `006e394`, PR #115, merged as `c97cb45`

**Contract:** `docs/design/2026-08-27-dashboard-product-brief.md`

**Decision:** PASS

## Scope

M3 adds presentation to the qualified M2 control plane. It does not add a job
lifecycle, queue, worker provider, browser upload, billing system, enrichment,
organization model, or JavaScript client. Cloudflare Access remains the login
surface. The origin serves authenticated, tenant-scoped HTML and one local CSS
file.

The deployed areas are:

- Jobs: newest-first timeline, state/date filters, fixed 25-row pagination,
  truthful non-terminal values, and tenant-scoped detail;
- Results: fresh five-minute grants for retained accepted results and an
  explicit expired state;
- Usage: current UTC month, succeeded jobs only, with the required estimated
  cost caveat adjacent to the values;
- API keys: create, one-time secret display, explicit revoke confirmation,
  and tenant-scoped history;
- API guide: the actual presigned upload, finalize, poll, and download flow.

## Verification

| Gate | Result |
| --- | --- |
| Core repository suite | 375 pass, 0 fail, 2 skipped |
| API suite without native Postgres | 103 pass, 0 fail, 2 skipped |
| API suite against PostgreSQL 18.6 | 113 pass, 0 fail |
| Schema verification | current |
| Desktop render | PASS at 1440 px |
| Tablet render | PASS at 768 px |
| Mobile render | PASS at 390 px; records replace the table |
| Public dashboard without Access session | Cloudflare Access 302, PASS |
| Public API health | HTTP 200, ready |
| Host separation | dashboard path on API host returned JSON 404, PASS |
| Live Compose state | API and PostgreSQL healthy; Tunnel running |

The responsive render used representative uploading, queued, dispatched,
succeeded, and failed jobs. Non-terminal and failed rows showed em dashes for
unknown pages and cost. Only the succeeded row showed terminal pages and
estimated cost. Red was reserved for failure.

## Live deployment

Only the five changed dashboard runtime files were copied into the isolated
`/home/ubuntu/pagespatial-control-plane` build context. Only the API image and
container were rebuilt. The PostgreSQL container, named volume, Tunnel, and
unrelated VPS application were not modified.

The API image exported as
`sha256:6a3b428df4b40c4a4c74b39d0d759b442e83426f187f003daf8e35fb23d4b29c`.
The recreated API container became healthy. `app.pagespatial.dev/jobs` and
`/dashboard.css` remained protected by Cloudflare Access, while
`api.pagespatial.dev/health` returned 200.

The authenticated Access login path and API-key lifecycle were already proven
end to end in M2.4 and were unchanged by M3. This gate re-ran the dashboard
handler against both PGlite and PostgreSQL 18, then verified the deployed
Cloudflare boundary and container health. It does not claim a second live
human-login trial.

## Product boundary

The UI is deliberately server-rendered and functional without JavaScript.
Search, command shortcuts, a search overlay, browser upload, charts, and
custom sign-in pages remain future product questions, not dormant controls.
Cloudflare owns unauthenticated sign-in for this deployment profile.

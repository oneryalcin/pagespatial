# Compact result viewer and schema guide

Date: 2026-09-02
Status: built and tested on `feat/compact-result-viewer`; not deployed

## Decision

Build Stage B before the retention gate so it can be reviewed and tested, but
do not merge or deploy the compact-default API change before
2026-09-04T16:07:01Z and the retained-success companion audit.

The result viewer reads only the compact derived object. Full evidence remains
authoritative and requires an explicit download. The control plane still does
not proxy result bytes.

## Built

- `GET /v1/jobs/{job_id}/result` defaults to compact on this branch.
- `view=compact` and `view=evidence` are the only accepted selectors.
- Grants identify one representation, version, digest, byte count, and expiry.
- The authenticated dashboard has a compact result viewer and two distinct
  JSON downloads.
- The viewer fetches one compact object and mounts one selected page at a time.
- The viewer checks the accepted byte count and SHA-256 digest before JSON
  parsing. Objects above the 16 MiB browser-display bound remain downloadable
  but are not rendered.
- Markdown uses self-hosted, pinned `markdown-it` with raw HTML disabled, then
  self-hosted, pinned DOMPurify with an explicit allowlist.
- Result reads use exact-origin R2 CORS, strict CSP, `no-store`, and
  `Referrer-Policy: no-referrer`.
- `docs/result-envelope-guide.md` documents the closed compact envelope,
  evidence boundary, compatibility rule, and TypeScript and Python use.

## Tested

Focused tests cover compact/evidence selection, duplicate and unknown query
parameters, tenant ownership, retention, not-ready and failed states, known
and inspected byte counts, exact CORS, CSP, no-store behavior, no presigned URL
in HTML, and the locally bundled viewer dependencies.

Browser-like adversarial fixtures cover raw and malformed HTML, JavaScript and
encoded protocols, image handlers, SVG, MathML, CSS, forms, and a known nested
sanitizer-bypass shape. The viewer relies on the accepted digest and the
sanitizer rather than a browser-side schema literal: it type-checks only the
fields it reads, tolerates extended envelopes, exposes only allowlisted
provenance, and removes the previous page when navigation changes.

The schema-guide JSON example parses and its successful page validates against
the generated compact schema.

`npm run check` passed. The API suite also passed all 138 tests against a
temporary native PostgreSQL 18.6 server, including migration, concurrent
admission, and accepted-result races. A final focused viewer, dashboard,
selector, and guide run passed all 35 tests after the no-JavaScript fallback
change.

A real headless-browser render passed at 1440, 768, and 390 CSS pixels with no
horizontal overflow, one document-level `h1`, one mounted page container, and
working three-page position state. The fixture included native-rich, OCR-only,
multi-page, tabular, and failed-page outcomes; automated DOM tests exercise
navigation and the failed-page shape.

## Deployment gate

This branch is not production authority. Before merge or deployment:

1. Wait until at least 2026-09-04T16:07:01Z.
2. Verify every retained succeeded job created after Stage A activation has a
   valid compact URI, digest, and positive byte count bound to its accepted
   attempt.
3. Notify alpha users that omitted `view` changes from evidence to compact.
4. Apply and verify the exact result-bucket CORS policy.
5. Run the live two-user Access and live R2 grant/CORS matrix.

If the retained-success audit finds any missing companion, stop. Fix Stage A;
do not add a fallback from compact to evidence.

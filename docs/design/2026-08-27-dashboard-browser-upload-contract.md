# Dashboard browser upload implementation contract

**Date:** 2026-08-27  
**Status:** accepted implementation slice  
**Parent:** `2026-08-27-dashboard-product-brief.md`

## 1. Decision

Add one browser path for submitting one PDF from the Access-protected
dashboard. This is a deliberate amendment to the M3 brief's API-only intake
boundary. The API-key workflow remains supported and unchanged.

The dashboard does not receive, persist, or expose an API key. An authenticated
Cloudflare Access identity calls narrow same-origin dashboard routes. Those
routes invoke the existing job-plane operations used by the public API:

1. create or replay a job;
2. mint a one-hour presigned R2 `PUT` grant;
3. finalize the uploaded object;
4. redirect to the existing job detail page.

There is still one job ledger, one input object, one dispatcher, and one
reconciler.

## 2. User flow

`GET /jobs/new` renders an Ivory Ledger page with:

- one PDF file control;
- the current limits: 90 MiB, 200 pages, one-hour upload window;
- a submit button;
- an accessible status region and a real byte-upload progress indicator.

On submit, the browser:

1. rejects an empty selection or a file larger than 90 MiB before upload;
2. materializes one `ArrayBuffer` and calculates lowercase SHA-256 with Web
   Crypto;
3. creates a random idempotency key for this page attempt;
4. calls `POST /jobs` with the digest;
5. uploads the PDF directly to the returned R2 URL with the exact signed
   `Content-Type: application/pdf` header;
6. calls `POST /jobs/{id}/finalize`;
7. navigates to `GET /jobs/{id}`.

The progress indicator measures bytes sent to R2. It must never imply parse
progress, completion percentage, or an ETA. After finalization the ordinary job
state is authoritative.

## 3. Browser contract

The dashboard host adds two JSON mutation routes:

- `POST /jobs`
  - exact body: `{ "input_sha256": "<64 lowercase hex>" }`
  - required header: `Idempotency-Key`
  - response: the existing `{ job, upload }` shape
- `POST /jobs/{job_id}/finalize`
  - exact body: `{}`
  - response: the existing `{ job }` shape

Both routes require a valid Access JWT and the exact
`Origin: https://app.pagespatial.dev`. They are tenant-scoped through the
Access identity. They call `createOrReplayJob()` and `finalizeJob()` directly;
they do not proxy through the public API and do not synthesize API credentials.

Application failures from these two routes use the existing safe
`ErrorResponse` JSON shape and always include `X-Request-ID`. HTML pages and
ordinary form routes keep HTML errors. The browser must show a generic
session-or-service failure when Access or another intermediary returns a
redirect or non-JSON response.

The browser script is a same-origin static asset. The CSP adds only:

- `script-src 'self'`;
- `connect-src 'self' <exact configured R2 input origin>`.

No inline script, external script, analytics, service worker, or browser
storage is required.

## 4. R2 boundary

The input bucket CORS rule is exact:

```json
[
  {
    "AllowedOrigins": ["https://app.pagespatial.dev"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["Content-Type"],
    "MaxAgeSeconds": 3600
  }
]
```

The presigned URL remains the authorization boundary. CORS only permits the
browser origin to use that already-scoped URL; it grants no bucket credential.
The input credential and bucket ACL matrix remains unchanged.

## 5. Failure behaviour

- Hashing failure: keep the selected file and allow retry.
- Job creation failure: show the public-safe API message and request id. Reuse
  the same in-memory idempotency key after an ambiguous failure; do not mint a
  new key for the same selected-file attempt.
- R2 upload failure: report that the upload did not complete; reuse the same
  in-memory job grant while it is valid when the user retries.
- Finalize failure: retry finalize without uploading again when possible.
- Page refresh or navigation: the browser `File` object is lost. The abandoned
  `uploading` job expires through the existing one-hour sweep. The user selects
  the file again and starts a new submission.

After a create replay, an upload grant means continue with the PUT. A job that
is already queued, dispatched, succeeded, or failed navigates to its detail
page. An uploading job without a usable grant is expired or inconsistent and
must show a restart action; it must not attempt a null URL or pretend upload is
complete.

The browser does not guess whether an expired presigned request was CORS,
network, or signature failure. R2 can omit CORS headers on expired presigned
responses. The UI reports a bounded upload failure and lets the user retry.

## 6. Explicit non-goals

- multiple files or batch submission;
- drag-and-drop framework;
- resumable or multipart upload;
- client-side PDF parsing or page counting;
- API-key storage in cookies, HTML, JavaScript, or browser storage;
- a second job state machine;
- fake parse progress, progress animation, or ETA;
- background upload after page navigation;
- support for browsers without Web Crypto.

The 90 MiB cap makes `file.arrayBuffer()` acceptable for this first slice. If
real browser memory measurements show a problem, a streaming hash is a later
measured optimization, not a prerequisite.

## 7. Acceptance

The slice is complete when tests and a live browser prove:

1. Access identity can create, upload, finalize, and reach the owned job page.
2. The browser never receives an API key or R2 account credential.
3. A foreign or missing Origin is rejected before mutation.
4. A foreign tenant cannot finalize or inspect another tenant's job.
5. The 90 MiB browser precheck does not replace the existing server and
   database limits.
6. The upload request sends the exact signed content type.
7. R2 permits the configured dashboard origin and rejects a foreign origin.
8. The status region and progress element have accessible labels; keyboard-only
   submission works.
9. No CSP relaxation beyond the exact same-origin script and input-R2 connect
   origins is present.
10. API-key submission and the existing dashboard remain green.

## 8. Stop condition

After this vertical slice passes, stop. Do not add batch upload, resumability,
or a client framework until observed user behaviour makes one necessary.

# parse-service

Remote parsing on the PageSpatial library (issue #22): submit a PDF, get a
job ticket, poll progressive schema-0.6.0 page records. No indexing, no
browser. Exists to measure per-stage cost; see
`docs/trials/2026-08-22-parse-service-skeleton.md` for current numbers.

```
npm run build                  # service consumes dist/
node service/server.mjs        # PORT=8571 SERVICE_WORKERS=2 SERVICE_DATA_DIR=service/data

curl -X POST :8571/v1/jobs -H 'content-type: application/json' -d '{"pdfPath":"/abs/doc.pdf"}'
curl -X POST :8571/v1/jobs -H 'content-type: application/pdf' --data-binary @doc.pdf
curl :8571/v1/jobs/<jobId>              # status + pages as they complete
curl :8571/v1/jobs/<jobId>/pages/3      # one page
curl :8571/v1/metrics                   # per-stage p50/p95, pages/sec, rss

node service/loadtest.mjs --base http://localhost:8571 a.pdf b.pdf   # bottleneck table
```

Until issue #2 delivers the server-native PP-OCR adapter, the OCR slot runs
a `canonical: false` stub: results carry stage timings and counts only —
**never** a `pageSpatial` record (a stub witness must not produce
evidence). Real records + the Tesseract second-opinion rung switch on when
a canonical adapter is configured via `SERVICE_OCR_ADAPTER`.

Job state is on disk under `SERVICE_DATA_DIR` (restart-resumable; state
writes are atomic temp+rename). Page failures are fail-closed per page
(#37): failed entry after 2 attempts, siblings unaffected. Job dirs
contain corpus-derived text — keep the data dir out of git and treat it
as private.

## Trust model (v1)

This service binds to localhost for a **trusted caller** — there is no
authentication, and none is pretended. Two consequences:

- **`pdfPath` mode is a dev convenience that MUST NOT survive to
  production**: it is an arbitrary server-file read plus a file-existence
  oracle for whoever can reach the port. The production ingress is bytes
  upload (or a fetch-from-object-store variant), never a caller-supplied
  server path.
- Request bodies are capped at 100 MB (413 beyond); malformed JSON is a
  400; uploads that fail to open as PDFs are deleted immediately.

Document identity is pinned at submission (sha256) and holds **by
construction**: when a worker opens a document it snapshots the bytes to a
context-private copy, and every stage — pdf.js, pdf-inspector, pdftoppm
render, Tesseract — reads that copy, never the live path. The worker also
fails a page closed if the on-disk file no longer matches the pinned hash
at context-open time. A file mutated after submission can therefore never
mix a second document into a job's records.

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

The canonical OCR witness is the server-native PP-OCRv6 adapter (issue #2,
witness-equivalence verified — node-worse bounded at 0.5% of gold at 95%):

```sh
SERVICE_OCR_ADAPTER=ppocr-server \
SERVICE_OCR_ASSETS_DIR=/path/to/ocr-assets-small \  # required, explicit
SERVICE_OCR_VARIANT=small \      # default; the evaluation-parity tier
SERVICE_OCR_THREADS=4 \          # default; measured better than 1 (trial doc)
node service/server.mjs
```

The backend is **pinned** from this config — no `auto` anywhere — and every
record's provenance carries the full descriptor
(`ocrAdapter: "ppocrv6-small-node@0.4.2#ep=wasm;threads=4"` plus a
machine-readable `configuration.ocrBackend`). The default adapter remains
the `canonical: false` stub (tests/load scaffolding): stub results carry
stage timings and counts only — **never** a `pageSpatial` record (a stub
witness must not produce evidence). `GET .../pages/:n.svg` serves the #51
deterministic reconstruction for canonical pages.

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

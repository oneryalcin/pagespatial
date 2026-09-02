# parse-service

Remote parsing on the PageSpatial library (issue #22): submit a PDF, get a
job ticket, poll progressive schema-0.6.0 page records. No indexing, no
browser. Exists to measure per-stage cost; see
`docs/trials/2026-08-22-parse-service-skeleton.md` for current numbers.

```
npm run build                  # service consumes dist/
SERVICE_ALLOW_PDF_PATH=1 node service/server.mjs   # PORT=8571 SERVICE_WORKERS=2 SERVICE_DATA_DIR=service/data
# (SERVICE_ALLOW_PDF_PATH=1 enables the JSON pdfPath dev mode used by the
# first curl below and by loadtest.mjs; default-off — see Trust model.)

curl -X POST :8571/v1/jobs -H 'content-type: application/json' -d '{"pdfPath":"/abs/doc.pdf"}'
curl -X POST :8571/v1/jobs -H 'content-type: application/pdf' --data-binary @doc.pdf
curl :8571/v1/jobs/<jobId>              # status + pages as they complete
curl :8571/v1/jobs/<jobId>/pages/3      # one page
curl :8571/v1/metrics                   # per-stage p50/p95, pages/sec, rss
curl :8571/health                       # readiness (below); 503 until ready
# NB: metrics rss is the NODE worker only — the sidecar's Python engine is
# a separate process. Measured on target hardware (linux/amd64, OpenVINO;
# docs/trials/2026-08-23-linux-verification.md): ~2.7 GB per worker-pair
# amortized (cgroup total 10.9 GB for server + 4 workers + 4 sidecars).

node service/loadtest.mjs --base http://localhost:8571 a.pdf b.pdf   # bottleneck table
```

## Container (the deployment unit)

The committed `Dockerfile` is the deployment unit — **linux/amd64 only**
(OpenVINO HPI is x86-only; an arm64 build truthfully reports
`ep=paddle-default` and must never serve as the production image or the EP
control):

```sh
docker build --platform=linux/amd64 -t pagespatial-service .
# -p 127.0.0.1:8571:8571 — a bare `-p 8571:8571` publishes on ALL of the
# HOST's interfaces, re-opening exactly the exposure the loopback default
# closed. Bind wider only behind your own gateway.
docker run --init -p 127.0.0.1:8571:8571 pagespatial-service
```

`--init` (or a tini entrypoint) is **part of the shutdown contract**, not a
nicety: PID 1 changes default signal handling and orphan reaping. The
graceful path is init-independent — SIGTERM makes `ParseService.shutdown()`
await every worker child's exit (bounded, SIGKILL escalation), and each
worker's exit hook group-kills its Python sidecar — but the SIGKILL
fallback path reparents detached Python groups to PID 1, and a non-reaping
Node PID 1 would accumulate zombies. **Honest caveat:** the M1 Linux
verification ran on Modal, which skips `USER` and substitutes its own
(gVisor) init — so the non-root user and the plain
`docker run --init` reaping path are built but not yet exercised; smoke
them on the first real Docker host (trial doc, criterion 4 notes).

Baked into the image, failing the BUILD rather than the boot: pinned model
weights (`fetch_models.py` verify mode — any hash mismatch aborts the
build) and the engine-pin assertion (`scripts/assert-engine-pins.mjs` —
the pip pins must equal `DEFAULT_PYTHON_CMD`'s versions, so weights AND
engine stay inside the ceremony-validated lineage). The image sets
`SERVICE_SIDECAR_PYTHON` to the baked venv interpreter — no uv, no network
at boot. Non-root user; `.dockerignore` keeps `.evaluation/` and all
corpus-derived data out of the build context. Engine pins and weight pins
live in different files by design: versions in `DEFAULT_PYTHON_CMD`
(`service/adapters/ppocr-sidecar.mjs`), weight hashes in
`service/sidecar/model-pins.json` — the build asserts they travel
together.

## GET /health — readiness gates traffic

`/health` answers 200 only after, in order: model pin hashes verified, a
sidecar child spawned per worker and its meta line received (in-band
`useHpip` — this is where `ep=` comes from), and one real warm-up
inference round-tripped per worker. Until then (and on warm-up failure) it
answers 503 with the failure detail in `error`. Point the orchestrator's
readiness probe here: a container must never receive work with a broken
engine. Budget the warm-up honestly — measured boot-to-ready with the
baked interpreter is **70–88 s** on a cold Linux container (HPI engine
build dominates; a respawned worker in a warm container re-warms in ~5 s
because the OpenVINO engine cache survives); with the uv default it can
additionally include a package resolution.

Target-hardware performance (linux/amd64, OpenVINO `ep=hpi`; full
162-page corpus; `docs/trials/2026-08-23-linux-verification.md`, unit
correction applied — Modal's `cpu=N` is **N physical cores**, not
vCPUs): **3.0–5.5 requested-physical-core-s/page full-pipeline**
(shared-tenancy range). On one allocation of four physical cores, four
one-thread workers beat one four-thread worker by 2.7–4.9×. That is a
single-allocation result: it does **not** establish one-vCPU-per-worker
packing on other platforms, and fleet linearity is unmeasured. These
figures supersede the earlier Mac/WASM and ad-hoc Modal numbers.

## OCR witnesses

**The ADOPTED canonical witness is the PaddleOCR sidecar** (issue #2 owner
decision; ceremony PR #67 — candidate-worse vs browser bounded at 0.74%
of gold at 95%, 2/1,223 discordant vs the node port):

```sh
# once per host: fetch + verify the PINNED models (revisions + sha256 in
# service/sidecar/model-pins.json — committed; det revision was observed
# in the ceremony itself, the rec pin is BEHAVIORALLY VALIDATED by the
# integrated-path sanity check; a mismatch refuses to serve)
uv run --with huggingface_hub python service/sidecar/fetch_models.py \
  --models-dir /path/to/sidecar-models

SERVICE_OCR_ADAPTER=ppocr-sidecar \
SERVICE_SIDECAR_MODELS_DIR=/path/to/sidecar-models \  # required, explicit
SERVICE_SIDECAR_THREADS=4 \   # bare-server default is 1; the production image sets 4. The PR #66 "one-thread wins" result was measured under an uncontrolled 10-thread OpenVINO pool (docs/trials/2026-09-02-ocr-sidecar-thread-sweep.md)
node service/server.mjs
```

Each page-worker owns one Python child (JSONL over stdin/stdout, pages as
tmpfiles; a page that gets no reply within `recognizeTimeoutMs` — 120 s
default — kills the child and fails closed). The child launcher defaults
to `uv run --with paddleocr==3.7.0 --with paddlepaddle==3.2.1 python`;
**for production prefer a prepared venv with a direct interpreter**
(`SERVICE_SIDECAR_PYTHON="python3"`, or the JSON-array form for paths
with spaces: `SERVICE_SIDECAR_PYTHON='["/opt/my venv/bin/python3"]'`) —
a wrapper like uv spawns python rather than exec'ing it, which is why
child cleanup kills the whole process group, and the first uv run on a
cold cache downloads ~1 GB (pre-warm before serving).
Boot fails closed: Node-side pin verification plus a real child `--check`
(imports, child-side pin verification, pipeline construction;
`SERVICE_SIDECAR_SKIP_BOOT_CHECK=1` for pre-warmed hosts that would rather
fail on the first page). There is NO silent fallback from a configured
sidecar to any other adapter.

Provenance is truthful per host: `enable_hpi` engages on Linux
(`ep=hpi`); elsewhere the pipeline runs paddle-default and the descriptor
says so (`ppocrv6-small-sidecar@3.7.0#ep=paddle-default;threads=1`).
`configuration.ocrBackend` carries the machine-readable block including
`modelPins` (repo → revision) and `engineEvidence` (the C++
backend-selection line, captured from child stderr and labeled
log-derived — the C++ layer bypasses Python logging).

The **validated fallback** is the server-native WASM adapter (node-worse
bounded at 0.5% of gold at 95%):

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

## Escalated-tier enrichment (opt-in, paid)

Design: `docs/design/2026-08-23-service-deployment-and-enrichment.md`
(workstream 2). Submit with `?enrichment=batch` (bytes mode) to run a
second phase after parse: qualifying pages (blocking escalation reasons
only) are routed through the shared request-plan builder, rendered at
**150 dpi** (a second pdftoppm pass — never the parse raster), and
submitted to Gemini through the **Batch API only** (50% pricing; zero
interactive calls, test-enforced). Results land as separate digest-bound
revision records under `<jobDir>/enrichment/` — canonical page records
are never touched, and `pages/` never gains a non-page file.

```
curl -X POST ':8571/v1/jobs?enrichment=batch' -H 'content-type: application/pdf' --data-binary @doc.pdf
curl :8571/v1/jobs/<jobId>                      # + enrichmentStatus, per-page enrichmentState
curl :8571/v1/jobs/<jobId>/pages/3/enrichment   # the revision record; 404 when none
```

Measured on the container over the full development corpus
(`docs/trials/2026-08-23-m4-corpus-enrichment.md`): **$0.001458 per
enriched page** (150 dpi, batch pricing — within 0.3% of the committed
ladder), enrichment CPU ~3% of parse CPU (the second 150 dpi render pass
~0.34 core-s/page), wall time dominated by Gemini batch turnaround
(chunk p50 ~3.5 min), `/v1/metrics` counters exactly equal to the job
manifests.

Enrichment is **fail-open**: Gemini down, over budget, or malformed means
the job still completes with `enrichmentStatus: unavailable`. Inside it,
staleness fails closed: a re-parsed page's stored enrichment goes
`stale` and is never served. The server owns batch polling; a restart's
boot sweep rejoins persisted batch operations from the manifest and never
resubmits paid work.

Env: `GEMINI_API_KEY` (environment only), `ENRICH_MAX_PAGES_PER_JOB`
(default 200; beyond it the job runs parse-only with a stated reason),
`ENRICH_MAX_CONCURRENT_CHUNKS` (default 4, service-wide; phase B queues,
phase A of new jobs proceeds), `ENRICH_SPEND_CEILING_USD` (default 10 per
process lifetime; surfaced in `/v1/metrics`), `ENRICH_MAX_ENTRIES_PER_CHUNK`
(default 24 requests per batch submission).

**Privacy/egress**: enrichment transmits rendered page images to the
Gemini API — use only where remote processing of the documents is
authorized. `enrichment=batch` is refused (400) for `pdfPath`-submitted
jobs: with enrichment on, a caller-named server path would become a
data-egress primitive. Bytes are re-verified against the job's
`documentSha256` immediately before transmission.

## Trust model (v1)

This service is built for a **trusted caller** — there is no
authentication, and none is pretended. Correction (2026-08-23, cold
review): earlier versions of this section claimed the service "binds to
localhost" while the code listened on **all interfaces**. The bind is now
loopback (`127.0.0.1`) by default; set `HOST` explicitly to bind wider.
The container image sets `HOST=0.0.0.0` because a loopback bind would
make the published port unreachable — and note the boundary is then
wherever docker publishes it: a bare `-p 8571:8571` binds ALL of the
host's interfaces, so publish as `-p 127.0.0.1:8571:8571` unless a
gateway you control fronts the port. Two consequences:

- **`pdfPath` mode is OFF by default** (`403` unless
  `SERVICE_ALLOW_PDF_PATH=1`): it is an arbitrary server-file read plus a
  file-existence oracle for whoever can reach the port, and it MUST NOT
  survive to production. The production ingress is bytes upload (or a
  fetch-from-object-store variant), never a caller-supplied server path.
- Request bodies are capped at 100 MB (413 beyond); malformed JSON is a
  400; uploads that fail to open as PDFs are deleted immediately.

Document identity is pinned at submission (sha256) and holds **by
construction**: when a worker opens a document it snapshots the bytes to a
context-private copy, and every stage — pdf.js, pdf-inspector, pdftoppm
render, Tesseract — reads that copy, never the live path. The worker also
fails a page closed if the on-disk file no longer matches the pinned hash
at context-open time. A file mutated after submission can therefore never
mix a second document into a job's records.

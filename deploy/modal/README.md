# Modal adapter (M1 skeleton + M2 instruments)

Deployment adapter per [the Modal design](../../docs/design/2026-08-23-modal-scaling-and-deployment.md).
One Modal asynchronous input owns one document; a warm `modal.Cls` container
starts the existing Node service once and drives it over loopback HTTP.
Parse-only. No public URL, no web endpoint, no shared Volume, enrichment off.

## SDK pin

Deployed with **Modal SDK 1.5.3** (`modal client version: 1.5.3`,
Python 3.13 via `uv tool install modal`). The warm-lifetime retirement path
uses `modal.experimental.stop_fetching_inputs()`, verified present in this
version and isolated in one helper (`stop_fetching_inputs` in
`modal_app.py`); re-verify it before bumping the SDK.

## Commands

All from the repository root, authenticated against the `desia` workspace:

```bash
# Deploy (builds the committed Dockerfile on Modal; first build is slow —
# the paddle/OpenVINO layer is ~2 GB):
modal deploy deploy/modal/modal_app.py

# M1 acceptance: two sequential asynchronous calls against the DEPLOYED
# app with a generated non-corpus PDF; asserts warm reuse on call 2:
modal run deploy/modal/modal_app.py::acceptance

# Tear down when done (M1 leaves nothing running: min/buffer containers 0):
modal app stop pagespatial-parse-m1-dev

# Helper unit tests (no Modal SDK required — stubbed):
python3 deploy/modal/test_modal_app.py

# parse_document integration matrix against a FAKE loopback service
# (failure paths reachable and bounded; no Modal SDK, no Node service):
python3 deploy/modal/test_modal_integration.py
```

Each qualification trial arm gets its own app tag (§10), e.g.:

```bash
PAGESPATIAL_MODAL_APP_NAME=pagespatial-parse-arm4-dev \
  modal deploy deploy/modal/modal_app.py
```

## Invocation

No Docker `CMD`/`USER` assumption: Modal ignores both, so `@enter` starts
`node service/server.mjs` explicitly, bound to `127.0.0.1:8571`, with a
fresh private `SERVICE_DATA_DIR` under `/tmp`, the measured topology
(4 workers x 1 sidecar thread), `SERVICE_MAX_PAGES_PER_JOB=200`, no
`GEMINI_API_KEY`, and `SERVICE_ALLOW_PDF_PATH` unset.

Callers use the Modal Python client:

```python
import modal
ParseContainer = modal.Cls.from_name("pagespatial-parse-m1-dev", "ParseContainer")
handle = ParseContainer().parse_document.spawn({
    "request_id": "…",            # caller-generated, non-empty, <=256 chars
    "pdf_bytes": pdf_bytes,        # non-empty, <=90 MiB
    "source_uri": "optional non-secret label",
    "expected_sha256": "…",       # 64 lowercase hex; recomputed and checked
    "schema_version": "0.6.0",
    "enrichment": "off",           # anything else is rejected
})
result = handle.get()
```

Output shape, bounds, and failure semantics are §7.1 of the design doc.
`pdfPath` is never accepted. A serialized result over 64 MiB returns a
visible `ResultTooLarge` failure — never truncated pages.

## Operational limits (qualification limits, not product promises)

| limit | value |
|---|---|
| Function input | 90 MiB, non-empty |
| pages per document | 200 (`SERVICE_MAX_PAGES_PER_JOB`, refused 400 by the service) |
| serialized result | 64 MiB (visible `ResultTooLarge`) |
| input concurrency per container | 1 |
| created Node jobs per warm lifetime | 100, then the container stops fetching inputs |
| `cpu` / `memory` | 4.0 physical cores / 24,576 MiB |
| `startup_timeout` / method `timeout` | 1,200 s / 1,800 s (explicit) |
| `retries` | 1 |
| `min_containers` / `buffer_containers` / `max_containers` | 0 / 0 / 1 (default; M3 arms set `PAGESPATIAL_MAX_CONTAINERS` to allowlisted 1/4/16 at deploy time — any other value refuses to deploy) |

A dead Node child, degraded `/health`, low disk, or an exceeded parse
deadline **retires** the warm instance (stop fetching inputs, then fail);
there is no in-place repair. Scratch is swept at method entry and cleaned
in `finally`; nothing survives container replacement.

## Observability (§12)

Every method result carries: `request_id`, `document_sha256`, `page_count`,
`status`, `pages`, `pages_ok`/`pages_failed`, `failure`, `timing`
(`container_cold`, `queue_wait_ms`, `service_ready_ms`, `parse_ms`,
`total_method_ms`), `retry` (`attempt`, `function_call_id`, `input_id`),
`resources` (`cpu`, `memory_mib`, `workers`, `sidecar_threads`),
`app_name`, `adapter_revision` (deploy-time git rev), and
`image_pin_revision` (digest of Dockerfile + package-lock.json +
service/sidecar/model-pins.json + fetch_models.py — a model-pin-only
commit changes it). Note: the Dockerfile's base images are pinned by
mutable tag, not digest, so `image_pin_revision` covers repo-controlled
pins only; a silently-moved base tag is not detectable from it.

Every structured log event carries the same identity context (app name,
both revisions, resources) plus the current method context (request id,
sha prefix, cold/warm, call/input ids).

Two documented caveats:

- **Cold readiness lives in logs, not results.** `timing.service_ready_ms`
  is nonzero only on the container's FIRST method call; if that first call
  is rejected before returning a result, readiness appears ONLY in the
  `service_started` log event. Aggregation therefore reads readiness from
  container logs (`scripts/evaluation/reconcile-modal-run.mjs` does; §12
  permits it).
- **No per-input retry counter.** The pinned SDK exposes none, so
  `retry.attempt` is always `null`; the reconciler counts attempts from
  repeated `job_submitted` log events sharing one request id. That means
  only retries that reached the loopback POST are counted — a retry that
  fails BEFORE submit (e.g. the injected application exception) surfaces
  only in the `injected_failure`/`retiring` event counts, not as a
  retried input.

## Test-only failure injection (§14.2 arms 8/9)

`payload["test_failure"]` accepts `"exception"` (one forced application
exception), `"timeout"` (hang past the method timeout), or `"kill-node"`
(terminate the Node child mid-document). Double-gated — BOTH must hold or
the call is rejected with a visible `InputRejected`:

1. the image was deployed with `PAGESPATIAL_ENABLE_TEST_FAILURES=1` set in
   the deploy shell (the production deployment configuration never sets
   it, and `modal deploy` refuses the flag for any app name that is not
   `*-dev`/`*-test`); and
2. the baked app name ends in `-dev` or `-test`.

There is deliberately **no container self-kill input**: container failure
is injected externally and one-shot per §14.2
(`modal container stop --yes <container-id>`, without `--graceful`) — a
self-kill input would be rescheduled by Modal and could crash-loop.

## Lifecycle probes (§14.4 criteria 8/9 instruments)

Dev-gated exactly like injection:

- `ParseContainer().probe_scratch.remote()` — scratch content (names
  only) and disk use; `clean` means no job state and no uploaded PDF
  survives a terminal method.
- `ParseContainer().probe_exit_drain.remote()` — retires the instance,
  runs the @exit drain NOW, then reports surviving Node/worker processes
  (from `/proc`) and whether scratch was removed; `clean` requires zero
  survivors and no scratch.

## Qualification manifest and reconciliation (§14.1, §12)

```bash
# Fix the 23-document correctness manifest + deterministic 100-call
# scaling manifest (committed; hashes/counts only — corpus stays local):
node scripts/evaluation/build-modal-qualification-manifest.mjs \
  --data-root /abs/path/.evaluation
# Verify the committed manifest matches the local subset PDFs:
node scripts/evaluation/build-modal-qualification-manifest.mjs \
  --data-root /abs/path/.evaluation --check

# Reconcile a run's captured results + container logs to the manifest
# (produces the §12 trial-aggregation table; nonzero exit on silent
# missing inputs or page/sha mismatches):
node scripts/evaluation/reconcile-modal-run.mjs \
  --results /path/to/captures.jsonl --logs /path/to/container-logs/ \
  --set scaling --out aggregation.json
```

The capture harness stores, per spawned call, either the raw result object
or a wrapper `{"request_id", "kind": "result"|"exception", "result"?,
"error"?, "spawned_at_ms"?, "result_at_ms"?}`. The M3 harness MUST record
the two epoch-ms wall clocks (at `spawn()` and at result/exception
receipt): they are what makes document-completion p50/p95/max and
aggregate pages/s derivable. Container logs are one file per container —
capture them with `modal container logs --timestamps <id> > <id>.log`; the
file name becomes the container tag, the adapter's own `ts` field (or the
`--timestamps` prefix as fallback) drives containers-over-time.

Rows the reconciler cannot derive and the M3 harness must capture
alongside (the table prints them as `NOT DERIVABLE here`): container
crash/OOM counts (`modal container list/logs` + FunctionCall history),
peak ephemeral disk (`probe_scratch` during the run), queue wait (no
per-input platform metric; the spawn→first-log-event gap is the proxy),
and billed cost (billing section below).

## Billing capture (§10)

Rules for the qualification run:

- give each trial arm a **unique app tag** via
  `PAGESPATIAL_MODAL_APP_NAME=pagespatial-parse-arm<N>-dev` and run each
  arm in a **non-overlapping, completed billing interval** (record UTC
  start/end per arm);
- capture the report AFTER the arm's interval has closed (commands
  verified against the pinned CLI, `modal client version: 1.5.3` — report
  intervals are full-interval only, start inclusive / end exclusive):

  ```bash
  # Whole qualification window (MANDATORY — acceptance criterion 12):
  modal billing report --start <YYYY-MM-DD> --end <YYYY-MM-DD> \
    --show-resources --json > billing/qualification-window.json
  # Per-arm, hourly resolution over that arm's non-overlapping window;
  # attributable only when no other workspace workload shares the hours:
  modal billing report --start <arm-start> --end <arm-end> -r h \
    --show-resources --json > billing/arm<N>.json
  ```

- **aggregate billed cost for the whole run is mandatory**; per-arm billed
  cost is reported only where the billing report can attribute it — if the
  report's granularity cannot isolate an arm, label that arm's number as a
  *resource-time estimate*, never as billed cost;
- record the pricing URL (https://modal.com/pricing) and the retrieval
  date next to every dollar figure — rates change;
- do not include free credits in unit cost, and report
  `actual_cost_per_million_terminal_pages =
  billing_total_usd / terminal_pages * 1_000_000` from the billed total
  and the reconciler's terminal page count.

## Retention

Modal retains Function **inputs and outputs** (the PDF bytes and the parsed
result) for up to **7 days**. Submit only approved evaluation documents;
M1 acceptance uses a generated minimal PDF, not corpus material. A
production API owns its own retention (design §7.1, §15).

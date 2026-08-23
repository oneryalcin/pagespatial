# Modal adapter (M1 skeleton)

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
| `min_containers` / `buffer_containers` / `max_containers` | 0 / 0 / 1 (M1; M3 arms use 1/4/16) |

A dead Node child, degraded `/health`, low disk, or an exceeded parse
deadline **retires** the warm instance (stop fetching inputs, then fail);
there is no in-place repair. Scratch is swept at method entry and cleaned
in `finally`; nothing survives container replacement.

## Retention

Modal retains Function **inputs and outputs** (the PDF bytes and the parsed
result) for up to **7 days**. Submit only approved evaluation documents;
M1 acceptance uses a generated minimal PDF, not corpus material. A
production API owns its own retention (design §7.1, §15).

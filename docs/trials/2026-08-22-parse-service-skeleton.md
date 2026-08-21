# Parse service skeleton: first real per-stage numbers

**Date:** 2026-08-22 · **Branch:** `parse-service-skeleton` · **Issue:** #22 (rescoped: service without indexing)

## What shipped

`service/` — a remote parse service consuming the built library (never
entangled with `src/`): submit a PDF → job ticket → **progressive**
schema-0.6.0 page records, polled over plain HTTP. node:http with no
framework (five routes, zero middleware needs). Child-process page workers
(crash containment for the napi/pdf.js native surface + honestly
attributable RSS), in-memory queue with on-disk job state (a restarted
service resumes half-done jobs), attempt cap 2, per-page fail-closed
semantics per #37: a failing or crashing page becomes a failed entry, its
siblings are untouched, the job still completes.

The OCR slot is pluggable. Until issue #2's server-native PP-OCR adapter
lands, the shipped adapter is an explicit **stub with `canonical: false`**,
and the pipeline refuses assembly for non-canonical adapters: no
`pageSpatial` key ever appears in a stub-mode result (test-pinned, at the
serialized-bytes level) — a forged witness cannot masquerade as evidence.
Stage timings and observation counts are all a stub run emits. Assembly +
the Tesseract second-opinion path (mirroring the harness flow) are wired
for canonical adapters but **cannot run and are therefore untested until
#2 delivers one** — stated here so nobody reads the code as validated.

Rendering: pdftoppm at **fractional dpi** `72 × scale`, which makes the
raster dimensions match pdf.js's `Math.ceil` viewport geometry exactly
(612×792pt at 1.6 → 980×1268 both ways; the integer-dpi rounding mismatch
is what the first probe found). Geometry itself comes from pdf.js with the
browser renderer's exact convention (pointBounds from `page.view`,
viewportTransform from the viewport). Raster size is reported per page so
the #2 witness-equivalence run can verify the convention everywhere.

## Measured (3 corpus PDFs, 176 pages, 4 workers, M-series laptop)

| | value |
|---|---|
| end-to-end wall | 22.2 s |
| pages/sec (4 workers) | **8.86** (~2.2/worker) |
| render (pdftoppm) p50 / p95 | **295.6 / 1034.1 ms** |
| native (pdf-inspector+pdf.js) p50 / p95 | 7.7 / 603 ms |
| ocr (stub) | ~0 — **awaits #2** |
| page wall p50 / p95 | 313 / 1326 ms |
| worker RSS peak | 481 MB |

**The bottleneck today is rendering, by an order of magnitude.** Native
extraction is nearly free per page once the whole-document pdf-inspector
pass amortizes (its p95 is the first-page cost of that pass). Known levers
on render, in the order to try them: batch page ranges per pdftoppm
invocation (`-f`/`-l` spans amortize process spawn + document open),
pdftocairo comparison, dpi reduction where the OCR model's input size
allows. None taken yet — the OCR stage is still a stub, and the ranking of
levers may change once real inference joins the table.

These are stage timings on a laptop, not capacity claims. The
production-shaped number (pages/sec/core on server hardware, with real
OCR) is exactly what this instrumentation exists to produce when #2 lands.

## Verification

`test/service-skeleton.test.mjs` (6 tests, all passing; full suite
178/178): lifecycle with progressive visibility before completion,
stub-never-canonical (bytes-level), fail-closed sibling independence,
worker-crash requeue completing on attempt 2, restart resume, and
non-PDF rejection at submission time. The load run above used the real
corpus read-only; job data (which contains corpus-derived output) was
written to a temp dir and deleted after measurement — nothing corpus-
derived is committed.

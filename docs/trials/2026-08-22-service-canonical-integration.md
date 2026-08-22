# Parse service v1: the canonical witness plugs in

**Date:** 2026-08-22 · **Branch:** `service-canonical-integration` ·
**Issues:** #22 (integration), #2 (witness swap, owner-adopted), #51 (SVG endpoint)

## What shipped

1. **The PR #55 PP-OCR witness is the service's canonical OCR adapter**
   (`service/adapters/ppocr-server.mjs` → `createPpOcrV6NodeAdapter` from the
   library). One engine per worker process, created on first use, reused for
   every subsequent page; cold init is reported once as its own
   `ocrColdInit` timing rather than hidden inside page 1's OCR number.
2. **The backend is pinned end to end** (the owner's witness-swap condition):
   service config takes an explicit assets dir, variant, and thread count —
   no `auto` exists anywhere — and every record's provenance carries both the
   one-string descriptor (`provenance.ocrAdapter =
   "ppocrv6-small-node@0.4.2#ep=wasm;threads=4"`) and the machine-readable
   pin (`provenance.configuration.ocrBackend = {adapter, version, variant,
   executionProvider, numThreads}`). The pin travels with each task and is
   persisted per job, so resumed pages run under the backend the job started
   with.
3. **`GET /v1/jobs/:id/pages/:n.svg`** serves the #51 deterministic
   reconstruction for canonical records (404 for failed/missing/non-canonical
   pages) — verified live against a real corpus job.
4. **The Tesseract second-opinion rung is now tested**, not just wired: a
   synthetic would-starve page (empty native witness + confident
   uncorroborated OCR over a real rendered page) trips `uncorroborated-ocr`
   blocking, and Tesseract reads the actual ink into `secondOpinion`. In the
   real 176-page run below it engaged on 3 pages.

## Full-pipeline measurement (same 3 corpus PDFs as the stub-era table: 176 pages, 4 workers, M-series laptop)

| stage | p50 ms | p95 ms | mean ms |
|---|---|---|---|
| render (pdftoppm) | 361 | 981 | 428 |
| native (inspector+pdf.js) | 20 | 436 | 65 |
| **ocr (PP-OCRv6 small, WASM EP, 4 threads)** | **6,504** | **10,869** | **6,601** |
| ocrColdInit (once per worker) | 665 | — | 648 |
| assembly (+schema parse) | 34 | 94 | 78 |
| secondOpinion (3 pages) | 2,100 | 2,627 | 2,256 |
| page wall | 7,278 | 11,548 | 7,375 |

**Aggregate: 0.54 pages/sec (4 workers), end-to-end wall 327.6 s, worker RSS
peak 1,759 MB. 176/176 pages produced schema-valid canonical records, 0
failures, 0 non-canonical leaks.**

A caveat on the two RSS figures in circulation — they come from different
instruments and both are true. The 1,759 MB here is
`process.memoryUsage().rss` sampled at page **completion** (the service's
Metrics path), which misses transient peaks during inference; the adapter
trial's 2.3 GB/worker was OS-level max RSS over the whole run. Capacity
planning should budget against the OS number: **4 workers ≈ 9 GB
(4 × 2.3 GB), not 7 GB** — the page-boundary sample is a floor, not the
peak.

### The corrected bottleneck sentence

The stub-era table's "render is the bottleneck (40× native)" described a
pipeline without its most expensive stage. With the real witness wired,
**OCR dominates render 18:1 at p50 and is ~88% of page wall time**; render
optimization is now a rounding error until OCR gets faster. The speed arms,
in the order the data ranks them:

1. **Native onnxruntime EP with the same ONNX models** — 6.5 s/page is the
   *WASM-EP* cost under a 4-worker load, not "the CPU cost"
   (`@paddleocr/paddleocr-js` hard-depends on onnxruntime-web; a native-EP
   run means departing from the byte-identical browser pipeline, which is
   now acceptable — the equivalence claim is already banked at the pipeline
   level).
2. Worker/thread topology — measured, not guessed: 4 workers × **1** WASM
   thread was tried and is **worse** (0.35 pages/sec; per-page OCR 6.5→10.4 s
   p50). Threads earn more than they contend on this hardware; the
   oversubscription hypothesis is rejected and 4×4 stands.
3. GPU — still last, still gated on the numbers above.

### Honest comparison to the stub era

| | stub era | full pipeline |
|---|---|---|
| pages/sec (4 workers) | 8.86 | 0.54 |
| page wall p50 | 313 ms | 7,278 ms |
| bottleneck | render (pdftoppm spawn) | OCR inference (WASM EP) |

The 16× throughput drop is the price of an actual OCR witness; the stub-era
table remains valid as the *floor* the non-OCR stages contribute.

## Tests

`test/service-integration.test.mjs` (4 new): canonical end-to-end with
provenance-pin assertions (skips **loudly** when model assets are absent, so
CI without private assets stays green while naming the gap), ppocr-server
refuses to exist without an explicit assets dir, the second-opinion rung
engages and reads real ink, and the SVG endpoint's 200/404 contract over the
real server. Full suite: 204 pass / 1 loud skip locally without assets; 205
runnable with `PPOCR_ASSETS_DIR` set.

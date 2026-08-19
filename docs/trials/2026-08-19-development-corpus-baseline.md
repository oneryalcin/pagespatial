# Development corpus baseline

Date: 2026-08-19

## Result

The hardened PageSpatial development baseline completed all 162 nominated pages across 23 private PDFs in 105.9 seconds. PDF.js and PP-OCR ran on every page with the fixed WebGPU provider. PDF Inspector supplied the native source in a separate process per document.

- OCR completed: 162/162 pages.
- Valid PageSpatial records: 148/162 pages.
- Fail-closed pages: 14/162.
- Successful-page native observations: 11,993.
- Successful-page OCR observations: 10,718.
- Source matches: 7,471.
- Critical conflicts: 273.
- Pages requiring escalation: 74/148.
- OCR time: 49.5 seconds total; 270 ms p50, 592 ms p95, 1,022 ms maximum.

The median native/OCR association coverage was 88.2%; its mean was 67.8%. This is a matcher diagnostic, not parser or OCR accuracy. Image-only pages can correctly have zero association coverage.

## Failures retained

Twelve selected pages in the Blackstone supplemental report are rotated. PDF Inspector geometry for real rotated pages is intentionally rejected until a retained fixture proves the coordinate transform. PP-OCR still completed on each page. Its raw observations and rendered geometry are retained as partial evidence, but no incomplete PageSpatial record was accepted.

Page 12 in each MonotaRO sibling produced a PDF Inspector point box outside the declared PDF page bounds. The runtime schema rejected both pages. Both raw sources are retained in the failed attempts. No clipping or tolerance was added after seeing the result.

These failures identify the next two parser tasks:

1. Add real rotated-page conformance and a proven Inspector-to-rendered transform.
2. Diagnose the two out-of-bounds native boxes and define a source-preserving policy before changing bounds handling.

## Evidence and limits

The committed aggregate is `evaluation/baselines/dev-v5-2026-08-19.summary.json`. Private page records and PDFs remain outside Git and npm packages. The checked-in generator verified the full content-hash chain from the immutable invocation through 23 immutable document summaries and 162 immutable attempts before writing the aggregate. `current.json` and mutable page convenience files are outside that historical graph.

Performance context: Node 25.8.2 on macOS arm64; Apple M4 Max with 14 logical CPU cores and 36 GiB RAM; Google Chrome 151.0.7922.140; Apple WebGPU adapter using Metal 3; render scale 1.6; serialized page and OCR execution. The aggregate retains a non-sensitive executable label, browser user agent, warm-up time, actual backend, and an executed/resumed breakdown. The run used clean implementation commit `89584cbf1434261823dafd8222e08b8513858060` with `dirty: false`.

No gold truth was authored in this run. OCR recall, critical-token recall, geometry precision/recall, reading order, table/chart relationship accuracy, answer quality, escalation quality, and false-confidence rate remain `not_evaluated`.

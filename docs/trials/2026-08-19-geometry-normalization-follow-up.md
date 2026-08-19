# Geometry normalization follow-up

Date: 2026-08-19

## Result

The clean `dev-v6-2026-08-19` development run completed all 162 nominated pages across 23 private PDFs. Every page ran PP-OCRv6 Tiny on WebGPU and produced a schema-valid PageSpatial record.

- OCR completed: 162/162 pages.
- Valid PageSpatial records: 162/162 pages.
- Fail-closed pages: 0/162.
- Native observations: 17,051.
- OCR observations: 14,796.
- Source matches: 11,245.
- Critical conflicts: 449.
- Pages requiring escalation: 98/162.
- OCR time: 89.8 seconds total; 465 ms p50, 1,239 ms p95, 1,747 ms maximum.
- Total run time: 156.9 seconds.

The median native/OCR association coverage was 86.2%; its mean was 69.1%. This is a matching diagnostic, not OCR or parser accuracy.

## General fixes

PDF Inspector scalar rectangles do not retain enough per-item orientation information for general rotated-page geometry. The Node composite adapter now uses PDF.js text-item transforms and the real page viewport matrix as the geometry authority. PDF Inspector remains the preferred source for page-aligned Markdown and unambiguous metadata. The adapter uses deduplicated PDF.js Markdown when Inspector output is blank or the page contains coincident text overlays.

The two MonotaRO failures came from three coincident source text runs for one visible page number. PageSpatial retains all three raw observations and source IDs. Its derived reading order and Markdown collapse only exact same-text, same-box overlays, so the visible value appears once. No raw evidence is deleted.

The implementation also rejects non-finite or singular transforms, incompatible native and renderer coordinate bases, out-of-bounds point boxes, and false geometry-method provenance. It does not clip invalid geometry to make a page pass.

## Evidence

The committed aggregate is `evaluation/baselines/dev-v6-2026-08-19.summary.json`. It authenticates 23 document summaries and 162 immutable page attempts through content hashes. The run used clean implementation commit `e8213730f0da7c3d2c8ecf379f49aebba0f629bf` with `dirty: false`.

Performance context: Node 25.8.2 on macOS arm64; Apple M4 Max with 14 logical CPU cores and 36 GiB RAM; Google Chrome 151.0.7922.140; Apple WebGPU adapter using Metal 3; render scale 1.6; serialized page and OCR execution.

Before the full rerun, the 14 previously failed pages were replayed with their retained OCR observations and browser geometry. All 14 passed schema validation with zero out-of-bounds observations. On the 12 rotated Blackstone pages, 2,879 unambiguous exact-text PDF.js/PP-OCR pairs had at least 0.5 overlap over the smaller box; median and tenth-percentile overlap were both 1.0. This is cross-engine corroboration, not independent gold truth.

## Limits and next gate

The development corpus is not independent gold. A page passing schema validation proves internal geometric and evidence invariants, not semantic accuracy. OCR and critical-token recall, geometry precision/recall, reading order, table/chart relationships, answer quality, escalation quality, and false-confidence rate remain `not_evaluated` until independently labelled references exist. The candidate holdout was not accessed.

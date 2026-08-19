# PageSpatial repository specification

## Objective

Extract the geometry-aware document evidence parser from Evidence Search into a standalone, browser-first TypeScript repository at `~/dev/personal/pagespatial`.

## Required outcomes

- A language-neutral `PageSpatialDocument` JSON contract.
- Strict TypeScript types and runtime validation.
- Pure geometry, text normalization, native/OCR association, reading-order, simple-relation, diagnostic, and Markdown-projection modules.
- Page-level adapter contracts that allow progressive browser WebGPU/WASM OCR or server GPU OCR to produce the same canonical output.
- One official browser stack: a shared PDF.js session, positioned native extraction, canvas rendering, and PP-OCRv6 Tiny with verified WebGPU-to-WASM fallback.
- One optional Node native adapter backed by Firecrawl PDF Inspector, the PDF engine used by AnyDoc, for page-addressable Markdown and positioned text.
- A parser orchestrator with bounded page concurrency and progressive page callbacks.
- Deterministic, source-preserving observation IDs and provenance.
- Unit tests for geometry, critical-token conflicts, relations, diagnostics, and browser/server adapter equivalence.
- Architecture, evaluation, and migration documentation.
- A local Git repository with no application UI, bundled model binaries, API keys, or runtime service calls.

## Constraints

- TypeScript is the public product and orchestration layer.
- Rust/WASM is an optional future optimization for measured deterministic CPU bottlenecks.
- GPU inference remains behind adapters and may use Python/C++, CUDA, TensorRT, Triton, ONNX Runtime, or browser WebGPU.
- Browser integrations use explicit named exports and injected asset URLs. There is no registry, runtime discovery, DI container, or implicit CDN fallback.
- AnyDoc document-wide Markdown is not canonical page evidence. PDF Inspector may supply page-aligned native evidence; PP-OCR still runs on every page.
- Raw observations remain authoritative. Markdown and inferred relationships remain derived projections.
- Current single-document results are feasibility evidence, not production accuracy.

## Acceptance criteria

- `npm install`, `npm run typecheck`, `npm test`, and `npm run build` succeed.
- The same parser test passes with simulated browser and server OCR adapters.
- Critical numeric disagreement produces an escalation diagnostic.
- Output passes runtime schema validation.
- README clearly states current scope, usage, architecture, and production gaps.
- Adapter tests prove single-flight OCR initialization, serialized prediction, sticky backend fallback, deterministic disposal, page identity validation, and shared PDF-page caching.

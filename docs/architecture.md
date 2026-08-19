# Architecture

## Boundary

PageSpatial converts normalized native and OCR observations into a canonical, source-preserving page record. PDF decoding, rasterization, OCR inference, persistence, retrieval, and answer generation remain replaceable adapters or downstream consumers.

## Three execution planes

### TypeScript product plane

- Public API and schemas.
- Browser and Node orchestration.
- Geometry normalization, association, diagnostics, and projections.
- Progressive page callbacks and cancellation.

### Optional Rust data plane

Rust is reserved for deterministic operations that profiling proves are CPU or memory bottlenecks. A Rust implementation must consume and emit the same schema and pass identical conformance tests. It may compile to WASM for browsers and native code for server runtimes.

### GPU inference plane

OCR and document-vision inference remain behind adapters. Browser adapters may use WebGPU or WASM. Server adapters may use Paddle, ONNX Runtime CUDA, TensorRT, Triton, or another benchmarked runtime. GPU implementation language is not part of the public contract.

## Evidence flow

```text
source PDF
  ├─ native adapter ── native observations and structure
  ├─ renderer ─────── canonical page geometry and raster handle
  └─ OCR adapter ──── OCR text, confidence and polygons
                              │
                              v
                      deterministic page builder
                              │
                              v
                       PageSpatialDocument
                         ├─ raw evidence
                         ├─ source matches
                         ├─ derived relations
                         ├─ diagnostics
                         └─ projections
```

## Identity

The caller supplies a document ID, revision ID, and source SHA-256. Observation IDs are deterministic for the document revision, page, source, text, geometry, and occurrence. They are stable for equivalent adapter output but are not a substitute for the source-file hash.

Adapter-supplied IDs are retained only as provenance. They must be unique within their page and source. The core generates canonical IDs before matching so arbitrary adapter IDs cannot suppress or merge unrelated evidence.

## Coordinates

Rendered top-left pixels are the canonical display coordinate system. Native PDF-point rectangles use the renderer's complete six-value viewport transform. All four corners are transformed so rotation, translation, crop-box shifts, and scale are retained.

## Validation contract

The TypeScript Zod validator enforces semantic invariants that JSON Schema cannot express portably: complete ordered pages, document/revision/run identity, unique canonical IDs, valid source references, page-bounded geometry, and recomputed diagnostic totals. The generated JSON Schema enforces the language-neutral structural shape and exact tuple lengths. Other language implementations must reproduce the semantic checks and pass the same conformance corpus.

## Trust

- Native and OCR observations are source observations.
- A native/OCR match is a derived association.
- Reading order is deterministic derived structure.
- Tables and chart mappings are derived relations.
- Markdown is a projection.
- Vision-model output must be labelled as model-derived and mapped back to source observations where possible.

Downstream authorization, deletion state, document canonicality, and revision selection remain outside parser relevance and confidence scores.

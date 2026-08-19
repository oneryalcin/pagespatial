# Architecture

## Boundary

PageSpatial converts normalized native and OCR observations into a canonical, source-preserving page record. PDF decoding, rasterization, OCR inference, persistence, retrieval, and answer generation remain explicit adapters or downstream consumers. Integrations are named imports and normal TypeScript objects. There is no plugin registry or runtime discovery.

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
  ├─ page-native adapter ─ native observations and structure
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

## Official integration boundary

The supported browser preset owns one lazy PP-OCR runtime. The caller owns one PDF.js session. Native extraction and rendering share its cached page proxies. Page-native extraction and rendering may overlap; OCR predictions are serialized through one model instance because the current Paddle browser pipeline is not proven safe or memory-efficient under concurrent inference.

Backend policy is explicit:

1. Try WebGPU when `backend: "auto"`.
2. Accept it only when both detector and recognizer report the WebGPU provider.
3. On initialization mismatch or the first prediction failure, dispose it and retry once with WASM.
4. Keep WASM sticky for that adapter lifetime.

The Node PDF Inspector adapter is optional. It is the PDF engine used by AnyDoc and provides page Markdown, positioned text, and tagged structure roles. `openNodePdfSession()` provides bytes, identity, page geometry, and cached page proxies; rendering and OCR remain caller-selected adapters. PDF Inspector currently extracts the full native document once, so it is not the default browser path and must be benchmarked on large documents. Its native geometry rejects rotated, cropped, and shifted pages until retained real fixtures prove each coordinate convention; use another native adapter for those pages.

## Resource ownership

- `openPdfJsSession()` owns and destroys one `PDFDocumentProxy`.
- The PDF.js session caches at most one promise per loaded page.
- A rendered canvas is owned by `RenderedPage` until `release()`; the parser calls it on success and failure.
- `createBrowserParser()` owns the PP-OCR engine and exposes `dispose()`.
- OCR model and ORT assets are owned and hosted by the consuming application.

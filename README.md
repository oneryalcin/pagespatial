# PageSpatial

PageSpatial is a source-preserving spatial evidence layer for PDF ingestion. It combines native PDF observations and visual OCR observations without reducing the source document immediately to Markdown.

Status: experimental parser core. The architecture and sample implementation are ready for corpus evaluation and application integration. They are not yet production-qualified.

## Core rule

> `PageSpatialDocument` is the evidence record. Markdown, search chunks, tables, chart summaries, and model prompts are derived views.

Raw native and OCR observations remain separate. Matches and inferred relationships retain their component observation IDs, geometry, method, confidence, and provenance.

## Runtime architecture

```text
                         PageSpatial contract
                                  │
                 ┌────────────────┴────────────────┐
                 │                                 │
        Browser/private use                 Server/scale
        TypeScript SDK                      TypeScript orchestration
        PDF.js                              GPU OCR adapter
        PP-OCR WebGPU/WASM                  CUDA/TensorRT/Triton
        Web Workers                         bounded batching
                 │                                 │
                 └──────── equivalent output ──────┘
```

TypeScript owns the public SDK, canonical schemas, orchestration, deterministic merge, diagnostics, and projections. Rust/WASM may later replace measured CPU bottlenecks. GPU inference remains behind an adapter and can use the most appropriate model runtime.

## Included

- Strict TypeScript types and Zod validation.
- Native PDF-point to rendered-page coordinate transforms.
- Source-preserving native/OCR association using text and geometry.
- Critical-token conflict detection for numbers, currencies, percentages, dates, units, signs, and financial suffixes.
- Reading-order rows.
- A deliberately narrow single-series year/value relation detector.
- Page-level diagnostics and escalation recommendations.
- Markdown as a derived projection.
- Adapter contracts for browser or server implementations.
- Bounded page concurrency and progressive page completion callbacks.

## Not included yet

- A bundled PDF engine or OCR model.
- Browser PP-OCR or server GPU adapter implementations.
- Production persistence, access control, or revision storage.
- General table reconstruction or complex chart interpretation.
- A sealed, representative evaluation corpus.

These boundaries are intentional. The core must not force every consumer to install a specific PDF parser, OCR runtime, or GPU stack.

## Install

This repository is private during the experimental phase:

```sh
npm install
npm run check
```

## Pure page merge

```ts
import { buildPageSpatial, pageSpatialSchema } from 'pagespatial';

const page = buildPageSpatial({
  document: {
    documentId: 'report',
    revisionId: 'sha256:abc',
    sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    pageCount: 1
  },
  pageNumber: 1,
  geometry: {
    width: 1200,
    height: 1600,
    pointWidth: 600,
    pointHeight: 800,
    viewportTransform: [2, 0, 0, -2, 0, 1600]
  },
  nativeObservations: [],
  ocrObservations: [
    {
      text: 'FY2022 647',
      pageNumber: 1,
      box: [900, 600, 1040, 630],
      confidence: 0.98
    }
  ],
  provenance: {
    parserName: 'example',
    parserVersion: '1',
    runId: 'run-1',
    createdAt: new Date().toISOString()
  }
});

pageSpatialSchema.parse(page);
```

## Portable parser orchestration

`createParser` accepts replaceable native, renderer, and OCR adapters:

```ts
const parser = createParser({
  native: pdfJsNativeAdapter,
  renderer: pdfJsRenderer,
  ocr: browserPpOcrAdapter
});

const document = await parser.parse({
  identity,
  data: pdfFile
}, {
  concurrency: 2,
  onPage(page) {
    indexPage(page);
  }
});
```

A server deployment can replace only the OCR adapter:

```ts
const parser = createParser({
  native: serverPdfAdapter,
  renderer: serverRenderer,
  ocr: remoteGpuOcrAdapter
});
```

Both paths must pass the same conformance corpus and produce equivalent IDs, coordinates, critical tokens, and relationship semantics.

## Repository layout

```text
src/
  adapters.ts       Runtime-neutral adapter contracts
  geometry.ts       Boxes, polygons and PDF viewport transforms
  merge.ts          Native/OCR association and conflicts
  reading-order.ts  Deterministic row grouping
  relations.ts      Narrow derived-relation detectors
  diagnostics.ts    Escalation signals
  projection.ts     Markdown derived view
  parser.ts         Page builder and document orchestrator
  schema.ts         Runtime validation
  types.ts          Canonical TypeScript contract
schemas/            Language-neutral JSON Schema
docs/               Architecture, migration and evaluation policy
test/               Deterministic conformance tests
```

The Zod schemas are the authoritative runtime validators for cross-field invariants such as document/page identity, complete page sets, source references, diagnostic totals, and page-bounded geometry. The published JSON Schema enforces the portable structural contract and exact coordinate tuple lengths. Non-TypeScript implementations must also implement the semantic invariants described in [Architecture](docs/architecture.md).

## Quality policy

The release rubric is in [docs/evaluation-rubric.md](docs/evaluation-rubric.md). Important rules:

- Association coverage is not OCR accuracy.
- Missing gold measurements are `not evaluated`, never successful.
- Answer accuracy and evidence grounding pass independently.
- A material false acceptance is a hard release failure.
- Performance and cost select between candidates only after evidence-safety gates pass.

## Development

```sh
npm run typecheck
npm test
npm run build
npm run example
```

See [Architecture](docs/architecture.md) and [Evidence Search migration](docs/evidence-search-migration.md).

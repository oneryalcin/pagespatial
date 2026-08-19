# PageSpatial

PageSpatial is a source-preserving spatial evidence layer for PDF ingestion. It combines native PDF observations and visual OCR observations without reducing the source document immediately to Markdown.

Status: experimental parser and adapter stack. The browser path is implemented and ready for corpus evaluation. It is not yet production-qualified.

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
        shared PDF.js session               PDF Inspector/native parser
        PP-OCR WebGPU/WASM                  GPU OCR adapter
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
- A shared PDF.js browser session, page-native extractor, and canvas renderer.
- A PP-OCRv6 Tiny browser adapter with verified WebGPU and sticky WASM fallback.
- An optional Node PDF Inspector adapter for page-aligned Markdown and positioned native text.

## Not included yet

- Bundled OCR model binaries. Asset URLs are explicit and caller-hosted.
- A server GPU adapter implementation.
- Production persistence, access control, or revision storage.
- General table reconstruction or complex chart interpretation.
- A sealed, representative evaluation corpus.

These boundaries are intentional. Root imports remain runtime-neutral. Browser and Node integrations are separate subpath exports.

## Install

This repository is private during the experimental phase:

```sh
npm install
npm run check
```

Install only the integration packages you use:

```sh
npm install pdfjs-dist@5.5.207 @paddleocr/paddleocr-js@0.4.2 onnxruntime-web@1.24.3
# Optional Node native enrichment:
npm install @firecrawl/pdf-inspector@1.14.2
```

## Browser parser

```ts
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { createBrowserParser, openPdfJsSession } from 'pagespatial/browser';

const session = await openPdfJsSession(file, {
  documentId: 'report-42',
  revisionId: 'upload-7',
  workerSrc: pdfWorkerUrl,
  maxBytes: 100 * 1024 * 1024,
  maxPages: 500
});

const browser = createBrowserParser({
  ocr: {
    detectionModelUrl: '/ocr-assets/models/PP-OCRv6_tiny_det_onnx_infer.tar',
    recognitionModelUrl: '/ocr-assets/models/PP-OCRv6_tiny_rec_onnx_infer.tar',
    wasmPaths: '/ocr-assets/ort/',
    backend: 'auto',
    localOnly: true
  }
});

try {
  const evidence = await browser.parser.parse(session.source, {
    concurrency: 2,       // rendering/native work may overlap
    renderScale: 1.6,     // OCR inference is serialized through one engine
    onPage(page) { indexPage(page); }
  });
} finally {
  await browser.dispose();
  await session.dispose();
}
```

Prepare exact, hash-verified local OCR assets into your application's public directory:

```sh
npm run prepare:ocr-assets -- --output ./public/ocr-assets
```

Threaded WASM requires cross-origin isolation. Without it, the adapter reports degraded one-thread WASM. The adapter verifies the actual detection and recognition providers; it never reports WebGPU solely because `navigator.gpu` exists.

The PDF.js renderer rejects pages over 16,384 pixels on either side or 40 million pixels total before allocating a canvas. Applications can set stricter `maxCanvasSide` and `maxCanvasPixels` values through the browser preset's renderer options.

The repository retains a packed-package browser smoke test with a generated raster-only fixture, actual PP-OCR assets, provider assertions, and an outbound-network deny-list:

```sh
PAGESPATIAL_SMOKE_ASSETS=/path/to/verified/ocr-assets npm run test:browser:wasm
# Run only on a WebGPU-capable release worker:
PAGESPATIAL_SMOKE_ASSETS=/path/to/verified/ocr-assets npm run test:browser:webgpu
```

## AnyDoc and PDF Inspector

For PDFs, [AnyDoc](https://github.com/firecrawl/anydoc) delegates to [PDF Inspector](https://github.com/firecrawl/pdf-inspector). PageSpatial integrates PDF Inspector directly on Node because it returns page-addressable Markdown and positioned native observations. Calling AnyDoc as well would parse the same PDF again and return document-wide Markdown without stronger page evidence.

```ts
import { createParser } from 'pagespatial';
import { createPdfInspectorNativeAdapter, openNodePdfSession } from 'pagespatial/node/pdf-inspector';

const session = await openNodePdfSession(pdfBytes, { maxPages: 500 });
const parser = createParser({
  native: createPdfInspectorNativeAdapter(),
  renderer: yourNodePageRenderer,
  ocr: yourServerOcrAdapter
});
```

This optional path performs a whole-document PDF Inspector extraction once and caches it per Node session. It can improve Markdown and tagged-PDF roles, but it may delay the first page on a large document. Rendering and server OCR remain explicit adapters. Rotated, cropped, or shifted native geometry is rejected until each mode passes a real retained conformance fixture. The default browser path stays progressive and uses PDF.js native text plus PP-OCR on every page.

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

`createParser` accepts replaceable page-native, renderer, and OCR adapters. Native extraction is page-level, so page 1 can complete without waiting for the whole document:

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
  browser/          Shared PDF.js and PP-OCRv6 browser integration
  node/             Optional Node integrations
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
npm run prepare:ocr-assets -- --output ./public/ocr-assets
```

See [Architecture](docs/architecture.md) and [Evidence Search migration](docs/evidence-search-migration.md).
The first real-PDF adapter trial is recorded in [docs/trials/2026-08-19-official-browser-adapters.md](docs/trials/2026-08-19-official-browser-adapters.md).

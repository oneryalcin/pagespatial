# PageSpatial

A TypeScript library (browser and Node) that extracts text from PDFs *and tells you which parts to trust*.

PDF extraction fails silently. Broken font maps make a page render perfectly and copy-paste as garbage. OCR reads `O` as `0` and reports 90% confidence. Numbers drawn inside charts don't exist in the text layer at all. Every extractor hands you a clean-looking string with no indication of which parts are lies — and if that string feeds a search index or an LLM, the lies get served as answers.

PageSpatial's premise: an extracted value is only trustworthy if you can trace it to actual ink on an actual page — and when the extraction might be wrong, the record should say so instead of bluffing. So it reads every page twice — once through the PDF's own embedded text, once through OCR looking at the rendered page like a human would — and compares:

- **The two readings agree** → that text is corroborated. Trust it.
- **They disagree** → that's a recorded conflict. Nobody wins by default — on real documents, each reader turns out to be the wrong one about half the time.
- **Only one reader saw it** (chart labels, scans, text missing from the PDF layer) → it's kept, labeled as single-witness evidence.

The output is a per-page evidence record — every observation with its text, position, confidence, and provenance, plus the agreements, conflicts, and escalation flags between them. It's built to feed a search index that can rank corroborated evidence above shaky evidence, and to let an answer engine cite a number *with the box it came from* — or hedge when the record says the page is disputed.

PageSpatial does **not** boil your document down to Markdown and call it a day. Markdown is one derived view among several; the evidence underneath is never thrown away, so any downstream decision can be re-examined later.

Status: the parser and adapter stack remains experimental as a library. The
parse-only hosted service is a public alpha with Cloudflare Access sign-up and
100 initial page credits. It has passed its live service qualification.
API-key users can start with the [PageSpatial API guide](docs/api-guide.md),
and engineers should start with the [current handoff](docs/handoff.md).
The project's standing commitments live in
[docs/principles.md](docs/principles.md).

## Core rule

> `PageSpatialDocument` is the evidence record. Markdown, search chunks, tables, chart summaries, and model prompts are derived views that point back at it.

Raw native and OCR observations remain separate — even after they match. Matches and inferred relationships retain their component observation IDs, geometry, method, confidence, and provenance.

## Recommended execution model

Run native extraction and PP-OCR together. They solve different problems:

1. **Native extraction** recovers selectable text, fonts, tagged roles, and document structure.
2. **PP-OCRv6 Tiny** reads every rendered page, including charts, diagrams, scans, and text missing from the PDF text layer.
3. **PageSpatial** keeps both sources, associates nearby equivalent observations, and records conflicts or uncertainty.
4. **Markdown and search indexes** are generated afterward from the evidence record.

The recommended browser stack is PDF.js + PP-OCR. On Node, the composite adapter adds PDF Inspector's page-aligned Markdown and unambiguous structure metadata while PDF.js remains the geometry authority. PP-OCR still runs; PDF Inspector is not an OCR replacement.

```text
PDF ─┬─ native extraction ─ positioned text and structure ─┐
     └─ rendered pages ─── PP-OCR text and polygons ───────┤
                                                            v
                                                   PageSpatialDocument
                                                            │
                                             Markdown, retrieval, answers
```

## Runtime architecture

```text
                         PageSpatial contract
                                  │
                 ┌────────────────┴────────────────┐
                 │                                 │
Browser/private use                 Server/scale
        TypeScript SDK                      TypeScript orchestration
        shared PDF.js session               PDF Inspector Markdown + PDF.js geometry
        PP-OCR WebGPU/WASM                  PP-OCRv6/OpenVINO sidecars
        Web Workers                         bounded page workers
                 │                                 │
                 └──────── equivalent output ──────┘
```

TypeScript owns the public SDK, canonical schemas, orchestration, deterministic merge, diagnostics, and projections. The managed service currently uses CPU/OpenVINO OCR. GPU inference was measured but was not adopted; Rust/WASM remains an option only for a measured bottleneck.

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
- An optional Node composite adapter for PDF Inspector Markdown plus PDF.js-positioned native text.

## Not included yet

- Bundled OCR model binaries. Asset URLs are explicit and caller-hosted.
- A reusable public server OCR adapter in the library package. The managed
  service has a private CPU/OpenVINO worker implementation.
- Persistence, access control, or revision storage in the library package.
  The managed service supplies PostgreSQL job state, R2 objects, Cloudflare
  Access, and tenant-scoped API keys.
- General table reconstruction or complex chart interpretation.
- Independent gold labels for the private evaluation corpus.

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
npm install @firecrawl/pdf-inspector@1.17.0
```

## Browser parser

```ts
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { createBrowserParser, openPdfJsSession } from 'pagespatial/browser';

const session = await openPdfJsSession(file, {
  documentId: 'report-42',
  revisionId: 'upload-7',
  workerSrc: pdfWorkerUrl,
  // REQUIRED for CJK and other CID-keyed fonts: serve pdfjs-dist's cmaps/
  // and standard_fonts/ directories and point pdf.js at them. Without
  // cMapUrl, pdf.js SILENTLY drops every glyph whose font references a
  // predefined CMap (Adobe-Japan1 etc.) — from text extraction AND
  // rendering — so both witnesses go blind to that content.
  cMapUrl: '/pdfjs-assets/cmaps/',
  standardFontDataUrl: '/pdfjs-assets/standard_fonts/',
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

For PDFs, [AnyDoc](https://github.com/firecrawl/anydoc) delegates to [PDF Inspector](https://github.com/firecrawl/pdf-inspector). PageSpatial integrates PDF Inspector directly on Node as the preferred page-addressable Markdown source. It uses deduplicated PDF.js Markdown when Inspector output is blank or the page contains coincident text overlays. PDF.js also supplies native observations and full text transforms because PDF Inspector's scalar text rectangles do not preserve enough orientation data for general rotated-page geometry. Calling AnyDoc as well would parse the same PDF twice without stronger page evidence.

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

This path performs one whole-document PDF Inspector extraction and caches it per Node session. Use it when improved Markdown is worth the startup delay. PDF.js text-item transforms and the renderer's six-value viewport matrix define geometry for normal, rotated, and shifted pages. Inspector metadata is attached only when normalized text is unambiguous in both sources. Repeated or ambiguous strings keep PDF.js defaults instead of receiving guessed roles. The default browser path stays progressive and uses PDF.js native text plus PP-OCR on every page.

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

Financial values are compared after geometry-aware reconstruction of adjacent PDF font runs. For example, PDF.js may expose one visible value as `27`, `,`, and `148,453`; the evaluator must reconstruct `27,148,453` before scoring. Parser run boundaries are not ground truth.

Current retained evidence:

- A three-page mixed native/chart sample recovered chart-only `FY2021` and `527` through PP-OCR with no external requests.
- On one dense annual-report table, PDF Inspector and PP-OCR each recovered all 39 independently checked critical table values.
- After font-run reconstruction, PDF.js and PDF Inspector agreed on all 45 critical tokens across that page.
- Inspector's Markdown still made one row-boundary error. Numeric preservation and table-relationship accuracy therefore remain separate gates.

These are feasibility results, not production qualification. See the [dense financial table trial](docs/trials/2026-08-19-dense-financial-table-recovery.md) and the [production evaluation rubric](docs/evaluation-rubric.md).

## Development corpus baseline

The repository includes a manifest and runner for the private `oneryalcin/enterprise-document-landfill` dataset. It runs PDF Inspector and PP-OCRv6 Tiny on the same 162 nominated development pages, then assembles one source-preserving PageSpatial record per page. The 13 candidate holdout documents cannot be selected or downloaded by these commands.

```sh
# Inspect the exact 23 development paths without network or filesystem writes.
npm run eval:corpus:dry-run

# Authenticate with `hf`, download exact files at the pinned revision, and verify SHA-256.
npm run eval:corpus:materialize

# Prepare hash-verified local OCR assets, then run the development baseline.
npm run eval:ocr-assets
npm run eval:baseline -- --backend webgpu
```

PDFs, OCR assets, outputs, caches, and logs remain under `.evaluation/`, which is excluded from Git and npm packages. Use a fixed backend for reproducible resume; `auto` deliberately reruns pages because its actual provider can change. Gold-dependent metrics are explicitly `not_evaluated`. Association coverage is only a parser diagnostic. See [Development corpus evaluation](docs/evaluation-corpus.md).

The geometry-normalized clean-commit baseline OCRed all 162 pages and produced 162 schema-valid PageSpatial records in 156.9 seconds on the hardware and browser recorded in the aggregate. PDF.js text-item transforms now define native geometry; PDF Inspector supplies preferred page Markdown and unambiguous metadata, with deduplicated PDF.js Markdown used for blank Inspector output or coincident overlays. This resolved the 12 rotated-page failures and the two coincident-overlay failures from the first baseline without clipping source boxes or discarding raw observations. The public aggregate is deterministically generated from a verified content-hash chain. See the [geometry-normalization follow-up](docs/trials/2026-08-19-geometry-normalization-follow-up.md); the [first development baseline](docs/trials/2026-08-19-development-corpus-baseline.md) remains as historical evidence.

## Development

```sh
npm run typecheck
npm test
npm run build
npm run example
npm run prepare:ocr-assets -- --output ./public/ocr-assets
```

See [Architecture](docs/architecture.md), [engineering handoff](docs/handoff.md), and [Evidence Search migration](docs/evidence-search-migration.md).
The first real-PDF adapter trial is recorded in [docs/trials/2026-08-19-official-browser-adapters.md](docs/trials/2026-08-19-official-browser-adapters.md).

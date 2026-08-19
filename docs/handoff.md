# PageSpatial engineering handoff

Date: 2026-08-19

## Purpose

PageSpatial is an experimental PDF ingestion library. It creates a durable evidence record for each page from native PDF extraction and visual OCR. It does not treat Markdown, inferred tables, chart mappings, or search chunks as source evidence.

This document tells the next engineer what exists, why the current design was chosen, what was tested, what remains unproven, and what to do next. API examples and detailed contracts stay in the linked files rather than being copied here.

Two standing principles frame all of it:

- **The library feeds an index; it is not the product.** Its output exists to make enterprise search/retrieval/answering trustworthy. The unique value delivered to the index is per-chunk trust metadata (source IDs, coordinates, corroboration state, escalation severity), not the text alone. Do not strip that metadata at the index boundary.
- **Humans belong to the evaluation loop only.** At enterprise ingestion scale no human reviews pages in the production path. Escalation is a routing signal, never a review queue: blocking pages route to an automated stronger-model tier or are indexed carrying their conflict records; advisory pages are indexed with their confidence metadata; documents always flow. Human effort (gold labeling, adjudication, spot checks) exists solely to measure and improve the library. LLMs are used sparingly and cost-consciously — the deterministic pipeline handles every page; models enter only where deterministic methods are structurally blind or during evaluation.

Start with:

1. [README](../README.md) — supported package surfaces and usage.
2. [Architecture](architecture.md) — boundaries, ownership, coordinates, and execution planes.
3. [Evaluation rubric](evaluation-rubric.md) — production gates and measurement rules.
4. [Development corpus guide](evaluation-corpus.md) — private corpus and reproducible runner.
5. [Security](../SECURITY.md) — untrusted content, local assets, and caller responsibilities.

## Current status

The repository contains a working TypeScript parser, browser adapters, a Node native adapter, strict runtime validation, and a development-only evaluation harness.

Current facts:

- Package version: `0.1.0`.
- Status: experimental; not production-qualified.
- Distribution: private repository; no public npm release has been qualified.
- Node support: Node 25 or newer.
- CI command: `npm run check`.
- Current CI: 101 tests, typecheck, build, schema freshness, package-boundary checks, and Vite filesystem-containment checks pass.
- Browser native path: one shared PDF.js session.
- Browser OCR path: PP-OCRv6 Tiny using WebGPU when verified, with sticky WASM fallback.
- Node native path: PDF Inspector for preferred Markdown and unambiguous metadata; PDF.js for native text and geometry.
- Persistence, authorization, retrieval, answer generation, and remote model escalation are outside this package.
- Evidence Search integration is deliberately deferred. See [migration plan](evidence-search-migration.md).

The authoritative record is `PageSpatialDocument`. Its TypeScript contract is in [`src/types.ts`](../src/types.ts), runtime validation is in [`src/schema.ts`](../src/schema.ts), and the generated portable schema is [`schemas/pagespatial.schema.json`](../schemas/pagespatial.schema.json).

## The design that should remain stable

### 1. Native extraction and OCR both run

Native PDF text and OCR are complementary. Native extraction supplies selectable text and document metadata. OCR recovers scans, chart labels, diagram text, and content missing from the PDF text layer.

Do not choose one source and discard the other. Raw native and OCR observations remain separate even after association. Matches, conflicts, reading order, chart relations, and Markdown are derived records that reference their source observation IDs.

### 2. PDF.js owns geometry

Rendered top-left pixels are the canonical display coordinate system. PDF.js supplies text-item transforms, `page.view` bounds, and the renderer's six-value viewport matrix. All four source-box corners are transformed.

PDF Inspector scalar rectangles are not a valid geometry source for general rotated pages because they omit per-item orientation. Keep PDF Inspector for Markdown and metadata only. Geometry code and invariants are in:

- [`src/geometry.ts`](../src/geometry.ts)
- [`src/pdfjs-text.ts`](../src/pdfjs-text.ts)
- [`src/page-parser.ts`](../src/page-parser.ts)
- [`src/node/pdf-inspector.ts`](../src/node/pdf-inspector.ts)

Never make invalid geometry pass by clipping it to the page. Reject non-finite, singular, mismatched, or out-of-bounds geometry.

### 3. Markdown is a derived, untrusted view

PDF Inspector is the preferred Node Markdown source. The adapter uses deduplicated PDF.js Markdown when Inspector output is blank or when coincident PDF text overlays would duplicate visible content.

The projection is marked `trust: "untrusted-document-content"`. Sanitize it before HTML rendering. Delimit it as untrusted evidence in model prompts. Document text must never change tool authority or system instructions.

### 4. Adapters are explicit objects

The core contracts are [`NativePageAdapter`, `PageRenderer`, and `OcrAdapter`](../src/adapters.ts). Composition uses normal TypeScript imports. There is no plugin registry, discovery protocol, or dependency-injection container.

This is intentional. A browser or server can replace one adapter without changing the evidence schema or merge logic.

### 5. TypeScript stays in control

TypeScript owns orchestration, schemas, deterministic matching, diagnostics, and projections. Do not introduce Rust or another data plane until profiling identifies a stable CPU or memory bottleneck. A replacement must consume and emit the same schema and pass the same conformance tests.

## Implemented runtime paths

### Browser

[`createBrowserParser()`](../src/browser/preset.ts) composes:

- a shared PDF.js session and native extractor;
- a bounded PDF.js canvas renderer;
- one lazy PP-OCRv6 Tiny engine;
- verified WebGPU or WASM execution;
- serialized OCR prediction;
- cancellation, deterministic cleanup, and progressive `onPage` callbacks.

The OCR adapter verifies the actual detector and recognizer providers. It does not infer success from `navigator.gpu`. A WebGPU failure causes one retry on WASM, after which WASM remains sticky for the document.

OCR assets are exact and caller-hosted. The hashes and sizes are in [`assets/ppocrv6-tiny.manifest.json`](../assets/ppocrv6-tiny.manifest.json). Private-document deployments should keep `localOnly: true` and serve assets from the same origin.

### Node/server

[`createPdfInspectorNativeAdapter()`](../src/node/pdf-inspector.ts) performs one cached, whole-document PDF Inspector extraction per Node PDF session. PDF.js still produces page-native observations and their complete transforms.

This path improves page Markdown, but its whole-document Inspector pass can delay the first completed page. That delay has not yet been isolated on long documents. Measure it before changing the execution model.

There is no server GPU OCR adapter yet. The existing `OcrAdapter` boundary is the intended extension point.

## What was tried and what we learned

| Trial | Result | Decision |
| --- | --- | --- |
| Shared PDF.js session plus PP-OCR on a mixed three-page PDF | WebGPU processed all pages in 2.639 seconds, recovered chart-only `FY2021` and `527`, and made zero external requests | Keep as the browser composition; details in [official browser adapter trial](trials/2026-08-19-official-browser-adapters.md) |
| AnyDoc plus PDF Inspector | AnyDoc delegates PDF work to PDF Inspector, so using both would parse the same document twice without stronger page evidence | Integrate PDF Inspector directly on Node; do not add AnyDoc as a second PDF pass |
| PDF Inspector rectangles as positioned native geometry | Failed on real quarter-turn pages because item orientation was lost | Rejected; PDF.js transforms are the geometry authority |
| First 162-page development run | OCR completed every page, but 12 rotated pages and two coincident-overlay pages failed closed | Kept as historical evidence in [dev-v5 baseline](trials/2026-08-19-development-corpus-baseline.md) |
| Geometry-normalized 162-page rerun | All 162 pages produced schema-valid PageSpatial records; no page was forced through by clipping | Adopted; details in [dev-v6 follow-up](trials/2026-08-19-geometry-normalization-follow-up.md) |
| Dense financial table comparison | An initial 47.54% figure was invalid because it scored PDF font fragments as complete values. Correct reconstruction recovered all 39 independently checked values in both Inspector and OCR | Keep fragment reconstruction; score value preservation and table relationships separately. See [dense table trial](trials/2026-08-19-dense-financial-table-recovery.md) |
| PDF Inspector Markdown on the dense table | All values were present, but one section label and one total were attached to the wrong row | Markdown is useful but cannot be treated as correct table structure |
| Heuristic audit: scale/locale hardening rerun (dev-v7) | Identical parser-controlled numbers to dev-v6 after moving pixel constants to point-space and fixing locale-dependent lowercasing | Adopted; constants live in `src/tuning.ts`. See [audit and redesign trial](trials/2026-08-19-heuristic-audit-and-critical-ink-redesign.md) |
| Critical-token "same ink" redesign (dev-v8) | 10 old conflicts were presentation heals; 215 new conflicts surfaced, including real OCR misreads the unit-whitelist regex missed | Adopted; conflict counts before/after are not comparable. Same trial report |
| Gold pilot: 30 human-verified pages vs dev-v8 | Headline numbers later partially retracted (measurement defects); the CJK/chart gap, the false-confidence page, and the conflict split survived with corrected magnitudes | Retracted in part; see the banner in [gold pilot trial](trials/2026-08-19-gold-pilot-first-accuracy.md) |
| Four-review adversarial pass over the audit/gold branch (dev-v9) | Chart detector is 25% recall / 96% precision, not dead; gold auto-accept was circular; word-glue made tokens segmentation-dependent; 36 of 663 conflicts were glue artifacts; blocking escalations were 14/14 confirmed real | Adopted: two-channel tokens, tiered gold metrics, hash-bound evaluator, schema 0.2.0. See [adversarial review fixes](trials/2026-08-19-adversarial-review-fixes.md) and issue #8 |

The browser trial also retained three tooling failures: Paddle worker prebundling, ORT `?import` handling, and a stale Vite process. These are solved in the current smoke harness and documented in the trial. They were integration failures, not accuracy results.

## Current empirical evidence

The current reference aggregate is [`evaluation/baselines/dev-v9-two-channel-tokens-2026-08-19.summary.json`](../evaluation/baselines/dev-v9-two-channel-tokens-2026-08-19.summary.json). Superseded aggregates ([dev-v6](../evaluation/baselines/dev-v6-2026-08-19.summary.json), [dev-v7](../evaluation/baselines/dev-v7-scale-locale-2026-08-19.summary.json), [dev-v8](../evaluation/baselines/dev-v8-critical-ink-2026-08-19.summary.json)) are retained as history; the [audit trial](trials/2026-08-19-heuristic-audit-and-critical-ink-redesign.md) and the [adversarial review fixes trial](trials/2026-08-19-adversarial-review-fixes.md) explain the lineage.

dev-v9 records (23 PDFs, 162 pages, schema 0.2.0, two-channel critical tokens):

- 162 OCR-completed, 162 schema-valid, 0 failed closed;
- 17,051 native observations; 14,797 OCR observations; 11,072 source matches;
- 627 critical conflicts; 102 pages requiring escalation.

Gold evidence (30 labelled pages, tiered): human-verified union recall 64% on mixed pages; on the EN/JA sibling pages the human tier (tokens the native layer missed, mostly chart-embedded) is missed-by-both 3% in English vs 75% in Japanese; blocking escalations 14/14 confirmed real errors; conflict adjudications OCR-right 23 / native-right 17 / both-wrong 6; chart detector 25% recall at 96% precision. Text-free aggregates: [`evaluation/gold/`](../evaluation/gold/).

The median native/OCR association coverage was 85.2%; the mean was 68.6%. This is matcher coverage, not parser accuracy or OCR recall. Conflict counts are comparable only within one token-definition era (dev-v8/dev-v9 differ from dev-v6, and from each other by the two-channel change).

The public aggregate authenticates the private invocation, 23 document summaries, and 162 immutable page attempts by content hash. Runtime PDFs, OCR output, and logs are private and are not committed or packed.

## Private corpus and reproducibility

The authoritative corpus definition is [`evaluation/corpus.v1.json`](../evaluation/corpus.v1.json). It references the private Hugging Face dataset `oneryalcin/enterprise-document-landfill` at pinned revision `e3ee38f067588644b11574ccc566843ca45f6d33`.

The manifest contains:

- 23 development PDFs with 162 nominated pages;
- 13 candidate holdout PDFs with 89 nominated pages;
- family-level split protection;
- exact paths, hashes, page counts, and page-class labels.

The provided commands can materialize only the development split. Do not add a holdout flag to the current runner.

Default local workflow:

```sh
npm ci
npm run check
npm run eval:corpus:check
npm run eval:corpus:dry-run
hf auth whoami
npm run eval:corpus:materialize
npm run eval:ocr-assets
npm run eval:baseline -- --backend webgpu --run-id <new-run-id>
npm run eval:baseline:summary -- \
  --run-root .evaluation/runs/<new-run-id> \
  --output evaluation/baselines/<new-run-id>.summary.json
```

For data outside the checkout, pass the same `--data-root <private-path>` to materialization and baseline commands, and prepare assets with:

```sh
npm run prepare:ocr-assets -- --output <private-path>/ocr-assets
```

The accepted dev-v6 private run used `/private/tmp/pagespatial-evaluation-data`. That path is machine-local and temporary; it is not a durable handoff artifact. Regenerate the run from the pinned dataset when private attempts are unavailable.

Use a fixed `--backend wasm` or `--backend webgpu` for reproducible resume. `--backend auto` intentionally disables resume because the actual provider can change. Use `--browser-executable` or `PAGESPATIAL_CHROME_EXECUTABLE` when Chrome is not at the macOS default path.

## Known gaps

These are real gaps, not implied future features:

1. Gold labels exist only for a 30-page pilot ([gold pilot trial](trials/2026-08-19-gold-pilot-first-accuracy.md)); the remaining 132 development pages are unlabelled and the pilot used one annotator without adjudication.
2. Geometry precision/recall, reading order, table structure, retrieval quality, and answer grounding remain unmeasured. Token recall, conflict composition, chart-relation recall, and one false-confidence instance are now measured at pilot scale only.
3. The current relation detector is deliberately narrow: single-series year/category/value candidates only.
4. General table reconstruction is not implemented.
5. A server GPU OCR adapter and server throughput benchmark are not implemented.
6. Full-document latency and time to first searchable page have not been measured for 50-page and 250-page workloads.
7. PDF Inspector performs a whole-document pass before its page result is available.
8. Browser and Node output equivalence is covered by fixtures, not a large independently labelled equivalence set.
9. No production persistence, revision store, ACL enforcement, deletion propagation, or tenant boundary exists in this library.
10. The package is not integrated into Evidence Search.
11. Vertical CJK writing mode is unvalidated: PDF.js swaps width/height roles for vertical fonts, so `pdfJsTextItemPointBox` would produce transposed, undersized boxes. No vertical-text page exists in the development corpus yet.

## Next work, in order

### P0 — Create independent development gold

Do this before changing thresholds or adding broader inference.

1. Define a versioned gold schema for:
   - visible critical tokens and their page boxes;
   - reading-order edges or ranks;
   - table cells, rows, columns, headers, and spans where present;
   - chart relation tuples such as `(series, category, value, unit)`;
   - page or region `needs escalation` labels;
   - material-error severity.
2. Keep private page text and labels outside the npm package. Commit the schema, manifest hashes, evaluator code, and text-free aggregate only. A private dataset revision is the preferred durable store.
3. Start with a stratified development pilot covering native pages, image-only scans, mixed pages, rotations/crop shifts, columns, dense tables, charts, multilingual pages, and both escalated and accepted pages.
4. Use an annotator who did not implement the parser. Record adjudication for disagreements.
5. Implement the metrics in [evaluation rubric](evaluation-rubric.md), sliced by page class and aggregate.
6. Treat a material false acceptance as a hard failure. Do not hide it in a weighted score.

Acceptance for P0:

- every labelled item is bound to source hash, page, coordinates, corpus revision, label version, and annotator/adjudication state;
- evaluator outputs are reproducible and content-hashed;
- missing metrics remain `not_evaluated`;
- the candidate holdout is not accessed or tuned against.

### P1 — Triage current conflicts with gold

Use the new labels to classify the 449 critical conflicts and 98 escalated pages into:

- OCR error;
- native-text error;
- incorrect association;
- correct disagreement caused by hidden or duplicated source content;
- genuinely ambiguous layout;
- unnecessary escalation.

Fix only repeated, general failure classes. Add a retained regression before changing code. Do not lower escalation thresholds merely to reduce the count.

### P1 — Measure long-document performance

Run cold and warm tests on approximately 10-, 50-, and 250-page documents. Record:

- time to first schema-valid/searchable page;
- PDF Inspector startup time;
- render, OCR, merge, and projection time;
- total document time and pages per second;
- peak browser, CPU, GPU, and server memory;
- actual backend, batch sizes, render scale, and concurrent workload.

First measure the whole-document Inspector delay. If it violates the product budget, test PDF.js plus OCR as the progressive first-page path and Inspector as later enrichment. Such enrichment needs explicit record revision semantics; do not silently mutate a canonical page in place.

### P1 — Implement and benchmark a server GPU OCR adapter

Target the existing `OcrAdapter` contract. An L4-class deployment is a reasonable first benchmark, but the backend is not part of the public schema.

Requirements:

- preserve PP-OCR text, confidence, polygons, page identity, and backend provenance;
- use bounded page batching and memory limits;
- produce schema-equivalent PageSpatial records;
- pass the same gold and conformance tests as browser WebGPU/WASM;
- compare throughput, first-page latency, peak GPU memory, and cost per page;
- keep browser-local parsing available for privacy-sensitive workflows.

Do not move deterministic merge or diagnostic logic onto the GPU.

### P2 — Freeze and run a release holdout

Only after the gold schema, evaluator, and numeric release profile are stable:

1. freeze holdout labels and hashes;
2. document the release profile and thresholds;
3. run the holdout once for the candidate release;
4. retain every failure and routing decision;
5. promote only if each safety gate passes independently.

### P2 — Integrate with Evidence Search

Follow [the migration sequence](evidence-search-migration.md) behind a feature flag. Keep the existing ingestion path as rollback until PageSpatial passes the sealed release profile. Application UI, retrieval, Gemini/OpenRouter calls, and annotations remain in Evidence Search.

## Change rules

For every parser or adapter change:

1. Add a focused regression using retained or generated evidence.
2. Run `npm run check`.
3. Run the applicable real browser smoke with verified assets.
4. Rerun affected development slices; rerun the complete development baseline for changes to schema, geometry, matching, diagnostics, OCR configuration, or adapter semantics.
5. Generate an authenticated text-free aggregate from a clean implementation commit.
6. State clearly whether a number is gold accuracy, cross-engine corroboration, association coverage, or schema conformance.
7. Preserve historical failed aggregates and trial reports. Do not overwrite them.

Do not:

- delete raw observations after matching;
- treat Markdown or derived relations as source evidence;
- trust PDF Inspector rectangles for rotated geometry;
- add AnyDoc as a second PDF parse without new measured evidence;
- use implicit CDN assets or silently report a requested OCR backend as actual;
- render document Markdown as trusted HTML;
- send private pages to a remote model without explicit authorization;
- tune against the candidate holdout;
- introduce Rust, a registry, or a general framework without a measured bottleneck.

## Handoff completion checklist

The next engineer should be able to confirm the repository state with:

```sh
node --version        # must satisfy package.json: >=25
npm ci
npm run check
git status --short    # should be empty after verification
```

Then confirm access separately:

```sh
hf auth whoami
npm run eval:corpus:dry-run
```

If these pass, begin with P0 independent development gold. Do not begin with a new model, Rust rewrite, Evidence Search integration, or holdout run.

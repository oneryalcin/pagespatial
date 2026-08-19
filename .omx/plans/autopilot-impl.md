# PageSpatial implementation plan

1. Define canonical types, runtime schemas, deterministic identities, and adapter contracts.
2. Port the proven geometry transform, text normalization, association, reading-order, relation, and diagnostic logic into strict TypeScript modules.
3. Add the page builder and bounded-concurrency document parser.
4. Add Markdown projection as a derived view.
5. Add tests for transforms, conflicts, chart relations, schema validity, progressive callbacks, and adapter equivalence.
6. Document browser/server architecture, evaluation gates, and Evidence Search migration.
7. Install pinned dependencies, run build/typecheck/tests, review package contents, initialize Git, and create the initial commit.

## Adapter milestone

1. Replace whole-document native extraction with a page-level native adapter so page parsing remains progressive.
2. Add a shared PDF.js session with byte/page limits, SHA-256 identity, cached page promises, and idempotent disposal.
3. Add PDF.js native and canvas adapters that retain the real viewport transform and release temporary canvases.
4. Add a lazy PP-OCRv6 browser adapter with explicit local assets, verified providers, single-flight initialization, serialized inference, and one sticky WASM fallback.
5. Add an optional Node PDF Inspector adapter for page-addressable native Markdown and positioned observations; do not add AnyDoc to the browser path.
6. Add exact asset preparation and verification without shipping model binaries.
7. Add focused unit tests, a browser example, lifecycle/security documentation, a real-PDF smoke test, and package-content verification.

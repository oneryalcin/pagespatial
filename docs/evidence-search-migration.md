# Evidence Search migration

## Move into PageSpatial

- Canonical evidence schemas.
- PDF coordinate transforms.
- Native/OCR association.
- Critical-token diagnostics.
- Reading-order construction.
- Simple chart/table relation candidates.
- Markdown and retrieval projections.
- Evaluation rubric and conformance tests.

## Keep in Evidence Search

- PDF viewer and upload flow.
- Browser model asset delivery.
- Search, ranking and query UI.
- Highlights and annotation gutter.
- Gemini/OpenRouter API routes.
- Application-specific answer cards.

## Integration sequence

1. Keep the current ingestion path as rollback.
2. Add PageSpatial behind a feature flag.
3. Convert existing PP-OCR results into `OcrObservation` records.
4. Open one shared PDF.js session and use the official page-native and canvas adapters.
5. Replace application-local merge and diagnostics with PageSpatial output.
6. Index projections while retaining the canonical document sidecar.
7. Compare current and PageSpatial behavior on the sealed corpus.
8. Promote only after the versioned evaluation gates pass.

Do not add AnyDoc as a second browser PDF parse. If stronger page Markdown is required on Node, use the optional PDF Inspector native adapter and measure its first-page delay separately.

Application code must not depend on internal matcher heuristics. It should consume the canonical schema, diagnostics, and projections.

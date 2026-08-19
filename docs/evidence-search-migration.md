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
4. Add the existing positioned-native extractor as a `NativeAdapter`.
5. Replace application-local merge and diagnostics with PageSpatial output.
6. Index projections while retaining the canonical document sidecar.
7. Compare current and PageSpatial behavior on the sealed corpus.
8. Promote only after the versioned evaluation gates pass.

Application code must not depend on internal matcher heuristics. It should consume the canonical schema, diagnostics, and projections.


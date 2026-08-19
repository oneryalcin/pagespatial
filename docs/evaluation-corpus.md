# Development corpus evaluation

This harness measures the PageSpatial extraction pipeline independently from Evidence Search.

## Scope

- Dataset: private Hugging Face dataset `oneryalcin/enterprise-document-landfill`.
- Revision: `e3ee38f067588644b11574ccc566843ca45f6d33`.
- Manifest: `evaluation/corpus.v1.json`.
- Development: 23 PDFs and 162 nominated pages.
- Candidate holdout: 13 PDFs and 89 nominated pages.

The holdout is recorded for future sealing, but this implementation has no holdout materialization or runner control. Source reports under `evaluation/corpus/manifests/` are selection provenance only; the flattened v1 manifest is authoritative.

## What runs

Every selected development page uses both inputs:

1. PDF Inspector provides page-aligned Markdown and unambiguous structure metadata. It runs once per document in a killable Node child process and caches its whole-document extraction inside that process.
2. PDF.js provides native text observations, full item transforms, page bounds, and canonical rendered geometry.
3. PP-OCRv6 Tiny reads every rendered page and returns text, confidence, and polygons. OCR inference is serialized through one engine.
4. The internal page assembler preserves both sources, their geometry, matches, conflicts, derived relations, diagnostics, and provenance.

Markdown is a derived view. A successful native/OCR match is not an accuracy label.

## Commands

```sh
npm run eval:corpus:check
npm run eval:corpus:dry-run
hf auth whoami
npm run eval:corpus:materialize
npm run eval:ocr-assets

# One nominated development page.
npm run eval:baseline -- \
  --document-id pa-sers:2024-09-24:llr-vii:staff-memo \
  --page 1 \
  --backend auto \
  --run-id smoke-llr-staff-1

# All 162 nominated development pages.
npm run eval:baseline -- --backend auto --run-id dev-v1
```

Use `--data-root <directory>` to keep private data outside the checkout. Use the same data root for materialization, OCR assets, and the runner. Set `--browser-executable <path>` or `PAGESPATIAL_CHROME_EXECUTABLE` when Chrome is not installed at the macOS default. Stable OCR asset URLs are verified against the committed model manifest before the browser starts.

## Private output

Runtime data is written below `.evaluation/` by default:

```text
corpus/<dataset path>
ocr-assets/
runs/<runId>/current.json
runs/<runId>/invocations/<invocationId>.json
runs/<runId>/invocations/<invocationId>/documents/<objectId>.json
runs/<runId>/events.ndjson
runs/<runId>/documents/<objectId>/attempts/<page>/<attempt>.json
runs/<runId>/documents/<objectId>/pages/<page>.json
```

Every page execution is retained as an immutable attempt. Every runner invocation and its document summaries are also immutable. `current.json` is only a mutable pointer to the latest invocation; it is not part of an authenticated historical graph. A successful attempt is promoted to the convenience path `pages/<page>.json`; aggregates authenticate the immutable attempt, not this mutable convenience copy. A later failure never replaces the accepted attempt. Failed attempts retain available raw OCR, rendered geometry, and native observations as typed partial evidence, but never label an invalid merge as PageSpatial.

A succeeded page resumes only when its source identity, PageSpatial payload, fixed actual backend, configuration fingerprint, and prior summary output hash all match. `--backend auto` deliberately disables resume because the actual provider may change between runs. Failed, timed-out, aborted, corrupt, or stale pages run again.

Each immutable invocation content-hashes every immutable document summary, and each summary content-hashes its immutable page attempts. Generate the public, text-free aggregate from the current invocation with:

```sh
npm run eval:baseline:summary -- \
  --run-root .evaluation/runs/<runId> \
  --output evaluation/baselines/<runId>.summary.json
```

Pass `--invocation <runRoot>/invocations/<invocationId>.json` to verify or regenerate an older invocation after later resumes. Historical aggregates remain auditable because `current.json` and canonical page convenience files are outside their authenticated graph.

The browser can request only loopback URLs. The route map exposes only selected development PDFs and verified local OCR assets. Events contain statuses and sanitized errors, not PDF text, signed URLs, or credentials.

The private dataset identifier and pinned revision in this document are intentionally publishable provenance. Corpus files, runtime outputs, route maps, and OCR caches are excluded from Git and the npm package.

## Interpreting results

The baseline records parser evidence, timings, sampled memory, actual OCR backend/fallback, conflicts, and escalation signals. It does not create gold truth. These production gates remain `not_evaluated` until independently labelled references exist:

- OCR text and critical-token recall.
- Geometry precision and recall.
- Reading-order correctness.
- Table-cell and chart-label relationship accuracy.
- Numeric, currency, percentage, date, and unit preservation.
- Retrieval and answer quality.
- Latency, memory, and cost.
- Escalation rate and false-confidence rate.

Do not tune parser behavior against the candidate holdout. A future sealed evaluation must unlock it through an explicit code and profile change.

The first clean-commit development pass is recorded in [Development corpus baseline](trials/2026-08-19-development-corpus-baseline.md).

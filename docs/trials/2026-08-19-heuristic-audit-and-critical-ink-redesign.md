# Heuristic audit, scale/locale hardening, and critical-token redesign

Date: 2026-08-19
Baselines: [dev-v7](../../evaluation/baselines/dev-v7-scale-locale-2026-08-19.summary.json) (behavior-preserving validation), [dev-v8](../../evaluation/baselines/dev-v8-critical-ink-2026-08-19.summary.json) (new conflict definition — the current baseline).

## What changed and why

An audit of the parser heuristics found overfitting to the development corpus: pixel constants tuned at one render scale, a critical-token regex with a financial unit whitelist, host-locale-dependent lowercasing, and several decisions whose uncertainty was never published. Changes landed in two validated steps.

### Step 1 — behavior-preserving hardening (validated by dev-v7)

- `toLocaleLowerCase()` → `toLowerCase()` in text normalization. The host locale (e.g. Turkish dotless ı) changed normalized text across machines, making matching nondeterministic. Regression test spawns a `tr_TR` subprocess.
- All heuristic spatial constants centralized in `src/tuning.ts`, expressed in PDF points with rationale, scaled by `renderedPixelsPerPoint(geometry)` (viewport-transform magnitude; correct under rotation). Values equal the old pixel constants at the 1.6 reference scale. Scale-invariance regression tests added.
- O(n²) member-box lookup in association replaced with a map.

dev-v7 vs dev-v6: identical on every parser-controlled number (162/162 valid, 449 conflicts, 98 escalated, 17,051 native observations). One OCR observation differed (14,797 vs 14,796) — WebGPU inference nondeterminism upstream of the parser.

### Step 2 — design changes (validated by dev-v8)

**Critical tokens compare ink, not values.** Native text and OCR transcribe the same visible glyphs, so only engine-introduced variance is healed (codepoint variants, typographic whitespace, segmentation, case). Notation is never interpreted: no unit whitelist, no `mm→m`/`b→bn` folding, no comma-stripping, currency via `\p{Sc}`. Contract tests in `test/critical-tokens.test.mjs` pin 22 match/conflict rows.

Offline old-vs-new diff over the retained dev-v7 records:

- 10 old conflicts became matches — all reviewed, all pure presentation heals (`$ 1,922,195` vs `$1,922,195`, `$ 1 m` vs `$1m`, `17 th` vs `17th`). No materially different value was merged.
- 215 old matches became conflicts — drivers: removed comma-loss healing, verbatim adjacent-word capture, previously invisible OCR misreads (`cd0ab370` vs `cdOab370`, Polish `ł`→`t` next to amounts, a neighboring column's `$` glued onto values). This deliberately trades silent false negatives for visible, triageable conflicts.

**Published uncertainty.** Additive schema fields, no decision changes:

- `EscalationReason.severity` (`blocking` for critical-token reasons, `advisory` for weak-OCR/ambiguous-relation; derived from type, no new knob) and `EscalationReason.share` (count over its denominator).
- `PageProjection.markdownSource` records which extractor produced the markdown.
- OCR adapter admission policy recorded in provenance (`ocrAdapterConfiguration`), because `recognitionThreshold` (0.25) and `lowOcrConfidence` (0.5) are a coupled pair: the 0.25–0.5 band escalates by construction.
- Relation components now publish the source observation's real box; character-interpolated boxes remain internal to column assignment. Method renamed to `column-chart-single-year-row-above-nearest-x-v1` to state its layout assumption. Year patterns unified on one definition (`YEAR_BODY_SOURCE`, now `19|20`).

**Reject, don't repair.** Singular PDF.js text transforms now throw instead of fabricating a 1pt height or an assumed writing direction.

## dev-v8 results (23 documents, 162 pages, WebGPU, Apple M4 Max)

- 162/162 OCR-completed and schema-valid; 0 failed closed — the singular-transform rejection hit zero corpus pages, answering the empirical question it was landed with.
- 17,051 native observations (unchanged); 14,797 OCR observations; 11,040 matches.
- 663 critical conflicts (was 449) across the new definition; 103 pages escalated (was 98).
- Escalation histogram (new instrumentation): critical-token-conflict 78 pages, critical-token-omission 44, low-ocr-confidence 43, ambiguous-derived-relation 7. Only 12 of 103 escalations are advisory-only.
- Markdown source: pdf-inspector 136 pages, pdfjs-deduplicated 12, native-lines 14. The page-wide Inspector discard fires on 12/162 — recorded as a P1 measurement, rule unchanged.

Interpretation rules unchanged: these are schema conformance and cross-engine corroboration numbers, not accuracy. The 663 conflicts are evaluation inputs. Conflict counts before and after this change are **not comparable**; dev-v8 replaces dev-v6 as the reference baseline, and dev-v6/dev-v7 are retained as history.

## Consequences for P0

Land gold labels against the dev-v8 conflict definition, not the retired regex. P1 triage gains three new slices for free: severity, share, and markdownSource.

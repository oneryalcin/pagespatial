# Trial: native glyph audit (schema 0.7.0)

**Date:** 2026-11-07 · **Branch:** `fix/native-glyph-audit`

## Problem

A PDF whose font ToUnicode map is corrupted renders correctly but extracts
wrong letters. Conflicts are raised only for digit-bearing tokens, so the full
pipeline let corrupted native prose into the markdown projection with no
conflict, no escalation and no diagnostic. A broken-CMap fixture put 36
corrupted words into the "Native structure reference" section.

## Change

- `src/glyph-audit.ts`, `auditNativeGlyphs`: per page and font, native
  observations at least 60% covered by OCR boxes are aligned against the OCR
  text, character by character. Gaps cost 2 and substitutions 1, and the
  alignment is global unless the OCR text is clearly longer, so substitution
  ciphers align positionally. A native letter is contradicted when OCR reads
  it as the same other letter at least twice and in at least half of its
  aligned occurrences.
- New escalation reason `native-glyph-mismatch` (**advisory**, so it never
  triggers paid enrichment). Its `sourceIds` are the native observations
  containing a contradicted letter. The schema re-derives it with the same
  function, so dropping the reason fails validation. **Schema 0.6.0 → 0.7.0**
  (precedent: 0.5.0 → 0.6.0 when re-derived second-opinion evidence was
  added). The Modal app's `SCHEMA_VERSION` moves with it, so redeploy it with
  this change.
- Projection: a font whose contradicted letters reach **10% of its aligned
  letters, over at least 100 letters**, is withheld. Its native text stays in
  the record but out of the markdown, which falls back from adapter markdown
  to native lines and states why.
- OCR blindness is not evidence. Letters in a script OCR never emitted on the
  page are not audited. Japanese text with no OCR kana also excludes Han,
  because a model without Japanese reads kana and kanji as Chinese
  look-alikes.

## Why narrow mismatches are flagged, not withheld

From the evidence alone, a single swapped letter in a broken map (`v`↔`y`) is
indistinguishable from a systematic OCR misread (Polish `ą` read as `q`, with
the native text correct). Withholding would remove correct text in the second
case. The threshold separates them by breadth:

| Case | Contradicted share | Letters | Result |
|---|---:|---:|---|
| e↔o broken CMap fixture | 0.294 | 978 | withheld |
| v↔y broken CMap fixture | 0.025 | 978 | flagged, kept |
| worst real-corpus case (pre-guard Tiny on Japanese) | 0.101 | 267 | no longer audited (script guard) |
| real Polish ą→q, kanji variants | ≈0.01–0.06 | — | flagged, kept |

## Evidence

- `test/glyph-audit.test.mjs`, five tests, each proven to fail without its
  mechanism:
  - broken font withheld;
  - offset-CMap font withheld;
  - narrow mismatch kept;
  - reason cannot be dropped;
  - script-blind OCR never withholds.
- Replay over every stored run (2,937 pages, 20 runs): **0 pages withheld**,
  250 pages flagged advisory, mostly older Tiny-OCR runs.
- End to end through the local service (PP-OCRv6 Small, ORT WASM), using the
  fixtures from `make_broken_cmap_fixture.py`:

| Fixture | glyph reason | corrupted words in markdown | markdown source |
|---|---|---:|---|
| clean | none | 0 | pdf-inspector |
| e↔o | advisory, 18 lines | **0** (was 36) | native lines + withheld note |
| v↔y | advisory, 12 lines | 6 (kept by design) | pdf-inspector |

- `npm run check`: 390/392 library tests (2 skipped), 128/130 API tests
  (2 skipped), schema verified.

## Limits

A letter seen once per page cannot be judged. Pages without OCR coverage of
the native text (no overlapping OCR boxes) are not audited.

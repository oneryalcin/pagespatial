# Trial: broken-CMap prose fixture through the full pipeline

**Date opened:** 2026-11-07

**Status:** finding recorded; no code change

**Finding:** when a body font's ToUnicode map is corrupted, so the page
renders correctly but extracts wrong letters, today's full pipeline produces
the right OCR text and corroborates it with Tesseract. But it **puts the
corrupted native text into the markdown projection** under "Native structure
reference", **with no conflict, no escalation and no diagnostic naming the
native layer as untrustworthy**. A consumer indexing the markdown would index
the garbage. This contradicts the precision and explainability promise
([selective OCR design](../design/2026-11-07-selective-ocr.md)).

## Fixture

[`scripts/evaluation/make_broken_cmap_fixture.py`](../../scripts/evaluation/make_broken_cmap_fixture.py)
writes `clean.pdf` and `broken.pdf`, a Letter page of 18 prose lines (Arial)
and 6 money lines (Courier New). Their pixels are identical. In `broken.pdf`
the Arial ToUnicode CMap swaps `e` and `o` (2 bfchar entries), so native
extraction reads "Tho cemmittoo roviowod tho prepesal…". Digit lines are in
the intact font.

## Run

Local parse service built from `chore/dependency-upgrades` (the branch whose
pdfjs-dist 6.3.289 matches the installed `node_modules`; `main`'s pdfjs-dist
5 `pdf.destroy()` call fails against the installed 6.x). Adapter
`ppocr-server` (PP-OCRv6 Small, ORT WASM, 4 threads), one worker, Tesseract
second opinion on.

| | clean.pdf | broken.pdf |
|---|---:|---:|
| native/OCR source matches | 24 | 6 (only the intact-font money lines) |
| association coverage | 1.00 | 0.25 |
| unmatched confident OCR | 0 | 18 |
| conflicts | 0 | 0 |
| requiresEscalation | false | false |
| corrupted words in markdown | 0 | 36 |

Why nothing fires:

- Conflicts are only ever raised for critical (digit-bearing) tokens: both
  reasons in `src/merge.ts` are critical-token disagreement or omission, and
  all 470 dev-v12 conflicts carry digits. A prose disagreement is never a
  conflict.
- `uncorroborated-ocr` would fire (24 confident lines, 25% engaged, below
  50%), but Tesseract reproduces PP-OCR's reading, so the OCR lines count as
  cross-engine corroborated. That is correct for the OCR text. Nothing then
  asks whether the *native* layer is wrong.

## Implication

The signal already exists in the record: an intact-geometry native line
sitting under an OCR line with near-zero text similarity, consistently for
one font. The selective-OCR font audit formalises it: per font, compare
audit lines; if they disagree, mark the font's native text untrusted and
keep it out of the projection. Doing this would close the gap in full mode
too, independent of whether selective OCR is ever adopted.

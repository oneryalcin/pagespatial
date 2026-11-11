# Trial: building selective OCR

**Date:** 2026-11-11 · **Branch:** `feat/selective-ocr` · **Status:** built, opt-in, not adopted

Design: [selective OCR](../design/2026-11-07-selective-ocr.md).

## Result

Selective OCR works as designed and keeps the guarantee, but on the dev
corpus it is **1.07x faster**, not the estimated 1.3x. It is built as an
opt-in mode and is not adopted.

- **Why the gain is small:** it skips 18.6% of recognizer work (by line
  width) on the 162 dev pages. 57% must always be read (numerals, scans,
  charts and other text outside the text layer), and the per-page font
  audit reads about as much again as is skipped.
- **Nothing was lost:** in replay over four full-OCR runs, the only
  conflicts in skipped boxes are OCR inventing a digit where the native
  text is right, and no wrong or edited gold token sits only in a skipped
  box. Broken-font fixtures and a scan with a hidden OCR text layer are
  read in full.
- **A finding that matters beyond this mode:** with the pipeline's default
  batching, a line's reading depends on which other lines are read with it.
  Batching only crops that pad to the same width removes that dependence,
  reads identically to batch size 1, is no slower than the default, and
  scores the same on gold.

Where it would pay: prose-heavy documents. The four most prose-heavy
documents in the corpus skip 34–45% of their recognizer work; table-heavy
and scanned documents skip almost nothing.


## What was built

Off by default. `SERVICE_OCR_SELECTIVE=1` (service) or `--selective`
(`run-baseline-sidecar.mjs`) turns it on. Full-OCR requests to the sidecar
are unchanged.

- **Sidecar** (`service/sidecar/ppocr_sidecar.py`): two new requests,
  `detect` and `recognize` with box indices. They drive the PaddleX
  pipeline's own detect, sort, crop and recognize steps.
- **Decision** (`src/selective-ocr.ts`): `skipVerdict(box, evidence)` is a
  pure function of the native observations and the OCR observations read so
  far. A detected box may go unread only when all of these hold:
  - the page has at least 200 native characters;
  - native boxes cover at least 60% of the box;
  - no native line touching the box holds a numeral (any Unicode numeral, or
    an ideographic one) or a control, private-use, unassigned or replacement
    character;
  - every native observation under the box has a font, and OCR contradicts
    no letter of that font on this page;
  - every letter of the native text under the box was read by OCR as that
    same letter, in that font, at least twice on this page.
- **Reading order** (`recognizeSelectively`): read the boxes no audit could
  excuse; read audit lines chosen greedily to confirm the remaining letters;
  then read whatever the evidence still does not excuse, repeating until
  every unread box is excused.
- **Pages read in full**: the native adapter now reports
  `textLayerDistrust` when pdf-inspector would send the page to OCR, or when
  images cover at least half the page. The second rule is for scans that
  carry an invisible text layer from an earlier OCR tool.
- **Record**: `selectiveOcr.skipped` lists each unread box with the native
  observations standing in. The schema re-runs `skipVerdict` on every skip,
  so a record cannot declare a skip its own observations do not excuse.
  **Schema 0.7.0 → 0.8.0.** The Modal app's `SCHEMA_VERSION` moves with it.
- **Starvation check**: skipped boxes count as detected and corroborated in
  the `uncorroborated-ocr` ratio. Without that, a page of skipped prose and a
  few chart labels would escalate as starved and trigger the Tesseract pass.
- **Provenance**: the adapter descriptor ends
  `;ocr=selective;rec_batch=same-width`, and `configuration.ocrBackend`
  carries `ocrMode: selective`.

One change reaches full-OCR records too: a native item that pdf-inspector
could not be matched to now takes the font name of the other items in the
same PDF.js font, instead of the PDF.js font id. Before, one font appeared
under two labels on a page, and each label needed its own audit lines.

## The split reproduces the pipeline

`scripts/evaluation/selective_ocr_split_modal.py`, 90 ceremony pages, Linux
x86, OpenVINO HPI, 4 cores, run twice (two containers). Driving the
pipeline's steps separately, with nothing skipped, gives the same texts,
scores and polygons as `ocr.predict()`: 0 mismatches in 7,928 and 7,940
lines, at recognizer batch size 6 and at 1.

## Reading fewer lines changes the lines that are read

The recognizer sorts crops by aspect ratio, takes them in batches, and pads
each batch to its widest crop. A line's input therefore depends on its
batch-mates. The test recognizes only the lines whose full reading holds a
digit and compares them with the full run. Second container, variants
interleaved page by page:

| Recognizer batching | Kept lines | Read differently | Digits differ | ms/page, all lines | ms/page, digit lines only |
|---|---:|---:|---:|---:|---:|
| 6 (production) | 4,313 | 66 | 9 | 2,947 | 1,207 |
| 1 | 4,312 | 0 | 0 | 3,184 | 1,135 |
| same width | 4,312 | 0 | 0 | 2,829 | 986 |

Detection alone takes 269 ms/page. The first container was faster overall
and showed the same pattern: batch 6 changed 74 kept lines (15 in their
digits); batch 1 changed none and was 26% slower per page (1,416 against
1,126 ms).

- **Batch 6** cannot be used: skipping prose would change about 0.2–0.35% of
  digit lines, in either direction.
- **Batch 1** is stable but slower on this backend. (On macOS with the
  Paddle backend it is twice as fast; the result does not carry across
  backends.)
- **Same width** is what the sidecar's `recognize` request uses. Crops no
  wider than the recognizer's base shape (320×48) all pad to that one width,
  so they share batches of 6 without affecting each other; wider crops go
  one at a time. Its readings and scores are identical to batch 1 on all
  7,940 lines (largest score difference 0), and it is no slower than batch 6.

Same width, like batch 1, is a different witness from batch 6: in the first
container 140 of 7,928 lines read differently, 11 in their digits. On the
ceremony gold tokens (1,223):

| Batching | Gold tokens found | McNemar p against the browser reference |
|---|---:|---:|
| 6 | 980 | 0.38 |
| 1 | 985 | 0.12 |
| same width | 985 | 0.12 |

The three are equivalent on gold. (First container: 977 and 982.)

## How much is skipped

`scripts/evaluation/selective-ocr-replay.mjs` runs the live decision over
stored full-OCR runs, with native text re-extracted by the current adapter.
Shares are of total detected line width, which is what recognizer time
follows.

| Run (162 dev pages) | Skipped | Read as audit lines | Read for a numeral | No text layer | Not covered by native text |
|---|---:|---:|---:|---:|---:|
| dev-v13 | 20.0% | 20.1% | 31.8% | 13.2% | 11.6% |
| dev-v12 | 18.3% | 19.6% | 31.8% | 13.2% | 12.2% |
| dev-v10 | 15.3% | 19.6% | 31.3% | 13.3% | 12.7% |
| dev-v7 | 15.3% | 19.6% | 31.3% | 13.3% | 12.7% |

A live local run of the same pages (macOS, Paddle backend) skipped 18.6% of
line width, 1,160 of 15,131 detected boxes, on 94 of 162 pages. It is a
little below the dev-v13 replay because the replay cannot apply the
page-image rule.

The design estimated 25–31% net of audit lines. The difference is the scope
of the audit:

- The design audits each font once per document. The service parses pages
  independently, and a page record that verifies itself can only use
  evidence from its own page. A per-page audit must confirm every letter of
  every font on every page.
- Of the audit lines on one 31-page filing, 263 of 280 hold a letter that
  occurs at most three times in its font on the page, mostly capitals.
- Before the font-label fix above, the skipped share on dev-v13 was 15.4%.
- With one confirmation per letter instead of two it would be 25.8%. That
  is a weaker audit than the design specifies and was not adopted.

## Acceptance gate

From the replay, on the four runs:

- **Conflicts in skipped boxes:** 1, 1, 2 and 1, of 454 to 627 per run. All
  five are OCR inventing a digit where the native text is right (`(i)` read
  as `(1)`, `newly` as `neely 1`, `Amount` as `1ount`, a letter run read as
  `2H`). No real native error is hidden.
- **Gold:** none of the 7 wrong or edited gold tokens is found only in a
  skipped box.

End to end, locally (macOS, Paddle backend):

| Input | Read | Skipped | Why |
|---|---:|---:|---|
| clean fixture | 16 | 8 | |
| e↔o broken CMap fixture | 24 | 0 | font contradicted; `native-glyph-mismatch` raised and the font withheld, as in full OCR |
| v↔y broken CMap fixture | 24 | 0 | font contradicted; `native-glyph-mismatch` raised |
| scan with a Tesseract text layer (4,016 native characters) | 37 | 0 | pdf-inspector sends the page to OCR |

The scan was made by rendering one filing page to an image and letting
Tesseract write the PDF, so it has a full-page image and an invisible
`GlyphLessFont` text layer.

The full-against-selective comparison of the dev pages is under Speed.

## Speed

`scripts/evaluation/m1_linux_verification_modal.py::selective_local`: the
162 dev pages through the real service in the production image, Linux x86,
OpenVINO HPI, 4 cores, 4 workers with 4 sidecar threads each. One
container: full, selective, full again.

| Run | Pages/s | OCR stage p50 | OCR stage p95 | OCR observations | Boxes skipped |
|---|---:|---:|---:|---:|---:|
| full | 0.999 | 2,120 ms | 6,006 ms | 14,839 | |
| selective | 1.066 | 1,981 ms | 5,058 ms | 13,677 | 1,161 |
| full again | 0.998 | 2,196 ms | 5,228 ms | 14,839 | |

**Selective OCR is 1.07x faster on this corpus.** The two full runs differ
by 0.1%, so the gain is not host drift. The design's estimate was about
1.3x.

Escalation, full against selective, in that container:

- Pages per reason type are the same for every blocking reason (63
  critical-token-conflict, 38 critical-token-omission, 5 uncorroborated-ocr),
  and the Tesseract second opinion ran on 27 pages in each mode.
- Conflicts: 515 full, 512 selective.
- Three pages differ, all in advisory reasons: `native-glyph-mismatch`
  disappears on one page and appears on another of the same document, and
  one `low-ocr-confidence` disappears because the low-confidence line was
  skipped.

## Tests

`test/selective-ocr.test.mjs`, 11 tests. The five that guard a mechanism
were each run with that mechanism removed and failed:

- a numeral outside the detected box but on the same native line forces the
  read;
- a record declaring a skip its evidence does not excuse fails validation;
- skipped prose does not starve a page that also has chart labels;
- a page that is mostly one image is distrusted;
- repeated text takes its font's one label.

`npm run check`: 406 of 408 library tests and 128 of 130 API tests pass, 2
skipped in each, schema verified.

## Limits

- Punctuation and symbols in skipped text are not audited, only letters.
  Characters with no faithful Unicode mapping force a read.
- The skip rule's thresholds were tuned on dev-v12. All four replayed runs
  cover the same 162 pages. The locked holdout was not used.
- The library parser (`createParser`) has no selective path; only the
  service sidecar does.

## Not done

- Production is not redeployed and the default is unchanged. Adopting
  selective OCR changes witness coverage and the recognizer's batching, so
  it starts a new baseline era and needs its own ceremony.

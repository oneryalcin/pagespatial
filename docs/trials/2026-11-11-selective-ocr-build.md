# Trial: building selective OCR

**Date:** 2026-11-11 · **Branch:** `feat/selective-ocr` · **Status:** built, opt-in, not adopted

Design: [selective OCR](../design/2026-11-07-selective-ocr.md).

## Result

Selective OCR works as designed and keeps the guarantee, but on the dev
corpus it is **1.07x faster**, not the estimated 1.3x. It is built as an
opt-in mode and is not adopted.

- **Why the gain is small:** it skips about 19% of recognizer work (by line
  width) on the 162 dev pages. 57% must always be read (numerals, scans,
  charts and other text outside the text layer), and the per-page font
  audit reads about as much again as is skipped.
- **Nothing was lost:** in replay over the dev pages and over 152 pages
  the rule was never tuned on, the only conflicts in skipped boxes are OCR
  inventing a digit where the native text is right, and no wrong or edited
  gold token sits only in a skipped box. Broken-font fixtures and a scan
  with a hidden OCR text layer are read in full.
- **A finding that matters beyond this mode:** with the pipeline's default
  batching, a line's reading depends on which other lines are read with it.
  Batching only crops that pad to the same width removes that dependence,
  reads identically to batch size 1, runs at the default's speed within
  measurement noise, and scores the same on gold.

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
- **Same-width batching on its own**: `SERVICE_OCR_REC_BATCHING=same-width`
  reads every box through the same detect and recognize requests. It exists
  to separate the batching change from the skipping (see Speed).

### Font labels, which reach full-OCR records too

The glyph audit and the skip rule pool letter evidence by a native
observation's `font`. That label was pdf-inspector's font name where an item
could be matched to pdf-inspector by its text, and the PDF.js font id
otherwise. So one font appeared under two labels on a page, and, the other
way round, two PDF.js fonts could share one pdf-inspector name. The label
now names exactly one PDF.js font:

- every item of a PDF.js font carries the pdf-inspector name its matched
  items carry;
- where that name covers several PDF.js fonts, the label is the name
  qualified by the PDF.js id, for example `Name (g_d0_f4)`. 36 of the 162
  dev pages have such a name, covering 27% of native characters.

Effect on full-OCR records, measured on dev-v13's stored OCR with stored and
with re-extracted native text: `native-glyph-mismatch` is raised on 9 pages
either way. Four pages change (two stop being flagged, two start), and no
font is withheld from the markdown in either case.

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
  7,940 lines (largest score difference 0), and in this harness it is no
  slower than batch 6.

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
| dev-v13 | 19.6% | 20.5% | 31.8% | 13.2% | 11.6% |
| dev-v12 | 18.0% | 20.0% | 31.8% | 13.2% | 12.2% |
| dev-v10 | 14.9% | 19.9% | 31.3% | 13.3% | 12.7% |
| dev-v7 | 14.9% | 19.9% | 31.3% | 13.3% | 12.7% |

dev-v10 and dev-v7 hold the same OCR readings, so they are one piece of
evidence, not two.

A live local run of the same pages (macOS, Paddle backend) skipped 18.6% of
line width, 1,160 of 15,131 detected boxes, on 94 of 162 pages. It is a
little below the replay because the replay cannot apply the page-image
rule. (That run predates the qualified labels, which moved the dev-v13
replay from 20.0% to 19.6%.)

The design estimated 25–31% net of audit lines. The difference is the scope
of the audit:

- The design audits each font once per document. The service parses pages
  independently, and a page record that verifies itself can only use
  evidence from its own page. A per-page audit must confirm every letter of
  every font on every page.
- Of the audit lines on one 31-page filing, 263 of 280 hold a letter that
  occurs at most three times in its font on the page, mostly capitals.
- With one label per font object split across two names, as before this
  change, the skipped share on dev-v13 was 15.4%.
- With one confirmation per letter instead of two it would be about 26%.
  That is a weaker audit than the design specifies and was not adopted.

## Acceptance gate

From the replay, on the four runs:

- **Conflicts in skipped boxes:** 1 of 454 (dev-v13), 1 of 470 (dev-v12),
  2 of 627 (dev-v10) and 1 of 449 (dev-v7). They are four distinct cases,
  and in each OCR invents a digit where the native text is right (`(i)`
  read as `(1)`, `newly` as `neely 1`, `Amount` as `1ount`, a letter run
  read as `2H`). No real native error is hidden.
- **Gold:** none of the 7 wrong or edited gold tokens is found only in a
  skipped box.

### On pages the rule was never tuned on

The four replayed runs cover the 162 pages the skip rule was tuned on, so
they are one test, not four. `scripts/evaluation/selective-ocr-replay-fresh.mjs`
replays the rule on the page sample of the
[recognizer trial](2026-11-10-fast-recognizer-options.md), which PP-OCRv6
Small read in full on Linux: pages of the dev documents that no run covers,
and pages of other documents (DocLayNet test split). For every box the rule
would skip, it reports what the full reading would have added.

| Pages | Count | Read in full | Boxes skipped | Line width skipped | Conflicts in skipped boxes | Readings under 0.9 similar to the native text |
|---|---:|---:|---:|---:|---:|---:|
| Unseen pages of the dev documents | 102 | 7 | 750 of 6,342 | 16.9% | 1 | 7 |
| Other documents | 50 | 11 | 855 of 3,646 | 23.1% | 0 | 12 |

- The conflict is OCR reading `Class I` as `Class 1`.
- The 19 dissimilar readings are OCR misreads (`during` as `durins`, commas
  as full stops, `ą` as `a`, a closing quote as `99`, `Firm` as `Fim`, two
  surnames), glyph variants (`➨` and `→`), and boxes cut differently from
  the native items (a ruled line, two-column name lists). The least obvious
  six were checked against the page images; in each the native text is
  right.
- One page of the other documents is rejected by the parser itself (a
  native item with a zero-area box), in any OCR mode.

No native error is hidden on these 152 pages either. This is still not the
locked holdout, and the unseen dev pages share fonts and layouts with the
tuning pages.

### Fixtures

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

The comparison of full and selective records on the dev pages is under
Speed.

## Speed

`scripts/evaluation/m1_linux_verification_modal.py::selective_local`: the
162 dev pages through the real service in the production image, Linux x86,
OpenVINO HPI, 4 cores, 4 workers with 4 sidecar threads each. Each run is
one container, with a full-OCR leg first and last to bound host drift.

First container (three legs, before the qualified font labels):

| Leg | Pages/s | OCR stage p50 | OCR observations | Boxes skipped |
|---|---:|---:|---:|---:|
| full | 0.999 | 2,120 ms | 14,839 | |
| selective | 1.066 | 1,981 ms | 13,677 | 1,161 |
| full again | 0.998 | 2,196 ms | 14,839 | |

Second container (four legs, final code). The extra leg reads every box
with same-width batching, to separate the batching change from the
skipping:

| Leg | Pages/s | OCR stage p50 | OCR observations | Boxes skipped |
|---|---:|---:|---:|---:|
| full | 0.727 | 3,133 ms | 14,839 | |
| full, same-width batching | 0.694 | 3,683 ms | 14,838 | |
| selective | 0.761 | 3,070 ms | 13,715 | 1,123 |
| full again | 0.667 | 3,394 ms | 14,839 | |

- **Selective OCR is about 1.07x faster on this corpus.** The first
  container's two full legs differ by 0.1%, and it measured 1.07x. The
  second container was slower and drifted 8% between its full legs; against
  their mean (0.697) selective is 1.09x.
- **The gain comes from skipping, not from the batching change.**
  Same-width batching alone is level with full OCR (0.694 against a mean of
  0.697).
- The design's estimate was about 1.3x.

Escalation, per page, in the second container:

- Every blocking reason has the same page count in all four legs (63
  critical-token-conflict, 38 critical-token-omission, 5 uncorroborated-ocr),
  and the Tesseract second opinion ran on 27 pages in each.
- **Skipping changed no page's escalation reasons and no conflict.**
  Selective matches the same-width leg on every page, with 512 conflicts in
  both.
- Same-width batching differs from the default on three pages, all in
  advisory reasons (`native-glyph-mismatch` moves between two pages of one
  document; one `low-ocr-confidence` goes), and has 512 conflicts against
  515. That is the batching reading 1.8% of lines differently, as measured
  above.

## Tests

`test/selective-ocr.test.mjs`, 13 tests. These five were each run with
their mechanism removed and failed:

- a numeral outside the detected box but on the same native line forces the
  read;
- a record declaring a skip its evidence does not excuse fails validation;
- skipped prose does not starve a page that also has chart labels;
- a page that is mostly one image is distrusted;
- repeated text takes its font's one label.

`npm run check`: 408 of 410 library tests and 128 of 130 API tests pass, 2
skipped in each, schema verified. `deploy/modal/test_modal_app.py`: 45 pass.

## Where the build departs from the design

- **Audit scope:** per page, not per document (above).
- **No ink check on skipped boxes.** The design skipped by native box and
  needed a luminance test to catch hidden text. The build skips by detector
  box, so text with no visible ink is never a candidate.
- **No stored pointers to audit observations.** A skip names its native
  observations. The OCR observations that confirmed its letters are the
  ones overlapping native text in the same font on the page; they are
  re-derived, not stored.
- **Invisible OCR layers:** caught when pdf-inspector sends the page to OCR
  or images cover at least half the page. An image under half the page with
  hidden text beneath it is not caught by this rule. Its letters would
  still have to pass the audit, which random OCR errors in a hidden layer
  could.

## Limits

- Punctuation and symbols in skipped text are not audited, only letters.
  Characters with no faithful Unicode mapping force a read.
- PDF.js numbers fonts as it loads them, so a qualified label may differ
  between two runs of the same page (not measured). The audit is per page and is
  not affected; comparisons of `font` strings across runs are.
- The skip rule's thresholds were tuned on dev-v12, and all replayed runs
  cover those 162 pages. The check on untuned pages covers 152 pages, 50 of
  them from other documents. The locked holdout was not used.
- The library parser (`createParser`) has no selective path; only the
  service sidecar does.

## Not done, and what merging changes

- Production is not redeployed and the default is unchanged. Adopting
  selective OCR, or same-width batching alone, changes the witness, so it
  starts a new baseline era and needs its own ceremony.
- Merging this branch still changes every record at the next deploy, with
  the mode off: `schemaVersion` becomes 0.8.0 (the Modal app's
  `SCHEMA_VERSION` moves with it), and `font` labels change as described
  above.

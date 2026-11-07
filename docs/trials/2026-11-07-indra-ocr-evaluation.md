# Trial: Indra OCR as a PP-OCRv6 replacement

**Date opened:** 2026-11-07

**Status:** first look complete (local, macOS); Linux A/B not run

**Current decision:** **NOT A DROP-IN WITNESS SWAP.** Indra is 30–50x faster
than PP-OCRv6 small on this host and matches it on clean body text, but its
detector misses text inside charts and loses lines on dense scans. Chart-borne
numbers are the values PageSpatial exists to recover, so swapping the witness
outright would regress the core use case. PP-OCRv6 small stays the production
witness.

## Candidate

[datalab-to/indra](https://github.com/datalab-to/indra), `indra-ocr` 1.1.2,
Hugging Face models tag `v1.1.0`. CPU-only ONNX Runtime pipeline: line
detector, a ~1.25M-parameter Latin CTC recognizer plus CJK/RTL/world
recognizers behind a line-script classifier, n-gram LMs for unsure lines,
layout and reading order. Python only.

- Code: Apache 2.0. Model weights: modified OpenRAIL-M, free for research,
  personal use and organisations under $20M funding/revenue, and "cannot be
  used competitively with our API". PageSpatial is under the size threshold.
  Whether the managed parse service counts as competing with Datalab's API is
  **unresolved**; read the full licence or ask Datalab before any service
  adoption.
- Run with `mode=ocr` so it never reads the PDF text layer and stays an
  independent witness. Its default `auto` mode would trust the layer, which
  defeats native/OCR corroboration.

## Setup

- Apple M1 Pro, macOS, 4 threads per engine, pages sequential, one untimed
  warm-up page.
- PP-OCRv6 small built exactly as `service/sidecar/ppocr_sidecar.py` does
  (`paddleocr==3.7.0`, `paddlepaddle==3.2.1`, pinned models in
  `.evaluation/sidecar-models`). **Caveat:** on macOS this is paddle-default
  inference; production runs OpenVINO HPI on Linux, so the speed ratio below
  overstates the production gap.
- Both engines get byte-identical images.
- Harness: [`scripts/evaluation/indra_vs_ppocr.py`](../../scripts/evaluation/indra_vs_ppocr.py).
  Evidence: [`evidence/2026-11-07-indra-vs-ppocr.json`](evidence/2026-11-07-indra-vs-ppocr.json).

## Results

### 1. Native-text-layer proxy (19 pages, 200 dpi)

First ≤3 pages of 7 PDFs from `.evaluation/m1-subset-pdfs` (scans, 10-Q,
World Bank, memo, annual report). Bag-of-words recall/precision against the
PDF's own text layer on the pages that have one (≥30 words).

| Engine | mean ms/page | word recall | word precision |
|---|---:|---:|---:|
| Indra | 267 | 0.987 | 0.990 |
| PP-OCRv6 small | 12,162 | 0.992 | 0.993 |

This proxy only sees clean digital pages, which is where Indra is strongest.
Its one visible miss was large white display type over a photo
(monotaro 2025 FY 004 p3 headline).

### 2. Gold-token proxy (60 gold review images, 753 tokens)

Share of human-confirmed gold tokens (verdict `correct` or `edited`) found in
each engine's page text. **Bias:** gold tokens were PP-OCR proposals, so PP's
score is a ceiling by construction and the gap is overstated; the failure
*patterns* are what matter. "No currency" ignores `$` and `~`, because both
engines often put `$` on its own line.

| Pages | Engine | tokens found | mean ms/page |
|---|---|---:|---:|
| image-only (7) | Indra | 128/137 = 0.934 | 197 |
| image-only (7) | PP-OCRv6 small | 133/137 = 0.971 | 7,495 |
| other (53), no currency | Indra | 524/571 = 0.918 | 240 |
| other (53), no currency | PP-OCRv6 small | 560/571 = 0.981 | 10,033 |

### Indra failure modes (inspected, not inferred)

1. **Text inside charts is not detected.** Ares 2026 Q1 p52: every pie-chart
   legend label read, none of the slice percentages (7%, 21%, 41% …). Chart
   dollar figures on Ares p50, p51 and p67 likewise missing. Indra's `lines`
   output does not filter picture regions; the detector simply does not
   propose those lines.
2. **Dense scans lose lines.** Legistar Seattle 2438 p20 (newspaper
   clipping): 40 lines vs PP's 79, whole ordinances missing
   (`Ordinance 124799`, `November 3, 2015`, `21.28.040.B`). Indra's README
   reports 29.5% on degraded-scan tests.
3. **Finance glyphs.** `$` read as `S`; `1Q'23` read as `10/23`.

## Why Indra is fast

Its main Latin recognizer is tiny and its vocabulary is small. PP-OCRv6
small's recognizer ends in an 18,710-class head, which was 43% of parameters
and 18–30% of single-thread CPU recognition time when it was profiled on
2026-09-01, and its output volume dominated GPU device-to-host traffic. Indra
is external evidence that a Latin-scoped vocabulary is the main CPU lever.

## Re-open conditions

Revisit Indra as a witness, or as a fast first pass with PP kept for picture
regions and low-coverage pages, only if all of these hold:

- The model licence is cleared for the managed service.
- A Linux A/B against the OpenVINO sidecar on the gold corpus shows the gain
  survives (expected ~8–10x from the README's 6.2 pages/s on 4 cores vs
  production's ~0.7 pages/s).
- Chart-borne and dense-scan misses are routed to PP, and the routed share on
  the demand profile still leaves a material end-to-end gain.
- A baseline-era change is accepted: a new witness makes conflict counts
  non-comparable with prior baselines.

## Follow-up

Spike PP-OCRv6 small recognizer vocabulary pruning (Latin-scoped head), the
lever Indra's design points at, without changing the detector.

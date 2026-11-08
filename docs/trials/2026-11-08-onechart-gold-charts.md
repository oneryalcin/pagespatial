# Trial: OneChart on the gold chart pages

**Date:** 2026-11-08

**Status:** closed

**Decision:** **REJECT as a chart-value proposer.** On the 12 data charts in
the gold set, PageSpatial's own OCR (PP-OCRv6 Small plus zoom-retry recovery)
already reads 79 of 81 chart values. OneChart contributes 2 correct values
OCR missed, against 18 wrong values OCR cannot corroborate, so its
uncorroborated output is 10% correct. Any value it adds is uncorroborated by
construction, so that is the only output that matters. Stacked bars are
especially bad, including negative values that appear nowhere on the page.

## Why it was tried

[franken_ocr](https://github.com/dicklesworthstone/franken_ocr) bundles
OneChart (Chen, Kong et al., ACM MM 2024, arXiv 2404.09987), a 0.3 GB
chart-to-data model with a built-in numeric self-check. franken_ocr itself
was not run: its licence rider withholds rights from Anthropic and parties
acting for it, including execution and benchmarking. Upstream weights,
`kppkkp/OneChart`, are Apache-2.0 and were run directly.

## Setup

- Charts: the only gold pages with real data charts, Ares 2026 Q1 p50, p51,
  p52 and p67. 12 crops (8 donuts, 4 stacked bars) from the 1275×1650 gold
  review images ([`charts.py`](../../scripts/evaluation/onechart/charts.py)).
  The other 18 gold pages labelled `chart` are slides, tables or text.
- Reference: 81 values transcribed from the renders. The gold-confirmed
  numbers on these pages coincide with the reference where they cover chart
  values (p51 30, p52 33).
- Model: upstream `modeling_OneChart.py` `chat(..., reliable_check=True)`,
  CPU float32, 4 threads, Apple M1 Pro. The remote code was read first; it
  fetches only when given a URL.
- **Environment matters.** With transformers 4.37.2, every output began with
  corrupted tokens ("Telecom Research", stray Chinese) even on a clean
  synthetic bar chart. With **transformers 4.32.1 + torch 2.1.2** (the Vary
  lineage) the synthetic chart reads perfectly and passes its self-check, so
  all results below use that environment.
- Scoring: [`score.py`](../../scripts/evaluation/onechart/score.py). Numbers
  are matched one-to-one against the reference. OneChart often emits
  malformed dicts (set-style entries such as `"$180.2%"`), so numbers inside
  the `values` block are scored leniently and the malformed count is reported
  separately.

## Results

| | charts | reference values | correct | wrong | recall | precision |
|---|---:|---:|---:|---:|---:|---:|
| donuts | 8 | 40 | 30 | 5 | 0.75 | 0.86 |
| stacked bars | 4 | 41 | 6 | 16 | 0.15 | 0.27 |
| all | 12 | 81 | 36 | 21 | 0.44 | 0.63 |

- 23 s per chart on CPU after a 5 s model load.
- 5 of 12 outputs were not valid JSON.
- The self-check said "reliable" on 2 charts, both fully correct
  (percentage donuts). It cannot vouch for absolute values: it compares
  min-max *normalized* numbers.
- Wrong values include the same `$`-as-digit misread the Tiny recognizer made
  (`$103.9` → `5103.9`, `$157.6` → `1557.6`), dropped digits (`218.2` →
  `18.2`), and invented negatives on stacked bars.

### Against PageSpatial's OCR

dev-v12 records, first pass plus zoom-retry recovery:

| | OCR also read the number | OCR missed it |
|---|---:|---:|
| OneChart correct | 34 | **2** |
| OneChart wrong | 3 | **18** |
| reference values OneChart missed | 45 | 0 |

PageSpatial's OCR reads 79/81 of these chart values. The chart-number misses
seen on these pages in the Indra and Tiny trials were those engines' misses,
not the production pipeline's.

## Limits

12 charts from one document, with a reference transcribed by inspection. The
conclusion rests on the OCR comparison, which does not depend on the
transcription: OneChart adds almost nothing OCR does not already read.

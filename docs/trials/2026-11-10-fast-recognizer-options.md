# Trial: training or fine-tuning a fast OCR witness

**Date:** 2026-11-10

**Status:** open. Fine-tune spike run and checked on fresh pages; routing is
simulated, not yet built.

**Current decision:** a fine-tuned Tiny recognizer **cannot replace** Small: it
misreads small print. Routing by confidence alone (Small re-reads lines under
0.95) looked equal to Small on the ceremony sample but is **slightly worse on
fresh pages**, with value-changing errors at high confidence. Routing that
also sends **every digit-bearing line to Small** equals Small on numbers on
both samples, at 41–43% of line width re-read, an estimated 1.5x on the page.
Whether 1.5x is worth a second recognizer in the sidecar is an open product
decision. Indra stays blocked on its licence, not on its accuracy.

## Context

Small det + Tiny rec is 2.6–2.9x faster per page but was rejected for wrong
values (`$ 1,455,057` → `51,455,057`), see
[ocr-arms-linux](2026-11-07-ocr-arms-linux.md). Indra is faster still but
misses chart text, see [indra-ocr-evaluation](2026-11-07-indra-ocr-evaluation.md).
The question here: can training close either gap?

## PP-OCRv6 Tiny recognizer: trainable

- Training config is published:
  `configs/rec/PP-OCRv6/PP-OCRv6_tiny_rec.yml` in PaddlePaddle/PaddleOCR
  (Apache-2.0). PPLCNetV4 tiny backbone, CTC head plus an NRTR head used only
  in training, input `[3, 48, 320]`.
- Trainable weights are published and download (HTTP 200, 71.5 MB):
  `https://paddle-model-ecology.bj.bcebos.com/paddlex/official_pretrained_model/PP-OCRv6_tiny_rec_pretrained.pdparams`.
  Small and Medium have the same pair of links.
- `$`, `€`, `£`, `%`, `§` are all in `ppocrv6_tiny_dict.txt`, so the
  `$` → `5` error is a learned confusion, not a missing class.
- **Limit:** the Tiny dictionary (6,904 entries) has Latin, Greek and Chinese
  characters but **no Cyrillic, kana or Hangul**. Small's dictionary is the
  full one. Tiny can never be the only recognizer; non-Latin lines need Small.

## Indra: usable only with a licence answer

- No training code in `datalab-to/indra` or on the model hub. Weights are
  ONNX only (`det.onnx` is 390 KB; `model.safetensors` is the Latin
  recognizer's weights, published for the parameter count).
- Model licence (modified OpenRAIL-M), Attachment A 2(c): no use "for any
  purpose" by anyone who "provides or otherwise makes available any product or
  service that competes with any product or service offered by" Datalab. This
  clause has no research or personal exception, unlike the $20M clauses.
  Fine-tuned and distilled models are derivatives under the same licence.
  A hosted PDF parse service plausibly competes with Datalab's API. This needs
  a written answer from Datalab; it is not an engineering question.
- **Chart misses are a detector-resolution problem.** `meta.json` sets
  `det_long_side: 1024`. On the four Ares ceremony pages (980×1269, production
  scale), Indra on 3×3 overlapping tiles reads what the full-page pass
  missed: p52 pie slices `7%`, `21%`, `41%`, `19%`, `4%`; p50 `$335.1`,
  `$399.6`, `$99.2`; p67 `$218.2`, `$260.2`, `$65.2`, `$88.4`. 2×2 tiles were
  not enough. Cost on an M1 Pro: 220–420 ms full page → 700–1,010 ms for 3×3.
  Tiles also add junk tokens where text is cut at tile edges (not scored
  against gold). So tiling whole pages spends most of Indra's speed margin;
  it would have to be limited to picture regions.

## Datasets

| Dataset | What it has | Use for us |
|---|---|---|
| [DocLayNet-v1.2](https://huggingface.co/datasets/docling-project/DocLayNet-v1.2) | 80,863 born-digital pages (finance, tenders, law, manuals, patents, science), each with its single-page PDF and line-level `pdf_cells` (text, box, font). CDLA-Permissive-1.0. 85 parquet shards, ~40 GB. | **Yes.** A document-disjoint source of line crops with exact labels: render the PDFs at production scale, crop by cell box. Its layout labels are not needed. No scans. |
| FinTabNet_OTSL | 109k financial-report table images with cell content. Licence field is `other`; not yet read. | **Probably.** Dense in `$`, `%` and digit cells, the exact failure class. Check licence and whether cells carry boxes. |
| SynthChartNet | 1.98M synthetic charts with the data table as target; one box for the whole chart, none per label. | **No** for recognition: no per-line boxes. Rendering our own charts gives exact label boxes for free. |
| DeskForge-1M, screenparse | Desktop screenshots. | No. |

Checked on one DocLayNet row group (100 pages, all from one 1,714-page
manual): 87 cells per page, 18% contain digits, cells are lines not words.
Shards are grouped by document, so sample across shards.

## Fine-tune spike

[`rec_finetune_modal.py`](../../scripts/evaluation/rec_finetune_modal.py):
word-group crops of at most 25 characters cut from DocLayNet PDFs with
pdfium, labelled by the text layer. A crop is kept only when Small reads
nearly the same text (similarity ≥ 0.8) on a 2.0-scale render of the same
box; the label is always the text layer. 4,800 pages from 24 of 72 train
shards, ~241k crops; 100 pages from 2 validation shards. Training is
PaddleOCR `tools/train.py` at commit `dab3fe3`, published config, from the
published weights, lr 1e-4, batch 128, one L4.

| Run | Crops | Epochs |
|---|---|---:|
| `smoke` | all pages at production scale 1.6 | 1 |
| `v2` | half the pages at scale 1.6, half at 0.55–1.6 | 4 |

Validation crops (`v2` set, 5,497 crops, production inference path, text-layer
label as truth):

| | Small | stock Tiny | Tiny `v2` |
|---|---:|---:|---:|
| exact | 0.793 | 0.703 | 0.833 |
| value crops, ignoring spaces (1,994) | 0.857 | 0.756 | 0.856 |
| value crops ≤ 12 px high (370) | 0.573 | 0.424 | 0.614 |

`tools/eval.py` squashes crops to 320 px wide, so its `acc` is not comparable
with these numbers.

## Ceremony result: Tiny alone still fails

Same harness as [ocr-arms-linux](2026-11-07-ocr-arms-linux.md), one container,
all arms on identical detector boxes (7,940 lines). "Number precision" is
[`native-token-precision.mjs`](../../scripts/evaluation/native-token-precision.mjs):
the share of an arm's critical tokens that the page's PDF text layer
corroborates, on the 76 pages that have one. Scores:
[`evidence/2026-11-10-rec-finetune/`](evidence/2026-11-10-rec-finetune/).

| Recognizer (Small detector) | gold (of 1,223) | McNemar p vs browser | number precision | recall | World Bank misread tokens | mean ms/page |
|---|---:|---:|---:|---:|---:|---:|
| Small (production) | 980 | 0.38 | 0.857 | 0.879 | 135 | 2,745 |
| stock Tiny | 939 | 0.001 | 0.779 | 0.838 | 342 | 875 |
| Tiny `smoke` | 969 | 0.84 | 0.756 | 0.813 | 462 | 869 |
| Tiny `v2` | 957 | 0.17 | 0.790 | 0.863 | 316 | 863 |

- Fine-tuning fixes the error that got Tiny rejected: lone `$` read as
  `S`/`5` (Small does this too) now comes out as `$`.
- It does not fix small print. The two World Bank documents have lines 7–10 px
  high; Tiny misreads 2.3x as many number tokens there as Small even after
  training on small renders (`2022-09-15` → `2022-09-1s`). The `smoke` run,
  trained only on ~18–22 px text, made this worse than stock.
- Tiny cannot read Japanese at all (no kana in its dictionary). Polish
  (Asseco): 10 misread tokens for Small, 11 stock, 10 `v2`.
- Timings are from one container and are only comparable within this table.

## Routing: Tiny first, Small on unsure lines

[`simulate_recognizer_routing.py`](../../scripts/evaluation/simulate_recognizer_routing.py)
builds the result a two-pass recognizer would give: Tiny's reading, except
lines whose Tiny confidence is under a threshold or that contain CJK, which
take Small's reading.

| Tiny model, threshold | lines to Small | line width to Small | gold | p | number precision | recall |
|---|---:|---:|---:|---:|---:|---:|
| Small only | 100% | 100% | 980 | 0.38 | 0.857 | 0.879 |
| stock, 0.95 | 26.8% | 14.6% | 963 | 0.37 | 0.844 | 0.868 |
| stock, 0.98 | 43.1% | 42.5% | 975 | 0.81 | 0.855 | 0.877 |
| `v2`, 0.90 | 16.1% | 10.4% | 976 | 0.73 | 0.849 | 0.874 |
| **`v2`, 0.95** | **28.5%** | **23.1%** | **982** | 0.29 | **0.857** | **0.880** |

`v2` at 0.95 equals or beats Small on all three measures with 23% of line
width re-read. The stock model needs 43% and is still slightly behind, so the
fine-tune earns its place. Recognition cost is roughly proportional to line
width, and Tiny costs 1/4 to 1/6 of Small per call, so the recognizer stage
should take about 0.4–0.5 of today's; from this run's page times that is about
1.4 s per page against 2.7 s. **That speed is an estimate, not a measurement.**

Confident Tiny lines that still differ from Small are mostly Small's errors
(`S101.7` vs `$101.7`, `(l)` vs `(1)`, `100,000.08` vs `100, 000.00`), but
some are Tiny's and change a value at high confidence: `1,324,332` →
`1,324,32` (0.999), `2022-10-04` → `2022-10-0` (0.995), `$180.2` → `180.2`
(1.0). The aggregate is level with Small; it is not error-free, and neither is
Small.

## Fresh pages

[`build_fresh_ocr_sample.py`](../../scripts/evaluation/build_fresh_ocr_sample.py):
153 pages no earlier run had seen, all with a text layer. 102 are unseen
pages of the corpus documents (OSF 56, Monotaro 16, Ares, Asseco and
Blackstone 8 each, World Bank 6); 51 are DocLayNet test-split pages, other
documents than the fine-tune used. No scans: they have no text layer to score
against. No gold exists for these pages, so the measure is number precision
and recall against the text layer. The 0.95 rule was fixed before the run.

| Recognizer | line width to Small | number precision | recall |
|---|---:|---:|---:|
| Small only | 100% | 0.9588 | 0.9611 |
| stock Tiny | 0% | 0.8780 | 0.9155 |
| Tiny `v2` | 0% | 0.8906 | 0.9478 |
| `v2`, under 0.95 to Small | 20.4% | 0.9545 | 0.9557 |
| `v2`, under 0.90 **or any digit** to Small | 43.0% | 0.9596 | 0.9602 |

- Confidence alone does not hold. Among lines Tiny kept, it lost 28 numbers
  that Small read correctly and gained 12 that Small misread (sign test
  p ≈ 0.02). The losses include dropped digits at confidence 0.998–1.0:
  `922,446` → `922,46`, `19%` → `1%`, on the ceremony pages `1,324,332` →
  `1,324,32`. The pattern is one of two adjacent equal or similar digits
  disappearing. 17 of the net loss is on Blackstone's small-print tables.
- Sending every line in which Tiny reads a digit to Small removes that: the
  numbers are then Small's. On the ceremony sample this rule gives gold 978
  (Small 980, p = 0.53), precision 0.8574 and recall 0.8787 (Small 0.8567 and
  0.8789) at 41.0% of line width.
- Estimated cost at 42% of width re-read: recognizer stage about 0.6 of
  today's, page about 1.85 s against 2.75 s in this run, **1.5x, not
  measured**. Confidence-only routing would be about 2x but breaks the
  precision promise on values.

## Limits

- Rules were chosen on the ceremony sample (about twenty rule and model
  combinations tried); the digit rule was added after seeing the fresh-page
  errors and is scored on the same two samples, so it too is unverified on
  untouched pages. Its number accuracy follows from construction (numbers
  come from Small) more than from tuning.
- Routing is simulated from two full runs. The two-pass sidecar is not built,
  and its speed is not measured.
- On scans there is no text layer to catch a confident misread. The scan
  pages in the sample were not inspected line by line.
- No Chinese document is in the sample, so forgetting of Chinese was not
  tested. DocLayNet is mostly English.
- Labels follow the text layer's typography (curly quotes, en-dashes), which
  PP-OCR's stock models flatten to ASCII.

## Next

1. Decide whether an estimated 1.5x on the OCR stage justifies a second
   recognizer and a fine-tuned model to maintain. Selective OCR
   ([design](../design/2026-11-07-selective-ocr.md), ~1.3x) is independent of
   it and multiplies with it.
2. If yes: build the two-pass recognizer in the sidecar, measure it with the
   arms harness, then run the adoption ceremony. A new witness starts a new
   baseline era.
3. Untested idea for the dropped-digit errors: give Tiny more horizontal
   resolution per character (stretch its crops). If that removed them, digit
   lines could stay on Tiny.

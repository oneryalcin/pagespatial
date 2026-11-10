# Pre-study: training or fine-tuning a fast OCR witness

**Date:** 2026-11-10

**Status:** open. Nothing trained yet; this records what was checked before
choosing a route.

**Current decision:** try **fine-tuning the PP-OCRv6 Tiny recognizer** first.
Indra stays blocked on its licence, not on its accuracy.

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

## Plan for the fine-tune spike

1. Export line crops from DocLayNet PDFs (and FinTabNet if the licence
   allows), labelled by the text layer. Drop lines where the Small recognizer
   and the text layer disagree on letters (broken text layers); keep those
   disagreeing only on `$`/digits for inspection rather than training on them
   blind.
2. Add scan-like augmentation, and Small-labelled crops from real scans
   outside the evaluation corpus.
3. Fine-tune Tiny from the published weights.
4. Gate: [`score-candidate-witness.mjs`](../../scripts/evaluation/score-candidate-witness.mjs)
   on the 90-page ceremony sample. Pass means gold within the control's
   interval (980) and no value-changing currency or digit errors. Nothing
   from `.evaluation` may be in the training set.

## Not known yet

- Whether 1.1M parameters can hold the accuracy at all.
- How much of Tiny's 47 lost gold tokens came from scans, where text-layer
  labels do not exist.
- Indra's speed on Linux (the 8–10x is from its README, not measured here).

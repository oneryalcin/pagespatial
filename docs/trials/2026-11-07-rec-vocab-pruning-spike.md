# Trial: PP-OCRv6 small recognizer vocabulary pruning

**Date opened:** 2026-11-07

**Status:** closed

**Decision:** **REJECT: below the pre-registered gate.** Pruning the CTC
head from 18,710 to 1,750 classes makes the recognizer 1.04–1.15x faster,
consistently across ONNX Runtime and OpenVINO, 1 and 4 threads, and crop
widths 320–1280. The gate, set before measuring, was ≥1.2x for the recognizer
alone at 1 thread; the page-level gain would be smaller still because the
detector is untouched. Not worth a witness change and a baseline-era break.

## Hypothesis

The 2026-09-01 inference-speed review found the head (`linear 120 → 18710`)
is 43% of the recognizer's parameters and estimated it at 18–30% of
single-thread CPU recognition time. The Indra evaluation
([2026-11-07-indra-ocr-evaluation.md](2026-11-07-indra-ocr-evaluation.md))
suggested a small Latin vocabulary might explain much of Indra's speed. 85% of
PP's classes are CJK ideographs (15,908); the English-dominant demand
profile does not need them.

## Method

- Model: `PP-OCRv6_small_rec_onnx_infer.tar` (the Node/browser ONNX asset).
- Kept classes: blank, space, and every dictionary character below U+0530
  (ASCII, Latin, IPA, Greek, Cyrillic) or in U+1E00–U+2BFF (Latin Extended
  Additional, punctuation, currency, symbols): 1,750 of 18,710.
- Pruning slices the columns of `linear_8.w_0` and `linear_8.b_0`. Kept-class
  logits are unchanged, so decoded text is identical wherever the full
  model's argmax is a kept class. Softmax confidences would rise for every
  line; not measured, because speed failed first.
- Synthetic `[1, 3, 48, W]` inputs (cost depends on shape, not content),
  batch 1, 5 warm-up runs and the median of 40 runs, Apple M1 Pro,
  onnxruntime 1.31.1, OpenVINO 2026.4.1.
- Harness: [`scripts/evaluation/rec_vocab_prune_speed.py`](../../scripts/evaluation/rec_vocab_prune_speed.py).
  The pruned model's output shape `(1, T, 1750)` was checked, so the result is
  not a no-op.

## Results (recognizer only, median ms per crop)

| Backend | Threads | W=320 | W=640 | W=1280 |
|---|---:|---|---|---|
| onnxruntime | 1 | 28.5 → 26.3 (1.08x) | 56.6 → 52.1 (1.08x) | 118.6 → 111.2 (1.07x) |
| openvino | 1 | 18.5 → 16.3 (1.14x) | 35.0 → 32.0 (1.09x) | 70.9 → 63.0 (1.12x) |
| onnxruntime | 4 | 10.4 → 9.5 (1.10x) | 20.1 → 19.2 (1.04x) | 42.2 → 38.5 (1.10x) |
| openvino | 4 | 5.9 → 5.3 (1.11x) | 10.6 → 9.6 (1.10x) | 20.9 → 18.2 (1.15x) |

An earlier run with a 1,750-class set that differed only in the currency
block gave the same 1.00–1.12x range.

## What this changes

- The head is roughly 7–13% of recognizer time on these CPU backends, not
  18–30%. Its parameter share does not translate into compute share: the
  convolutional/SVTR backbone runs over every timestep and dominates.
- Indra's speed does not come mainly from its vocabulary. It comes from a
  much smaller network overall (~1.25M-parameter recognizer vs PP's 5.27M)
  and its own detector.
- Open question, not measured here: OpenVINO at 4 threads spends
  ~10–20 ms per crop in the recognizer, and pages have roughly 50–400 crops.
  That is well under the ~5.7 s per page of production OCR work implied by
  0.7 pages/s on 4 cores. If the gap holds up under profiling, the remaining
  time is outside the recognizer: the detector, PaddleX pre/post-processing,
  and the PNG write/decode round trip. Profile one production page by stage
  before choosing the next speed lever.

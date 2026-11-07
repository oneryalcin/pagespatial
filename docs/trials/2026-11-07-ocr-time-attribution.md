# Trial: where server OCR time goes, and the remaining levers

**Date opened:** 2026-11-07

**Status:** attribution closed; Tiny-recognizer candidate open

**Decision:** The OCR stage is almost all recognizer model execution, one call
per text line. The only large untested lever is swapping the Small recognizer
for **Tiny while keeping the Small detector**. In a local first look it made
pages 2.5x faster and recovered the same gold tokens except for currency and
apostrophe glyphs. It needs the existing merged-output safety gate on Linux
before it can be adopted.

## Where the time goes

Per-page stage medians from the Linux service run
(`.evaluation/m1-linux/throughput-1x4.json`, 162 pages):

| Stage | p50 ms | p95 ms |
|---|---:|---:|
| ocr | 1,980 | 4,956 |
| render | 355 | 659 |
| assembly | 35 | 4,691 |
| native | 29 | 605 |
| second opinion (27 pages) | 3,949 | 14,328 |

Inside OCR, the 2026-08-25 CPU hotspot follow-up
([gpu-bottleneck-instrumentation](2026-08-25-gpu-bottleneck-instrumentation.md#independent-cpu-hotspot-follow-up),
Tiny, ONNX Runtime, 4 threads, x86) attributes 99.7% of `predict()`:
recognizer model execution 67% (~99 calls per page), detector 17%, decode,
resize, batching, crop generation and PNG decode ~14% together. ONNX Runtime
holds 88.6% of CPU samples and Python 1.8%. Production uses Small, whose
recognizer costs more per call (below), so its recognizer share is at least
as large.

An earlier same-day note guessed that time sat outside the models. That was
wrong: 50–400 lines per page at 10–20 ms per call accounts for the whole
stage.

## Levers

| Lever | Effect | Status |
|---|---|---|
| Recognizer vocabulary pruning | 1.04–1.15x recognizer | rejected ([spike](2026-11-07-rec-vocab-pruning-spike.md)) |
| Recognizer batching on CPU | slower than batch 1 | rejected (2026-08 GPU/CPU trials) |
| Thread count | inside host noise | settled at 4 ([sweep](2026-09-02-ocr-sidecar-thread-sweep.md)) |
| Indra OCR | 30–50x, misses chart text | not a drop-in ([trial](2026-11-07-indra-ocr-evaluation.md)) |
| **Tiny recognizer, Small detector** | 2.5x per page locally | **candidate, below** |
| Skip recognition on lines the native layer already covers | large on digital pages | design change: OCR no longer reads the whole page independently |
| int8 recognizer | unknown | untested; needs calibration crops and an x86 host |

## Tiny recognizer first look

Recognizer alone, OpenVINO 2026.4.1, 4 threads, Apple M1 Pro, synthetic
`[1, 3, 48, W]`: Small (5.27M parameters) 10.1 ms → Tiny (1.10M) 1.6 ms at
W=320 (6.2x); 10.7 → 2.8 ms at W=640 (3.8x).

Full pipeline: PaddleOCR 3.7.0, Small detector + Tiny recognizer vs
production Small/Small, built as in `service/sidecar/ppocr_sidecar.py`,
paddle-default on macOS, 4 threads. The same 60 gold review images and
scoring as the [Indra trial](2026-11-07-indra-ocr-evaluation.md). Gold
tokens are Small proposals, so Small's score is a ceiling. Harness:
`ENGINES=paddle-tinyrec,paddle` with
[`scripts/evaluation/indra_vs_ppocr.py`](../../scripts/evaluation/indra_vs_ppocr.py)
(`run paddle-tinyrec`).

| Pages | Engine | gold tokens found | mean ms/page |
|---|---|---:|---:|
| image-only (7) | Small det + Tiny rec | 131/137 = 0.956 | 3,119 |
| image-only (7) | Small/Small | 133/137 = 0.971 | 7,495 |
| other (53), strict | Small det + Tiny rec | 559/616 = 0.907 | 3,971 |
| other (53), strict | Small/Small | 576/616 = 0.935 | 10,033 |
| other (53), ignoring `$` `~` | Small det + Tiny rec | 560/571 = 0.981 | 3,971 |
| other (53), ignoring `$` `~` | Small/Small | 560/571 = 0.981 | 10,033 |

Of the tokens Small found and Tiny did not, 19 of 22 are currency values whose
digits Tiny read correctly but whose `$` it dropped or misread. Across the 60
pages Tiny emits 403 `$` characters vs Small's 446. It also drops apostrophes
(`1Q'25` → `1Q25`). The other three tokens are non-currency misses:
`50 years` and `500` (osf p10) and `$50M-$150M` (a range).

The Linux speed gain will be smaller than 2.5x because OpenVINO already makes
Small's recognizer cheaper there. Tiny has no Japanese.

## What Indra's architecture says about PP

ONNX graphs inspected directly. Timings: OpenVINO 2026.4.1, 4 threads,
Apple M1 Pro. Detector on one Letter page at production render size
(scale 1.6). Recognizer on one ~600 px line at PP's 48 px height, which is
400 px at Indra's 32 px row.

| | Indra | PP-OCRv6 Small | PP-OCRv6 Tiny |
|---|---|---|---|
| Detector params | 0.09M | 2.45M | 0.43M |
| Detector input | gray, 1024 long side | RGB, full render (PaddleX `limit_type: min`, never downscales) | same as Small |
| Detector output | 3 maps (text, picture, …) at 1/2 res | 1 map at full res | same as Small |
| Detector ms/page | **15** | 157 | 73 |
| Recognizer params | 1.25M, pure CNN | 5.27M, conv + attention (13 MatMul) | 1.10M |
| Recognizer input | gray, 32 px row in a 96 px window (line plus context) | RGB, 48 px | RGB, 48 px |
| Recognizer output | ids, conf, lengths, top-8 (decoded in graph) | full softmax `[B, T, 18710]` | full softmax `[B, T, 6906]` |
| Recognizer ms/line | **2.8** | 9.9 | **2.5** |
| Batching | width-bucketed, padded, `widths` input masks padding | B1 in production | B1 |

Readings:

1. **Per line, Tiny is as cheap as Indra.** Indra has no special recognizer
   trick for speed: its Latin recognizer is in the same size class as Tiny.
   The recognizer lever is Tiny (above).
2. **The detector is the next bottleneck after Tiny.** With Small det + Tiny
   rec, a 100-line page costs about 157 ms of detector against about 250 ms
   of recognizer, so the detector becomes about 40% of model time. Indra
   shows a much cheaper detector is possible: about 10x less, from fewer
   parameters, grayscale, lower input resolution and half-resolution
   output. The available PP knobs need no training: the Tiny detector
   (2.2x), and a capped detector input size (`limit_type: max`). Indra's own
   failure modes (missed chart labels, lost lines on dense scans) show the
   accuracy cost of going too small, so any detector change must pass the
   gold chart and scan pages.
3. **Decoding in the graph is what makes batching viable.** PP returns a
   full softmax per timestep; Indra returns argmax ids and confidences and
   masks padding with a `widths` input. Our CPU batching trials were run with
   the full-softmax output. Appending ArgMax/ReduceMax to the PP graph is a
   small graph edit, but CPU decode was only about 6% of `predict()`, so
   this matters mainly for the GPU path.
4. **Not transferable without retraining:** 32 px grayscale rows, the context
   window, and the n-gram LMs for unsure lines.
5. **Indra's `auto` mode is the skip-native-lines lever.** It OCRs only what
   the text layer lacks. That is speed bought by dropping independent
   corroboration, which is a product decision, not an engineering one.

## Next step to adopt

Run the merged-output safety gate from the GPU spike on Linux/OpenVINO with
Small det + Tiny rec: zero newly incorrect, missing, or unresolved critical
values in trusted, non-escalated output, plus end-to-end pages/s against the
current sidecar. Swapping the recognizer changes the witness, so a new
baseline era starts if it is adopted.

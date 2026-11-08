# Trial: PP-OCRv6 model arms on Linux/OpenVINO (Tiny recognizer, Tiny detector, detector cap)

**Date opened:** 2026-11-07

**Status:** closed

**Decision:** **REJECT every Tiny and capped-detector arm, and int8** (below). Small/Small stays the
server witness.** Small det + Tiny rec is 2.6–2.9x faster per page, but on
the adoption-ceremony scorer it loses critical tokens significantly
(gold 939 vs 980; McNemar p = 0.001 against the browser reference), and some
losses are **wrong values**, not omissions: `$ 1,455,057` read as
`51,455,057`. That violates the precision promise. The local
gold-token proxy in [ocr-time-attribution](2026-11-07-ocr-time-attribution.md),
which found "equal recovery", was too coarse: it checked for token presence
anywhere on the page.

## Setup

- [`scripts/evaluation/ocr_arms_modal.py`](../../scripts/evaluation/ocr_arms_modal.py):
  paddleocr 3.7.0, paddlepaddle 3.2.1, `enable_hpi=True` (OpenVINO
  backend confirmed in logs), Modal `cpu=4`,
  `PADDLE_PDX_CPU_NUM_THREADS=4` (logged `cpu_num_threads=4`), 8 GiB.
- All arms run in **one container, interleaved page by page** with rotating
  order, so host variance cannot fake a speed difference. A second container
  ran the arms in reverse order.
- Pages: the 90-page adoption-ceremony sample (`.evaluation/hpi-ceremony`,
  production render scale 1.6).
- Scoring (text-free aggregates committed in
  [`evidence/2026-11-07-ocr-arms-scores/`](evidence/2026-11-07-ocr-arms-scores/)):
  [`score-candidate-witness.mjs`](../../scripts/evaluation/score-candidate-witness.mjs)
  against the dev-v12 browser reference and gold, as in the
  [adoption ceremony](2026-08-22-sidecar-adoption-ceremony.md). The control
  arm reproduces the ceremony's committed numbers exactly (gold 980,
  4,274/4,662 browser tokens matched), so the harness and models are
  unchanged.

## Results

| Arm | mean ms/page (r0 / r1) | lines | gold (of 1,223) | vs browser: cand-only / browser-only | McNemar p | true diff CI95 | browser critical tokens matched |
|---|---|---:|---:|---|---:|---|---:|
| Small det + Small rec (production) | 2,067 / 2,069 | 7,940 | **980** | 36 / 28 | 0.38 | [−9, +24] | 4,274 |
| Small det + **Tiny rec** | 797 / 712 | 7,940 | 939 | 33 / 66 | 0.001 | [−51, −13] | 4,124 |
| **Tiny det + Tiny rec** | 730 / 622 | 8,067 | 906 | 48 / 114 | <0.001 | [−88, −41] | 4,025 |
| Small det **capped 960** + Tiny rec | 631 / 574 | 6,982 | 886 | 45 / 131 | <0.001 | [−108, −61] | 3,724 |
| Small det **capped 960** + Small rec | 1,769 / 1,820 | 6,982 | 922 | 44 / 94 | <0.001 | [−71, −27] | 3,944 |

The control's 2.07 s/page matches production's ~1.98 s OCR-stage median
(`.evaluation/m1-linux/throughput-1x4.json`).

### What Tiny's recognizer gets wrong

47 gold tokens that Small/Small corroborates and Small det + Tiny rec does
not:

- **Currency glyph to digit, which changes values:** `$ 1,455,057` → `51,455,057`;
  `$ 1,236,925` → `5 1,236,925`; `$180.2` → `3180.2`. Elsewhere `$` → `S`/`§`.
- **Digit errors on scans:** `124726` → `124725`, `118333` → `118338`,
  `2023-11-23` → `2023-11-20`, `620,000` → `620,0O0`.
- **Spacing and dropped lines:** `48th and` → `48thand`, `May 21, 2015` →
  `May 21,2015`; several scan lines missing entirely.

### Capping the detector input

`text_det_limit_type: max, limit_side_len: 960` drops 12% of lines (6,982 vs
7,940) and loses 58 gold tokens even with Small rec. The full-resolution
detector stays. This matches Indra's failure mode: a smaller detector input
loses small text.

## int8 recognizer: rejected at the pre-set gate

[`scripts/evaluation/rec_int8_modal.py`](../../scripts/evaluation/rec_int8_modal.py)
v2: NNCF post-training quantization of the Small recognizer (`MIXED`
preset), calibrated on 300 real line crops and evaluated on 2,000 disjoint
ones. Modal `cpu=4` x86, OpenVINO 2026.4.1, 4 threads.

The preprocessing is PaddleX-exact (`OCRReisizeNormImg`: height 48, aspect
kept, right zero-pad to max(320, 48·w/h)), with padded widths rounded up to
fixed buckets so fp32 and int8 are both compiled with static shapes. The
harness is **validated**: fp32 decoding equals PaddleX's own ceremony text on
96% of lines. The rest differ only because crops are axis-aligned rather than
minimum-area rectangles.

Gate, set before the second run: ≥1.2x faster, and ≤1% of digit lines
changed from fp32.

| Quantization | fp32 ms | int8 ms | speed-up | int8 = fp32 | digit lines changed | digit lines = PaddleX (fp32 → int8) |
|---|---:|---:|---:|---:|---:|---|
| default | 21.0 | 16.5 | 1.27x | 19% | 811 / 1,079 | 1,053 → 267 |
| `model_type=TRANSFORMER` | 18.8 | 14.2 | **1.32x** | 90% | **66 / 1,079 (6.1%)** | 1,053 → 1,004 |

Default int8 destroys the SVTR attention blocks. Transformer-aware
quantization repairs most of that but still changes 6% of digit lines, which
fails the precision gate. The ceiling is also modest: about 1.3x on the
recognizer, so roughly 1.2x on OCR. Neither host reported AVX-512 VNNI or AMX
for this run (a v1 host did), so Modal CPU generations vary.

Untested: NNCF accuracy-controlled quantization, which keeps the most
sensitive layers in fp32. It would trade some of the 1.3x for accuracy and
still faces the ≤1% digit gate.

v1 of this harness (earlier the same day) resized crops without padding. Its
fp32 baseline decoded garbage, so its "2x slower" number is void.

## Remaining levers

- **Selective OCR** with the glyph-level font audit: about 1.3x on this
  corpus, no real native error lost in replay
  ([design](../design/2026-11-07-selective-ocr.md)).

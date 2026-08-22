# HPI benchmark: the gate on the Python-sidecar speed arm

**Date:** 2026-08-23 · **Branch:** `hpi-benchmark` · **Issue:** #2 (speed-arm 2)

## Question

The service's OCR witness costs 6.5 s/page (WASM EP, 4-worker load; 3.7 s
single) — 88% of page wall time. Does the official PaddleOCR
high-performance-inference (HPI) pipeline earn the Python-sidecar path,
and does a GPU earn anything beyond it? Half-day throwaway benchmark,
owner-authorized on modal.com (Linux x86), decided before any commitment.

## Method

- **Sample:** 32 pages, stratified from the witness-equivalence gold∩record
  set (`hpi-bench-render.mjs`): all 5 rotated Blackstone pages, 5 Japanese
  monotaro pages (p61 pinned), 6 dense World-Bank pages, plus osf /
  legistar / pa-sers / ares / asseco pages. Rendered locally with the exact
  server-witness render path (rotation-aware dpi; dims must match record
  geometry within 5% or fail closed) — **reader-swap-camera-fixed by
  construction**.
- **Remote:** `hpi_bench_modal.py`, ephemeral Modal app, pages passed as
  function arguments (nothing persisted remotely). Container: **4 vCPU /
  8 GB** (GPU arm adds a **Tesla T4**, identity proven in-band on the GPU
  re-run: `nvidia-smi -L` + `paddle.device.get_device()` in the result —
  a silent CPU fallback cannot forge the GPU rows. The four CPU results
  predate the deviceTruth payload and carry none; mitigated by physics —
  Modal CPU functions have no GPU to fall back onto). Pins:
  **paddleocr 3.7.0, paddlepaddle 3.2.1** (3.4.0 predates the v6 model
  registry), Python 3.11, `paddleocr install_hpi_deps cpu`.
  Orientation/unwarping/textline stages disabled (clean rasters, as the
  service feeds). Polygon output mapped to axis-aligned boxes
  (min/max over vertices) in rendered-pixel space.
- **Timing discipline:** cold costs (constructor incl. model download;
  first page incl. HPI engine build) recorded separately; **every quoted
  ms/page is warm** — page 0 is re-run at the end so all 32 samples are
  warm. Warm is what a long-lived service worker experiences.
- **Scoring:** `score-candidate-witness.mjs` — the library's own
  consume-once token mechanics (dist/text.js + dist/corroborate.js),
  first-pass vs first-pass against the dev-v12 browser reference, plus
  paired gold recall on the 23 gold pages (560 human-verified tokens).
  Same mechanics as the committed equivalence run, so rows are comparable.
- HPI backend actually selected: **OpenVINO**, with `cpu_num_threads=10`
  self-configured inside the 4-vCPU cgroup (oversubscribed but enforced —
  the number is honest per-4-vCPU and might improve slightly with a
  matched thread setting). Evidence: streamed container LOGS, not an
  in-band result field — in-band backend capture is a named item for the
  ceremony run.

## Speed (warm ms/page, 32 pages, 4 vCPU / T4)

| config | warm p50 | warm p95 | cold: init + first page |
|---|---|---|---|
| service witness, WASM EP (reference: M-series laptop, 176 pages, 4-worker contention) | 6,504 | 10,869 | 0.6 s |
| service witness, WASM EP (reference: M-series laptop, single adapter, 90 pages) | 3,700 | 13,300 | 0.6 s |
| paddle default CPU, v6-small | 3,884 | 8,796 | 11 s + 4.0 s |
| paddle default CPU, v6-medium | 4,110 | — | 9 s + 3.3 s |
| **paddle HPI CPU (OpenVINO), v6-small** | **989** | — | **54 s** + 0.8 s |
| paddle HPI CPU (OpenVINO), v6-medium | 1,933 | — | 28 s + 1.9 s |
| paddle GPU T4, v6-small | 952 | — | 12 s + 2.0 s |
| paddle GPU T4, v6-medium | 1,378 | — | 4 s + 1.0 s |

(Per-config p95 and per-page detail in `.evaluation/hpi-bench/score-*.json`;
GPU rows are from the device-verified re-run — the first GPU run measured
783/1,237 ms, same order, run-to-run variance noted.)

**Reference-row provenance and the honest multipliers.** The two reference
rows are cross-machine AND cross-sample (laptop, different page sets,
contended vs single) — so the headline multipliers are approximate by
construction: **~6.6× vs the loaded-laptop service figure, ~3.7× vs the
single-adapter laptop figure**, both cross-machine. One order-of-magnitude
sanity note (not a control): paddle-default-CPU on Modal (3,884 ms) lands
where single-adapter WASM on the laptop does (3,700 ms). The GPU-vs-HPI
comparison, by contrast, is same-container and clean — the GPU-dead
conclusion does not depend on any cross-machine inference.

## Accuracy (vs dev-v12 browser witness; gold = 560 tokens on 23 pages)

| config | token agreement b→cand / cand→b | gold recall | discordants (+cand/−browser) |
|---|---|---|---|
| browser witness (reference) | — | 399 | — |
| **server witness WASM, SAME 32 pages** (recomputed from the committed equivalence perPage) | **85.3% / 84.8%** | **414** | — |
| server witness WASM (all 90 pages, for context) | 91.7% / 91.4% | tie ±0.5% | +36/−26 of 1,223 |
| paddle default CPU small | 85.2% / 84.8% | 413 | +26/−12 |
| **paddle HPI CPU small** | **85.5% / 85.0%** | **409** | **+22/−12** |
| paddle default/GPU medium | 83.6% / 82.0% | 405 | +42/−36 |
| paddle HPI medium | 83.7% / 82.0% | 407 | +42/−34 |
| paddle GPU small | 85.2% / 84.8% | 413 | +26/−12 |

Readings, stated conservatively (case series over 32 system-conditioned
pages — no equivalence claim is being made here):

- **HPI changes speed, not output**: HPI rows match their default-CPU
  siblings' accuracy within noise — same models, faster engine.
- **The official pipeline is not worse than our witnesses on gold**: every
  config lands at or above the browser's 399/560, with modest discordants.
- **No cross-pipeline gap is demonstrated — a correction to this doc's
  first draft.** The draft compared the candidates' 85% agreement against
  the server witness's 90-page figure (91.7%) and called the difference
  "cross-pipeline daylight". Sample-matched, it vanishes: restricted to
  these same 32 pages (which deliberately overweight the hard families —
  rotated, CJK, dense tables), the same-pipeline server witness scores
  **85.3%/84.8%** and gold 414 — indistinguishable from the official
  pipeline's 85.5%/85.0% and 409–413. **This strengthens the adoption
  case**: the official pipeline agrees with the browser exactly as well
  as our own same-pipeline witness does on these pages. The ceremony's
  job becomes verifying parity on the full gold set, not characterizing
  a gap.
- **v6-medium buys nothing on this corpus**: gold 405–407 vs small's
  409–413, at ~2× the cost, with larger both-way discordants. The
  documented medium uplift does not show on financial-numeric gold.

## Gate verdict

**The HPI CPU sidecar (OpenVINO, v6-small) is the recommended speed arm:
~6.6× the loaded WASM cost (989 ms vs 6.5 s) and ~3.7× the single-worker
cost, at accuracy parity with the default pipeline and gold recall at
least matching our current witnesses — and the GPU arm is dead on this
workload: a Tesla T4 (952 ms) buys nothing over OpenVINO on 4 vCPUs.**
The native-ORT port (arm 1) remains the fallback if a Python sidecar is
operationally unwanted — it plausibly lands near the same ~1 s but
requires forking paddleocr-js and owning the fork.

These are recommendations, not decisions: adopting any official-pipeline
config as a witness is a NEW-witness adoption and takes the full ceremony
— witness-equivalence run over all gold pages, McNemar, confidence-
calibration diff, **geometry/box-IoU verification** (this benchmark scored
text only; candidate boxes are in the raw results but unverified),
in-band backend capture, and the era decision. Not started here.

Operational notes for whoever runs the ceremony: HPI worker boot pays a
~54 s engine build (amortizes in a long-lived worker; a restart storm
would feel it — OpenVINO/HPI engine caching is worth investigating);
thread setting should be matched to the vCPU pin; costs measured on
Modal's 4-vCPU containers — a production box's number scales with cores.

## Caveats

32 pages, one hardware sample per arm, warm-path only; per-page raw
outputs (corpus text) live in gitignored `.evaluation/hpi-bench/`; the
committed scripts (`hpi-bench-render.mjs`, `hpi_bench_modal.py`,
`score-candidate-witness.mjs`) reproduce the whole run end to end.

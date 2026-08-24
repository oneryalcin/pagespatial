# Trial: PP-OCRv6 GPU throughput spike

**Date opened:** 2026-08-24

**Design:** [`docs/design/2026-08-24-gpu-ocr-spike.md`](../design/2026-08-24-gpu-ocr-spike.md)

**Status:** merged-output safety complete; A2 B1 measured; effective B8 retry pending

**Current decision:** **A2 MISSES THE 2X GATE: B1 IS FASTEST; CPU REMAINS THE
PRODUCTION DEFAULT; CONCURRENT-OWNER ATTRIBUTION IS NEXT.**
The rejection below is the completed pre-A2 result. The owner later supplied a
50 terminal pages/s target and an initial USD 50 experiment ceiling, raised to
USD 75 after an infrastructure-only aborted startup. This authorizes
only the bounded E1 comparison described at the end of this trial.

**Pre-A2 decision:** **REJECT: CPU REMAINS THE SIMPLEST WINNER.**
The adopted CPU Modal deployment remains unchanged. A supported and attested
TensorRT lane is materially faster for prepared-image OCR, but no treatment
passes the original raw output-equivalence gate. The owner replaced that gate
with zero newly incorrect, missing, or unresolved critical values in trusted,
non-escalated output. Small FP32 passes the amended safety gate after a narrow
standalone-numeric conflict repair, but its diagnostic prepared-image cost is
about $221/M versus $114/M for CPU. Production end-to-end performance and
billed cost were not run because the preliminary cost screen already fails.
The separate Small FP16 window's
median was 4% above FP32, which is not a causal precision result; recognition
batching makes Small slower within each precision window. Tiny is faster but
remains an unqualified witness. The runtime-lifetime defect was repaired and
the discordant Small FP32 page was image-adjudicated. Merged-output safety
passes; engine equivalence does not. A2, sustained qualification, the locked
candidate holdout, A100, and production integration were therefore not
authorized.

## Scope

- demand profile: predominantly English, approximately 50-page documents;
- models: PP-OCRv6 Tiny and Small;
- primary accelerator: one NVIDIA L4;
- deployment profile under test: `en-gpu`;
- holdout: locked; not accessed;
- enrichment: off.

## Run ledger

| UTC window | milestone | arm(s) | attempted / terminal | spend | result |
|---|---|---|---:|---:|---|
| 2026-08-24, app `ap-xmBTnDt09g4MevkatHNV6F` | M1 shakedown | C-HPI Small, G-PD Small requested | 1 build / 0 calls | not isolated; no compute call started | operator-stopped during image creation; no performance evidence |
| 2026-08-24, app `ap-6CQdHQoeUBsueRg36H5S3C` | M1 shakedown | C-HPI Small, G-PD Small requested | 1 failed build / 0 calls | not isolated; no compute call started | uv resolver could not find PyPI-only `paddleocr` when mixed with Paddle's CUDA extra index; split into two install layers |
| 2026-08-24 01:27-01:30 UTC, app `ap-s0PamYPqmdTKvFmWfcQMEB` | M1 shakedown | C-HPI Small, G-PD Small | 4 warm-up/measurement page passes per arm / 2 terminal arms | about $0.024 resource-time estimate; not a billed-cost observation | PASS: pinned models, OpenVINO CPU and L4/CUDA backends attested; two measured pages completed; no performance decision from this sample |
| 2026-08-24 01:32-01:46 UTC, app `ap-0aii4tHcqGCAb0eDoCYRZj` | M1 controls | C-HPI and G-PD, Tiny and Small | 384 measured page passes / 4 terminal arms | about $0.123 resource-time estimate | backend/model/mutation checks pass; all arms internally text-stable; Tiny 1.71x and Small 1.13x serial median speedup; CPU/GPU engine-equivalence screen fails |
| 2026-08-24 01:47-01:52 UTC, app `ap-i3ys9ooIIqjelEmM93YO5u` | M1.5 first attempt | G-PD B1/C1 and B8/C8, Tiny and Small | 192 measured page passes / 2 success, 2 failed | about $0.083 resource-time estimate including failed calls | B1/C1 succeeds; both B8/C8 calls visibly fail because heterogeneous page arrays cannot be stacked |
| 2026-08-24 01:53-02:00 UTC, app `ap-snT3FCMjjaRG3rbO7QvVkB` | M1.5 shape-aware retry | G-PD B1/C1 and B8/C8, Tiny and Small | 384 measured page passes / 4 terminal arms | about $0.121 resource-time estimate | effective batch 8 reached without padding; Tiny batch gain 2.23x, Small 1.67x; both fail batch-companion equivalence |
| 2026-08-24 02:03-02:10 UTC, app `ap-fkcdsf0bIXbOt230jrwqsi` | M1.5 decomposition | G-PD B1/C1, B8/C1, B1/C8; Tiny and Small | 576 measured page passes / 6 terminal arms | about $0.126 resource-time estimate | Tiny recognition batching gives 1.72x within-window gain but fails equivalence; list-input page grouping gives no gain. Neither axis improves Small. Absolute throughput shifted between app windows, so only same-window ratios are interpreted. |
| 2026-08-24 02:12 UTC, apps `ap-ces1iyZFahDvoVNGFQijVs`, `ap-VKGG1MdMKXim5U790McdPJ` | M1 provider setup | G-HPI requested | 2 failed image builds / 0 calls | build cost not isolated | provider dependency installation exposed incompatible/missing GPU runtime libraries; no OCR evidence |
| 2026-08-24 02:13-02:17 UTC, apps `ap-nNcHh36d6UejV3pzNSxrh9`, `ap-6RusHZZHlypXyKbd9ytkw3` | M1 provider setup | G-HPI Small | 2 failed calls / 0 terminal arms | about $0.010 resource-time estimate | visible failures: missing `libcudart.so.12`, then missing `libnvjpeg.so.12`; no fallback accepted |
| 2026-08-24 02:18-02:27 UTC, app `ap-bXtdqfZ3vNiUSnxPLHyPSe` | M1 G-HPI shakedown | G-HPI Small | 2 measured page passes / 1 terminal arm | about $0.014 resource-time estimate | CUDA 12.6 HPI path runs, but attestation proves Paddle Inference, not TensorRT |
| 2026-08-24 02:27-02:32 UTC, app `ap-ke44zgBxpot1fg1N5c4Z1B` | M1 G-HPI controls | G-HPI Tiny and Small | 192 measured page passes / 2 terminal arms | about $0.085 resource-time estimate | G-HPI is slower than G-PD and its projected outputs are exact-equal to G-PD; provider logs identify default Paddle Inference |
| 2026-08-24 02:39-02:46 UTC, app `ap-2QKutrHA4gYbUqwiR2rB1z` | conditional TensorRT setup | G-TRT Small requested | 1 image import / 0 calls | no compute call started; build cost not isolated | operator-stopped after 7m36s while Modal copied/unpacked the official PaddleX CUDA 11.8/TRT 8.6 image |
| 2026-08-24 02:47-02:50 UTC, app `ap-2e9NCJqpPPIyntmbpoca4d` | conditional TensorRT bounded retry | G-TRT Small requested | 1 image import / 0 calls | no compute call started; build cost not isolated | retry again remained in vendor-image import for 3m04s with zero tasks; stopped by the experiment limit |
| 2026-08-24 02:56-03:00 UTC, app `ap-Fpy4MQtJppcxQ0h5bf9PJ9` | conditional ONNX Runtime fallback shakedown | G-ORT Small | 2 measured page passes / 1 terminal arm | about $0.033 resource-time estimate | ONNX Runtime GPU backend attested; 0.590 pages/s and 74.3 s initialization, already slower than G-PD Small |
| 2026-08-24 03:00-03:09 UTC, app `ap-QxfKyRu5YhZZ7Rt4jdEytz` | M1 provider fallback control | G-ORT Tiny and Small | 192 measured page passes / 2 terminal arms | about $0.154 resource-time estimate | both tiers stable and correctly attested, but about 40% slower than G-PD and non-equivalent; dominated, no batching authorized |
| 2026-08-24 03:13-03:17 UTC, app `ap-8y3rKV9j1KwYp64R3D55d9` | triggered ONNX thread fairness check | G-ORT Small, `cpu_num_threads=4` | 2 measured page passes / 1 terminal arm | about $0.036 resource-time estimate | requested four threads attested; 0.541 pages/s versus the default's 0.590 and 86.1 s init versus 74.3 s; stop without a full run |
| 2026-08-24 08:16-08:24 UTC, app `ap-scGiogOpxkbnmwjn0dSFd8` | reopened TensorRT stack shakedown | Small FP32 B1, apparent FP16 B1 | 4 measured page passes / 2 terminal arms | about $0.136 resource-time estimate | CUDA 11.8/TRT 8.6.1 and ORT-detection/TRT-recognition attested; FP32 0.211 pages/s after a 365 s engine build; the apparent FP16 result is invalid because UltraInfer loaded the FP32 cache from the same path |
| 2026-08-24 08:25-08:32 UTC, apps `ap-zEK7tbhKkIInBYjqdOXsfF`, `ap-PbDdaNwvcYbuhHsZw6q0PH` | TensorRT batching smoke and cache repair | Small FP32 B4/B8; Tiny attempts | 8 measured Small page passes / 2 terminal Small arms; 3 visible Tiny harness failures | about $0.222 resource-time estimate for terminal calls | two-page steady repeats made B4 look fastest, but both batches changed output; failed Tiny calls exposed mutable model-root state; caches were then isolated by tier and precision |
| 2026-08-24 08:40-08:46 UTC, app `ap-rkDwEZwHwCcJIZIK6Pt3mz` | TensorRT Tiny smoke | Tiny FP32 B1/B4/B8 | 12 measured page passes / 3 terminal arms | about $0.104 resource-time estimate | batching improved the two-page steady repeat but failed batch-companion equivalence; B8 had fewer critical-token deltas than B4 |
| 2026-08-24 08:46-09:04 UTC, app `ap-StfTjk7YWFa3gAuqmMP0MD` | TensorRT FP32 diagnostic | Small B1/B4; Tiny B1/B8 | 384 measured page passes / 4 terminal arms | about $0.286 resource-time estimate | same L4 UUID; Small B4 was 12% slower than B1 on 32 pages, overturning the two-page result; Tiny B8 retained a 1.63x batching gain; every arm has zero repeat text/score delta, both batch comparisons fail equivalence |
| 2026-08-24 09:04-09:36 UTC, app `ap-LDObH88mZzZs6uHmZBmnT2` | TensorRT FP16 diagnostic | Small B1/B4; Tiny B1/B8 | 384 measured page passes / 4 terminal arms | about $0.582 resource-time estimate | precision-isolated engines; the Small FP16 window median was 4% above the separate FP32 window, not an isolated precision effect; batching remained slower; Tiny FP16 B1 nearly reached its B8 result within the FP16 window; every arm has zero repeat text/score delta, all precision/batch comparisons fail equivalence; engine builds took 931 s Small and 606 s Tiny |
| 2026-08-24 10:58-11:02 UTC, apps `ap-rRrVq4U16YMMPW3n85x7nU`, `ap-wIH2QAZNEGGxSxGu6vlmZA`, `ap-lscXGyCZp0erMR8YYDJsSl` | UltraInfer lifetime-fix build shakedowns | patched UltraInfer only | 3 failed image builds / 0 GPU calls | build cost not isolated | stopped at three concrete build-contract errors: the upstream wheel requires an explicit build before `bdist_wheel`, Python development headers, and modern-case CMake Python variables; each was corrected without changing inference providers |
| 2026-08-24 11:03-11:15 UTC, app `ap-aLOVLkjXe06gsroDrR7Viz` | patched TensorRT build-path probe | Small FP32 B1, first 2 manifest pages | 4 measured page passes / 1 terminal arm | about $0.100 GPU-call resource-time estimate; image build excluded | exact PaddleX source and local patch attested; engine build completed without the TensorRT runtime-lifetime error |
| 2026-08-24 11:17-11:24 UTC, app `ap-pXca4rS3aI7Cqu8nlH4K2Y` | patched TensorRT cache-load and correctness probe | Small FP32 B1, first 29 current-manifest pages | 58 measured page passes plus 1 cached-load page / 1 terminal arm | about $0.108 resource-time estimate | cached engine loaded in 6.67 s without rebuild or lifetime error; the known discordant page remained outside the zero-noise correctness tolerance, so all later work stopped |
| 2026-08-24, offline retained-evidence replay | amended merged-output safety gate | Small FP32 TensorRT versus default Paddle GPU, three repeats, real PageSpatial native/OCR merge | 96 control + 96 candidate merged pages; complete 162-page baseline merge-impact replay | $0 new GPU spend | PASS: both adjudicated wrong candidate dates create exact native-backed blocking conflicts; zero incorrect values on non-escalated pages; zero control/candidate route changes; cost screen still stops paid A2/E2E work |
| 2026-08-24, offline retained-evidence replay | production-control merged-output gate | Small FP32 TensorRT versus CPU OpenVINO, three repeats, real PageSpatial native/OCR merge | 96 control + 96 candidate merged pages | $0 new GPU spend | PASS: 42 candidate-only and 40 control-only occurrences across 12 pages; 81 occur only on pages escalated in both arms; the sole trusted-output difference, `1|mayor`, is source-correct; zero route changes |

## M0 record

The earlier T4 result is now scoped correctly in the HPI trial and living
workstream. Its raw values remain unchanged. It measured sequential default
Paddle GPU on a T4, not GPU HPI, FP16, batching, overlap, or an L4.

The fixed diagnostic input is
[`evaluation/gpu-spike/english-diagnostic-v1.json`](../../evaluation/gpu-spike/english-diagnostic-v1.json):
32 English development pages with exact rendered-PNG SHA-256 values —
per the manifest's own note, 26 pages are the much-observed historical
HPI diagnostic with its six non-English pages replaced by five
page-matched MonotaRO English siblings and one English image-only page.
It uses no candidate-holdout document. Page language is an explicit
selection decision; the corpus's `multilingual` label is not used as
language truth.

Design M0 item 5's *complete* English-only development correctness
manifest (with document/page/labelled-page counts) was **never frozen or
committed** — only this 32-page diagnostic exists. That gap is moot for
these measurements because the spike stopped before M4, where that
manifest would first have been consumed; a resumed spike must freeze it
before M4.

Model revisions and file hashes are frozen in
[`evaluation/gpu-spike/model-pins-v1.json`](../../evaluation/gpu-spike/model-pins-v1.json).
The runtime manifest also pins the observed PaddleX 3.7.2 directly; the paid
runs recorded that exact version. It is not left as a transitive PaddleOCR
resolution for future rebuilds.

## Measurements

The first successful shakedown is stored under the ignored evidence directory
`.evaluation/gpu-spike/2026-08-24/20260824T012729Z-f25fae84/`. It is a harness
check, not an M1 performance result:

- C-HPI Small: OpenVINO attested, 66.25 s initialization, 0.631 pages/s for one
  randomized two-page repeat, effective batch maximum 1;
- G-PD Small: NVIDIA L4, CUDA 12.6, and Paddle GPU attested, 18.24 s
  initialization, 0.864 pages/s for one randomized two-page repeat, effective
  batch maximum 1;
- all 103 recognized text lines were positionally and textually identical
  between the two arms on these pages;
- the sequential GPU arm showed 7% median and 10% peak device utilization,
  with 660 MiB peak device memory. This diagnoses an unsaturated arm; it does
  not predict the batched result.

M1 then ran all 32 frozen pages three times per arm. Same-arm text and scores
were exact across all three repeats. Median throughput was:

| tier | C-HPI B1/C1 | G-PD B1/C1 | serial speedup | L4 median / peak utilization |
|---|---:|---:|---:|---:|
| Tiny | 0.677 pages/s | 1.160 pages/s | 1.71x | 8% / 20% |
| Small | 0.614 pages/s | 0.697 pages/s | 1.13x | 12% / 26% |

CPU and GPU are separate Modal functions and containers. These are
same-app-window median ratios, not same-host ratios, and shared-tenancy
variance applies. The later decomposition is the stronger evidence for
within-one-L4 treatment ratios: all six arm records attest the same GPU UUID.

The derived same-configuration null was zero critical-token and zero raw-line
differences for every arm. Against that null, CPU versus GPU failed the engine
screen: Tiny had 16 critical-token multiset differences and 53 unmatched
exact-text lines; Small had 92 and 273. Direction is not inferred from this
comparison. It proves only that the engines are not interchangeable under the
predeclared zero-null rule.

**Protocol deviations:** section M1 said only the fastest correct GPU engine
could advance. G-PD failed that strict equivalence rule, so it was already
ineligible for production qualification. M1.5 was nevertheless run as a
bounded diagnostic to answer the separate architecture question: can batching
fill the L4, and which batching axis creates the gain? Those runs are valid
performance and mechanism evidence, but they were never eligible to authorize
A2 or the holdout. This deviation spent about $0.33 across the initial failure,
shape-aware retry, and decomposition. It did not weaken the final rejection;
the batched treatments also failed their own companion-equivalence gates.

The arm IDs also overstate `C`. The harness implemented `pageBatchSize=8` by
passing a same-shaped list of up to eight decoded pages to one `predict()`
call. It did not create eight concurrent producers or a bounded owner queue.
Therefore B1/C8 and B8/C8 establish page-list batching behavior only. They do
not prove that true page concurrency or CPU/GPU overlap has no value. That
architecture remains unmeasured and unauthorized because no engine
advanced — Small mechanically, Tiny by the discretionary stop below.

**Discretionary Tiny stop (dated deviation, 2026-08-24, cold review
PR #95):** the frozen `acceptance-v1.json` tinyScreen would have allowed
serial Tiny to advance to development scoring — its G-PD B1/C1 arm was
stable, attested, and 1.71x (above the 1.3x serial bar), and recognition
batching gained 1.72x (above the 1.2x bar). The engine-equivalence screen
that the verdict table cites is, by its own name, a Small gate. Tiny was
stopped anyway, as a discretionary call, because: (a) Tiny adoption
requires the full §4.2 new-witness ceremony and English gold labeling
regardless of speed, none of which exists yet; and (b) Tiny's only
demonstrated gain axis — recognition batching — is companion-dependent
and failed same-treatment reproducibility, so the speed that would
motivate the ceremony does not survive its own stability gate.
Additionally, the §6-required M1.5 optimistic end-to-end bound was never
computed: the stage attribution it needs was not instrumented in these
arms. That bound is unmeasured, alongside TensorRT. A future engineer
who funds Tiny's ceremony may treat serial Tiny G-PD as a live M1.5
pass; this trial's stop is a judgment, not a mechanical gate outcome.

The first B8/C8 call exposed that Paddle's detection predictor stacks page
arrays and rejects heterogeneous shapes. The retry preserved exact decoded
pixels by batching only same-shaped pages; it did not pad or resize. Effective
batch maximum and median both reached eight. Results were:

| tier | G-PD B1/C1 | G-PD B8/C8 | batch gain | B8/C8 median / peak utilization |
|---|---:|---:|---:|---:|
| Tiny | 1.077 pages/s | 2.401 pages/s | 2.23x | 12% / 51% |
| Small | 0.680 pages/s | 1.134 pages/s | 1.67x | 17% / 100% |

Both faster B8/C8 treatments fail companion invariance. Small differs from its
B1/C1 control by 20 critical-token entries and 146 unmatched exact-text lines.
Tiny differs by 34-40 critical-token entries and also varies between B8/C8
repeats (same-treatment null 10 critical-token entries). Neither B8/C8 arm can
advance as a qualified execution engine.

Metric note (cold review PR #95): the tables report "unmatched exact-text
lines" — the geometry-matching metric — for readability, but the PASS/FAIL
gate compares **positional differing lines against the same-treatment
null** (e.g., Tiny B1/C8: 13 unmatched lines but 1,053–1,403 positional
differing lines versus a null of 351). Both metrics reproduce from the
archived score rows and both fail where FAIL is stated; the positional
comparison is the gating one. Per-group wall times for every arm live in
the archived run rows; p95/latency percentile tables are omitted here as
presentation, not lost data.

The bounded decomposition then separated recognition batching (`B8/C1`) from
same-shape page-list input batching (`B1/C8`) in one warm L4 container:

| tier | treatment | median pages/s | gain vs same-window B1/C1 | critical-token diff | unmatched exact-text lines | verdict |
|---|---|---:|---:|---:|---:|---|
| Tiny | B1/C1 | 2.001 | control | 0 null | 0 null | stable control |
| Tiny | B8/C1 | 3.432 | 1.72x | 37 | 218 | faster, not equivalent |
| Tiny | B1/C8 | 1.999 | 1.00x | 4-6 | 13 max | no gain, not equivalent |
| Small | B1/C1 | 1.175 | control | 0 null | 0 null | stable control |
| Small | B8/C1 | 1.110 | 0.94x | 19 | 136 | slower, not equivalent |
| Small | B1/C8 | 1.158 | 0.99x | 1 | 6 | no gain, not equivalent |

The same-window device sampler reported:

| tier | treatment | median / peak GPU utilization | peak device memory |
|---|---|---:|---:|
| Tiny | B1/C1 | 14% / 24% | 526 MiB |
| Tiny | B8/C1 | 18% / 29% | 1,132 MiB |
| Tiny | B1/C8 list input | 14% / 68% | 2,232 MiB |
| Small | B1/C1 | 19% / 37% | 802 MiB |
| Small | B8/C1 | 17% / 55% | 2,386 MiB |
| Small | B1/C8 list input | 19% / 93% | 3,224 MiB |

The sampler can miss short kernels, so these percentages are diagnostic rather
than a saturation proof. They do show that larger inputs consumed materially
more device memory. For Small that extra memory did not buy throughput; for
Tiny only recognition batching bought throughput, and that treatment changed
the output.

Absolute B1/C1 throughput in this window was 73-86% higher than in the prior
window on equivalent code and an L4. That is direct shared-tenancy/runtime
variance evidence. The table uses only randomized same-container ratios. It
does not join absolute rates across windows.

This decomposition locates the useful speedup and the defect. Tiny's
recognition batching can use the GPU, but recognition output changes with
batch companions. List-input page batching does not make either tier faster.
True producer concurrency was not tested. Small's
earlier B8/C8 gain requires combined scheduling behavior that neither isolated
axis reproduces, and the combined treatment is also non-equivalent. Building a
Node queue and overlap architecture around these engines would amplify an
unqualified engine, not solve the limiting problem.

## Provider findings

The CUDA 12.6 G-HPI lane eventually ran after its system libraries were made
explicit. It did not test TensorRT. Backend logs state `Using Paddle Inference
backend` for both detection and recognition and warn that the default
configuration may not be optimal. The device attestation records NVIDIA L4,
CUDA 12.6, cuDNN 9.5.1, and Paddle GPU. Its median throughput was:

| tier | G-PD B1/C1 | G-HPI B1/C1 | HPI / default | provider verdict |
|---|---:|---:|---:|---|
| Tiny | 1.160 pages/s | 1.115 pages/s | 0.96x | Paddle Inference; dominated |
| Small | 0.697 pages/s | 0.633 pages/s | 0.91x | Paddle Inference; dominated |

For all three repeats in both tiers, the stable projection of page identity,
detected-crop count, line text, confidence, and geometry has the same SHA-256
between G-HPI and G-PD. G-HPI therefore adds a much larger provider image and
dependency surface without changing the observed output or improving speed.
The pairwise projection-SHA comparison backing this claim is archived at
`.evaluation/gpu-spike/2026-08-24/provider-comparison-gpd-hpi-v1/score.json`
(added at cold review, PR #95 — the claim was previously re-derivable but
not archived; the reviewer independently reproduced it before the artifact
existed).

Official PaddleX documentation says its CUDA 12.6 HPI package does not support
TensorRT; the documented TensorRT route is CUDA 11.8, cuDNN 8.9, and TensorRT
8.6. At the initial close, the conditional harness used that exact official
PaddleX image instead of claiming the CUDA 12.6 lane was TensorRT. Both bounded
imports stalled before image build steps, task creation, uv installation, or
GPU allocation. That was **unsupported operational evidence**, not a
TensorRT speed or correctness verdict. The later reopened lane below used the
smaller official PaddlePaddle image for the same vendor-documented stack.

The design's ONNX Runtime GPU fallback used the already-working CUDA 12.6 HPI
stack, so it did not create another provider stack. Both detector and
recognizer reported ONNX Runtime on GPU. The explicit provider token, L4/CUDA
device truth, wrong-device mutation, and missing-provider-evidence mutation all
passed. The 32-page results are under
`.evaluation/gpu-spike/2026-08-24/20260824T030051Z-bcf927de/`; the cross-run
comparison is under `provider-comparison-gpd-ort-v1/`. Results were stable
across three repeats but dominated:

| tier | G-PD B1/C1 | G-ORT B1/C1 | ORT / default | init | equivalence vs G-PD |
|---|---:|---:|---:|---:|---|
| Tiny | 1.160 pages/s | 0.695 pages/s | 0.60x | 82.8 s | FAIL: 2 critical-token entries, 16 unmatched lines |
| Small | 0.697 pages/s | 0.426 pages/s | 0.61x | 39.5 s | FAIL: 2 critical-token entries, 14 unmatched lines |

This closes the configured fallback cell. A slower provider that also changes
the record does not earn a batching sweep.

The default ONNX log named ten CPU threads on a four-physical-core Modal
allocation. PaddleX documents `cpu_num_threads` as an exposed ONNX backend
option, so one triggered two-page fairness check set it to four. The log
attested four; throughput fell 8% and initialization increased by 12 seconds.
The default thread setting was therefore retained, and no full tuned run was
justified.

The first two attempts exposed harness cost defects before producing benchmark
calls: normal dependencies used `pip_install` instead of Modal's faster
`uv_pip_install`, and declaring the optional GPU-HPI function caused its heavy
provider image to be created even when no G-HPI arm was requested. The normal
CPU/GPU images now use uv. PyPI packages and Paddle's CUDA-index wheel are in
separate uv layers because mixing both indexes caused the resolver to search
the CUDA index for `paddleocr`. Provider experiments use separate conditional
harnesses so the base M1 run cannot build them accidentally.

Every attempt, including failed image builds and backend fallbacks, remains in
the ledger rather than being discarded.

## Reopened TensorRT result

The reopened lane uses the official PaddlePaddle
`3.0.0-gpu-cuda11.8-cudnn8.9-trt8.6` image, its bundled TensorRT 8.6.1 Python
wheel, PaddleOCR 3.7.0, PaddleX 3.7.2, PaddleX's GPU HPI plugin, and
Paddle2ONNX 2.0.2rc3. Ordinary Python packages use Modal
`uv_pip_install`; the exact vendor-local TensorRT wheel and PaddleX's own HPI
installer use their documented install paths. Runtime evidence records CUDA 11.8, cuDNN 8.9.7, one L4,
ONNX Runtime detection, and TensorRT recognition. Wrong-device and
missing-provider-evidence mutations both fail as required.

The vendor base is recorded by its registry tag, not an immutable manifest
digest. That is sufficient for this development spike but not for a future
qualification or deployment image.

Raw FP32 evidence is under
`.evaluation/gpu-spike/2026-08-24/20260824T084656Z-81ec27e9/`; raw FP16 evidence
is under `20260824T090409Z-3cdc3451/`. The read-only cross-provider projection
is `trt-controls-comparison-v1/score.json`. These paths are ignored local
development evidence, not a durable published archive.

The first two-page shakedown found a real cache hazard: UltraInfer serialized
FP32 and FP16 engines to the same model-relative filename. The apparent FP16
arm loaded the FP32 engine and is invalid. The harness now copies each model
tier into a private scratch tree keyed by precision before TensorRT writes its
cache. All later FP16 evidence uses that isolation.

The paid runs used the explicit development override on git revision
`84bb16ff54f99019d5fb90693469631dd5105170`. Both full 32-page windows record
dirty diff SHA-256
`bf97b89bee78dfbbf410b342f731664f8844cc34c6bbc4842752526b3563176b`
covering the TensorRT harness and scorer. The raw arm records preserve this
provenance; the work was not represented as a clean-commit qualification.

The full FP32 and FP16 diagnostics each ran four arms, 32 frozen pages, and
three randomized repetitions. Every arm within a window used the same L4 UUID;
every arm had zero repeat-to-repeat critical-token, raw-line, and score delta.
The comparator does not use that statement to claim every geometry field was
byte-identical. The first repetition is visibly slower; this is consistent
with lazy dynamic-width warm-up, but the cause was not instrumented. The
median of three reflects the two stable repeats without discarding the first:

| tier | precision | recognition batch | pages/s | vs tier CPU | estimated warm resource $/M prepared pages | batch/precision verdict |
|---|---|---:|---:|---:|---:|---|
| Small | FP32 | 1 | 1.269 | 2.07x | $230 | simplest TensorRT Small arm |
| Small | FP32 | 4 | 1.117 | 1.82x | $262 | 12% slower than B1 |
| Small | FP16 | 1 | 1.324 | 2.15x | $221 | separate-window median 4% above FP32; not causal |
| Small | FP16 | 4 | 1.129 | 1.84x | $259 | slower than B1 |
| Tiny | FP32 | 1 | 1.483 | 2.19x | $197 | stable serial control |
| Tiny | FP32 | 8 | 2.410 | 3.56x | $121 | batching wins but changes output |
| Tiny | FP16 | 1 | 2.312 | 3.41x | $126 | separate FP16-window result |
| Tiny | FP16 | 8 | 2.424 | 3.58x | $121 | only 5% above FP16 B1 |

The CPU ratios and FP32/FP16 differences compare separate app windows on the
same frozen inputs. They are not same-host ratios and remain subject to Modal
shared-tenancy variance. They are screening evidence, not causal precision
effects or an end-to-end qualification result.

The warm resource estimates divide the dated $0.00029216/s four-core, 8 GiB,
and L4 rate by median pages/s. The 4-core/8-GiB diagnostic CPU Small control is
about $114/M prepared pages at its measured 0.614 pages/s. It is not the
design's mandatory 4-core/24-GiB adopted-service cost control. These estimates
exclude engine build and idle time; they are not isolated bills and not
end-to-end service costs.

The 32-page result rejects the two-page inference that Small batching was the
missing architecture. Small B4 is slower even though the effective recognition
batch median and maximum are four. The likely explanation is width-padding and
batch-management work across heterogeneous crops, but that mechanism was not
instrumented and is not claimed as proven. Tiny did benefit from batching
within each precision window. No causal FP32/FP16 conclusion is made.

Correctness remains the stop. Relative to the repeat-stable text/score controls:

- Small FP32 versus default Paddle GPU: 4 critical-token differences,
  11 raw-line differences, and 18 unmatched lines;
- Small FP16 versus Small FP32: 3 critical-token differences, 20 raw-line
  differences, and 36 unmatched lines;
- Small B4 versus its serial precision: 6-8 critical-token differences and
  85-87 raw-line differences;
- Tiny FP16 versus FP32: 8 critical-token differences and 6 raw-line
  differences; and
- Tiny B8 versus serial: 26 critical-token differences and 97 raw-line
  differences.

The scorer's one text mutation is detected as required. Box, confidence,
routing, and independent line mutations from the full predeclared comparator
mutation suite were not run; that suite is required before any resumed
qualification. No difference is relabeled harmless without gold evidence.
TensorRT engine construction also took 351 seconds for
Small FP32, 931 seconds for Small FP16, and 606 seconds for Tiny FP16. Runtime
engine construction is therefore rejected. Provider logs also contain a
TensorRT API-usage error while destroying a runtime before its deserialized
engine; TensorRT itself warns that this leads to undefined behavior. It did not
prevent these bounded calls from completing repeatably. At the close of this
original lane it remained unresolved and blocked production qualification.
The continuation below removes that error; a future candidate would still
have to bake and integrity-pin the selected engine and prove that its
deployment GPU can load it.

### Smallest continuation: lifetime repair and adjudication

The bounded continuation traced the runtime error to UltraInfer, not to Modal
or PageSpatial. At PaddleX source revision
`ffb64904d23708863ff5b8da312a5cbd52a7f462`, both `BuildTrtEngine()` and
`LoadTrtCache()` create a local TensorRT `IRuntime`, deserialize a long-lived
member engine from it, and then destroy the runtime as the function returns.
The same failure is visible in upstream PaddleX issue 4291. The local patch
keeps that runtime as a backend member declared before the engine and context,
so reverse member destruction releases context, engine, then runtime. The
patch is integrity-pinned as
`b03632bbfae1372f21a2e31babbf72f8936943a0848ff3db853a2f1cd5216bd6`.

Two real L4 probes passed:

- the OCR pipeline initialized in 302.55 s, including a fresh TensorRT engine
  build, with no lifetime error; and
- a second OCR pipeline in the same container initialized in 6.67 s while
  loading the cached engine, did not rebuild it, attested ORT detection plus
  TensorRT recognition, and emitted no lifetime error.

Raw evidence is under
`.evaluation/gpu-spike/2026-08-24/20260824T110919Z-8f766bc9/` and
`20260824T111751Z-a57c1249/`. The latter used a different current manifest hash
from the frozen 32-page performance window and only its first 29 entries.
Its 2.260 pages/s median is therefore a lifecycle/correctness observation, not
a replacement performance result.

The original engine-equivalence gate still fails. On the 23 pages shared with the earlier default
Paddle GPU control, both patched repeats report four critical-token
differences at a derived tolerance of zero. All four occur on
`world-bank:P170734:document:34222345#7`. Direct inspection of the source page
image at
`.evaluation/gold/batch3-v1/images/world-bank_P170734_document_34222345-p7.png`
(image SHA-256
`a514fd8dd157febf7731d9593decd9b5e6fab4cdfb8ef05ce5fb1c2df43c1c8c`)
shows two regressions:

- the native source reference contains `FPIU`; default Paddle preserves the
  `I` in the corresponding crop while TensorRT drops it; and
- the visible date is `2023-04-04`; default Paddle returns that value while
  TensorRT returns `2022-04-04`.

The ownership patch intentionally changes no inference math, and the patched
run confirms that runtime safety does not restore output equivalence. The
original gate therefore stopped paid work at this point. No engine was baked
or published, and no width-bucket/concurrency grid, B16/B32 profile, A2
service work, or 50-page end-to-end comparison was run.

### Merged-output safety continuation

The owner then made the product trade-off explicit: PageSpatial may retain
different raw OCR evidence, but it must admit **zero newly incorrect, missing,
or unresolved critical values into trusted, non-escalated output**. This does not
prefer native silently. Native and OCR remain separate observations; a
material disagreement must remain blocking.

The retained 32-page Small FP32 default-Paddle and TensorRT arms were first
replayed through the real PageSpatial merge with the frozen dev-v13 native
observations. This engine-isolation comparison is not the production-control
verdict. Its four symmetric critical-token differences were source-adjudicated
in `evaluation/gpu-spike/merged-output-adjudications-v1.json`. It found a real
merge blind spot: standalone dates such as `2022-04-04` versus native
`2023-04-04` have zero word-token similarity, so the older conflict candidate
filter ignored them despite coincident boxes.

The smallest repair adds one path only for readings that contain the same
non-zero number of critical tokens, contain no letters, and overlap by at
least 0.8. It does not loosen prose matching, and an exact/text-supported
native candidate wins before this numeric fallback. Regression tests prove
the colocated date becomes a blocking conflict, a competing exact native value
does not create a false conflict, and moving the wrong date away from native
evidence makes the merged-output gate fail.

After the repair, all three engine-isolation repeats agree and pass:

- 32 pages: 25 native-backed and 7 native-starved;
- 14 non-escalated pages in both control and candidate; zero route changes;
- two incorrect candidate-only critical values, both on the same
  native-backed already-blocking page;
- both wrong dates are attached to the correct native dates by explicit
  critical conflicts; and
- zero incorrect, missing, or unresolved critical values occur on a non-escalated page.

The production decision was then replayed against the actual adopted CPU
OpenVINO control, not default Paddle GPU. Critical-token subtraction uses the
library's compatible-token semantics and spatially matches exact duplicates
first. This prevents a split `1` + `City Clerk` from being misreported against
`1 City Clerk`, even when other bare `1` values occur later on the page.

Across each repeat, 12 pages differ: 42 candidate-only and 40 control-only
occurrences. Eleven pages are escalated in both arms, containing 41 unreviewed
candidate-only and 40 unreviewed control-only occurrences. They remain in the
artifact but are outside trusted output, so the gate does not spend human
labelling on them. The only residual difference on a candidate page that
remains non-escalated is `1|mayor` from the line `1 Mayor`; the source image
confirms it is correct. Both CPU and TensorRT have 14 of 32 non-escalated pages
and zero route changes. A native-starved deletion mutation, moved wrong-value
mutation, repeated-token/split-tail mutation, missing adjudication, bad image
hash, and unknown verdict all fail as required.

The replay outputs bind the verdict to complete arm metadata and SHA-256 values
for both arm artifacts, the manifest, adjudications, source images, all 162
consumed base records, the scorer, every built `dist/*.js` implementation file,
and `package-lock.json`.

The complete 162-page dev-v13 baseline was also rebuilt through the narrow
merge change. Non-escalated pages remain 67 before and after, with zero route
transitions. Critical conflicts increase from 355 to 420 across seven pages;
all seven were already escalated, but one advisory-only page becomes newly
blocking. Blocking/enrichment-eligible pages therefore rise from 84 to 85.
Enrichment is off here; a future enriched deployment must include this delta
in its spend measurement. The scorer outputs are
`.evaluation/gpu-spike/2026-08-24/merged-output-small-fp32-vs-gpd-v1.json`
and
`.evaluation/gpu-spike/2026-08-24/merged-output-small-fp32-vs-chpi-v1.json`.
Their SHA-256 values are respectively
`f5823e2d447b89d638c739bcb63818024bbdfd0d0caa602b228819b5709fe1d1`
and
`ed2aed181885bd5fc728e79f803b4168d78b5e473c5e6889a84a4c528b61999d`.
These integrity pins do not make the ignored local evidence durable.

This passes the amended safety gate, not the economic gate. Small TensorRT's
warm prepared-image estimate remains about $221/M pages versus $114/M for the
8-GiB diagnostic CPU control. A paid A2/50-page implementation would now test
an already more-expensive treatment. Ruthless simplicity stops before it.

## Decision against the gates

| gate | result |
|---|---|
| backend and device are attested | PASS for CPU OpenVINO, G-PD L4/CUDA, G-HPI L4/Paddle Inference, G-ORT L4/ONNX Runtime, and G-TRT L4/ORT-detection/TRT-recognition |
| same-treatment text/score stability | PASS within each reopened TensorRT arm: the earlier frozen 32-page arms were stable across three repeats, and the patched probes were stable across two repeats on their exercised pages; not a claim of byte-identical geometry |
| runtime health | PASS for the bounded patched build and cached-load probes; this is not a production engine qualification |
| raw engine/batch equivalence | FAIL for every TensorRT batched arm; Small FP32 serial also differs from G-PD; retained as a diagnostic after the owner amended the product gate |
| merged-output safety | PASS for Small FP32 B1 against the adopted CPU control after the numeric-only and symmetric-comparator repairs: zero incorrect/missing/unresolved critical values on non-escalated pages, zero route changes, three repeat-consistent replays |
| prepared-image speed | Small best 2.15x CPU at 1.324 pages/s; Tiny best 3.58x CPU at 2.424; neither is end-to-end evidence |
| diagnostic cost screen | Small warm prepared-image estimate $221/M versus the 8-GiB diagnostic CPU's $114/M; not billed or end-to-end |
| production performance/cost gate | NOT RUN — requires terminal end-to-end pages, the 24-GiB adopted control, and billed cost |
| A2 authorization | NO — Small passes merged-output safety but fails the preliminary cost screen and batching is slower; Tiny still needs the unfunded witness ceremony |
| candidate holdout | correctly unopened |
| production change | NO |

The result is narrower than either “GPU is bad” or “batching fixes Small.” A
real TensorRT lane materially accelerates Small prepared-image OCR, but the
best Small treatment is serial, has an unfavorable diagnostic resource-cost
screen, changes evidence, and has no end-to-end document result. Repairing the
runtime lifetime did not repair those output differences. Tiny has a
near-CPU diagnostic cost screen and higher throughput, but it is a different
unqualified witness.
The smallest correct decision is to retain CPU and stop before A2.

## Spend

The successful shakedown used about $0.024 by the dated resource-time rates:
4 physical cores and 8 GiB for 102.60 s, then the same CPU/memory allocation
plus one L4 for 57.26 s. This is an estimate, not an isolated Modal bill.
Image-build billing, if any, was not isolated and is not reported as zero.

Across the successful controls, failed M1.5 calls, provider shakedowns, and
visible failed provider calls, the attributable resource-time estimate is
about **$0.81** before the reopened TensorRT work. The six reopened TensorRT
windows add about **$1.33**. The two successful lifetime-fix calls add about
**$0.21**, for about **$2.35** total attributable
resource-time. This is not an isolated invoice. Registry/image-build charges,
if any, were not isolated and are excluded.

Cleanup (operator-attested): every GPU-spike Modal app was stopped at the final
write-up check; `modal app list --json` showed every retained GPU-spike app
record in `stopped` state with zero tasks. No automated post-drain probe was
run for these benchmark-only apps.

## Unmeasured and next trigger

### Bounded A2 continuation authorized — 2026-08-24

The owner supplied the missing demand trigger: 50 terminal pages/s across the
fleet, plus an initial USD 50 total PageSpatial experiment ceiling in the
`desia` Modal workspace for 2026-08-24. The owner later raised the ceiling to
USD 75 after an effective-B8 container was stopped during cold startup by a
local-client heartbeat loss. Posted PageSpatial spend at initial authorization
was USD 2.62063099. A serialized launch guard now stops at USD 75 of posted
plus reserved exposure, matching the current owner cap.
The authorization ends at 2026-08-24 23:00 UTC (midnight Europe/London).
Spend is read from Modal's UTC billing interval
`[2026-08-24T00:00:00Z, 2026-08-25T00:00:00Z)`.

This reopens only benchmark A2 for Small FP32 TensorRT B1: four CPU producers,
one persistent L4 owner, one frozen 50-page English PDF, and the adopted
four-physical-core/24-GiB CPU control at the complete terminal PageSpatial
boundary. The prior economic stop remains the null hypothesis, not the final
answer. Sustained and fleet stages run only after the 50-page candidate is
correct, at least 2x faster end to end, billed, and within the exposure gate.
No production deployment change is authorized.

E1 uses one cold plus exactly three warm calls in each arm. Fixed worst-case
reservations are USD 3 for CPU and, after the measured amendment below, USD 3
for GPU; they remain charged until the
exact app is stopped and a final closed-interval total is operator-attested.
`scripts/evaluation/run_gpu_a2_experiment.py` is the only paid entry point. It
reserves before deploy or image construction, gives each arm a unique app ID,
uses no application retries, and stops and verifies the exact app in `finally`.
The continuation also corrects one provenance-only defect before E1: CPU
`engineEvidence` now prefers the concrete `Backend::OPENVINO` line, falls back
only to PaddleX's explicit `Inference backend: openvino` statement, and never
treats a generic backend-config line as engine proof. This covers the observed
stderr-read race without changing engine selection or OCR behavior.

### A2 B1 result and invalid B8 attempt — 2026-08-24

The first valid A2 window ran effective Small FP32 TensorRT B1. Its three warm
complete-document calls had median 0.996 pages/s at the client boundary versus
0.700 pages/s for the CPU control (1.42x). Inner pipeline throughput reached
1.15-1.25 pages/s. Median GPU utilization was about 22%, maximum 32%, with
about 1.4 GiB used. The bounded page queue filled to eight, so rendering fed
the serial OCR owner; the L4 was not saturated.

A requested B8 follow-up is **invalid as B8 evidence**. The local run manifest
said B8, but the remote result identified B1 and its live recognition sampler
reported batch one. Modal remote hydration did not inherit the launcher's
shell-only batch value. The 0.996 pages/s result is therefore a repeated B1
control, not a B8 result. The harness now bakes the batch value into the image
environment and fails before inference on either local/remote arm mismatch or
requested/effective sampler mismatch.

The two complete four-call L4 windows posted incremental costs of about USD
0.199 and USD 0.203. The prospective E1-GPU reservation is reduced from USD
3.50 to USD 3.00, still over 14x the larger observed complete window; prior
ledger entries are unchanged. One true B8 retry may run within the owner's USD
75 ceiling. It also records effective crop batches and compares tiny metadata,
raw JSON bytes, and the full result object without repeating OCR.

The first effective-B8 retry never reached user code. Its image log proves
`PAGESPATIAL_A2_RECOGNITION_BATCH_SIZE=8`, but Modal stopped the app during
TensorRT cold startup after the local client heartbeat timed out. It produced
zero page results and posted about USD 0.062. The paid launcher now uses
`modal run --detach`; it still resolves and stops the exact app in `finally`.

### Effective B8 complete-document result — 2026-08-24

App `ap-hthLjw1aBbXUlAjQovzO31` completed one cold and three warm 50-page
calls in one container. The live startup sampler proved recognition batch
eight. Each repeat processed 4,952 recognition crops in 640 recognition
batches; 598 batches (93.4%) were full batches of eight. This is genuine B8
evidence, not a requested-only label.

Warm median throughput was 0.775 pages/s inside the complete render, queue,
OCR, and assembly method, and 0.709 pages/s at the client boundary. B1 was
1.243 inner and 0.996 client pages/s. Effective B8 was therefore about 38%
slower inside the method and 29% slower at the client boundary. It was only
1.01x the 0.700 pages/s CPU control and fails the 2x gate. Warm median GPU
utilization was 15%, peak 55%, with 1,630 MiB maximum memory. Per-page OCR
service time increased from 0.760 s mean at B1 to 1.248 s at B8.

All four offline correctness reports contain zero newly incorrect trusted
critical values, zero missing trusted values, and zero unresolved trusted
values. Five source adjudications remain pending and raw OCR differs on all 50
pages, so the stricter scorer status is pending. Under the owner's amended
safety rule, no trusted-output defect is demonstrated.

The returned compact server JSON was about 6.46 MB. Warm client time exceeded
method time by a 5.19 s median. This is a measured combined Modal dispatch,
serialization, transfer, and decode boundary—not a measured network-only or
JSON-only cost. The diagnostic response probe exposed that Modal's decoded
object re-encodes 123 bytes differently from the server's original JSON; that
byte-representation mismatch occurred after all four OCR results were saved
and does not invalidate their timings. The probe now treats semantic object
identity separately from exact raw-byte identity.

The architecture conclusion is narrow but decisive: four CPU render producers
filled the page queue, and B8 recognition batches were full, but the Python
owner still executed one monolithic page `predict()` at a time. Larger Small
recognition batches do not solve utilization. The smallest remaining test is
two independent B1 inference owners/streams sharing one L4. A split
detector-to-crop-queue-to-recognizer A3 is justified only if that simpler
concurrent-owner treatment cannot raise utilization and throughput.

- The §6 M1.5 optimistic end-to-end bound was never computed — the stage
  attribution it requires was not instrumented in these arms.
- The suggested crop-width padding explanation for Small B4 is unproven;
  per-batch padded tensor area and recognizer-only time were not recorded.
- The vendor base-image manifest digest was not captured.
- Comparator mutations for box, confidence, routing, and an independent line
  change were not run.
- Sustained 1,000-page operation, failure injection, 1-to-4 GPU scale, and the
  candidate holdout remain unmeasured. Complete 50-page B1 and B8 A2 documents
  are now measured; neither crosses the 2x continuation gate.
- B16/B32 exceed the pinned Small TensorRT batch profile and remain unrun.
  Width buckets and concurrent inference owners remain unrun. Four render
  producers did run, but one Python owner serialized page-level `predict()`.
- The unadopted engine was not baked or published. Only the source revision
  and lifetime patch are integrity-pinned.
- Non-English transfer is intentionally unqualified.

Continue Small only with the bounded concurrent-owner attribution earned by
the A2 traces; do not repeat B4/B8. A split A3 must still justify its extra
interfaces with measured throughput. Alternatively, fund Tiny's complete
new-witness ceremony.

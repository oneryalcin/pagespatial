# Trial: PP-OCRv6 GPU throughput spike

**Date opened:** 2026-08-24

**Design:** [`docs/design/2026-08-24-gpu-ocr-spike.md`](../design/2026-08-24-gpu-ocr-spike.md)

**Status:** bounded spike complete through the pre-A2 stop gate

**Decision:** **REJECT: CPU REMAINS THE SIMPLEST WINNER.**
The adopted CPU Modal deployment remains unchanged. GPU execution and batching
were measured, but no faster treatment preserved the predeclared output
equivalence. A2, sustained qualification, the locked candidate holdout, A100,
and production integration were therefore not authorized.

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
architecture remains unmeasured and unauthorized because no correct engine
advanced.

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
8.6. The conditional harness therefore used that exact official PaddleX image
instead of claiming the CUDA 12.6 lane was TensorRT. Both bounded imports
stalled before image build steps, task creation, uv installation, or GPU
allocation. This is **unsupported operational evidence**, not a TensorRT speed
or correctness verdict. The repository retains the conditional harness for a
future retry if Modal or the vendor image path changes. This spike does not
authorize a second hand-built provider stack.

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

## Decision against the gates

| gate | result |
|---|---|
| backend and device are attested | PASS for CPU OpenVINO, G-PD L4/CUDA, G-HPI L4/Paddle Inference, and G-ORT L4/ONNX Runtime; TensorRT unrun |
| same-treatment stability | PASS for serial controls; FAIL for Tiny B8/C8 and Tiny B1/C8 |
| batch-companion/output equivalence | FAIL for every faster batched arm |
| prepared-image serial speed | Tiny 1.71x; Small 1.13x; not end to end, and neither reaches the 2x optional-fast-lane gate |
| A2 authorization | NO — Small mechanically (fails equivalence + serial bar); Tiny by the dated discretionary stop above (ceremony unfunded, batching gain fails its own stability gate) |
| candidate holdout | correctly unopened |
| production change | NO |

The result is narrower than “GPU is bad.” One L4 can accelerate Tiny when
recognition crops are batched, but the tested engine changes evidence and is
not eligible for PageSpatial records. Small, the current witness, has no
qualified material speedup. TensorRT remains unmeasured because the one
allowed official stack did not become runnable within the bounded setup
attempts. The smallest correct decision is to retain CPU and stop before A2.

## Spend

The successful shakedown used about $0.024 by the dated resource-time rates:
4 physical cores and 8 GiB for 102.60 s, then the same CPU/memory allocation
plus one L4 for 57.26 s. This is an estimate, not an isolated Modal bill.
Image-build billing, if any, was not isolated and is not reported as zero.

Across the successful controls, failed M1.5 calls, provider shakedowns, and
visible failed provider calls, the attributable resource-time estimate is
about **$0.81**. It is not an isolated invoice. The two TensorRT imports made
zero compute calls; any image-build charge is unknown and excluded.

Cleanup (operator-attested): every GPU-spike Modal app was stopped at
write-up time and `modal app list` showed zero running or deployed
gpu-spike apps; no automated post-drain probe was run for these
benchmark-only apps.

## Unmeasured and next trigger

- TensorRT/FP16 throughput and numerics are unmeasured.
- The §6 M1.5 optimistic end-to-end bound was never computed — the stage
  attribution it requires was not instrumented in these arms.
- End-to-end Node A2 overlap, sustained 1,000-page operation, failure
  injection, billed cost, 1-to-4 GPU scale, and the candidate holdout were not
  run because no M1.5 treatment advanced.
- No complete 50-page document was run through a GPU service. The 32-page
  diagnostic measures OCR runtime behavior, not a 50-page completion SLO.
- Non-English transfer is intentionally unqualified.

Reopen only when one of these facts changes: a supported TensorRT image starts
cleanly on Modal, Paddle fixes companion-dependent batching for these pinned
models, or production volume makes a separate lower-level TensorRT/ONNX
implementation worth its maintenance cost. A reopened spike starts with the
same frozen 32-page diagnostic and equivalence scorer. It does not start with
the production architecture.

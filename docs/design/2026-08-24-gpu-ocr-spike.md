# Design: PP-OCRv6 GPU throughput spike

**Status:** merged-output safety is complete; bounded A2 E1 is authorized and
not yet measured; no production GPU path is adopted

**Date:** 2026-08-24

**Baseline:** main at `f1dac3a`; the parse-only Modal deployment is qualified
through M4. This spike does not change that adopted CPU path.

**Scope:** English-language PP-OCRv6 Tiny and Small; one-GPU inference,
batching, CPU/GPU pipeline overlap, correctness, cost, and the minimum
production architecture if a GPU treatment wins

**Audience:** the engineer implementing the spike and the reviewer deciding
whether a GPU path has earned further work

This document is the source of truth for the GPU OCR spike. It supplements the
[Modal scaling design](2026-08-23-modal-scaling-and-deployment.md). It does not
authorize a production migration.

**Execution result (updated 2026-08-24):** the bounded M1 provider pre-screen,
prepared-image batching diagnostics, one reopened TensorRT provider lane, and
the smallest runtime/correctness continuation are complete. The supported lane
uses the vendor-documented CUDA 11.8,
cuDNN 8.9, TensorRT 8.6.1, Paddle 3.0, and PaddleX HPI stack. Provider logs,
device truth, and mutations attest ONNX Runtime detection plus TensorRT
recognition on one L4.

On the fixed 32-page English diagnostic, the current Small tier reached
1.269 pages/s with FP32 and 1.324 with FP16 at recognition batch one, versus
0.614 for the earlier CPU control. Recognition batch four was slower at
1.117/1.129 pages/s. Tiny reached 2.312 pages/s with FP16 batch one and 2.424
at batch eight, versus 0.677 for its CPU control. All arms had zero
critical-token, raw-line, and score delta across three repeats. However,
precision and batch changes exceeded the derived zero-noise output tolerance.
The Small FP32 arm also differed from
default Paddle GPU by four critical tokens and 11 raw lines. The separate
Small FP16 window observed a median 4% above FP32; this is not a causal
precision comparison. The diagnostic warm resource estimate was about 1.94x
the 8 GiB CPU harness control per prepared page. Neither figure executes the
design's end-to-end billed production gate. TensorRT engine construction took
351 seconds for Small FP32, 931 seconds for Small FP16, and 606 seconds for
Tiny FP16. A bounded continuation traced the TensorRT runtime-destruction error
to UltraInfer's runtime/engine ownership order and repaired it in an
integrity-pinned source build. Both a fresh engine build and a same-container
cached-engine load then completed without the error. The patched Small FP32
lane still failed the original zero-noise engine-equivalence gate: four
critical-token multiset differences remain on one adjudicated page, including
`2023-04-04` becoming `2022-04-04`. The owner later replaced that internal
equivalence gate with the merged-output safety gate below; the retained Small
FP32 lane passes the amended safety rule after one narrow merge repair.

The adopted CPU deployment nevertheless remains unchanged. The locked holdout
and production qualification remain closed. The owner continuation amendment
below reopens only bounded A2 E1 because a concrete 50 pages/s demand target
and experiment budget now exist. The evidence does reject the earlier broad claim
that a well-engineered TensorRT path could not be materially faster: it can be
faster, but speed alone does not justify the more expensive lane. See the
[trial record](../trials/2026-08-24-gpu-ocr-spike.md) for the complete ledger
and stop decision.

**Acceptance amendment (owner decision, 2026-08-24):** raw OCR equivalence is
no longer the Small adoption gate. PageSpatial is a two-witness evidence
system: it preserves native and OCR readings and blocks material conflicts.
The product gate is now **zero newly incorrect, missing, or unresolved critical
values in trusted, non-escalated output**, not zero differences in raw OCR
evidence. Candidate-only and control-only values are enumerated symmetrically.
Every difference on a candidate page that remains non-escalated must be
source-adjudicated. Differences confined to escalated pages stay visible in
the inventory but need not be labelled because they cannot enter trusted
output. Raw line, score, geometry, and batch-companion deltas remain required
diagnostics.

Two retained replays were required. The first isolates TensorRT from default
Paddle GPU on all 32 frozen English pages. It found two incorrect
candidate-only dates on one native-backed page. A narrow merge blind spot was
exposed: standalone dates with one changed digit had zero text-token similarity
and were not paired despite coincident boxes. The merge now permits this
comparison only when both readings contain the same number of critical tokens,
contain no letters, and overlap by at least 0.8. Exact or text-supported native
matches take precedence over this fallback. Mutation tests cover a moved-away
wrong value, a deleted value, compatible split tokens with repeated numbers,
and competing native numeric candidates.

The second replay uses the adopted CPU OpenVINO arm as the production control.
It finds 42 candidate-only and 40 control-only critical-token occurrences on
12 pages. Eleven of those pages are escalated in both arms; their 81 residual
occurrences are enumerated and intentionally unreviewed. The only difference
on a candidate page that remains non-escalated is `1|mayor`; direct source
inspection confirms the visible row is `1 Mayor`. Both arms have 14 of 32
non-escalated pages, with zero route changes. Thus the production-control
replay passes the amended rule without claiming raw equivalence.

Each replay output records the complete arm metadata and hashes the control,
candidate, manifest, adjudications, retained evidence images, every consumed
base page record, the scorer, the built JavaScript merge implementation, and
`package-lock.json`. The verdict is therefore bound to the evidence and code
that produced it; the ignored local evidence directory is still development
storage, not a durable published archive.

In the engine-isolation replay, both wrong dates are tied to their correct
native readings by explicit blocking conflicts. Replaying the merge change over the complete
162-page development run creates no escalated/non-escalated route transition.
It does increase critical conflicts from 355 to 420 across seven already
escalated pages and makes one advisory-only page newly blocking, so pages
eligible for enrichment rise from 84 to 85. Enrichment is off in this spike;
any future enriched deployment must price that delta. The merge-safety gate
therefore passes, but the existing economic screen does not: Small TensorRT
remains about $221/M prepared pages versus $114/M for the diagnostic CPU
control. The earlier cost screen did not justify A2 by itself. The later owner
target does justify one bounded end-to-end measurement; CPU remains the
adopted path.

The M1.5 harness's historical `C` field grouped same-shaped pages into one
list-input `predict()` call. It did not implement the design's concurrent
producer window. Those results are page-list batching evidence, not page
concurrency evidence. True producer/owner overlap remains an A2 question and
was not built because no correct engine advanced.

The governing rules are [measure, then trust](../principles.md#8-measured-then-trusted)
and [use ruthless simplicity with explicit composition](../principles.md#9-ruthless-simplicity-explicit-composition).

### Owner continuation amendment — 2026-08-24

The owner has now stated a concrete target: sustain 50 complete, successful,
unique PageSpatial pages per second across the fleet, equivalent by arithmetic
to one million pages in 20,000 seconds (5 h 33 m 20 s). The owner also
authorized up to USD 75 of total PageSpatial experimentation in the `desia`
Modal workspace on 2026-08-24 Europe/London time, raising the initial USD 50
ceiling after the first effective-B8 startup was lost to a client heartbeat.
The authorization ends at
2026-08-24 23:00 UTC. Modal billing is reconciled over the UTC interval
`[2026-08-24T00:00:00Z, 2026-08-25T00:00:00Z)`.

This decision supersedes only the earlier refusal to fund A2. It authorizes a
benchmark-only Small FP32 continuation with four CPU producers, one persistent
L4 TensorRT owner, recognition/page batch B1, bounded queues, one exact
50-page English PDF, and the adopted four-physical-core/24-GiB CPU control.
The seam lives under `scripts/evaluation/` and may reuse
`service/lib/stages.mjs`; it must not modify or become selectable from the
production Modal adapter, service scheduler, worker adapter table, or adopted
CPU adapter.

One deployment-neutral provenance correction is an explicit prerequisite:
the CPU sidecar must retain direct OpenVINO stderr testimony in
`engineEvidence`: prefer the C++ `Backend::OPENVINO` line, otherwise retain
PaddleX's explicit `Inference backend: openvino` line. A later generic
thread-config line is not engine proof. This changes no engine, routing,
scheduling, or OCR output.

Paid stages are serialized. Launches stop at the owner-authorized USD 75 of
posted plus reserved PageSpatial exposure. E1 is one cold and exactly three
warm 50-page comparisons per arm. Fixed reservations are USD 3 for E1 CPU and,
prospectively after the measured amendment below, USD 3 for E1 GPU; callers
cannot lower them. The only paid
launcher is `scripts/evaluation/run_gpu_a2_experiment.py`; it reserves before
CPU deployment or TensorRT image construction and stops the exact app in every
terminal path. E2 (two independent 1,000-page
single-container lifetimes) and E3 (the smallest measured fleet for 50,000
pages) are authorized only if every previous correctness, at-least-2x speed,
billing, and spend-exposure gate passes. CPU remains the production default;
any adoption still requires a separate decision.

**Measured reservation amendment, 2026-08-24:** two complete four-call L4
windows posted incremental costs of about USD 0.199 and USD 0.203. The second
window was invalid as B8 evidence because its local B8 arm identity hydrated as
B1 remotely; it nevertheless measured the same resource envelope. Future E1
GPU reservations are therefore fixed at USD 3.00, still more than 14 times the
largest complete observed window. Existing reservations remain unchanged. One
true B8 retry is allowed only after the image carries the batch value, the
remote arm equals the requested arm, and the live recognition sampler reports
effective batch eight before inference.

**Measured Small A2 result, 2026-08-24:** Small FP32 B1 remains the fastest
complete Small 50-page A2 cell: 0.996 warm client pages/s. Effective B8 reached batch eight
before inference and 598 of 640 recognition batches were full in every repeat,
yet warm client throughput fell to 0.709 pages/s and median GPU utilization
was only 15%. B8 is rejected. It produced zero newly incorrect, missing, or
unresolved trusted critical values under the owner-amended safety rule; five
source adjudications remain pending, so the stricter scorer status remains
pending. The A2 2x speed gate fails and E2/E3 remain locked.

This result triggered one smaller check before A3: two independent B1
inference owners on one L4. That treatment truly overlapped—the sum of page
OCR service time was about 1.89 times wall time and each owner handled roughly
half the crops—but warm client throughput was only 1.017 pages/s versus 0.996
for one owner. Median GPU utilization remained about 21%. The exact pinned
UltraInfer TensorRT backend creates a distinct CUDA stream per backend, so this
also tests the obvious multi-stream treatment.

The bounded Tiny lane is now measured too. Tiny B1 reached 1.403 warm client
pages/s and 1.632 inner pages/s. Effective B8 filled 593 of 639 recognition
batches to eight but improved client throughput only 1.4%. Two B1 owners were
the measured optimum: 1.672 warm client pages/s and 2.134 inner pages/s, with
both owners attested and sharing crops evenly. Four owners regressed to 1.109
warm client pages/s as mean page OCR service time grew from about 0.57 s to
about 3.0 s. GPU median utilization stayed low and fell under four-owner
contention. More owners or recognition-batch sweeps are not justified.

Tiny remains a new, non-adopted witness. Its 50-page results have zero known
newly incorrect or missing trusted values, but two unresolved trusted values,
101-103 pending source adjudications, and four cleared Small blocking routes.
The CPU/Small deployment remains the production default. Do not build split A3
without a profiler-backed custom-runtime hypothesis that isolates detector,
host preprocessing, recognizer, and synchronization cost. None of these
treatments changes production.

## 1. Decision

Run a bounded GPU spike because the existing T4 result did **not** test the
interesting GPU configuration.

**Demand trigger:** the expected near-term workload is predominantly English,
with documents around 50 pages. This spike qualifies that workload only. It
does not infer a language from a submitted PDF.

The spike shall answer five questions:

1. Can one L4 run the current PP-OCRv6 Small witness materially faster than
   the adopted four-core CPU container, end to end?
2. Does PP-OCRv6 Tiny provide a useful speed/cost option without unacceptable
   evidence loss?
3. Is GPU utilization limited by the models, by serial page scheduling, by
   recognition batch size, or by CPU rendering and post-processing?
4. What is the smallest architecture that keeps one GPU busy while preserving
   PageSpatial's page-level failure and provenance rules?
5. Does any winner justify production engineering after cost, correctness,
   reliability, and operational complexity are included?

The spike shall use one L4 first. It shall test a finite decision matrix, not
every combination that a framework or cloud provider exposes. A100 is a
triggered ceiling test. H100, multi-GPU, a public serving layer, and a GPU
fleet larger than four containers are excluded.

The current CPU deployment remains the control and production default. A
passing GPU treatment may earn a separate, explicitly selected `en-gpu`
deployment profile under section 13; it does not silently replace the CPU
profile for every caller.

### 1.1 Decision labels

| label | meaning |
|---|---|
| **CONFIRMED** | supported by current code, a committed trial, or cited vendor documentation |
| **CORRECTION** | a previous project claim that must be narrowed before this spike |
| **HYPOTHESIS** | a plausible explanation that this spike must measure |
| **DECISION** | a requirement of this experiment |
| **TRIGGERED** | run only when the stated prior condition is true |
| **DEFERRED** | intentionally outside this spike |

## 2. What is known, and what is not

### 2.1 The previous GPU test was narrow

**CONFIRMED.** The committed
[`hpi_bench_modal.py`](../../scripts/evaluation/hpi_bench_modal.py) compared:

- PP-OCRv6 Small with CPU OpenVINO HPI; and
- PP-OCRv6 Small with default Paddle GPU on a T4.

Both paths called `predict()` sequentially, once per page. The GPU arm had
`hpi: false`. It did not test GPU HPI, TensorRT, FP16, page concurrency,
recognition batching, a split detector/recognizer pipeline, or an L4.

The committed [HPI trial](../trials/2026-08-23-hpi-benchmark.md) measured a
952 ms warm median for that T4 arm and 989 ms for one CPU HPI arm. The result
supports only this statement:

> Sequential default Paddle GPU on one T4 did not materially beat the tested
> CPU OpenVINO HPI arm.

It does not prove that GPU OCR, an L4, or batched GPU inference cannot win.
The CPU and GPU arms also ran in separate Modal containers under shared-host
variance. They were not a literal same-container comparison.

### 2.2 The current model is not a 1.5-million-parameter model

**CORRECTION.** PP-OCRv6 is a tiered family. The official model collection
lists approximately:

| tier | detector | recognizer | combined description |
|---|---:|---:|---:|
| Tiny | 0.43M | 1.11M | about 1.5M parameters |
| Small | 2.48M | 5.29M | about 7.7M parameters |

The adopted service uses **Small**, not Tiny. The project board currently
attaches the 1.5M figure to the deployed workload and says that GPU is dead.
That wording is too broad. M0 of this spike shall add a dated correction to
the historical trial and living board before new measurements are interpreted.
Historical raw values shall not be rewritten.

This spike is English-only. PaddleOCR's published internal benchmark reports
lower printed-English recognition for Tiny than Small (88.4% versus 93.3%).
That vendor result is orientation, not PageSpatial evidence. It is enough to
require a real English quality gate instead of treating Tiny as a free speed
setting.

### 2.3 Current full-pipeline time is mostly OCR, but not all OCR

**CONFIRMED.** The Linux verification trial reported representative p50 stage
times of about 319 ms render, 44 ms native extraction, 1,174 ms OCR, and 30 ms
assembly. These stages sum to about 1.57 seconds per page. In that sample OCR
was about 75% of the summed stage time.

This gives a useful bound, not a prediction. If only OCR became infinitely
fast and all other work remained serial, the page could improve by at most
about 4x. CPU rendering, decoding, crop preparation, Python/native crossings,
and output assembly therefore need direct measurement and controlled overlap.

### 2.4 The present service architecture is CPU-shaped

**CONFIRMED.** The current path is:

```text
one Modal input = one document
              |
              v
one warm Node service, private scratch
              |
              v
four Node page-worker child processes
              |
              v
one Python OCR sidecar per worker
              |
              v
render -> native text -> one-page OCR predict -> assembly
```

Each worker handles one page message at a time. Each worker owns one OCR
adapter and one Python sidecar. This is a sensible CPU topology: four isolated
one-thread workers can use four physical cores.

It is not automatically a sensible GPU topology. Changing `device="cpu"` to
`device="gpu"` would create four model-owning GPU sidecars, duplicate weights
and runtime state, and make independent processes compete for one device. It
would still issue one page at a time. That naive port is included only as an
architecture control; it is not the proposed production design.

### 2.5 Vendor results are orientation, not PageSpatial evidence

PaddleOCR publishes end-to-end pipeline measurements that include image I/O,
pre/post-processing, and inference. Its published PP-OCRv6 results include:

| hardware/backend | Tiny | Small |
|---|---:|---:|
| A100 / Paddle | 0.13 s/image | 0.25 s/image |
| A100 / TensorRT | 0.16 s/image | 0.32 s/image |
| V100 / Paddle | 0.21 s/image | 0.49 s/image |
| Xeon 8350C / OpenVINO | 0.20 s/image | 0.59 s/image |

These numbers establish that Tiny is faster in PaddleOCR's corpus and that
TensorRT is not guaranteed to beat Paddle. They do not predict PageSpatial's
PDF rendering, page distributions, model configuration, Modal tenancy, or
correctness. We shall not use them as acceptance evidence.

## 3. Hypotheses

The spike tests these hypotheses separately:

| id | hypothesis | observation that supports it | observation that rejects it |
|---|---|---|---|
| H1 | the old T4 result was starved by serial submission | throughput rises with pages in flight or a list input while GPU utilization and batch fill rise | throughput stays flat and GPU remains lightly used after measured queueing |
| H2 | recognition batching is the main GPU opportunity | recognition batch 4 or 8 raises pages/s and lowers GPU cost/page without a large p95 penalty | batch 1 is equal or better after repeats |
| H3 | CPU work starves the GPU | GPU idle gaps align with render/preprocess work and shrink when CPU production overlaps GPU inference | overlap does not change device idle time or throughput |
| H4 | four independent sidecars are the wrong GPU ownership model | one GPU owner with a bounded queue beats the four-sidecar control in throughput, memory, or stability | four isolated sidecars are equal or better without OOM or thrash |
| H5 | Tiny is a useful low-cost witness | it is materially faster and passes its separate gold/discordance gate | it loses critical text, geometry, or calibration, or saves too little |
| H6 | L4 is too small only after it is saturated | a winning L4 arm shows high sustained compute utilization but still misses the speed SLO | the L4 is input-starved, memory-latency-bound, or already meets the SLO |

No architectural claim is accepted from timing alone. The relevant device,
backend, batch, queue, and stage evidence must agree with the explanation.

## 4. Model and correctness lanes

Tiny and Small must not share one acceptance rule.

### 4.1 Small: same witness, different execution engine

PP-OCRv6 Small on CPU is the adopted witness. Small on GPU uses the same
detector and recognizer weights but changes runtime, precision, batching, and
possibly numeric results.

This is an engine/provider change. It requires:

- pinned Small detector and recognizer hashes;
- exact backend and precision truth in every result;
- comparison through the existing stable-result comparator and gold scorer;
- a same-host or same-run CPU Small control where possible;
- deterministic-field and OCR-field comparisons with the correct projection;
- explicit confidence and geometry analysis; and
- no silent fallback from the requested GPU backend.

### 4.2 Tiny: a new witness

Tiny uses different detector and recognizer weights. It is not a faster
execution setting for Small. It is a different evidence witness.

Any Tiny adoption from this spike is explicitly an **English-only** witness
decision. The spike makes no claim about non-English languages and does not
build a language router.

Tiny therefore requires the full candidate adoption ceremony:

- gold-labelled field and critical-token scoring;
- raw-line recall and precision;
- detection-box coverage and geometry comparison;
- discordant-page review against Small;
- special attention to small, narrow, rotated, vertical, handwritten,
  table, stamp, low-contrast, and sparse English text, plus digits,
  punctuation, currency, and proper names;
- confidence calibration, including confident wrong output;
- routing and escalation impact; and
- a separately sealed and labelled holdout check after any threshold is tuned.

The existing 23-document/162-page corpus is development evidence and has been
observed repeatedly. It is not a holdout, and not every page is in the English
scope. M0 shall freeze an English-only development manifest from existing
eligible pages and report its real document/page/gold counts. The repository
also records a candidate 13-document/89-page holdout across languages, but it
is not materialized, labelled, or runner-enabled. An English-only,
document-family-separated subset must be sealed before Tiny adoption.
Materializing and labelling that subset is triggered only if Tiny passes the
development gate; a failed Tiny candidate does not wake that work.

A speed win cannot compensate for an undetected critical omission. Tiny may
be rejected even when it is much faster.

### 4.3 Optional Tiny-first cascade

**TRIGGERED.** A Tiny-first, Small-on-uncertain cascade is tested only if:

1. Tiny is at least 2x faster end to end than Small on the selected engine;
2. Tiny alone does not pass the general witness gate; and
3. every critical Tiny miss in the development set is detectable using inputs
   already available to the router, without consulting Small's answer.

The cascade is evaluated on held-out gold. One confidently wrong critical
result that the router accepts rejects the cascade. Do not build a learned
router or a new distributed scheduler in this spike.

## 5. Finite treatment space

“All possible cases” in this design means all cells in this finite matrix.
It does not mean the Cartesian product of every GPU, runtime, precision,
batch size, page count, and concurrency value.

### 5.1 Model tiers

| id | detector | recognizer | purpose |
|---|---|---|---|
| S | PP-OCRv6 Small | PP-OCRv6 Small | current-witness engine and architecture test |
| T | PP-OCRv6 Tiny | PP-OCRv6 Tiny | new-witness speed/quality test |

Mixed Tiny/Small detector-recognizer pairs are excluded initially. Add one
only if stage evidence identifies detection or recognition as the dominant
tier-specific cost and the complete Tiny lane fails quality. This prevents a
four-model combinatorial sweep without evidence.

### 5.2 Hardware

| hardware | status | reason |
|---|---|---|
| adopted 4 physical-core, 24 GiB CPU container | mandatory control | current qualified deployment |
| one NVIDIA L4 | primary | affordable inference GPU with enough memory for these models and queues |
| one NVIDIA T4 | optional bridge | reproduces the historical arm if harness changes make comparison ambiguous |
| one NVIDIA A100-40GB | triggered ceiling | tests whether a saturated L4 is compute-limited |
| L40S, H100/H200, B200/B300 | deferred | no decision needs them before L4 saturation is proven |
| multiple GPUs in one container | deferred | model and batch sizes do not justify device-level distribution |

Use an exact GPU type for benchmark arms. Do not allow Modal GPU fallback or
automatic upgrade in a comparison arm.

### 5.3 Runtime and precision pre-screen

Run these configurations at effective batch 1 and one page in flight for each
model tier:

| id | runtime | precision | rule |
|---|---|---|---|
| C-HPI | CPU OpenVINO HPI | framework-selected/recorded | mandatory control |
| G-PD | Paddle GPU | FP32 | mandatory GPU baseline |
| G-HPI | PaddleOCR GPU HPI | backend and precision must be reported | run only if installed cleanly |
| G-TRT | TensorRT | FP16 | run only on an officially compatible pinned CUDA/cuDNN/TRT/Paddle stack |
| G-ORT | ONNX Runtime GPU | FP16 or documented provider default | fallback candidate if G-TRT is unsupported, not an automatic extra winner |

As of 2026-08-24, PaddleOCR's HPI documentation says CUDA 12.6/cuDNN 9.5 does
not support its TensorRT backend and that TensorRT 8.6.1.6 is supported with
CUDA 11.8. The historical GPU image used Paddle GPU packages from a CUDA 12.6
index. Therefore:

- do not label a CUDA 12.6 HPI result “TensorRT” unless runtime evidence proves
  that exact backend was used;
- prefer one separate, pinned CUDA 11.8/TRT 8.6 image for G-TRT;
- fail an arm if the requested backend is unavailable; and
- never accept a framework's silent fallback as the requested treatment.

The fastest correct GPU engine for each tier advances. If two are within 10%
after repeat variance, choose the simpler, officially supported engine.

All arms must hold the non-treatment inputs constant: render DPI and pixels,
orientation/unwarping/textline-orientation switches, detection thresholds and
size limits, recognition vocabulary, crop ordering, recovery rules, and output
assembly. The arm manifest shall contain these values. If a runtime cannot
honor one, it is a different treatment and gets a different arm ID.

### 5.4 Batching and in-flight work

For the winning engine in each tier, test:

- recognition batch size `B` in `{1, 4, 8}`; and
- pages in flight `C` in `{1, 2, 4, 8}`.

This is 12 cells per tier, 24 cells total. Each cell must report requested and
effective recognition batch size. A requested batch of eight that repeatedly
runs as one is not a batch-eight treatment.

Why stop at eight: the pinned Small recognition configuration describes
dynamic TensorRT shapes up to batch eight, while detection is described with
batch-one shapes. Batch 64 is not an evidence-backed default for this stack.
Higher recognition batches are tested only if batch eight is full, GPU memory
has at least 30% headroom, throughput is still increasing, and the runtime
reports support for the larger shape.

`C` is a bounded producer window, not concurrent unsynchronized calls into one
Paddle object. One process owns the GPU engine. Producers enqueue work; the
owner forms and executes batches.

M2 uses a no-wait greedy batcher: after the first crop arrives, take up to
`B` items already ready and run immediately. This makes the base grid
deterministic and avoids hiding latency in an arbitrary timer. If the selected
`B > 1` cell has less than 75% fill while the GPU is measurably idle, run one
triggered dwell check at 2 ms and 10 ms. Keep a dwell only if it adds at least
10% end-to-end throughput without breaking the p95 latency gate.

Hold the GPU arm at four requested physical CPU cores for the 24-cell grid so
batch results remain comparable. After selecting the best `B x C` cell, run
one **triggered CPU-supply check** at eight cores only if CPU utilization is
high and GPU traces show input starvation. Test 16 cores only if eight cores
improves end-to-end throughput by at least 25% and can still cross the billed
cost gate. Do not multiply this resource check across the complete grid.

Pinned host memory, asynchronous copies, or multiple CUDA streams are also
triggered, not default arms. Test one only when measured host-to-device copy or
serialization time exceeds 10% of OCR wall time and the public runtime exposes
the optimization without a framework fork. INT8 calibration, CUDA Graphs, and
custom kernels are deferred.

### 5.5 Architecture treatments

Run architecture treatments in order. Stop when the question is answered.

| id | architecture | purpose |
|---|---|---|
| A0 | current one-page sequential GPU call | historical/control shape |
| A1 | four current worker processes, each with a GPU sidecar | proves or rejects the naive port; never production default by assumption |
| A2 | one GPU owner; bounded page/list input; CPU render work may overlap | smallest plausible GPU shape |
| A3 | split detection and recognition; crop queue; batched recognizer | run only if A2 cannot fill batches or device traces show pipeline bubbles |

A3 is not automatic. Splitting the upstream pipeline increases interfaces,
failure cases, and reconciliation work. It earns implementation only if A2's
stage and utilization evidence shows the monolithic API is the bottleneck.

## 6. Experiment phases and stop rules

### M0 - correct the record and freeze inputs

Before spending on new runs:

1. Add dated corrections to the HPI trial and living board. Preserve original
   measurements. State that the old arm was sequential default Paddle GPU on
   a T4, that GPU HPI/batching/L4 were untested, and that Small is about 7.7M
   combined parameters.
2. Freeze the source commit, PDF manifest, page selections, model URLs,
   model SHA-256 values, package lock, container definitions, and pricing
   capture.
3. Define the result projections and quality thresholds before viewing a new
   treatment result.
4. Make the harness refuse a dirty source tree unless an explicit development
   override records the diff hash.
5. Freeze and commit the English-only development manifest with its actual
   document, page, and labelled-page counts. Record that it is development
   data. Do not infer page language from the corpus's `multilingual` selection
   label. Keep the candidate holdout locked during M1-M3.

**Gate:** one reviewer confirms the correction and frozen manifest. No GPU
conclusion may use pre-freeze exploratory results.

### M1 - backend truth and single-page controls

For Tiny and Small:

1. Run C-HPI on the same frozen page sample.
2. Run G-PD on one L4.
3. Attempt G-HPI and the one compatible accelerated provider selected in
   section 5.3.
4. Record the actual backend, provider, precision, device UUID/type, driver,
   CUDA, cuDNN, TensorRT if present, Paddle, PaddleOCR, PaddleX, ONNX Runtime,
   OpenVINO, model hashes, and image digest.
5. Run one synthetic mutation that makes the backend-attestation check fail.

**Stop:** reject a runtime arm that cannot prove its backend or silently falls
back. Do not debug more than one unsupported provider stack per tier.

**Advance:** the fastest correct L4 runtime per tier, with the simpler runtime
winning a tie inside 10%.

### M1.5 - prepared-image batchability smoke

Before building A2, run the best correct L4 engine for each surviving tier on
the same frozen, already rendered English pages:

- batch/concurrency `B1/C1` versus `B8/C8`;
- identical image bytes and preprocessing;
- at least three randomized paired repeats; and
- requested and effective batch sizes reported separately.

For this gate:

```text
serialSpeedup = L4-B1/C1 pages/s / C-HPI pages/s
batchGain = L4-B8/C8 pages/s / L4-B1/C1 pages/s
Toptimistic = Tunoverlappable + max(Tgpu-B8, Toverlap-eligible-CPU)
optimisticEndToEndSpeedup = Tcpu-end-to-end / Toptimistic
```

Calculate the terms from measured stage times. `Toptimistic` deliberately
assumes perfect CPU/GPU overlap and zero added queue/serialization cost, so it
is an upper bound, not a forecast.

**Stop before PR 3** only when all are true:

1. serial L4 speedup is at most 1.3x over C-HPI;
2. effective B8/C8 batch gain is less than 1.2x over L4 B1/C1 across repeats;
3. the optimistic end-to-end speedup is below the 2x continuation gate; and
4. correctness and backend-attestation checks pass, so failure to accelerate
   is not being confused with a broken arm.

An arm that fails output equivalence or same-treatment stability is ineligible
for A2 regardless of speed. If no correct arm remains after M1.5, stop and
retain the CPU deployment. Otherwise advance to A2. A single-page performance
miss is not a GPU verdict because the
original T4 test already established that serial inference is the wrong place
to settle the batching question.

### M2 - bounded batching grid

Run the 24 `tier x B x C` cells in section 5.4 using A2 and the frozen
50-page OCR-forced diagnostic lane. Use one warm container and randomized
cell order. Repeat every cell at least three times; the first measured call is
reported separately as engine-build/warm-up, not mixed into the warm
distribution. Re-run the simplest control and the per-tier winner once through
the production-routed lane as a sanity check. Only M4 production-routed runs
can support adoption.

Early prune a cell when it has:

- a correctness failure;
- OOM or repeated allocator failure;
- no effective batch growth;
- p95 page latency more than 2x the best lower-concurrency cell without at
  least 20% throughput gain; or
- throughput more than 15% below a simpler cell in two repeats.

**Advance:** keep the Pareto frontier for sustained runs: maximum three
treatments per tier across throughput, p95 latency, and cost/page.

### M3 - architecture attribution

For Small, compare A0, A1, and the best A2 cell. Run A3 only if A2 shows
unfilled recognition batches or GPU idle gaps attributable to the monolithic
pipeline.

For every treatment, report:

- model copies and GPU memory by process;
- page producer queue depth and dwell;
- detection and recognition batch fill;
- GPU busy/idle timeline aligned with CPU stages; and
- throughput change from A0.

**Decision:** if batching wins but only A3 can realize it, the report must name
the current service boundary as the bottleneck. If A2 wins, do not build A3.

### M4 - correctness and sustained workload

Run each surviving treatment over:

1. the fixed 32-page hard/stratified diagnostic sample;
2. the complete frozen English-only development correctness manifest;
3. at least one real or synthetic 50-page document with representative page
   density; and
4. a deterministic 20-call x 50-page sustained manifest: 1,000 terminal pages.

For Small engine changes, these runs plus the same-configuration null control
are the qualification evidence. For Tiny, M4 is still a development gate. If
Tiny passes it, freeze an English-only, document-family-separated candidate
holdout manifest, labels, and runner procedure before one M6 evaluation. Do
not use holdout results to tune Tiny.

Run the sustained manifest twice in independent app windows. Randomize the
order of CPU control and GPU treatments across windows. Do not infer fleet
performance from this phase.

**Advance:** only treatments that pass correctness, stability, and the
performance gates in section 13.

### M5 - small fleet and optional hardware ceiling

Compare one and four containers for the single winning GPU treatment. Each
container still owns one document input at a time. Measure cold and warm work
separately.

Run one A100-40GB ceiling arm only when all are true:

- L4 sustained GPU compute utilization is high rather than input-starved;
- the treatment passes correctness;
- L4 misses the accepted throughput or latency target; and
- a measured A100 speedup could cross the cost or latency gate.

Do not run 16 GPU containers in this spike. A 1-to-4 curve is enough to find a
gross orchestration or shared-resource problem. A larger fleet belongs to a
qualification design after one-container economics are real.

### M6 - optional Tiny cascade

Run only under section 4.3's triggers. Freeze the rule on development data,
then evaluate it once on the newly sealed holdout gold. No tune-after-looking
cycle is allowed. A Tiny full-witness candidate also needs this one sealed
holdout run even when no cascade is proposed.

## 7. Corpus and workload contract

### 7.1 Correctness corpus

Derive a committed English-only manifest from the 23-document/162-page
**development** corpus and its existing gold-labelled subsets and overlays.
Do not assume all 23 documents or 162 pages qualify. The 32-page hard sample
shall be selected from eligible English pages and committed before treatment
results are viewed. It must include, where the corpus permits:

- clean born-digital pages;
- raster scans;
- sparse and dense pages;
- small and narrow text;
- tables and multi-column layouts;
- varied English fonts, casing, punctuation, numerals, and currency;
- rotated, vertical, and skewed text;
- low contrast, blur, and compression damage;
- pages that currently trigger recovery or escalation; and
- known OCR-jitter pages.

Repeated pages increase performance sample size. They do not increase
correctness coverage and shall not be reported as if they do.

The repository's candidate holdout is not part of this development corpus.
Do not unlock it for engine screening or batching. If Tiny reaches M6, create
a separate English-only sealing record that proves document-family
separation, language eligibility, hashes, labels, runner controls, and one-run
access before calling it held out.

### 7.2 Performance documents

All performance documents in this spike are English-language documents. The
50-page workload is important because the user's expected jobs are about 50
pages. It is also large enough to fill bounded batches without a cross-document
scheduler.

The benchmark shall record per document:

- input bytes;
- page count;
- rendered pixels and render DPI per page;
- detected crops and recognized characters per page;
- native-only, OCR, and recovery routing counts; and
- terminal result bytes.

Use two performance lanes:

1. **production-routed:** run the unmodified PageSpatial decision path. This is
   the only lane used for end-to-end adoption and cost claims;
2. **OCR-forced diagnostic:** feed the same frozen rendered pages directly to
   OCR, including pages that production routing might satisfy from native
   text. This keeps the device supplied and isolates OCR capacity.

The OCR-forced lane can explain a bottleneck. It cannot justify a production
throughput claim because it changes which pages receive OCR. Report the
production route's native-only, OCR, and recovery page counts so two arms
cannot appear faster merely because they routed less work to OCR.

All throughput and batch-fill conclusions are scoped to these English
documents. Crop density, characters per crop, preprocessing, and batch fill
can change with language and document class. Do not transfer the measured rate
to non-English traffic without a new workload manifest and qualification.

If one available document cannot represent the distribution, build the
50-page workload from a committed ordered manifest of existing pages. Label it
synthetic and do not use its document wall time as a user-latency claim.

### 7.3 Warm-up and repetitions

For every arm:

- record container start, model initialization, first inference, and steady
  inference separately;
- discard nothing silently;
- label the first call cold or engine-build;
- use at least three warm repetitions in M1/M2;
- use two independent sustained windows in M4; and
- report every attempted call, including timeout, retry, OOM, and failure.

Median alone is insufficient. Report p50, p95, p99 when the sample count makes
them meaningful; otherwise report all observations and do not attach a
percentile label.

## 8. Required instrumentation

### 8.1 Stage time

Add monotonic timers around:

1. PDF page render;
2. image decode/normalize;
3. native-text extraction;
4. detector preprocess;
5. detector inference;
6. detector postprocess;
7. crop/sort/resize;
8. recognizer queue dwell;
9. recognizer inference;
10. CTC/NRTR decode and OCR postprocess;
11. PageSpatial assembly; and
12. result serialization.

If the public Paddle pipeline cannot expose a sub-stage without a fork, mark
it as an opaque combined stage. Do not patch framework internals merely to
obtain perfect attribution before the architecture decision needs it.

### 8.2 Queue and batch truth

Each page or crop group shall carry document ID, page number, sequence number,
enqueue time, dequeue time, requested batch size, effective batch size, and
batch ID. The aggregate shall report:

- batch fill ratio;
- number of partial batches and why they flushed;
- queue depth p50/max;
- queue dwell p50/p95/max; and
- out-of-order completion count.

### 8.3 Device and host truth

Capture at fixed intervals during measured work:

- GPU utilization and memory utilization;
- allocated and peak GPU memory;
- power draw when available;
- per-process GPU memory;
- CPU time/utilization and requested physical cores;
- process RSS and peak RSS;
- scratch-disk peak;
- device model and UUID; and
- provider/backend/precision reported by the engine.

Use `nvidia-smi` or equivalent vendor telemetry as an independent device
cross-check. Framework configuration alone is not proof that the GPU or
TensorRT executed the model.

### 8.4 Throughput, latency, and cost

Report:

- terminal pages/second;
- OCR pages/second and crops/second;
- first-page latency;
- per-page p50/p95/max;
- per-document p50/p95/max;
- warm method wall time;
- cold readiness and engine-build time;
- terminal pages per billed container-second;
- billed dollars per terminal page and per million pages; and
- a resource-time estimate, clearly labelled as an estimate, when billing
  cannot isolate the arm.

Do not call a single-container billed arm “marginal warm fleet cost.” Separate
boot, idle, failed calls, and useful warm work.

### 8.5 Correctness

Record at least:

- critical-token precision/recall and exactness;
- raw-line precision/recall;
- gold field accuracy;
- detected box count and matched-box IoU/coverage;
- confidence distribution and calibration buckets;
- deterministic-result projection equality;
- OCR-derived projection deltas;
- routing/escalation changes; and
- a list of every discordant page with review disposition.

The comparator must include mutation tests that prove it fails when a critical
token, line, box, confidence, or routing decision is changed.

## 9. Candidate GPU architecture

The spike starts with measurements, but it needs a concrete architecture to
test. The smallest plausible winner is:

```text
one Modal document input
          |
          v
Node document controller on private scratch
          |
          +---- CPU render/native producers (bounded)
          |                 |
          |                 v
          |         bounded page queue
          |                 |
          |                 v
          |       one GPU owner process
          |          |            |
          |          | detect     | recognize batches (1/4/8)
          |          v            v
          |       keyed page/crop results
          |                 |
          +-----------------+
                    |
                    v
       deterministic per-page assembly
```

### 9.1 Ownership rules

- One process owns one GPU engine instance in v1.
- CPU producers never call the GPU object directly.
- Queues have explicit item and byte bounds.
- The document-level Modal call remains the durability/retry boundary.
- Every result is keyed by document, page, and crop sequence.
- Publication remains per page and deterministic even when inference finishes
  out of order.
- Private scratch remains private to one container. A shared Volume is not a
  job database or lock.
- One container processes one document input at a time during qualification.

### 9.2 Backpressure

The GPU queue must stop CPU producers before memory grows without bound. The
initial limits shall be derived from measured peak rendered-page and crop
bytes, with these conservative caps:

- at most eight rendered pages awaiting GPU work;
- at most two recognition batches awaiting execution; and
- at most 70% of device memory committed at the observed peak.

If byte size reaches the bound before item count, the byte bound wins. Queue
limits and observed peaks must be emitted with every result manifest.

### 9.3 Batch formation

Detection and recognition have different shapes. Do not pretend that “batch
eight pages” means every stage runs with batch eight.

- Detection begins at batch one unless the selected backend proves a supported
  larger dynamic shape.
- Recognition groups compatible crops up to the selected batch size.
- The base batch flushes when full or when no more crops are immediately
  ready. Only the triggered M2 dwell check may wait for more work.
- Any selected dwell deadline is carried in the arm identity and final result.
- Padding and resize work is counted as recognizer preprocessing.

### 9.4 Failure behavior

One bad page or batch must not poison the document silently.

- On a batch execution error, retry once at half batch size.
- If it still fails, isolate remaining items and try them individually once.
- Write successful per-page records inside the attempt only after their
  complete page result is atomic.
- Mark an unrecoverable page failed with the backend, batch ID, and error.
- Never publish a partial OCR batch as a complete page.
- If the GPU owner dies, stop accepting producer work, terminate the document
  attempt visibly, and let Modal's document-level retry policy act.
- Outputs must be idempotent because Modal delivery is at least once.
- A poisoned container exits; it does not repair the GPU runtime in place.

The current Modal method returns one bounded document bundle after the job is
terminal. Per-page records in private scratch are not externally durable
progress. If the container dies, the document is replayed; this spike does not
invent cross-container page checkpointing.

The retry policy is for fault isolation, not infinite resilience. Failure
injection in section 10 must prove its bound.

### 9.5 Source boundary

The spike may add a deployment-specific GPU adapter and neutral batching
primitives. It shall not place Modal imports in `src/` or `service/`.

Any change to canonical PageSpatial output or witness semantics requires its
own reviewed library change. A benchmark-only switch must be locked out of the
production Modal app unless and until adoption occurs.

Every canonical page produced by the English GPU profile must carry
`provenance.configuration.deploymentProfile: "en-gpu"` beside the existing
backend descriptor. The arm definition and document result manifest carry the
same value. A missing or conflicting profile is a provenance failure.

The deployment README must state:

> `en-gpu` is qualified only for English documents. Profile selection is an
> operator responsibility. Non-English results are outside qualification.

Do not add automatic language detection or routing to enforce this profile.

## 10. Adversarial and failure tests

The winning treatment must survive:

| injection | required observation |
|---|---|
| unsupported requested backend | arm fails before measurement; no fallback result |
| falsified backend-attestation fixture | provenance check rejects it |
| missing or conflicting `deploymentProfile` | result/provenance check rejects it |
| one corrupt rendered page | that page fails or isolates; other completed pages remain attributable |
| GPU OOM during a batch | bounded split/individual retry; visible terminal failure if exhausted |
| GPU owner process kill | document attempt becomes visibly terminal or retries at document boundary; no silent loss |
| Node controller kill | at-least-once replay produces idempotent final output |
| timeout during a full queue | producers stop; all children drain or are killed within the existing exit bound |
| duplicate document delivery | one digest-bound final result; duplicate work is observable |
| out-of-order GPU completion | final page order and page numbers remain deterministic |
| oversized or crop-heavy page | queue byte bound holds; no unbounded RSS/GPU growth |
| 100 warm document calls | bounded RSS/GPU-memory slope and no orphaned process |

Inspect the live process tree before drain and the PID namespace after drain,
using the hardened process probe from the Modal qualification. Classify only
what is observed. Do not infer that an unexplained process state is harmless.

## 11. Harness and evidence contract

### 11.1 One harness, explicit arms

Extend or add one Modal benchmark harness with declarative arm definitions.
An arm ID must determine:

- source commit and image digest;
- hardware and resource request;
- language scope (`en` for every arm in this spike);
- deployment profile (`en-gpu` for GPU-profile arms);
- model tier and both model hashes;
- runtime/provider and precision;
- architecture treatment;
- requested batch and concurrency;
- corpus/workload manifest;
- warm-up policy and repetitions; and
- fault injection, if any.

The aggregation tool shall reject mixed arm identities.

### 11.2 Required files per arm

Archive:

- `arm.json` with the frozen definition;
- `environment.json` with package/device/backend truth;
- `calls.jsonl` with every submitted and terminal call;
- `pages.jsonl` with page, stage, queue, and batch metrics;
- `device.jsonl` with timestamped GPU/CPU samples;
- `comparison.json` with correctness verdicts;
- `aggregation.json` with declared formulas;
- complete timestamped logs;
- billing export or query result; and
- failure-injection evidence when applicable.

Every aggregate must be reproducible from raw rows. Counts must reconcile:
submitted documents, terminal documents, submitted pages, terminal pages,
failed pages, retries, and duplicates.

### 11.3 Reproducibility

- Pin every package and base image by immutable version/digest where possible.
- Hash downloaded weights after staging.
- Cache engines only when their cache key includes model hash, provider,
  precision, shapes, device capability, and runtime versions.
- Record whether engine build time is included in the billed arm.
- Keep exploratory runs separate from qualification evidence.
- Record the exact Modal app name and UTC window.
- Seal adopted evidence with SHA-256 and a stated retention location.

## 12. Cost model

Capture fresh Modal pricing at run time. The following values are dated
orientation only, retrieved 2026-08-24:

- physical CPU core: $0.0000131/core-second;
- memory: $0.00000222/GiB-second;
- T4: $0.000164/second;
- L4: $0.000222/second;
- A100-40GB: $0.000583/second; and
- H100: $0.001097/second.

At the adopted 4-core/24-GiB request, CPU plus memory is about
$0.00010568/second before other charges. An L4 added to the same request makes
the resource rate about $0.00032768/second, approximately 3.1x the CPU
container rate. Therefore an L4 needs roughly 3.1x the **same measured useful
throughput** merely to reach resource-rate parity at that allocation.

This is not an adoption threshold by itself because:

- a GPU winner may need a different CPU/memory request;
- billed time includes boot, engine build, idle, and failures;
- Modal pricing can change; and
- user latency can justify a bounded premium.

The report shall calculate both resource-rate parity and actual billed
cost/page from the captured prices and run windows. Do not reuse 3.1x if the
resource request or price changes.

## 13. Acceptance and stop gates

### 13.1 Small correctness gate

Small GPU advances only if:

1. model hashes match the Small CPU control;
2. deterministic-exact fields match under the existing stable projection;
3. candidate-only and control-only critical values are enumerated using the
   library's compatible-token semantics, with exact spatial matches preferred;
4. every difference on a candidate page with
   `diagnostics.requiresEscalation === false` is source-adjudicated;
5. zero incorrect, missing, or unresolved critical values occur on such a
   non-escalated page;
6. adjudicated incorrect candidate values covered by native evidence create an explicit critical
   conflict, rather than relying on an unrelated page warning;
7. no candidate treatment clears a control blocking route;
8. no wrong-side or critical gold result regresses;
9. raw-line, score, geometry, confidence, routing, batch-companion, and
   submission-order deltas are measured and reported, but are not required to
   be zero when the trusted-output gate passes; and
10. every backend, gate, and comparator mutation test fails as expected.

`Non-escalated` means the page's `requiresEscalation` field is false. This gate
does not silently prefer native text: both observations remain in the record,
and a conflict identifies the unresolved disagreement. An FP16 or TensorRT
difference is not dismissed as harmless numeric jitter until the merged-output
scorer proves that it cannot enter trusted output.

### 13.2 Tiny correctness gate

Tiny advances only if:

1. it passes the full candidate-witness ceremony in section 4.2;
2. it introduces zero undetected critical omissions or wrong-side decisions
   on held-out gold;
3. any accepted quality loss is written as a product decision, not hidden in
   an average score;
4. confidence remains useful for routing; and
5. its model tier and hashes are explicit in every result.

Passing this gate supports only an English-language witness decision. It says
nothing about non-English capability.

The engineer may recommend “Tiny rejected” without trying to tune it into
Small. That is a successful spike result.

### 13.3 Performance and cost gates

Use end-to-end terminal pages, not OCR-only calls.

**English GPU deployment-profile candidate:** recommend an `en-gpu`
production design only if the winning Small GPU treatment:

- reaches at least 3x the adopted CPU container's sustained end-to-end
  pages/second on the same workload;
- passes all correctness and reliability gates;
- is not more expensive per terminal page in the dated billed comparison;
- repeats within a predeclared variance band in two app windows; and
- has a simpler operational cost than the value it creates.

The 3x gate presupposes the overlapped A2 architecture. Section 2.3's serial
Amdahl bound means A0/A1 may be unable to reach it even when the GPU is useful.
A serial-arm miss is therefore an input to M1.5/M3, not a hardware verdict.

**Optional fast lane:** a GPU treatment may be recommended as a non-default
latency lane if it reaches at least 2x end-to-end document speed, passes all
correctness gates, and the report states the exact cost premium and workload
that justifies it.

**Stop:** stop GPU production work when the best bounded L4 treatment is below
2x end-to-end CPU throughput, or when gains come only from Tiny and Tiny fails
quality. Preserve the measurements and keep CPU as default.

**Investigate architecture:** if OCR-only GPU throughput is at least 3x but
end-to-end speed is below 2x, the architecture or non-OCR stages are the
bottleneck. Use M3 attribution before changing hardware.

### 13.4 Reliability gate

The winner must have:

- zero silent loss;
- visible terminal state for every call and page;
- bounded retries and queue memory;
- no unexplained orphan after drain;
- idempotent duplicate delivery;
- no increasing GPU-memory or RSS slope across the warm-lifetime test; and
- exact reconciliation between raw calls, pages, failures, retries, and
  aggregates.

### 13.5 Architecture decision table

| observed result | decision |
|---|---|
| A2 Small passes all gates | write a separate `en-gpu` production integration design for the one-owner bounded-queue path |
| only A3 passes performance | name the monolithic OCR boundary as the bottleneck; price the split before implementation |
| Tiny passes as a full witness | consider Tiny as a separately versioned witness; do not silently replace Small |
| Tiny fails alone but cascade passes held-out | design the simple deterministic cascade separately |
| L4 saturated and A100 crosses a gate | include A100 economics in the production design |
| GPU below stop threshold | close the workstream with CPU retained |
| correctness or provenance cannot be proven | reject regardless of speed |

## 14. Explicit non-goals

This spike shall not:

- replace the adopted CPU deployment during testing;
- add public ingress, authentication, object storage, or an external queue;
- enable enrichment;
- introduce VLM OCR or a heavier PP-OCR tier;
- qualify non-English OCR;
- test Medium again without a separate accuracy trigger;
- build a generic GPU scheduler;
- schedule crops across documents;
- use more than one GPU per container;
- test every Modal GPU;
- qualify a 16-container GPU fleet;
- optimize browser WebGPU; or
- promise a 50,000-page completion time from a microbenchmark.

If the spike finds a production candidate, production integration and fleet
qualification are new, smaller documents based on the observed winning cell.

## 15. Implementation sequence

### PR 1 - record and harness contract

- dated correction to the historical GPU claim;
- frozen manifests and treatment schema;
- backend/device attestation and mutation test;
- result projection/scorer wiring; and
- no paid performance conclusion.

### PR 2 - Tiny/Small single-page controls

- pinned models and engines;
- CPU and L4 M1 arms;
- prepared-image M1.5 `B1/C1` versus `B8/C8` smoke and stop calculation;
- stage/device telemetry; and
- cold adversarial review before choosing advancing engines.

### PR 3 - one-owner bounded batching

- A2 prototype behind a benchmark-only entry point;
- `B x C` finite grid;
- queue bounds and failure isolation tests; and
- M2/M3 report with stop/advance decision.

### PR 4 - sustained and correctness qualification

- only surviving treatments;
- complete correctness corpus and 1,000-page sustained runs;
- fault injections, billing, and reconciliation; and
- final adopt/defer/reject recommendation.

A3, A100, and Tiny cascade are conditional PRs. Do not prebuild them.

Each PR follows the existing pattern: implementation, cold adversarial review,
fixes with reproduced failures as regression tests, and independent closure.

## 16. Required final report

The final trial document must lead with one of:

- **ADOPT `en-gpu` FOR PRODUCTION DESIGN**;
- **ADOPT AS OPTIONAL FAST LANE**;
- **TINY ONLY: NEW WITNESS DECISION REQUIRED**;
- **DEFER: PROMISING BUT BELOW A STATED TRIGGER**; or
- **REJECT: CPU REMAINS THE SIMPLEST WINNER**.

It must include:

1. the complete attempted-arm ledger;
2. backend/device attestation;
3. Tiny and Small correctness verdicts kept separate;
4. stage, queue, batch, device, throughput, latency, and memory tables;
5. actual billed cost and dated resource-rate calculation;
6. failure and cleanup evidence;
7. the exact winning cell, if any;
8. which architecture component was limiting;
9. what remains unmeasured; and
10. the smallest next action, or an explicit stop.

No result may say “GPU is faster” without naming model tier, hardware,
runtime, precision, effective batch, concurrency, architecture treatment,
corpus, end-to-end boundary, and whether cold time and failures are included.

## 17. References

### Project evidence

- [Modal scaling and deployment design](2026-08-23-modal-scaling-and-deployment.md)
- [HPI benchmark trial](../trials/2026-08-23-hpi-benchmark.md)
- [Linux verification trial](../trials/2026-08-23-linux-verification.md)
- [Modal qualification trial](../trials/2026-08-23-modal-qualification.md)
- [Evaluation rubric](../evaluation-rubric.md)
- [Development and candidate-holdout corpus contract](../evaluation-corpus.md)
- [Current witness adoption ceremony](../trials/2026-08-22-sidecar-adoption-ceremony.md)
- [Current Node page worker](../../service/worker.mjs)
- [Current PP-OCR sidecar adapter](../../service/adapters/ppocr-sidecar.mjs)
- [Current Python PP-OCR sidecar](../../service/sidecar/ppocr_sidecar.py)
- [Current Modal adapter](../../deploy/modal/modal_app.py)
- [Historical benchmark harness](../../scripts/evaluation/hpi_bench_modal.py)
- [TensorRT continuation harness](../../scripts/evaluation/gpu_spike_trt_modal.py)
- [UltraInfer runtime-lifetime patch](../../scripts/evaluation/ultra-infer-trt-runtime-lifetime.patch)
- [Merged-output safety scorer](../../scripts/evaluation/score_gpu_merged_output.mjs)
- [TensorRT-versus-default-GPU adjudications](../../evaluation/gpu-spike/merged-output-adjudications-v1.json)
- [TensorRT-versus-production-CPU adjudications](../../evaluation/gpu-spike/merged-output-production-adjudications-v1.json)

### Primary external references

- [PaddleOCR PP-OCRv6 algorithm and published performance](https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version3.x/algorithm/PP-OCRv6/PP-OCRv6.en.md)
- [PaddleOCR general OCR pipeline usage](https://www.paddleocr.ai/main/en/version3.x/pipeline_usage/OCR.html)
- [PaddleOCR high-performance inference and compatibility](https://www.paddleocr.ai/main/en/version3.x/inference_deployment/local_inference/high_performance_inference.html)
- [PaddleOCR text recognition module](https://www.paddleocr.ai/main/en/version3.x/module_usage/text_recognition.html)
- [Pinned UltraInfer TensorRT backend source](https://github.com/PaddlePaddle/PaddleX/blob/ffb64904d23708863ff5b8da312a5cbd52a7f462/deploy/ultra-infer/ultra_infer/runtime/backends/tensorrt/trt_backend.cc)
- [PaddleX issue 4291: matching TensorRT runtime-lifetime failure](https://github.com/PaddlePaddle/PaddleX/issues/4291)
- [Official PP-OCRv6 model collection](https://huggingface.co/collections/PaddlePaddle/pp-ocrv6)
- [PP-OCRv6 Tiny detector](https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_det)
- [PP-OCRv6 Tiny recognizer](https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_rec)
- [PP-OCRv6 Small detector](https://huggingface.co/PaddlePaddle/PP-OCRv6_small_det)
- [PP-OCRv6 Small recognizer](https://huggingface.co/PaddlePaddle/PP-OCRv6_small_rec)
- [PP-OCRv6 Small detector inference configuration](https://huggingface.co/PaddlePaddle/PP-OCRv6_small_det/blob/main/inference.yml)
- [PP-OCRv6 Small recognizer inference configuration](https://huggingface.co/PaddlePaddle/PP-OCRv6_small_rec/blob/main/inference.yml)
- [Modal GPU guide](https://modal.com/docs/guide/gpu)
- [Modal CUDA guide](https://modal.com/docs/guide/cuda)
- [Modal pricing](https://modal.com/pricing)

External benchmark figures and prices are dated inputs. The archived project
run, not a vendor table or this document, decides adoption.

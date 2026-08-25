# Design: GPU bottleneck instrumentation

**Status:** proposed measurement contract; no paid run or optimization is
authorized

**Date:** 2026-08-25

**Baseline:** `main` at merge `2e23a98` (PR #98). The bounded GPU spike and
its paired split rejection are complete. The qualified CPU/Small deployment
remains unchanged.

**Scope:** one warm PP-OCRv6 Tiny FP32, recognition-batch-one, two-owner
document on one NVIDIA L4; CPU call stacks, CUDA API calls, memory copies,
kernels, synchronization, and GPU-idle gaps

**Audience:** the engineer adding the instrumentation and the reviewer who
decides whether one native optimization experiment is justified

This document is the source of truth for the next GPU measurement. It extends
the [GPU spike design](2026-08-24-gpu-ocr-spike.md), the
[GPU trial](../trials/2026-08-24-gpu-ocr-spike.md), and
[issue #97](https://github.com/oneryalcin/pagespatial/issues/97). It does not
authorize a new GPU SKU, model, batch sweep, queue, deployment, or production
path.

The governing rules are [measured, then trusted](../principles.md#8-measured-then-trusted)
and [ruthless simplicity](../principles.md#9-ruthless-simplicity-explicit-composition).

## 1. Decision

Instrument the measured Tiny B1 O2 pipeline before changing it again.

Use **Nsight Systems first** to produce one correlated CPU/CUDA timeline. Add
only enough NVTX ranges to name PageSpatial and PaddleX stages. Capture a
separate native CPU call-stack profile if the host is material. Add narrow
C++ ranges inside the pinned UltraInfer TensorRT backend only if the first
trace leaves a large synchronous backend interval opaque.

Use **Nsight Compute only if** Nsight Systems shows that kernels occupy most
of the relevant wall time or keep the L4 continuously busy. Kernel replay and
hundreds of counters cannot explain a GPU that is waiting for the host.

The result must answer this question:

> Which measured operation is the largest removable cause of warm
> complete-document time or GPU idle time?

If the trace cannot answer that question, stop. Do not compensate with more
arms or more instrumentation.

The demand consequence is concrete. At the measured 2.134 inner pages/s, the
50 pages/s fleet target projects to about 24 continuously warm L4 containers;
the 1.672 full-result client rate projects to about 30. Those are arithmetic
capacity estimates, not fleet measurements. A real per-container gain reduces
both counts; another configuration sweep without a mechanism does not.

The primary metric for this workstream is **inner complete-document
throughput**: terminal pages per second measured when the in-container result
is fully assembled. This is the boundary the CPU, CUDA, and NVTX evidence can
explain. **Full-result client throughput** remains a secondary end-to-end
metric. Its gap from the inner rate is divided honestly:

- in-container result construction and JSON assembly are measured under
  `result.assemble`; and
- Modal serialization, transport, and client receipt remain outside the traced
  child process and use the existing response-probe measurement.

The eventual production metric is **persisted terminal pages per second**:
results are durable and the caller receives a pointer rather than a multi-MB
payload. That path has not been built or measured and is not authorized by this
instrumentation work.

## 2. What is already known

These facts come from committed evidence, not from GPU utilization alone:

- Tiny B1 with two owners was the fastest complete A2 arm: 2.134 inner
  pages/s and 1.672 full-result client pages/s on the frozen 50-page document.
- Tiny B8 filled 593 of 639 recognition batches to eight but improved client
  throughput by only 1.4%.
- Four owners regressed to 1.109 client pages/s. More owners are not an open
  treatment.
- The valid paired Python split ran every crop and reached queue depth two,
  but regressed inner throughput from 1.702 to 1.597 pages/s and did not raise
  GPU utilization. That executable treatment was removed in `4a4e042`.
- The faster warm Python-visible profile attributed 18.27 summed seconds to
  recognition preparation plus decoding, 7.62 summed seconds to the
  synchronous recognition backend, and another 7.40 summed seconds to
  detector host work plus cropping.
- That profile is not a stable benchmark. Modal replaced the container between
  repeats, so profiling overhead and a four-repeat warm median are unresolved.
- A synchronous backend interval includes copies, native execution, and
  synchronization. It is not kernel time and does not show which low-level
  operation dominates.

Committed inputs:

- [`a3-profile-analysis-v1.json`](../../evaluation/gpu-spike/a3-profile-analysis-v1.json)
- [`a3-paired-split-result-v1.json`](../../evaluation/gpu-spike/a3-paired-split-result-v1.json)
- [`gpu_a3_stage_profile.py`](../../scripts/evaluation/gpu_a3_stage_profile.py)
- [`gpu_a2_modal.py`](../../scripts/evaluation/gpu_a2_modal.py)

## 3. What is not known

We do not yet know:

1. how much GPU-idle time is caused by host preparation, host scheduling, or a
   small workload that cannot fill the L4;
2. how the opaque detector and recognizer backend intervals divide among
   host-to-device copies, CUDA launches, kernels, device-to-host copies, and
   blocking synchronization;
3. which native CPU functions dominate preprocessing, crop generation,
   postprocessing, or CTC decoding;
4. whether detector and recognizer CUDA work use separate streams and overlap
   in the measured execution, rather than merely having separate configured
   stream objects;
5. whether CUDA launches are numerous and small, copy-bound, or compute-bound;
6. the instrumentation overhead on one stable warm container; or
7. whether Modal permits the required CUPTI and CPU sampling operations in
   this container shape.

`nvidia-smi` utilization cannot answer these questions. Modal documents that
its GPU utilization metric means time with at least one kernel executing; it
does not measure the fraction of FLOPS, memory bandwidth, or SM capacity used.

## 4. Non-goals

This work shall not:

- rerun or restore the rejected Python split;
- change Tiny or Small model weights;
- test FP16, B4/B8/B16/B32, another owner count, another GPU, or multiple GPUs;
- build a new crop queue, CUDA graph, buffer pool, scheduler, service, or
  deployment path;
- move native PDF extraction onto the GPU path;
- qualify Tiny correctness, access the locked holdout, or change the trusted
  output gate;
- optimize the 7 MB Modal result return;
- claim kernel time from Python wall-clock spans;
- run Nsight Compute as a fishing expedition; or
- spend against the expired 2026-08-24 authorization.

The clean performance boundary remains: native PDF evidence is supplied
separately, while the measured GPU path owns page-image input, detection,
crops, recognition, and returned OCR evidence.

## 5. Fixed experiment identity

Every accepted capture uses this identity:

| field | fixed value |
|---|---|
| workload | the 50-page English PDF pinned by [`a2-50page-v1.json`](../../evaluation/gpu-spike/a2-50page-v1.json) |
| model | PP-OCRv6 Tiny detector and recognizer, existing exact hashes |
| runtime | pinned UltraInfer source `ffb64904d23708863ff5b8da312a5cbd52a7f462` plus the committed runtime-lifetime patch |
| backend | ONNX Runtime detection plus TensorRT recognition, both attested |
| precision | FP32 |
| recognition batch | 1 |
| owners | 2 |
| producers | 4 |
| host | 4 physical CPU cores, 24 GiB memory |
| device | one Modal L4; UUID recorded |
| native evidence | the existing content-addressed precomputed artifact |
| output rule | existing trusted, non-escalated scorer; no new correctness rule |

No result is comparable when one of these fields differs.

## 6. Instrumentation architecture

### 6.1 Preserve one execution core

Nsight Systems normally launches the process it profiles. Modal launches the
Function entrypoint for us. Do not copy the page loop into a second benchmark.

Extract the evaluation-only document execution core from
`GpuA2Container.parse_document()` into one callable under
`scripts/evaluation/`. The existing Modal method and a small trace worker must
call that same core. The extraction shall not change production code, the
adopted Modal adapter, the controller protocol, page scheduling, queue bounds,
or result schema.

Before any profiler run, prove the extraction with:

- a thin `parse_document()` delegate whose diff introduces no new algorithm,
  copy, queue, thread, batch, or scheduling decision;
- exact terminal page count and document identity;
- exact deterministic projection;
- the existing trusted-output scorer;
- exact arm, backend, model, batch, owner, and process-tree attestations; and
- an uninstrumented same-container, same-L4-window comparison between the
  ordinary Modal-method invocation and the child-worker invocation. Their
  inner throughput must be within 10%. A larger difference blocks profiling
  because the launch boundary has changed the subject.

The trace worker is launched as a child of `nsys profile`, so Nsight observes
the Python owner and all CUDA work it creates. Node producers remain children
of the same traced process tree. Do not assume that Nsight can attach to the
already-running Modal entrypoint.

### 6.2 NVTX vocabulary

Keep the current Python profiler as the coarse truth source and add one NVTX
domain named `pagespatial.ocr`. Use a small fixed vocabulary:

- `document`;
- `page.decode`;
- `predict.total`;
- `detector.prepare`, `detector.backend`, `detector.postprocess`;
- `crop.generate`;
- `recognizer.prepare`, `recognizer.wait_backend`, `recognizer.backend`,
  `recognizer.decode`; and
- `result.assemble`.

Each page range carries the run ID, page number, owner index, and request ID.
Each recognition range carries crop count and batch ordinal. These identities
must reconcile with the existing result record. Use registered NVTX strings
and matched scoped ranges. Do not annotate sub-microsecond helpers or create a
range per tensor operation.

`recognizer.wait_backend` starts when an owner has a prepared batch and ends
when that owner enters the backend. It observes contention without adding a
queue. At this level, `detector.backend` and `recognizer.backend` remain honest
opaque ranges. Do not invent `h2d`, `kernel`, `d2h`, or `sync` labels in
Python.

If the Python NVTX package is absent, install one exact version in the Modal
image with `.uv_pip_install`; record the package and hash. Nsight Systems
itself is an NVIDIA binary/tool layer, not a pip dependency, and must be
version-pinned separately.

### 6.3 Nsight Systems capture

Run one capability probe before building the full harness. It must record:

- `nsys --version` and CUDA driver/runtime identity;
- whether a trivial child process produces NVTX, CUDA API, memory-copy, and
  kernel events;
- whether CPU sampling and call stacks are permitted;
- whether the report and SQLite export can be copied to retained storage; and
- the exact error when any capability is denied.

The capability check is one bounded probe sequence, not one shell invocation.
A missing package, invalid flag, bad path, or other demonstrated harness error
may be fixed and retried once. A documented platform denial consumes the Modal
attempt and triggers the host fallback in section 11. A second ambiguous or
harness failure stops the probe; it does not authorize open-ended environment
debugging.

For the real run, launch the shared trace worker with CUDA, NVTX, and OS runtime
tracing. Use an NVTX capture range so model loading, TensorRT engine hydration,
and the first warm-up document are outside the measured window. Capture two
fixed 10-page windows in the profiled third document, submitted pages 11--20
and 31--40. Use `--capture-range-end=repeat:2:defer`, or the equivalent syntax
reported by the pinned M0 tool version, so the second NVTX range is honored and
result generation waits until both ranges finish or the child exits. Plain
`stop` is forbidden because Nsight Systems ignores later capture ranges after
the first stop. The child must remain alive for `control-after` and then exit
cleanly. Record every page and companion operation that actually overlaps each
capture; do not discard boundary work.

A window opens when the first page in its numeric target set enters the Python
OCR owner path. It closes only after all ten target pages have completed the
existing page-scoped `result.assemble` event. Record every non-target page and
operation that overlaps the open interval. An incomplete window, or the second
window opening before the first closes, invalidates the run. This rule measures
ten completed target pages rather than ten queued submissions.

Analyze both windows independently before aggregating them. The dominant cause
must select the same section 9 decision-table row in both windows before it can
be named. If the rows disagree, that disagreement is the finding and no
optimization is authorized.

Retain the forward-compatible `.nsys-rep`. Export SQLite only as an analysis
derivative. Generate at least the CUDA API, CUDA GPU trace, kernel summary,
memory-operation summary, and NVTX range reports. The analyzer shall read the
schema it receives instead of assuming all optional tables exist.

### 6.4 Native CPU call stacks

Capture CPU call stacks in a separate warm repeat. Combining every profiler in
one run compounds perturbation and makes the result harder to interpret.

Preferred order:

1. Nsight Systems CPU sampling with DWARF backtraces if permitted and symbols
   resolve adequately;
2. otherwise `perf record` at a bounded sampling frequency with DWARF call
   graphs; and
3. if Modal blocks both, run the exact pinned image on a dedicated Linux x86
   L4 host or VM.

The report must separate on-CPU samples from waiting. A wall-clock frame high
in the stack is not necessarily CPU work. Report unresolved/unknown native
sample weight. If more than 10% of the top-stage on-CPU weight is unresolved,
do not name a low-level CPU function as the bottleneck.

Do not rebuild libraries merely to obtain pretty symbols before trying the
shipped symbols and exported module map. If a symbol-enabled build becomes
necessary, keep optimization flags unchanged, give it a new binary identity,
and prove its unprofiled throughput stays within 10% of the shipped binary.

### 6.5 Conditional UltraInfer markers

Add C++ NVTX ranges to the pinned UltraInfer backend only when the first
Systems trace shows that at least 20% of the captured document wall remains in
an opaque backend range and CUDA correlation cannot divide it.

The maximum useful native vocabulary is:

- input tensor preparation;
- host-to-device copy;
- TensorRT enqueue;
- stream/event synchronization;
- device-to-host copy; and
- output materialization.

Instrument both detection and recognition when both are opaque. Use scoped
RAII ranges so errors cannot leave ranges open. This is an evaluation patch
with its own SHA-256, not a production runtime change.

### 6.6 Conditional Nsight Compute

Nsight Compute becomes eligible only when Systems proves one of these
conditions:

- GPU kernels occupy at least 70% of the steady capture window;
- one kernel family consumes at least 30% of captured document wall; or
- the GPU is continuously busy but throughput remains below the target.

Then profile only the named kernel family and NVTX range with a small metric
set. A dated spend authorization is still required. Record replay count and
overhead. Do not collect the full metric set by default: NVIDIA documents that
metric collection can require replay and that larger sets add overhead.

## 7. Control sequence

One valid measurement lifetime is:

```text
same container, same model objects, same PID, same L4 UUID

1. warm-up document                 not scored
2. unprofiled control document      control-before
3. profiled capture document        trace
4. unprofiled control document      control-after
```

The run is invalid when:

- the container, owner PID, L4 UUID, model, backend, or arm changes;
- either control has a failed/missing page;
- the cold pattern is not exactly `[true, false, false, false]`;
- control-before and control-after inner throughput differ by more than 10%;
- the trace lacks CUDA, NVTX, or required identity events;
- captured page, detector-call, recognition-call, crop, or batch counts do not
  reconcile; or
- any profiler error is silently converted to an empty metric.

Profiler overhead is:

```text
trace document wall / median(control-before, control-after) wall - 1
```

Report it. Never use the profiled document's throughput as the uninstrumented
performance claim. If overhead exceeds 15%, shorten the capture window once.
If it still exceeds 15%, the timeline remains qualitative and every duration
claim must be taken from the bracketing controls.

The one allowed retry uses submitted pages 11--15 and 31--35 with the same
completion rule. No other page range may be selected after seeing the trace.

## 8. Required attribution

CPU threads, CUDA APIs, copy engines, and GPU kernels can run at the same time.
Do not combine them into one 100% pie chart. Use the same capture start/end as
the denominator, then publish three correlated views.

### 8.1 GPU timeline

Partition the capture interval by the union of CUDA activity attributed to the
traced PageSpatial process:

1. detector kernels;
2. recognizer kernels;
3. host-to-device copies;
4. device-to-host copies;
5. other identified device work; and
6. no PageSpatial device activity.

Kernel and copy engines can overlap. Report their individual service totals
and their occupied union; do not double-count their overlap as wall time.
Divide no-PageSpatial-device-activity gaps into:

- at least one owner is inside `recognizer.wait_backend`;
- no recognition batch is ready and owners are in a named preparation,
  detector, crop, decode, or assembly stage; and
- unattributed.

This is correlation, not proof of causation. On shared hardware, an absence of
events from our process does not prove the physical L4 was idle; another CUDA
context can run outside the trace. Record GPU context-switch evidence when the
host permits it. Otherwise use the phrase **no PageSpatial device activity**,
never **GPU idle**, and keep Modal/device-wide samples as a separate signal.
The report names the exact ranges used for each classification.

### 8.2 CPU timeline

For each relevant owner/producer thread, report sampled or scheduled time as:

1. running on CPU inside a named stage;
2. runnable but not scheduled;
3. blocked/waiting; and
4. unresolved or unattributed.

Publish summed CPU service time and each thread's share. Do not divide summed
CPU time by document wall and call the result latency.

### 8.3 Named-stage timeline

For each NVTX stage, report:

- summed service time;
- occupied wall union;
- call count, median, p95, and maximum duration;
- owner/thread identities; and
- contained CUDA API, copy, and kernel events.

Service times for two owners may overlap and may exceed document wall.
**Occupied wall union** answers how much elapsed time touched a stage;
**summed service time** answers how much owner work occurred.

Never add overlapping CPU and GPU categories and call the result wall time.
Never call a synchronous backend span GPU occupancy.

## 9. Decision table

| measured dominant cause | smallest allowed next experiment |
|---|---|
| CPU crop/resize or recognizer preparation | optimize or parallelize that one native/array operation; no scheduler rewrite |
| host-to-device copies | reuse bounded buffers or test pinned host memory for that tensor only |
| device-to-host copies | reduce or defer that exact output transfer |
| blocking synchronization between small launches | one native asynchronous enqueue/event experiment on one stream plan |
| many tiny kernels with repeated launch gaps | one CUDA Graph or fusion feasibility check, only for the named stable shape |
| detector blocks recognizer while streams are idle | one native cross-page detector/recognizer overlap experiment |
| CTC/result decode dominates CPU | vectorize or move that exact decode path; keep crop order and output mapping |
| kernels dominate and L4 is saturated | Nsight Compute on the dominant kernel; only then reconsider precision or GPU |
| GPU idle although batches are available | inspect runtime/stream serialization before adding producers |
| no prepared batches during GPU gaps | improve the named producer stage; do not enlarge recognition batch blindly |
| no removable cause reaches 20% of warm wall | stop; CPU/Small remains the simplest production path |

The next implementation may change one row only. It must have a predeclared
complete-document keep bar of at least 10% inner throughput improvement and no
new incorrect, missing, or unresolved critical value in trusted,
non-escalated output.

The analyzer may select a row only when one row's stated condition is met and
the same row is selected independently in both Systems windows. When two rows
remain plausible, their thresholds tie, or required evidence is missing, the
machine result is `ambiguous-stop`. A later reviewed decision record may
interpret the retained evidence, but M2 must not encode a subjective tie-break.

## 10. Artifacts and provenance

Every remote attempt, including a failed capability probe, records:

- git revision and dirty state;
- Modal app, Function, container, and GPU identities;
- image/package/runtime/model/patch identities;
- exact command and profiler configuration;
- workload and native-evidence SHA-256;
- start/end UTC timestamps and result state;
- raw `.nsys-rep` SHA-256 and byte count;
- exported SQLite and report hashes;
- CPU profile and symbol-map hashes, when present;
- control and trace results with their hashes;
- inner complete-document and full-result client rates, plus the measured
  `result.assemble` interval and the external response gap derived from the
  existing response probe;
- reconciliation counts; and
- a visible limitations array.

Raw traces can contain process arguments, paths, and document-derived sizes.
Store them with the existing private qualification evidence, not in the npm
package or a public repository. Commit only compact summaries and a manifest
that pins the private archive by SHA-256. A hash detects change; it does not
make storage immutable.

## 11. Cost and host fallback

No paid execution is authorized by this design. Before the capability probe,
record a new dated owner budget and a fixed worst-case reservation. The expired
2026-08-24 ledger must not be reopened or edited to manufacture headroom.

Use Modal first because it is the deployment host under investigation. The
bounded retry rule in section 6.3 applies. If CUPTI, process launch, trace
export, or native CPU sampling is blocked by the platform, do not spend a day
bypassing the container boundary. Run the exact image and L4 shape on a
dedicated Linux x86 host or VM, and label it a different host control. Re-run
one unprofiled Modal control beside it before transferring a conclusion.

For the 2026-08-25 GCP host control, the owner explicitly permits temporary
external SSH access on only
`pagespatial-gpu-profiler-20260825`. The project account lacks IAP tunnel
authorization, and IAM or firewall mutation is out of scope. The owner must
prove the VM starts and ends `TERMINATED` with no access configuration. Inside
the protected lifetime it may attach one exact ephemeral `external-nat`
configuration, use direct SSH/SCP with the existing OS Login key and pinned
host key, then stop the VM and remove that configuration in mandatory cleanup.
The project has an existing world-reachable SSH rule, so this is a deliberate,
time-bounded public port-22 exposure. Do not run a public service, create or
refresh keys, or mutate any other GCP resource.

After `RUNNING`, wait up to three minutes for `sshd` with a read-only `true`
probe. Connection refusal is boot readiness and may retry; a host-key or
identity error fails immediately. Every failed owner attempt gets a unique
cleanup directory. If an M2 bundle fails at this access-only boundary before
upload or build, that already-counted bundle may be reopened exactly once.
Keep its prior completion in retry history and do not add a new $30
reservation or reduce recorded exposure.

The OS Login user is not a member of the Docker group. Run the fixed host owner
through non-interactive `sudo -n`; do not mutate users, groups, socket modes, or
the Docker service. The host owner remains responsible for its bounded sysctl,
container cleanup, and evidence permissions.

No additional global economic overturn threshold applies. The owner has
decided that a real saving is material at the expected million-page scale.
The evidence gates still prevent drift: a removable cause must reach 20% of
warm wall, and each optimization must improve inner complete-document
throughput by at least 10% without violating the output gate.

## 12. Milestones and pull requests

### M0 — capability, no pipeline refactor

- pin the profiler tool identity;
- prove NVTX plus CUDA trace on a trivial child process;
- probe CPU sampling and artifact export;
- write the result, including a clean unsupported verdict; and
- stop if both Modal and the fallback host are unavailable.

### M1 — shared core and coarse ranges

- extract one evaluation-only execution core used by the existing A2 method
  and the trace worker;
- add the fixed NVTX vocabulary;
- prove exact output/provenance parity and less than 10% unprofiled drift; and
- add analyzer mutation tests for missing events and bad reconciliation.

### M2 — two Systems windows and one CPU capture

- run the fixed four-call lifetime;
- capture and analyze both fixed 10-page Systems windows;
- persist the raw and derived artifacts;
- produce the wall-union, service-time, CUDA, CPU, and unattributed tables; and
- require both windows to select the same decision-table row, then name the
  largest removable cause or stop.

### M3 — conditional native visibility

- add the six bounded UltraInfer markers only if the backend remains opaque;
- repeat one capture, not the whole A2 grid; and
- update the attribution and decision.

### M4 — conditional kernel analysis

- run Nsight Compute only if section 6.6 triggers it;
- inspect only the named kernel family; and
- decide one optimization or close the workstream.

Each implementation PR gets a cold adversarial review. The design PR contains
no instrumentation code and does not itself start M0.

## 13. Acceptance checklist

The measurement closes only when:

1. the traced process is the same execution core used by the unprofiled A2
   method;
2. one stable warm lifetime passes every identity and control rule;
3. NVTX, CUDA API, copy, kernel, synchronization, and CPU evidence are present
   or explicitly unsupported;
4. counts reconcile exactly and mutation tests prove the analyzer can fail;
5. profiler overhead and unresolved symbol weight are reported;
6. overlapping service time is never presented as wall time;
7. named stages cover at least 80% of owner `predict()` wall, GPU activity plus
   classified GPU gaps covers the complete GPU capture interval, and unknown
   CPU sample weight is reported; otherwise the unattributed remainder is the
   blocker;
8. correctness remains visibly separate from performance;
9. raw artifacts are retained and integrity-pinned; and
10. both Systems windows choose the same decision-table row, or their
    disagreement is reported and the workstream stops.

## 14. References

### Project

- [GPU spike design](2026-08-24-gpu-ocr-spike.md)
- [GPU trial](../trials/2026-08-24-gpu-ocr-spike.md)
- [GPU A3 issue #97](https://github.com/oneryalcin/pagespatial/issues/97)
- [Current Python-visible profiler](../../scripts/evaluation/gpu_a3_stage_profile.py)
- [Current A2 Modal harness](../../scripts/evaluation/gpu_a2_modal.py)
- [Current A2 controller](../../scripts/evaluation/gpu_a2_controller.mjs)
- [Pinned UltraInfer TensorRT source](https://github.com/PaddlePaddle/PaddleX/blob/ffb64904d23708863ff5b8da312a5cbd52a7f462/deploy/ultra-infer/ultra_infer/runtime/backends/tensorrt/trt_backend.cc)

### Primary external documentation

- [NVIDIA Nsight Systems User Guide](https://docs.nvidia.com/nsight-systems/UserGuide/)
- [NVIDIA Nsight Systems post-collection analysis and SQLite schema](https://docs.nvidia.com/nsight-systems/AnalysisGuide/)
- [NVIDIA Nsight Compute documentation](https://docs.nvidia.com/nsight-compute/)
- [NVIDIA Nsight Compute profiling guide](https://docs.nvidia.com/nsight-compute/ProfilingGuide/index.html)
- [Modal GPU metrics](https://modal.com/docs/guide/gpu-metrics)
- [Modal profiling example and trace retention](https://modal.com/docs/examples/torch_profiling)
- [Modal CUDA guide](https://modal.com/docs/guide/cuda)

Tool behavior and platform support can change. M0 records the versions and
capabilities actually observed; this document does not promote vendor
documentation into measured PageSpatial behavior.

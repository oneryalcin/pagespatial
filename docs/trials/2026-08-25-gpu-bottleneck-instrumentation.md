# Trial: GPU bottleneck instrumentation

**Status:** M0 through M3 measured. M2 selects `producer-starvation`. M3
identifies TensorRT enqueue and device-to-host transfer as the largest named
recognizer costs, but fails its 80% visibility gate at 78.67%. The bounded
B8/O2 follow-up is complete and rejects B8: it is 12.7% slower than B1/O2.

**Date:** 2026-08-25

**Design:** [GPU bottleneck instrumentation](../design/2026-08-25-gpu-bottleneck-instrumentation.md)

## Modal result

Do not run the planned Nsight Systems measurement on the tested Modal container
shape.

The retained third capability attempt generated an `.nsys-rep` and exported a
valid SQLite database with 948 events. It contained 891 OS-runtime events but
zero NVTX, CUDA API, CUDA kernel, or CUDA memory events. Nsight diagnostics
said that no NVTX or CUDA events were collected. The profiled command returned
139 before its target wrote application output. Whether the target process or a
profiler component emitted 139 is unclassified. This result applies to the
fixed Modal L4/gVisor container, Nsight Systems 2025.5, and Paddle CUDA 11.8
target. It does not establish that every Modal image or Nsight version fails.

Modal also cannot provide the separate native CPU profile. `nsys status -e`
reported that gVisor rejects `perf_event_open`, both sampling triggers fail,
and the process-tree and system-wide CPU profiling environments are
unsupported.

This is a capability result, not a bottleneck result. No claim about GPU idle
time, kernel time, copies, synchronization, or a dominant PageSpatial stage is
authorized from the Modal attempt.

## Modal attempts

| attempt | source | outcome | evidence |
|---|---|---|---|
| 1 | `da5f2f2` | harness error | the combined trace requested a CPU sampler after Modal denied `perf_event_open`; command returned 139 |
| 2 | `d1f8471` | harness error | sampling disabled; Nsight printed that it generated a report, but the harness discarded it because the command returned 139 |
| 3 | `b7e7c79` | platform unsupported | owner-approved bounded retry; report and SQLite retained; export succeeded; required NVTX/CUDA events absent |

The compact machine-readable result is
[`m0-capability-result-v1.json`](../../evaluation/gpu-instrumentation/m0-capability-result-v1.json).
It pins all raw-result, report, SQLite, tool, app, and reservation identities.
Raw artifacts stay under the ignored private `.evaluation/` tree.

## GCP host fallback

The host fallback passed the capability gate on a Google Compute Engine
`g2-standard-8` VM in `us-central1-a`. The VM exposed exactly four physical
Cascade Lake cores as eight logical threads, one full NVIDIA L4, and 32 GiB of
memory. The measured workload container was capped to the design's 24 GiB.
The VM used the pinned Ubuntu 22.04 accelerator image and NVIDIA 580 driver.

The probe container used the same pinned Paddle CUDA 11.8 base, Nsight Systems
package and hash, NVTX version, and probe child as the Modal attempt. It ran
privileged with Docker's seccomp restriction removed. The guest set
`kernel.perf_event_paranoid=-1`; this is isolated experiment configuration, not
a production requirement.

Both bounded traces completed normally and exported valid SQLite databases:

| evidence | observed events |
|---|---:|
| NVTX | 4 |
| CUDA API | 875 |
| CUDA kernels | 28 |
| CUDA memory copies | 1 |
| CPU sample events / callchains | 1,668 |
| sampled callchain frames | 10,712 |
| scheduler events | 612 |

`nsys status -e` reported `perf_event_open` and the sampling trigger as `OK`,
with both process-tree and system-wide CPU profiling supported. KVM does not
expose the hardware PMU counters used by `perf stat`, but software-event CPU
sampling and callchains work. That is sufficient for the native flamegraph in
the design.

The compact host result is
[`m0-gcp-host-capability-result-v1.json`](../../evaluation/gpu-instrumentation/m0-gcp-host-capability-result-v1.json).
It pins the host, image, driver, GPU UUID, tool versions, event counts, raw
artifact sizes, and SHA-256 values. It also pins the host-identity, profiler
capability, and read-only GCP instance snapshots that support the host-shape and
isolation claims. Raw evidence remains in the ignored private `.evaluation/`
tree.

The first host run used the recorded final Docker image ID, but its source
Dockerfile selected the Paddle base by mutable tag and selected NVTX by version.
After review, the reproduction Dockerfile pinned the recorded Paddle digest and
required the recorded NVTX wheel hash. This improves future reproduction; it
does not retroactively claim that the historical image was built from the
amended Dockerfile.

## M1 shared-core parity

M1 passed on the unprofiled Modal deployment host at source revision
`9962f96427acc2101bc340c7aa84acc29c31353e`. The fixed arm was Tiny, FP32,
recognition batch 1, four render producers, two inference owners, four physical
CPU cores, 24 GiB, and one L4. The ordinary method and the child trace worker
used the same `gpu_a2_modal.A2ExecutionCore`.

| measurement | result |
|---|---:|
| ordinary control before | 2.3653 pages/s |
| ordinary control after | 2.3898 pages/s |
| ordinary bracket mean | 2.3776 pages/s |
| shared child, warm | 2.3472 pages/s |
| control-bracket drift | 1.03% |
| launch-boundary drift | 1.28% |
| maximum allowed drift | 10% |

The deterministic projection was exact. The ordinary null repeat and the
shared child each differed by one critical token and one raw OCR line from the
control. Both equal the derived null tolerance, so the predeclared output gate
passed. This is a parity result, not Tiny production qualification.

The first attempt, app `ap-oyXNUPBwRhZBYr3qTwf7tq`, failed before child parse.
Operator-observed console output showed that when a plain child process imported
the copied Modal source, `modal.is_local()` was true and the import entered the
local budget path. It raised `ModuleNotFoundError` for
`gpu_instrumentation_budget`. That console log was not retained; the pinned
failed-attempt artifact is the invocation manifest. The fix gives copied
`/root` and `/app` source paths a remote-import context and prevents budget,
repository-path, and real image-build work in the child. The full suite and
Linux CI passed before the retry.

The successful retry used app `ap-nov49mC4hCDTdeO9vBcRK8` and container
`ta-01M0VCHGSZGDZGBD7W2S7E4ZJR`. The exact app stopped with zero tasks.
Operator-observed console output showed PaddleX downloading `simfang.ttf`
during cold initialization. That console log was not retained. The event was
before the measured bracket, so it is not part of the reported OCR rate; bake
the font into the image if this runtime advances.

The compact result is
[`m1-parity-result-v1.json`](../../evaluation/gpu-instrumentation/m1-parity-result-v1.json).
It pins the failed and successful attempts, source, workload, model/runtime,
device, cleanup, parity verdict, and every private result artifact by byte count
and SHA-256. The private records remain under the ignored `.evaluation/` tree.

## Modal analyzer correction

The first derived Modal result falsely marked CPU samples and scheduling events
as present because it matched the non-empty `ENUM_SAMPLING_THREAD_STATE` and
`ENUM_SCHEDULING_THREAD_BLOCK` schema tables. Those rows define values; they
are not captured events. The analyzer now excludes `ENUM_` tables. The
corrected result is CPU sampling `false` and CPU context-switch trace `false`.

## M2 result in plain English

In both profiled windows, PageSpatial's traced CUDA context has long intervals
with no PageSpatial device activity while named host preparation runs. OCR
kernels do not occupy most of either perturbed trace window.

In both retained trace windows, PageSpatial GPU work occupies a small part of
the window. Most of each gap overlaps named host preparation. Recognition
decode is also substantial. Copies and TensorRT kernels are present, but they
are not the largest measured cause.

This result does **not** identify one C++ function to optimize. The CPU sample
profile leaves 77.25% of leaf samples unresolved, and 94.06% of the dominant
`recognizer.backend` stage unresolved. The next justified measurement is the
design's bounded M3 native visibility pass. It must split the opaque backend
into its existing low-level phases before any scheduler rewrite or larger GPU
test.

## M2 measured unit

- Host: `pagespatial-gpu-profiler-20260825`, `us-central1-a`.
- GPU: NVIDIA L4, UUID
  `GPU-447307de-e52e-e2fa-4099-9bd9e2b01260`, driver `580.173.02`,
  23,034 MiB.
- Container image ID:
  `sha256:522688d5325ee4d6096e9152931b02476fe5190ea2d8907998e8fbb04d82bffc`.
- Workload: one 50-page document, Tiny, recognition B1, two inference owners.
- PDF SHA-256:
  `46ba5fc15613a260cf019ff6f9be0bb579279be4f5892694a76e02a536d8fcda`.
- Native-evidence SHA-256:
  `8e1f5bf2bc2b8a45b5c1cf6699fa275a6a4199acb0f9e308d7183d12ce7f10ef`.
- Nsight Systems: `2025.5.1.121`.
- Host measurement: 11:20:10Z to 11:29:52Z.

The host manifest names base revision `4548f31`. Live debugging then fixed the
runtime faults listed below without restarting the expensive native build from
zero. The measured image was assembled through live-debug layers whose exact
layer history was not retained. The image ID identifies the measured binary
identity. The branch commit containing this trial is a future clean-archive
rebuild recipe; it is not presented as the source identity of the measured
image.

## M2 control bracket

| lifetime | warm-up | control before | traced call | control after | control drift | profiler overhead |
|---|---:|---:|---:|---:|---:|---:|
| Systems, pages/s | 1.982 | 2.073 | 1.157 | 2.028 | 2.22% | 77.24% |
| CPU sampling, pages/s | 2.040 | 2.127 | 1.021 | 2.145 | 0.85% | 109.24% |

Both lifetimes have the required cold/warm pattern, one stable worker PID,
and controls within 10%. Both profilers exceed the 15% overhead limit.
Therefore, traced interval durations are **diagnostic structure**, not
production timing or cost numbers.

## M2 Systems evidence

| evidence | window 1 | window 2 |
|---|---:|---:|
| capture wall | 5,970.9 ms | 5,397.9 ms |
| named-stage coverage | 99.80% | 99.79% |
| PageSpatial device activity | 900.0 ms | 855.9 ms |
| no PageSpatial device activity | 5,070.9 ms | 4,541.9 ms |
| named preparation during device gaps | 4,989.1 ms | 4,471.9 ms |
| selected row | `producer-starvation` | `producer-starvation` |

These values describe the profiled windows only. They do not prove the
physical L4 was globally idle, and they must not be projected as unprofiled
percentages. They do prove the same qualitative structure twice: when this
PageSpatial CUDA context has no device event, named host preparation covers
nearly all of the gap. The selection is not a kernel-saturation result.

The analyzer reports CPU preparation and recognition decode as material
secondary candidates in both windows. Host-to-device and device-to-host copies
are not the leading row. Blocking backend wait is below one percent in both
traced windows.

## M2 CPU evidence

The CPU capture retained 28,770 samples. The most visible resolved leaves are
NumPy `argmax`, NumPy maximum/copy/cast operations, Python evaluation, Poppler
rendering, locks, and allocation. This is useful direction, but it is not
enough to name a surgical target:

- unresolved leaf samples: 77.25%;
- dominant named stage: `recognizer.backend`;
- unresolved leaves inside that stage: 94.06%;
- `mayNameLowLevelFunction`: false.

No Nsight Compute run is justified. Kernels are not the measured dominant
cause. This trace does not predict another GPU's behavior.

## M2 correctness

The strict raw-equivalence diagnostic fails: two critical-token occurrences
and four raw-line positions differ from the control, against a zero null
tolerance. The product safety gate passes under the owner-approved rule:

- deterministic native projection is exact;
- the trace introduces zero candidate-only critical values;
- page 31 drops a low-confidence OCR `5` (`0.2627`);
- page 49 changes a low-confidence OCR `5` (`0.2903`) to `S` (`0.8948`);
- native observations and conflict records are unchanged;
- page 31 retains a blocking critical-token conflict;
- page 49 has only an advisory low-confidence reason, but remains escalated
  and `untrusted-document-content`;
- both candidate pages remain non-trusted; and
- no difference occurs on a trusted, non-escalated page.

The raw evidence remains retained. The pass means that no new incorrect,
missing, or unresolved critical value entered trusted output. It does not mean
the OCR bytes were identical.

## M2 implementation corrections

The live measurement exposed runtime faults that the simulated tests missed:

1. Docker's root ignore file excluded every evaluation input. A
   Dockerfile-specific path allowlist now supplies the required trees and
   files. The GCP owner always builds from `git archive`, so untracked files
   cannot enter that context; the private `.evaluation` tree remains excluded.
2. The pinned NVTX Python API requires raw strings at `start_range`; passing a
   pre-registered object fails at runtime.
3. Nsight `repeat:2` writes two numbered reports. The runner now exports and
   analyzes both before choosing a decision row.
4. The CUDA compiler existed at `/usr/local/cuda/bin/nvcc` but was hidden by
   the image `PATH`; the build now pins `CUDACXX` directly.
5. The HPI convenience installer tried to download a redundant prebuilt
   UltraInfer package. The image installs only the pinned build dependencies.
6. The result reader now decodes UTF-8 explicitly.
7. Interval subtraction is linear rather than quadratic, so retained trace
   analysis finishes in about one minute instead of stalling.

`uv` was not substituted into the completed image build. The expensive time
was native UltraInfer compilation and TensorRT engine creation, not Python
package resolution. Changing the installer would have invalidated a working
cached layer without improving the measured path.

## M2 decision and next experiment

M2 closes. The smallest justified continuation is M3 from the design:

1. add only the six bounded native markers around the existing UltraInfer
   input preparation, H2D, execute, D2H, synchronization, and output decode
   phases;
2. capture one fixed window on the same Tiny B1/O2 unit;
3. require at least 80% of the opaque backend to receive a stable name; and
4. only then select one unprofiled A/B optimization with the existing 10%
   complete-document keep bar.

Do not test H100, enlarge recognition batches, add more producers, or rewrite
the scheduler yet. M2 selects the `producer-starvation` row for the traced
PageSpatial context, but it does not yet say which native operation should be
removed.

## M3 native TensorRT result

M3 measurement completed on the same Tiny, FP32, recognition-B1, four-producer,
two-owner L4 shape. The output correctness gate passed, the controls differed
by only 0.59%, and the same worker served all four calls. The trace added 50.30%
overhead, so its durations are diagnostic structure, not production throughput.

The detector uses ONNX Runtime. The recognizer uses TensorRT. The first analyzer
incorrectly required TensorRT markers under both roles. The corrected analyzer
requires native TensorRT coverage only for roles whose retained backend
attestation says `tensorrt`.

| recognizer phase | calls | occupied time | recognizer share | mean per call |
|---|---:|---:|---:|---:|
| TensorRT enqueue | 1,348 | 1,129.94 ms | 48.27% | 838.23 us |
| device to host | 1,348 | 538.87 ms | 23.02% | 399.75 us |
| host to device | 1,348 | 132.60 ms | 5.66% | 98.37 us |
| input preparation, excluding nested H2D | 1,348 | 19.58 ms | 0.84% | diagnostic aggregate |
| synchronize | 1,348 | 11.19 ms | 0.48% | 8.30 us |
| output materialization | 2,696 | 9.27 ms | 0.40% | 3.44 us |
| unattributed PaddleX runner wrapper | - | 499.26 ms | 21.33% | - |

The TensorRT recognizer occupied 2,340.71 ms of the 10-page capture. The six
native phases cover 78.67% of that parent range. This misses the predeclared
80% gate by 1.33 percentage points, so the formal M3 verdict is **FAIL:
insufficient native visibility**. The threshold was not relaxed after seeing
the result.

This failure does not erase the measured structure. At B1, the recognizer made
1,348 inference calls for 10 pages, or 134.8 calls per page. TensorRT enqueue is
the largest named cost. Device-to-host transfer is the second. Together they
occupy 71.30% of the recognizer parent. The leading performance hypothesis is
therefore fewer, larger recognizer calls, tested with a bounded B8 lane. It is
a hypothesis, not an adoption decision: the 21.33% PaddleX runner remainder
must remain visible, and profiled timings must not be quoted as production
speed.

The first retained profiler attempt failed before capture because the shared
core allowed only `m2.*` capture names. Commit `d7ff1ec` adds the exact
`m3.native.capture` name. The successful measurement bind-mounted that one
committed Python file over cached image
`sha256:3514d9e0da6d4b045907370e5025e184d51d556854c7c696274f53a5adff6138`.
Native UltraInfer and TensorRT binaries were unchanged. The capture-fix file
SHA-256 is
`76b0598034a65a5889f38513c73b34367e035318ea9e5cb0a0398420dbf587cf`.

The compact result is
[`m3-gcp-l4-summary-2026-08-25.json`](../../evaluation/gpu-instrumentation/m3-gcp-l4-summary-2026-08-25.json).
It pins the measured unit, backend split, timings, formal failure, source and
image identities, correctness, raw evidence hashes, and cleanup. Raw evidence
stays under the ignored private `.evaluation/` tree.

## B8 with two owners: batching hypothesis rejected

M3 observed 134.8 B1 recognizer calls per captured page. The smallest direct
test was therefore Tiny FP32 B1 versus B8 with the same two inference owners.
The comparison used the same cached image, dedicated GCP L4 VM, frozen 50-page
document, four producers, and no profiler. The lifetime order was B1, B8, B8,
B1. Each fresh container ran one warm-up and three measured documents.

| lifetime | warm pages/s | median |
|---|---|---:|
| B1 A | 2.476, 2.473, 2.515 | 2.476 |
| B8 A | 2.133, 2.170, 2.141 | 2.141 |
| B8 B | 2.097, 2.084, 2.096 | 2.096 |
| B1 B | 2.342, 2.375, 2.367 | 2.367 |

The pooled median is 2.424 pages/s for B1 and 2.115 pages/s for B8. B8 is
12.7% slower. Both independent lifetime comparisons agree: B8 is 13.5% and
11.5% slower. The treatment was real: 3,553 of 3,834 observed recognition
batches were full batches of eight (92.7%). Median GPU utilization fell from
16.0% at B1 to 11.75% at B8, while peak memory rose from 1,390 MiB to
1,566 MiB.

Trusted output passes all four cross-arm comparisons under the accepted product
gate. Raw equivalence does not pass: cross-arm comparisons differ by 6-8
critical tokens and 57-61 raw lines, above the same-arm null tolerance of two
tokens and four lines. These differences remain on non-trusted pages and do not
create an incorrect, missing, or unresolved critical value in trusted output.

Each fresh container spent about 269-278 seconds building its TensorRT engine.
That startup is reported separately and is not included in the warm document
rates. The VM ran for 1,701 seconds; posted billing is not yet available.

**Decision:** keep B1 with two owners. Recognition batch size is closed as a
throughput lever for this architecture. This result does not trigger M4 kernel
analysis, and there is no automatic M5. A new optimization requires a separate,
specific hypothesis.

The compact result is
[`b8-o2-gcp-summary-2026-08-25.json`](../../evaluation/gpu-instrumentation/b8-o2-gcp-summary-2026-08-25.json).
Raw results remain under the ignored private `.evaluation/` tree and are pinned
by SHA-256 in that summary.

## Spend, evidence, and cleanup

At the successful M1 reservation snapshot, posted Modal instrumentation spend
was `$0.30717691`. This was not a closed billing interval. The retained budget
ledger continues to treat incomplete billing conservatively. GCP billing for
the host has not posted into the project record, so this trial does not invent
an actual cost. The work remained inside the owner's $130 ceiling.

All five exact Modal apps were stopped with zero tasks:

- `ap-YUWekHlpnKTfOSBGebuNbm`;
- `ap-kh3ORTuip6RcmCr73sEggn`;
- `ap-aPx94y7VW1rS8cKGHRh7Ix`;
- `ap-oyXNUPBwRhZBYr3qTwf7tq`; and
- `ap-nov49mC4hCDTdeO9vBcRK8`.

The private M2 archive is
`.evaluation/gpu-instrumentation/2026-08-25/m2-gcp-l4-live-run4.tar.zst`:

- bytes: 116,645,234;
- SHA-256:
  `bf88f2610dacae8e73a0734ca9a0d0a8f8e5f21890f0dd0c8cd5f53f1dbaf083`;
- combined analysis SHA-256:
  `a7ed87d58c9854686e73d85f275e476249ec28be6fbfcca59c115776bb344296`.

The committed compact summary is
[`m2-gcp-l4-summary-2026-08-25.json`](../../evaluation/gpu-instrumentation/m2-gcp-l4-summary-2026-08-25.json).
The raw archive is private and ignored by Git.

The final read-only GCP state is retained in
[`m2-gcp-l4-cleanup-2026-08-25.json`](../../evaluation/gpu-instrumentation/m2-gcp-l4-cleanup-2026-08-25.json),
SHA-256
`e088f20bb205d4d16bf189825ac9f430dce65dbbddc84d98be5d641cfa612172`.

After all artifacts were copied and hash-verified, the temporary external
access configuration was removed. The exact VM reached `TERMINATED` with zero
access configurations, zero GPU processes remained after the run, and the
proposed `pagespatial-gpu-profiler-20260825-b` fallback VM did not exist.

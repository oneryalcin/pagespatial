# Trial: GPU bottleneck instrumentation

**Status:** M0 and M1 complete; the tested Modal container shape cannot collect
the required trace, the GCP full-VM fallback supports it; M2 not started

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
authorized.

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
memory. The measured workload container will be capped to the design's 24 GiB.
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
Operator-observed console output showed that when a plain child process imported the copied Modal source,
`modal.is_local()` was true and the import entered the local budget path. It
raised `ModuleNotFoundError` for `gpu_instrumentation_budget`. That console log
was not retained; the pinned failed-attempt artifact is the invocation manifest.
The fix gives
copied `/root` and `/app` source paths a remote-import context and prevents
budget, repository-path, and real image-build work in the child. The full suite
and Linux CI passed before the retry.

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

The first derived Modal result falsely marked CPU samples and scheduling events as
present because it matched the non-empty `ENUM_SAMPLING_THREAD_STATE` and
`ENUM_SCHEDULING_THREAD_BLOCK` schema tables. Those rows define values; they
are not captured events. The analyzer now excludes `ENUM_` tables. The
corrected result is CPU sampling `false` and CPU context-switch trace `false`.

## Spend and cleanup

At the successful M1 reservation snapshot, posted instrumentation spend was
`$0.30717691`. This is not a closed billing interval. Three fixed `$5` M0
reservations and two fixed `$10` M1 reservations remain charged as `$35`
conservative exposure under the `$100` owner ceiling. The first M1 reservation
includes the failed child-import attempt; the second includes the successful
retry and its image rebuild.

All three exact Modal apps were stopped with zero tasks:

- `ap-YUWekHlpnKTfOSBGebuNbm`;
- `ap-kh3ORTuip6RcmCr73sEggn`; and
- `ap-aPx94y7VW1rS8cKGHRh7Ix`.

Both M1 apps were also stopped with zero tasks:

- `ap-oyXNUPBwRhZBYr3qTwf7tq`; and
- `ap-nov49mC4hCDTdeO9vBcRK8`.

The GCP VM was created without a service account or API scopes, with project
SSH keys blocked, automatic restart disabled, and a six-hour shutdown guard.
London and Belgium requests failed for lack of capacity and created no
resources. The successful US VM was stopped after the evidence was copied
back. Its auto-delete boot disk is retained only to reuse the downloaded image
layers for M1. GCP billing is not yet final; the committed result records the
published hourly pricing basis and does not present an estimate as billed
cost.

## Decision

M1 closes the shared-core and deployment-host transfer-control gate. It does
not authorize a bottleneck claim. Before M2, the exact shared core must be
reproduced on the dedicated GCP L4 host with the workload container capped to
four physical cores and 24 GiB. M2 then runs the unprofiled controls and both
fixed trace windows in one bounded host lifetime. The passed Modal M1 bracket
is the contemporaneous deployment-host control for transferring a GCP finding.

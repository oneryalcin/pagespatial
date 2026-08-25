# Trial: GPU bottleneck instrumentation

**Status:** M0 complete; the tested Modal container shape is unsupported, the
GCP full-VM fallback supports the required trace; M1 and M2 not started

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
| sampled CPU callchains | 10,712 |
| scheduler events | 612 |

`nsys status -e` reported `perf_event_open` and the sampling trigger as `OK`,
with both process-tree and system-wide CPU profiling supported. KVM does not
expose the hardware PMU counters used by `perf stat`, but software-event CPU
sampling and callchains work. That is sufficient for the native flamegraph in
the design.

The compact host result is
[`m0-gcp-host-capability-result-v1.json`](../../evaluation/gpu-instrumentation/m0-gcp-host-capability-result-v1.json).
It pins the host, image, driver, GPU UUID, tool versions, event counts, raw
artifact sizes, and SHA-256 values. Raw `.nsys-rep` and SQLite files remain in
the ignored private `.evaluation/` tree.

## Analyzer correction

The first derived result falsely marked CPU samples and scheduling events as
present because it matched the non-empty `ENUM_SAMPLING_THREAD_STATE` and
`ENUM_SCHEDULING_THREAD_BLOCK` schema tables. Those rows define values; they
are not captured events. The analyzer now excludes `ENUM_` tables. The
corrected result is CPU sampling `false` and CPU context-switch trace `false`.

## Spend and cleanup

At the final status snapshot, posted instrumentation spend was `$0.03867405`.
This is not a closed billing interval. Three fixed `$5` reservations remain
charged as `$15` conservative exposure under the `$100` owner ceiling.

All three exact Modal apps were stopped with zero tasks:

- `ap-YUWekHlpnKTfOSBGebuNbm`;
- `ap-kh3ORTuip6RcmCr73sEggn`; and
- `ap-aPx94y7VW1rS8cKGHRh7Ix`.

The GCP VM was created without a service account or API scopes, with project
SSH keys blocked, automatic restart disabled, and a six-hour shutdown guard.
London and Belgium requests failed for lack of capacity and created no
resources. The successful US VM was stopped after the evidence was copied
back. Its auto-delete boot disk is retained only to reuse the downloaded image
layers for M1. GCP billing is not yet final; the committed result records the
published hourly pricing basis and does not present an estimate as billed
cost.

## Decision

M0 does not authorize M1 or M2 on Modal. The GCP full-VM fallback supports the
required CUDA, NVTX, OS-runtime, scheduler, and CPU evidence, so M1 is now
authorized on that host. M1 must reproduce the complete A2 image, cap the
container to four physical cores and 24 GiB, extract the shared execution core,
and pass the unprofiled launch-boundary parity gate before M2 can begin. One
unprofiled Modal control remains required before a GCP bottleneck conclusion is
transferred to the deployment host.

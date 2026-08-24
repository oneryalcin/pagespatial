# Trial: GPU bottleneck instrumentation

**Status:** M0 complete; the tested Modal container shape is unsupported for
the required trace; M1 and M2 not started

**Date:** 2026-08-25

**Design:** [GPU bottleneck instrumentation](../design/2026-08-25-gpu-bottleneck-instrumentation.md)

## Result

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

## Attempts

| attempt | source | outcome | evidence |
|---|---|---|---|
| 1 | `da5f2f2` | harness error | the combined trace requested a CPU sampler after Modal denied `perf_event_open`; command returned 139 |
| 2 | `d1f8471` | harness error | sampling disabled; Nsight printed that it generated a report, but the harness discarded it because the command returned 139 |
| 3 | `b7e7c79` | platform unsupported | owner-approved bounded retry; report and SQLite retained; export succeeded; required NVTX/CUDA events absent |

The compact machine-readable result is
[`m0-capability-result-v1.json`](../../evaluation/gpu-instrumentation/m0-capability-result-v1.json).
It pins all raw-result, report, SQLite, tool, app, and reservation identities.
Raw artifacts stay under the ignored private `.evaluation/` tree.

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

## Decision

M0 does not authorize M1 or M2 on Modal. The next allowed action is the design's
host fallback: run the exact image and L4 shape on a dedicated Linux x86 host
or VM, with one unprofiled Modal control beside it before transferring a
conclusion. Until that host exists, the instrumentation workstream is stopped.

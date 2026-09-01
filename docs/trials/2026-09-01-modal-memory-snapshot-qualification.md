# Modal 8 GiB memory-snapshot qualification — 2026-09-01

## Decision

ADOPT the existing Modal CPU memory-snapshot path with a reversible deploy-time
switch. Keep the Python Modal wrapper, Node service, four Node workers, and four
Python OCR sidecars. Do not rewrite the parser in another language for cold
start.

The current implementation defaults to snapshots enabled. A deployment can set
`PAGESPATIAL_ENABLE_MEMORY_SNAPSHOT=0` to restore ordinary startup without a
code change.

## Treatment

- App: `pagespatial-parse-m6-dev`
- Adapter revision: `58cbcfa1999a-dirty` (isolated qualification worktree)
- Image pin revision: `ee110672752b`
- Modal client: `1.5.3`
- Resources: 4 vCPU, 8 GiB memory, one container maximum
- Snapshot preparation: existing service startup in `@modal.enter(snap=True)`
- Restore gate: `/health` validation plus fresh cgroup/OOM baselines in
  `@modal.enter(snap=False)`
- Real document: 142,510-byte, three-page World Bank fixture
- Pointer storage: existing split Cloudflare R2 input/result buckets

No parser, service topology, request contract, or correctness policy changed.

## Cold-start observations

Three deliberately stopped fresh containers populated three Modal CPU worker
types. A fourth deliberately stopped fresh container used an existing snapshot.

| Path | Model/process preparation | Post-restore health | One-page client wall |
| --- | ---: | ---: | ---: |
| population 1 | 64.180 s | 0.049 s | 78.2 s |
| population 2 | 118.182 s | 0.060 s | 269.9 s |
| population 3 | 78.147 s | 0.015 s | 106.8 s |
| snapshot hit | already captured | 0.035 s | 26.1 s |

The snapshot-hit log contained `Restoring Function from memory snapshot` and no
preceding creation event for that container. Its parse took 2.199 seconds. The
remaining client wall is Modal scheduling and restore overhead, not PageSpatial
service initialization.

This run proves an improvement over the ordinary 70–102 second cold band, but
does not reproduce the earlier 24 GiB experiment's 7.1-second median. A
26.1-second observation is not an SLA. The 269.9-second population call also
shows that immediately after a redeploy snapshots can make individual first
calls materially worse while Modal fills worker-type coverage.

## Live R2 and correctness gate

The existing qualification harness ran on the snapshot-restored process tree.

- Two direct controls established 0 critical-token / 0 raw-line null tolerance.
- Direct versus pointer output passed at 0/0 tolerance across 402 critical
  tokens and 724 raw lines.
- Two pointer executions passed repeat comparison at 0/0 tolerance.
- Both executions used distinct immutable result keys and were recovered by
  prefix LIST.
- A wrong input digest failed and published no result.
- Every cross-role ACL probe returned `AccessDenied`: input role PUT to input,
  result role GET/PUT to input, and input role GET/PUT to results.
- Pointer executions completed all 3 pages. Sampled memory peaked at
  4,704,448,512 bytes (4.38 GiB), with no pressure, OOM, or OOM-kill event.
- Qualification cleanup removed the temporary R2 objects.

Compact evidence: `evidence/2026-09-01-modal-memory-snapshot-8gib.json`.

## What this proves

- The production-shaped 8 GiB multi-process topology survives snapshot restore.
- The restored topology preserves direct/pointer deterministic output exactly.
- Lazy R2 clients and split-bucket credential boundaries still work after
  restore.
- Memory measurement starts after restore rather than inheriting snapshot
  population peaks or OOM counters.

## Limits and operations

- Modal maintains snapshots per CPU worker type. Coverage is not immediate.
- Redeploying invalidates snapshots and reopens the population window.
- Snapshot-hit latency remains subject to Modal scheduling and restore tails.
- `service_ready_ms` measures only the post-restore PageSpatial health gate;
  client wall is the service-relevant cold metric.
- The rollback is a redeploy with `PAGESPATIAL_ENABLE_MEMORY_SNAPSHOT=0`.

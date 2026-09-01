# Modal memory-allocation trial — 2026-09-01

## Decision

Set the Modal parse container default to **8 GiB** for the POC. Keep 12, 16,
and 24 GiB as bounded diagnostic values. Do not enable memory snapshots in
this change.

All six 100-page calls completed 100/100 pages with no failed page, retry, or
OOM. The warm 12 GiB call was also the fastest measured arm and used 1,433
allocated GiB-seconds, versus 2,415 at 16 GiB and 4,019 at 24 GiB. The speed
ordering is not attributed to memory size: the arms ran on shared Modal hosts
and host variance was already measured as material. The defensible conclusion
is narrower: 12 GiB did not regress this bounded workload and had the lowest
allocation cost among those three arms.

An owner-directed 8 GiB continuation then completed two more 100-page calls,
200/200 pages total, with no failed page, retry, OOM event, OOM-kill event, or
memory-pressure alarm. Its two-second cgroup samples peaked at 5.92 and 6.01
GiB, leaving 2.08 and 1.99 GiB headroom. This is sufficient for the current
POC default. The samples are lower bounds, so every production result and
terminal log now carries the same memory report and raises `pressure=true` at
90% sampled utilization, below 512 MiB headroom, or after an OOM event.

## Setup

- Adapter base: merged main `15ee1b093e0ca3352a4ed34e1084d208543103d0`
- Modal client: `1.5.3`
- Resources: 4 physical CPU cores, four page workers, one container maximum
- Snapshots: disabled in every arm
- Input: the same scanned page repeated to make one 100-page PDF
- Source: `.evaluation/m1-subset-pdfs/legistar_seattle_1859_v0_attachment_3318.pdf`
- Arms: 8, 12, 16, and 24 GiB
- Calls: two sequential calls per arm; the first was cold and the second warm
- Gate: completed status, 100 successful pages, zero failed pages, no retry

No returned page content was retained or compared. This is an allocation and
completion gate, not a new output-equivalence qualification.

## Results

| Memory | State | Ready | Parse wall | Parse rate | Client wall | Allocated GiB-s | Result |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 8 GiB | cold | 90.433 s | 161.386 s | 0.620 p/s | 260.357 s | **1,291.632** | 100/100 |
| 8 GiB | warm | 0 s | 164.196 s | 0.609 p/s | 167.917 s | **1,314.008** | 100/100 |
| 12 GiB | cold | 78.145 s | 125.958 s | 0.794 p/s | 211.728 s | 1,511.532 | 100/100 |
| 12 GiB | warm | 0 s | 119.440 s | **0.837 p/s** | 122.449 s | **1,433.304** | 100/100 |
| 16 GiB | cold | 94.651 s | 153.781 s | 0.650 p/s | 257.795 s | 2,460.544 | 100/100 |
| 16 GiB | warm | 0 s | 150.962 s | 0.662 p/s | 155.986 s | 2,415.424 | 100/100 |
| 24 GiB | cold | 92.279 s | 191.284 s | 0.523 p/s | 294.479 s | 4,590.888 | 100/100 |
| 24 GiB | warm | 0 s | 167.458 s | 0.597 p/s | 172.723 s | 4,019.040 | 100/100 |

`Allocated GiB-s` is configured memory multiplied by method wall. It is a cost
proxy, not a Modal invoice. On the warm calls, 12 GiB used 40.7% fewer
allocated GiB-s than 16 GiB and 64.3% fewer than 24 GiB. At equal wall time,
the reservation reduction from 24 GiB to 12 GiB is exactly 50%.

The recorded Node worker RSS peaks were 297–355 MiB and exclude the Python OCR
sidecars and shared mappings. They are not container peak memory. The 8 GiB
continuation measured the whole cgroup every two seconds. Cold and warm sampled
peaks were 6,357,295,104 and 6,453,198,848 bytes (74.0% and 75.1% of the
configured limit), with zero new OOM counters. Those peaks remain lower bounds:
a short spike between samples can be missed.

## Scope limits

- Two calls per arm are enough to reject OOM and obvious regression, not to
  estimate a latency distribution.
- The 8 GiB continuation demonstrates about 2 GiB sampled headroom on this
  repeated-page workload. It does not prove that every allowed 200-page input
  fits 8 GiB.
- The faster 12 GiB host does not prove that less memory makes parsing faster.
- This does not change the one-document-per-container topology.
- This does not land or qualify memory snapshots.
- Production changes only after this branch is reviewed and merged.

## Evidence

- `docs/trials/evidence/2026-09-01-modal-memory-12gib.json`
- `docs/trials/evidence/2026-09-01-modal-memory-8gib.json`
- `docs/trials/evidence/2026-09-01-modal-memory-16gib.json`
- `docs/trials/evidence/2026-09-01-modal-memory-24gib.json`

All four experimental Modal apps were stopped after the measurements.

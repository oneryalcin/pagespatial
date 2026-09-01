# Modal one-document page-scaling trial

Date: 2026-08-28

## Decision

Keep one PDF in one Modal container. Do not add cross-container page sharding.

The four-worker scheduler reaches near-full utilization by 20 pages and stays
near-full at 100 pages. From 20 to 100 pages, a five-times larger document took
4.52x to 4.86x as long to parse across three runs. This is approximately linear
scaling, with a small improvement from amortized fixed work.

The next justified efficiency experiment is a bounded memory-allocation trial,
not a scheduler rewrite. The container reserves 24 GiB, while a post-run cgroup
sample showed about 5.24 GiB in use. That sample is not a peak measurement, so
12 GiB and 16 GiB must be tested before the allocation changes.

## Question

Does one document use the four page workers efficiently at 1, 4, 20, and 100
pages? After the four workers are occupied, does parse wall time remain linear?

## Setup

- App: `pagespatial-parse-m5-dev`
- Container: 4 vCPU, 24 GiB, one input at a time, four Node page workers
- Fleet limit: one container
- Snapshot setting: enabled
- Source: page 1 of
  `.evaluation/m1-subset-pdfs/legistar_seattle_1859_v0_attachment_3318.pdf`
- Source page: 2552 x 3300 grayscale CCITT scan at 300 DPI, without native text
- Generated documents: the same source page repeated 1, 4, 20, or 100 times
- Harness: `scripts/evaluation/modal_page_scaling.py`
- Runs: three fresh launches with different execution orders
- Scope: OCR and parse timing only; no returned OCR text or PageSpatial record
  was persisted; output parity was not assessed

The harness records both `parse_ms` from inside the method and client wall time.
Only parse time is used for the page-scaling conclusion. Modal scheduling,
snapshot restoration, response transport, and container churn can occur outside
the method.

## Results

### Parse measurements

| Run | Pages | Parse wall (s) | Parse pages/s | Effective workers | CPU-s/page |
| --- | ---: | ---: | ---: | ---: | ---: |
| R1 ascending | 1 | 8.250 | 0.121 | 0.866 | 33.020 |
| R1 ascending | 4 | 10.051 | 0.398 | 3.188 | 10.054 |
| R1 ascending | 20 | 38.801 | 0.516 | 3.905 | 7.761 |
| R1 ascending | 100 | 175.225 | 0.571 | 3.896 | 7.009 |
| R2 descending | 1 | 4.015 | 0.249 | 0.988 | 16.072 |
| R2 descending | 4 | 6.023 | 0.664 | 3.036 | 6.025 |
| R2 descending | 20 | 24.334 | 0.822 | 3.740 | 4.867 |
| R2 descending | 100 | 117.305 | 0.853 | 3.937 | 4.692 |
| R3 mixed | 1 | 8.275 | 0.121 | 0.791 | 33.116 |
| R3 mixed | 4 | 8.213 | 0.487 | 3.235 | 8.220 |
| R3 mixed | 20 | 18.217 | 1.098 | 3.774 | 3.644 |
| R3 mixed | 100 | 88.545 | 1.129 | 3.979 | 3.542 |

`Effective workers` is the sum of per-page wall time divided by document parse
wall time. Four is the physical maximum. `CPU-s/page` is four allocated vCPU
multiplied by method wall, divided by pages. It is an allocation measure, not a
Modal invoice or measured CPU utilization.

Median results:

| Pages | Parse wall (s) | Parse pages/s | Effective workers |
| ---: | ---: | ---: | ---: |
| 1 | 8.250 | 0.121 | 0.866 |
| 4 | 8.213 | 0.487 | 3.188 |
| 20 | 24.334 | 0.822 | 3.774 |
| 100 | 117.305 | 0.853 | 3.937 |

### Linearity after saturation

Twenty to 100 pages is a five-times increase in work.

| Run | 100-page / 20-page parse wall | 100-page / 20-page throughput |
| --- | ---: | ---: |
| R1 | 4.516x | 1.107x |
| R2 | 4.821x | 1.037x |
| R3 | 4.861x | 1.029x |

There is no growing queue or synchronization penalty in this interval. The
small throughput improvement is consistent with fixed work being amortized.

### Client wall and cold-restoration variance

The four-page R2 result was 0.664 parse pages/s and 0.506 client pages/s. The
previously quoted approximately 0.5 pages/s therefore described this short
document's client rate. It did not describe the sustained four-worker ceiling.

R3 did not preserve one warm lifetime for its first three calls. Modal reported
all three as cold. Time outside the method was 103.608 seconds for four pages
and 383.302 seconds for 100 pages. These observations invalidate R3 client wall
as a same-lifetime scaling sequence, but do not invalidate its in-method parse
measurements.

Across the three 100-page parses, throughput ranged from 0.571 to 1.129 pages/s.
This approximately two-times host/lifetime range is more material to latency
predictability than the page scheduler after it is saturated.

## Findings

1. One large PDF stays in one container and uses the four page workers well.
   Effective worker occupancy is 94% to 98% at 20 pages and 97% to 99% at 100
   pages.
2. Four pages use about 76% to 81% of worker capacity. One page uses only about
   20% to 25%. Small documents leave compute idle because one document is the
   scheduling unit and the app accepts one input at a time.
3. From 20 to 100 pages, parse wall is approximately linear. Splitting one PDF
   across containers would add coordination and spend to solve a bottleneck
   that this trial did not observe.
4. The 24 GiB reservation is likely larger than necessary. After the R3
   100-page and 20-page calls, cgroup current memory was about 5.24 GiB. The
   process RSS sum was about 7.62 GiB but double-counts shared pages. Neither is
   a peak-in-flight measurement.
5. Snapshot restoration and host selection remain variable. Memory snapshots
   reduced the normal service-ready work, but they did not guarantee a small
   client-visible cold tail in every launch.

## Next bounded experiment

Run the same 100-page scan at 12, 16, and 24 GiB. Sample cgroup memory before,
during, and after parsing. Keep the smallest arm that has no OOM, no retry, and
no throughput regression. Start at 12 GiB because the observed current usage
was 5.24 GiB; do not test 8 GiB first because the missing peak measurement makes
that margin too small.

Only after the memory result, consider concurrent small documents if real
traffic is dominated by one- to four-page PDFs. That change requires per-call
scratch and lifecycle isolation; the current shared method context must not be
made concurrent by changing one Modal decorator.

## Evidence

Raw summaries, intentionally ignored by Git:

- `.evaluation/modal-page-scaling/2026-08-28/r1.json`
- `.evaluation/modal-page-scaling/2026-08-28/r2.json`
- `.evaluation/modal-page-scaling/2026-08-28/r3.json`

The PageSpatial test container had already scaled to zero when this record was
completed. The two remaining live containers belonged to
`gliner-ner-service-v2` and were not changed.

# OCR sidecar thread sweep — 2026-09-02

Issue #126, step 1. Owner un-parked the issue on 2026-09-02.

## Decision

Set the OpenVINO thread count per OCR sidecar to **4** (`SERVICE_SIDECAR_THREADS=4`,
deploy knob `PAGESPATIAL_SIDECAR_THREADS`, allowlisted `{1, 2, 4}`), and make
the sidecar actually apply that value by exporting `PADDLE_PDX_CPU_NUM_THREADS`
before constructing the pipeline.

Two claims are settled, one is refuted:

1. **The production sidecar never controlled its thread pool.** `SIDECAR_THREADS=1`
   was passed as `cpu_threads=` to PaddleOCR, which the OpenVINO HPI runner
   ignores. PaddleX sized the pool from `PADDLE_PDX_CPU_NUM_THREADS`, default
   10, so every result reported `sidecar_threads: 1` while each sidecar ran 10
   hot inference threads. The in-band attestation below proves it. The
   descriptor string `threads=1` in every prior server-side record was untrue.
2. **Oversubscription is real: about 80 hot threads on 4 cores.** In the
   unchanged-`main` arm each sidecar had 45–46 OS threads, 20–25 of them with
   more than one second of CPU, versus exactly 4 hot threads per sidecar at
   the 4-thread setting.
3. **The #126 prediction that 1 thread per worker would win is refuted.**
   1 thread was the slowest arm in every round. 4 threads was best or tied
   in every round and had the tightest spread. The unchanged 10-thread
   baseline matched the 4-thread median but swung 2.3× between runs.

The measured gain of 4 over the baseline median is 6% on 100 pages, inside
host noise. The defensible benefit is variance and truthfulness, not
throughput. #126 steps 2–5 remain unstarted.

## Setup

- Branch `perf/ocr-thread-sweep` from `main` `e634782`; baseline arm deployed
  from an unchanged `main` worktree at the same revision.
- Four dev apps: `pagespatial-parse-arm{10,1,2,4}-dev`. Production app untouched.
- 4 physical cores, 8,192 MiB, one container, four Node page workers, four
  sidecars, memory snapshots enabled. Image pin revision `ee110672752b` for
  all arms.
- Harness: `scripts/evaluation/modal_page_scaling.py`, source page 1 of
  `.evaluation/m1-subset-pdfs/legistar_seattle_1859_v0_attachment_3318.pdf`
  (2552×3300 CCITT scan, no native text), documents of 1, 20, and 100 repeated
  pages, execution order 1→20→100 in every run.
- Three rounds, arms interleaved 10→1→2→4 per round, each run a fresh process
  and a fresh container. Rounds landed on different Modal hosts; the 100-page
  time of the same arm varied up to 2.3× between rounds.
- Limitation: arm order was fixed at 10→1→2→4 in every round and Modal
  host variation was large, so no strong speed or variance claim is made.
  The conclusions rest on direct attestation, 1 losing in every round, and
  4 avoiding the attested 10-thread oversubscription.
- Attestation: `modal container exec` into the live container during the
  100-page call, reading `/proc/<sidecar>/status` thread counts and per-thread
  CPU ticks from `/proc/<sidecar>/task/*/stat`.

## Results

Parse wall time in seconds from inside the method (`parse_ms`); excludes
Modal scheduling, snapshot restore, and transport.

| Threads | Pages | R1 | R2 | R3 | Median | Median pages/s | p95 page ms (median) |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 10 (main, unchanged) | 1 | 6.3 | 10.5 | 6.5 | 6.5 | 0.155 | 6000 |
| 10 (main, unchanged) | 20 | 33.2 | 72.4 | 27.1 | 33.2 | 0.603 | 7320 |
| 10 (main, unchanged) | 100 | 151.2 | 288.3 | 123.1 | 151.2 | 0.661 | 6234 |
| 1 | 1 | 8.3 | 10.8 | 12.9 | 10.8 | 0.093 | 9356 |
| 1 | 20 | 36.9 | 43.5 | 54.3 | 43.5 | 0.460 | 10069 |
| 1 | 100 | 161.4 | 211.1 | 249.9 | 211.1 | 0.474 | 8513 |
| 2 | 1 | 8.3 | 9.6 | 8.3 | 8.3 | 0.120 | 7589 |
| 2 | 20 | 33.0 | 39.3 | 37.3 | 37.3 | 0.537 | 8574 |
| 2 | 100 | 152.8 | 180.9 | 178.1 | 178.1 | 0.562 | 7425 |
| 4 | 1 | 6.4 | 8.4 | 6.3 | 6.4 | 0.157 | 5958 |
| 4 | 20 | 35.5 | 31.2 | 31.1 | 31.2 | 0.641 | 7358 |
| 4 | 100 | 151.9 | 138.4 | 142.5 | 142.5 | 0.702 | 6651 |

Within-round ranking on 100 pages (fastest first): R1 `10 ≈ 4 ≈ 2 > 1`;
R2 `4 > 2 > 1 > 10`; R3 `10 > 4 > 2 > 1`. Effective worker parallelism was
3.9 of 4 in every 100-page run, so the differences are per-page OCR speed,
not scheduling.

Every run completed all pages with zero failures. Node worker peak RSS was
255–347 MiB in all arms; sidecar RSS was not sampled.

### Attestation (per sidecar, during the 100-page call)

| Arm | OS threads | Hot threads (≥1 s CPU) | Shape of hot threads |
|---|---:|---:|---|
| 10 (main) | 45–46 | 20–25 | main ~35 s, ~10 threads at 27–53 s each, ~10 at 7–40 s |
| 4 | 30–36 | 11–13 | main ~16 s, exactly 4 threads at 25–29 s, rest ≤1.7 s |
| 2 | 28 | not captured | — |
| 1 | 27 | not captured | — |

OS thread count rose by exactly one from the 1-thread to the 2-thread arm,
and the hot-thread count matched the setting at 4, so the env var controls
the real inference pool. The baseline arm's `/proc/<pid>/environ` shows only
`SIDECAR_THREADS=1`; PaddleX's default of 10 comes from code, not the
environment.

## Why 1 thread lost

Each page worker is sequential: rasterize, OCR, match. While a worker is in a
non-OCR phase its sidecar is idle. With one inference thread per sidecar,
an OCR phase can use at most one core even when the other three are idle, so
cores go unused whenever the four workers are out of phase. With 4 threads a
sidecar in its OCR phase can take the idle cores. With 10 the same happens
but with 80 runnable threads on 4 cores, which is where the 288 s outlier
lives. This is the reverse of the #126 hypothesis and is consistent with the
earlier page-scaling trial's 88–175 s swing on identical inputs.

## What this does and does not authorize

- Authorizes: `SERVICE_SIDECAR_THREADS=4` as the production default; the
  allowlist; the sidecar env fix; the in-band `pdxCpuNumThreadsEnv` and
  `osThreadCount` meta fields.
- Does not authorize: any recognition-policy change, GPU work, or a
  throughput claim. The 6% median gain is inside host noise.
- Correction to prior records: every server-side OCR descriptor that said
  `threads=1` before this change ran 10 OpenVINO threads per sidecar. The
  `dev-v13-sidecar-2026-08-23` baseline was produced under that
  configuration.

## Live gate

`scripts/service/qualify-modal-object.py` against `pagespatial-parse-arm4-dev`
rebuilt from this branch (image pin revision `08928d6a48a6`): direct-vs-pointer
parity exact, pointer repeat exact, every cross-role R2 ACL probe denied,
digest mismatch rejected, results report `sidecar_threads: 4`. The harness
had drifted from the `parse_object` contract (missing `page_limit`, added
with the alpha page-credit reservation) and was fixed in this branch; the
2026-09-01 snapshot qualification predates that contract change.

## Output parity: 10 threads vs 4 threads

The 23-document correctness manifest (162 pages) ran through
`pagespatial-parse-arm10-dev` (unchanged `main`) and `pagespatial-parse-arm4-dev`
(this branch), each with a same-configuration duplicate, via
`scripts/evaluation/m3_qualification_modal.py submit --set correctness
--duplicate`. All 92 calls completed. Captures under
`.evaluation/modal-qualification/2026-09-02-threads/` (private).

`compare-modal-runs.mjs` 10 vs 4: OCR-score projection exact on all 23
pairs, OCR-derived projection exact, critical-token delta 0, raw-line delta
0. Both same-configuration null pairs were exact everywhere.

The comparator's stable deterministic projection reported every page as
differing. A field-level diff over all 162 pages, excluding only timing,
RSS, `runId`, and `createdAt`, found exactly three differing leaves:

| Leaf | Pages | Nature |
|---|---:|---|
| `provenance.ocrAdapter` descriptor `threads=1` → `threads=4` | 162 | intentional; the old value was untrue |
| `provenance.configuration.ocrBackend.numThreads` 1 → 4 | 162 | intentional; same |
| `nativeObservations[].font` label | 747 observations | per-process font counter, already adjudicated as metadata and excluded by the comparator |

No OCR observation, text, score, polygon, native observation, conflict, or
derived projection differed. OpenVINO thread count does not change the
recognizer's output on this cohort. The comparator's deterministic
projection includes the provenance configuration by design, so any run that
changes a provenance field will report this way; the field-level diff above
is the evidence that nothing else moved.

## Reproduce

```bash
# deploy one arm (image build ~3 min on first arm, seconds after)
PAGESPATIAL_MODAL_APP_NAME=pagespatial-parse-arm4-dev PAGESPATIAL_MAX_CONTAINERS=1 \
PAGESPATIAL_MEMORY_MIB=8192 PAGESPATIAL_ENABLE_MEMORY_SNAPSHOT=1 \
PAGESPATIAL_SIDECAR_THREADS=4 modal deploy deploy/modal/modal_app.py

uv run --with modal python scripts/evaluation/modal_page_scaling.py \
  --app pagespatial-parse-arm4-dev --pages 1,20,100 --label arm4-r1 \
  --source .evaluation/m1-subset-pdfs/legistar_seattle_1859_v0_attachment_3318.pdf \
  --output /tmp/arm4-r1.json

# attest while the 100-page call runs (the image has no pgrep)
modal container exec --no-pty <container-id> -- bash -c '
for d in /proc/[0-9]*; do tr "\0" " " < $d/cmdline 2>/dev/null | grep -q ppocr_sidecar.py || continue
  p=${d#/proc/}; grep ^Threads /proc/$p/status
  for t in /proc/$p/task/*; do awk "{print \$14+\$15}" $t/stat; done | sort -rn | head -6
done'
```

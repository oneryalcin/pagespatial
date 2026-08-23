# M4 corpus enrichment: workstream-2 acceptance on the container

**Date:** 2026-08-23 · **Branch:** `m4-corpus-run` · **Design:**
`docs/design/2026-08-23-service-deployment-and-enrichment.md` (workstream 2)
· **Milestone:** M4 (final)

First real-corpus run of the service's escalated-enrichment phase (M3) on
the deployment unit (M1's container, Modal linux/amd64), plus the replayed
dev-v13 acceptance measurements. Committed instruments:
`scripts/evaluation/m4-replay-enrichment.mjs` (criteria 1 and 3),
`scripts/evaluation/m4_corpus_enrichment_modal.py` (criteria 2, 4, 5),
`scripts/evaluation/score-enrichment-recall.mjs` (committed scorer,
unchanged). Raw outputs (corpus-derived) live in gitignored
`.evaluation/m4/`; this document carries counts only.

## The assigned reconciliation, first

The design's "Numbers cited here" flagged two figures for one endpoint:
the batch trial's scoreboard said 11.3× at $0.000825/corpus page;
`docs/workstreams.md` said 11.4× at $0.000817. Recomputed from the run's
persisted ledger (250,107 prompt + 20,529 output tokens, batch pricing →
$0.132282 exact): **$0.000817 and 11.4× are correct**; the scoreboard row
followed from no artifact and now carries a dated correction
(`docs/trials/2026-08-20-batch-and-residue-crops.md`). The reconciled
reference for criterion 2 is the ladder's **$0.001454 per enriched page**
($0.132282 / 91 blocking pages, dev-v12).

## Two runs, and which criteria each carries

1. **Replay run (Mac, service machinery, real Gemini batches).** The
   dev-v13 baseline records — the same 162 records, replayed — laid out as
   service job dirs and driven through the service's own
   `EnrichmentPhase` (manifest build, chunked batch submit, poll, join,
   digest-bound records). Carries criterion 1 (routing parity) and
   criterion 3 (token gain on replayed gold pages). A container adds
   nothing here: these criteria are properties of the records and the
   routing/enrichment code, not of the OCR runtime — and replayed records
   cannot be injected through the container's HTTP ingress, which parses
   fresh.
2. **Container corpus run (Modal, the committed Dockerfile, the real
   service over HTTP).** The 162-page development corpus (M1's 23
   qpdf-lossless subset PDFs — page numbering remapped, so this run
   measures service behaviour and economics, never record-level parity
   with dev-v13), submitted with `?enrichment=batch`, GEMINI_API_KEY as a
   Modal secret. Carries criterion 2 (cost per enriched page), criterion 4
   (metrics reconcile), criterion 5 (parse-vs-enrichment split), and the
   default-off assertion.

## Criterion 1 — routing parity on replayed records: PASS

`m4-replay-enrichment.mjs` feeds the same dev-v13 records to both
routings: the evaluation runner's exact loop
(`pageQualifiesForEscalatedEnrichment` → shared plan builder → request
kinds, as `run-flash-enrichment.mjs` derives its batch keys) and the
service's real path (`EnrichmentPhase.buildManifest` over stored records →
submitted chunk keys). Page-for-page comparison of selection, rung kinds,
and the plan payload rebuilt from the stored record:

| | runner | service |
|---|---|---|
| pages replayed | 162 | 162 |
| qualifying (blocking) pages | 84 | 84 |
| adjudication rung | 80 | 80 |
| full-transcription rung | 4 | 4 |
| residue-crops rung | 0 | 0 |
| **mismatches (any kind)** | | **0** |

Identical page-for-page — reproducing M2's replay counts (84 qualifying of
162; the 84 is a dev-v13-era measurement, not a parity target against
dev-v12's 91). The residue-crops zero remains "nobody looked": the
sidecar-era baseline runs with region recovery and unread-ink analysis
off, so no dev-v13 record can fire the crops rung (#10/#13; M2's honest
label carries over).

## Criterion 3 — token gain on replayed gold pages: PASS

The replay run then executed those 84 plans for real through the
service's phase B (`EnrichmentPhase`: 16 chunks across 23 jobs, 84
batch entries, chunk sizes 1–24 under `ENRICH_MAX_ENTRIES_PER_CHUNK=24`,
concurrent-chunk semaphore 4, zero interactive calls by construction —
the module imports no interactive adapter). All 84 pages landed
`complete`, digest-bound to the replayed dev-v13 records; 454
adjudication verdicts (ocr 293 / native 127 / both-wrong 34 / **0
unsure, 0 unanswered** — every one of dev-v13's 454 conflicts
adjudicated) and 86 transcription proposals (71 corroborated-ocr, 15
novel). Committed scorer (`score-enrichment-recall.mjs`, dev-v13
run-root + these records):

| | tokens |
|---|---|
| gold∩blocking pages (dev-v13) | 18 pages, 370 gold tokens |
| base union recall | 332/370 |
| **with enrichment** | **338/370 (+6)** |

The committed floor is the dev-v12 measurement's gain (381→382, **+1**);
+6 clears it. Honest era note on "same pages": the gold∩blocking page
set is a property of the era's records — one dev-v12 gold page
(`725f4b428d49` p7, 47 gold tokens) is no longer blocking on dev-v13
(criticalConflicts 470→454, a genuine first-pass difference the dev-v13
baseline doc documents), so the replayed set is the 18 gold∩blocking
pages dev-v13 actually has. Absolute recalls are not comparable across
eras or scorer mechanisms; the checkable claim is the same-era gain,
same scorer, same replayed records.

Replay-side spend: 219,710 prompt + 20,275 output tokens, **$0.1204**
(batch pricing), $0.001433 per enriched page — an independent
corroboration of criterion 2's ladder figure from a second code path.

## The container corpus run (criteria 2, 4, 5)

One 4-vCPU container from the committed Dockerfile (4×1 packing — M1's
winner), GEMINI_API_KEY via Modal secret, `SERVICE_DATA_DIR` on the
container tmpfs. Boot-to-ready 114.1 s (M1 range was 70–88 s; shared
tenancy — the readiness 503 window itself was not observed by the 2 s
probe here because the port stays closed through the dominant boot-check
phase and warm-up fell between polls; readiness gating is M1's verified
result, not re-measured). All 23 documents (162 corpus pages) submitted
over HTTP with `?enrichment=batch`: **162/162 pages ok, 23/23 jobs
`completed`, 23/23 `enrichmentStatus: complete`, 83/83 routed pages
`complete`, 0 unavailable, 0 stale**; SIGTERM drain exit 0.

**Default-off asserted**: a control job submitted first WITHOUT the
enrichment param (same image, same boot) completed with
`enrichmentStatus: "disabled"`, no per-page `enrichmentState` fields,
and no `enrichment/` directory in its job dir.

**dev-v13-era blocking count, new measurements, not parity targets**:
the replayed dev-v13 records qualify **84** pages (80 adj + 4 full); the
container's fresh first-pass records on the same page images qualify
**83** (78 adj + 5 full). The one-page delta is cross-container
first-pass variance of the conflict set (the ceremony's ±4-token
container variance, M1 criterion 2), not a routing difference — routing
parity on FIXED records is criterion 1's zero-mismatch result. dev-v12's
91 is a different era and is not a target (design, criterion 2).

## Criterion 2 — cost per enriched page: PASS

| | container run | reconciled ladder (dev-v12) |
|---|---|---|
| enriched pages | 83 | 91 |
| tokens (prompt / output) | 215,739 / 21,375 | 250,107 / 20,529 |
| spend (batch pricing) | $0.120984 | $0.132282 |
| **$ / enriched page** | **$0.001458** | **$0.001454** |

**+0.3% against the reconciled figure** (10% window; the replay run's
independent $0.001433 sits −1.4%). 150 dpi, batch pricing (0.5×
multiplier on Google's published rate applied to measured tokens, not an
invoiced number). Per corpus page this run lands at $0.120984/162 =
$0.000747 — reported for context only; $/corpus-page is a function of
the era's blocking rate and is not a comparison target.

## Criterion 4 — metrics reconcile with job records: PASS

`/v1/metrics` at end of run vs the sum over the 23 on-disk job manifests
— every pair EXACTLY equal:

| counter | /v1/metrics | Σ job manifests |
|---|---|---|
| promptTokens | 215,739 | 215,739 |
| outputTokens | 21,375 | 21,375 |
| estimatedSpendUsd | 0.120984 | 0.120984 |
| pagesComplete | 83 | 83 |
| pagesPerRung (full / crops / adj) | 5 / 0 / 78 | 5 / 0 / 78 |
| chunksCompleted | 16 | 16 |
| noEligibleRegionPages | 0 | 0 |

Spend ceiling surfaced and not reached ($0.12 of $10);
`spendCeilingReached: false`.

## Criterion 5 — parse-vs-enrichment split (wall and CPU): MEASURED

Wall (from first corpus submit; the control job precedes t0):

| phase | wall |
|---|---|
| parse: submit → all 23 jobs `completed` | **125.1 s** |
| enrichment tail: → all 23 `enrichmentStatus` terminal | **942.2 s** (1,067.3 s total) |
| batch chunk wall (16 chunks, semaphore 4) | p50 211 s, max 409 s |

CPU, from `/proc/<pid>/stat` utime+stime (+cutime/cstime for reaped
children) snapshotted at the phase boundaries:

| phase | workers (self + children) | sidecars | server (self + children) | total |
|---|---|---|---|---|
| parse window | 140.3 + 384.3 | 1,110.8 | 5.8 + 5.4 | **~1,647 core-s** |
| enrichment window | 0.9 + 0.0 | 0.0 | 20.5 + 27.9 | **~49.3 core-s** |

- **Enrichment costs ~3% of parse CPU**: ~0.59 core-s per enriched page,
  of which the **second 150 dpi render pass is ~0.34 core-s/page**
  (27.9 core-s of server-reaped pdftoppm children ÷ 83 renders; crops 0
  this era). The rest is the server's join/validation work plus serving
  the harness's 10 s polling. Enrichment wall is Gemini batch turnaround,
  not local compute — the phase is I/O-shaped by design (batch API,
  §4).
- Honest labels: (a) phase B of early-finishing jobs overlaps the parse
  window — the overlap is bounded by the +5.4 core-s of server-children
  growth inside the parse window; (b) absolute parse CPU exceeds
  4 vCPU × wall because Modal's `cpu=4` is a request, not a hard cap
  (osCpuCount 20; the container burst above 4 cores) — the SPLIT is this
  criterion's deliverable, and M1's range (3.0–5.5 core-s/page under its
  stated packing) remains the parse-throughput reference; (c) the
  server-children baseline at t0 (45.5 core-s) is the boot-time sidecar
  `--check` engine build, excluded from both windows.

## Spend, total

$0.120984 (container corpus run) + $0.12041 (replay run) =
**$0.241394** for the whole milestone — per-job page caps and the $10
service ceiling engaged nowhere.

## Docs superseded by this run

- The enrichment batch wall-clock ("~4 min to results") and the ladder's
  per-page economics were previously Mac-client measurements
  (dev-v12 era); this trial adds the container-side measurement (batch
  chunk p50 211 s under chunked submission) and confirms the ladder's
  per-enriched-page figure on the service path ($0.001458 / $0.001433).
  M1 already superseded every Mac/Modal parse-throughput figure; no
  remaining doc quotes a Mac-era enrichment number as current
  (`docs/workstreams.md` updated in this PR; the dev-v12 trial docs are
  era-labeled records and stand as written, plus the dated scoreboard
  correction above).

## Provenance (§8)

- **Code state**: all measurements ran from branch `m4-corpus-run` with
  the instruments byte-identical to their committed content at
  `f578eaa` (base: main at `1a54891`, which includes M1/M2/M3 — PRs
  #82/#80/#81). The container image was built by
  `modal.Image.from_dockerfile` from this tree's committed Dockerfile on
  Modal's linux/amd64 builder, exactly as M1 — same pins, same baked
  hash-verified models; environment details in
  `docs/trials/2026-08-23-linux-verification.md`. The build context had
  no untracked/modified files in any path the Dockerfile COPYs (the M4
  instruments and this doc live under `scripts/evaluation/` and `docs/`,
  outside the runtime COPY set or excluded by `.dockerignore`).
- **Instruments** (committed): `scripts/evaluation/m4-replay-enrichment.mjs`
  (criteria 1/3 + the replay enrichment), 
  `scripts/evaluation/m4_corpus_enrichment_modal.py` (criteria 2/4/5),
  `scripts/evaluation/score-enrichment-recall.mjs` (unchanged committed
  scorer), `scripts/evaluation/build-corpus-subset-pdfs.mjs` (M1's input
  builder, reused).
- **Page sets**: replay = the 162 dev-v13 baseline records
  (`.evaluation/runs/dev-v13-sidecar-2026-08-23`, authenticated
  lineage); container run = M1's 23 qpdf-lossless subset PDFs (162
  pages; page numbering remapped — service behaviour and economics only,
  never record-level parity). Gold join: pilot-v1 + batch2-v1 verdicts,
  the committed scorer's own selection (18 gold∩blocking pages on
  dev-v13).
- **Raw outputs** (gitignored, corpus-derived): `.evaluation/m4/`
  (`replay-parity.json`, `replay-enrich.json`, `replay-scoring/`,
  `replay-jobs/`, `corpus-enrichment.json`).
- **Spend**: $0.241394 total, estimated from measured tokens at batch
  pricing (0.5×), per-source accounting; not an invoiced number.
- **Independence checklist**: criterion 3 quotes a gold rate on a
  system-conditioned page set (gold∩blocking) — a case series, not a
  corpus rate; its load-bearing claim is the same-era, same-scorer GAIN
  (+6 vs the +1 committed floor). All other numbers are operational
  measurements of the system's own behaviour (cost, counts, wall, CPU)
  with no gold denominator. The blocking-page counts (84 replayed / 83
  fresh) are new dev-v13-era measurements, not parity targets.

## Summary — the five criteria in one line each

1. **Routing parity on replayed records: PASS** — 162 pages, 84
   qualifying, 80 adj + 4 full + 0 crops, ZERO mismatches between the
   service's manifest routing and the runner's, plan payloads equal.
2. **Cost per enriched page: PASS** — $0.001458 on the container
   ($0.001433 on the replay) vs the reconciled $0.001454, within 10%
   (+0.3%); blocking counts reported as new measurements (84/83).
3. **Token gain on replayed gold pages: PASS** — 332→338 (+6) on the 18
   dev-v13 gold∩blocking pages, over the committed +1 floor; 454/454
   conflicts adjudicated, 0 unsure/unanswered.
4. **Metrics reconcile: PASS** — every enrichment counter in
   `/v1/metrics` exactly equals the sum over job manifests.
5. **Parse-vs-enrichment split: MEASURED** — parse ~1,647 core-s /
   125.1 s wall; enrichment ~49.3 core-s (~3%) / 942.2 s wall
   (batch-turnaround-bound), second 150 dpi render pass ~0.34
   core-s/page.

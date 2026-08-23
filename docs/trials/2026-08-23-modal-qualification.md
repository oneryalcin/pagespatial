# Trial: Modal qualification run (M3)

**Date:** 2026-08-23 (all times UTC)

**Design:** [Modal scaling and deployment](../design/2026-08-23-modal-scaling-and-deployment.md) §14, run unchanged per §16 M3.

**Verdict: DOES NOT PASS as specified — 10 of 12 acceptance criteria PASS; criteria 3 and 7 FAIL as written, with one shared, fully isolated root cause** (the pdf.js font `loadedName` embeds a process-lifetime document counter; see §Finding — OCR deltas were zero everywhere and document hashes always matched). Every delivery, failure-semantics, cleanup, and cost criterion passed. No tuning or rerun was attempted: per §16 M4 that decision belongs to the checkpoint, not this trial.

## Provenance

| item | value |
|---|---|
| workspace | `desia` (Modal profile `desia`) |
| workspace plan/limits | not exposed by the pinned CLI; the run requested at most 16 containers, far below Modal's documented 4,000-container Function cap; no `ResourceExhaustedError` was observed |
| Modal SDK / CLI | `modal client version: 1.5.3` (uv tool install, Python 3.13) |
| adapter revisions (deploy-time, baked) | arm2 `c3e160e95f36`; arm3 `7aa91eedfcc7`; arms 4–7 `211b0d7e5416-dirty`; arms 8–10 `02f4f3e3f656` — the `-dirty` on arms 4–7 was solely the then-untracked draft of THIS trial document in the working tree; no source or adapter file differed |
| image/model-pin revision | `f09d61d7b51f` (identical for every arm) |
| resource settings (§7.3) | cpu 4.0 physical cores; memory 24,576 MiB; 4 workers x 1 sidecar thread; `startup_timeout` 1,200 s; method `timeout` 1,800 s; `retries` 1; `min_containers`/`buffer_containers` 0/0; `max_containers` 1/4/16 per arm (allowlisted deploy knob); one input per container; enrichment off; 100 Node jobs per warm lifetime |
| manifest | committed `evaluation/modal-qualification/manifest.v1.json` (fixed before any result was viewed, PR #90): 23 documents / 162 pages correctness; deterministic 100-call / 750-page scaling set; `--check` against local subset PDFs passed before the run |
| corpus location | local `.evaluation/m1-subset-pdfs/` — content never enters git; every PDF hash re-verified against the manifest at submit time |
| pricing | https://modal.com/pricing retrieved 2026-08-23: CPU $0.0000131/physical-core-s, memory $0.00000222/GiB-s → $0.380448 per provisioned container-hour at this configuration (archived: `.evaluation/modal-qualification/2026-08-23/pricing-2026-08-23.md`) |
| raw results | `.evaluation/modal-qualification/2026-08-23/arm{2..10}/` — per arm: `captures.jsonl` (with mandatory `spawned_at_ms`/`result_at_ms` wall clocks), `container-list.jsonl` snapshots, `logs/<container-id>.log` (full `--all --timestamps` dumps), `aggregation.json`, plus `kill-evidence/` (arm 7), probe JSONs (arm 8) and the comparison JSONs |
| harness | `scripts/evaluation/m3_qualification_modal.py` (committed this PR) |

Every number below is read from those artifacts; none from dashboard glances (§12).

## The §14.3 comparator (built this PR)

`scripts/evaluation/lib/modal-comparator.mjs` implements the three named
projections exactly as specified — `stableDeterministicProjection` (page
minus `provenance.runId`, `provenance.createdAt`, and the nine OCR-dependent
roots), `ocrScoreProjection` (the existing EP-scorer shape, observation
order unchanged), `ocrDerivedProjection` (only the nine roots) — wires the
existing critical-token and raw-line scorer semantics over the score
projection, and refuses to render a verdict without a *derived* null
tolerance. `pageDigest()` is never compared across runs (unit-tested: a
reparse under a new runId has a new digest and an exact deterministic
projection). The two §14.3-required unit tests exist and pass: an OCR
text/score variation inside the tolerance may pass; a native-field mutation
fails regardless of OCR score. CLI: `scripts/evaluation/compare-modal-runs.mjs`;
criterion-2 checker: `scripts/evaluation/validate-modal-captures.mjs`.

## Arm windows and per-arm aggregation (§12)

Arms ran in §14.2 order, sequentially, in non-overlapping windows, each on
its own app tag (`pagespatial-parse-arm<N>-dev`).

| arm | app window (UTC) | calls | completed / failed / visible exceptions | terminal pages | containers (cold starts) | cold readiness s (from logs) | warm method ms p50/p95/max | completion wall s p50/p95/max | aggregate pages/s |
|---|---|---|---|---|---|---|---|---|---|
| 2 (one real doc) | 19:00:01–19:03:05 | 1 | 1 / 0 / 0 | 9 | 1 (1) | 101.6 | — (cold 17,233) | 126.6 | 0.071 |
| 3 (100 calls, mc=1) | 19:03:35–19:26:07 | 100 | 100 / 0 / 0 | 750 | 1 (1) | 82.2 | 6,054 / 29,443 / 35,675 | 653 / 1,089 / 1,180 | 0.599 |
| 4 (100 calls, mc=4) | 19:26:21–19:34:15 | 100 | 100 / 0 / 0 | 750 | 4 (4) | 82.2–90.3 | 8,038 / 37,817 / 48,571 | 232 / 330 / 366 | 1.731 |
| 5 (100 calls, mc=16) | 19:34:29–19:38:56 | 100 | 100 / 0 / 0 | 750 | 16 (16) | 76.1–94.6 | 6,054 / 35,281 / 46,727 | 97 / 125 / 137 | 3.678 |
| 6 (10 duplicated inputs) | 19:39:17–19:48:14 | 20 | 20 / 0 / 0 | 232 | 1 (1) | 82.6 | 12,211 / 35,507 / 35,548 | — | — |
| 7 (external container stop) | 19:48:22–19:53:51 | 3 | 3 / 0 / 0 | 44 | 2 (2) | 84.2, 98.6 | 22,963 / 40,009 / 41,903 | 245 / 286 / 290 | 0.152 |
| 8 (kill-node during 10 inputs) | 19:54:14–20:02:17 | 10 | 9 / 0 / 1 | 85 | 2 (2) | 76.2, 78.1 | 8,151 / 26,748 / 26,965 | 239 / 288 / 290 | 0.291 |
| 9 (exception + timeout) | 20:02:31–21:06:49 | 2 | 0 / 0 / 2 (both visible, by design) | 0 | 1 (1) | 78.2 | — | — | — |
| 10 (repeat of arm 3) | 21:06:57–21:35:07 | 100 | 100 / 0 / 0 | 750 | 1 (1) | 88.3 | 8,063 / 46,844 / 61,250 | 896 / 1,449 / 1,598 | 0.449 |

Arm 1 (local suites, stub parser): `npm test` 276 tests, 274 pass / 0 fail /
2 pre-existing skips (includes the 8 new comparator tests);
`test_modal_app.py` 27 pass; `test_modal_integration.py` 13 pass; manifest
`--check` OK. Re-run green at the final revision (274/0/2).

Common rows across arms (each reconciled to its manifest subset by
`reconcile-modal-run.mjs`; nonzero-exit gates): **silent missing inputs 0 in
every arm; page-count mismatches 0; sha mismatches 0; cleanup failures 0;
unexpected request ids 0.** Duplicate terminal outputs: 10, all in arm 6 by
design. Retirements: arm 3 `job_budget_exhausted:1` (the 100-job warm-lifetime
budget fired exactly at call 100); arm 8 `node_child_died:2`; arm 9 none
(both injections fire before Node work by design). Container crashes
outside the injected/stopped ones: 0 (container-list snapshots +
FunctionCall outcomes; no OOM observed — every container's log ends with a
clean `service_stopped`, including arm 9's, which survived two method
timeouts: Modal killed the inputs, not the container).

Queue-wait proxy (§12 "when the platform exposes it" — it does not; this is
spawn→method-start estimated as wall − method − readiness, so it includes
waiting behind earlier inputs in the arm's backlog):

| arm | p50 s | p95 s | max s |
|---|---|---|---|
| 2 | 7.7 | 7.7 | 7.7 |
| 3 | 626.3 | 1,062.2 | 1,151.4 |
| 4 | 209.9 | 319.7 | 333.6 |
| 5 | 89.3 | 91.8 | 93.1 |
| 6 | 318.5 | 414.3 | 421.4 |
| 10 | 855.7 | 1,410.5 | 1,536.7 |

Ordinary variance (arm 10 vs arm 3, identical configuration): aggregate
throughput 0.449 vs 0.599 pages/s (arm 10 ran 25% slower; warm p95 46.8 s
vs 29.4 s) — shared-tenancy variance of that order is normal background for
any future latency SLO.

## Scaling arms 3/4/5 (criterion 11)

Actual container counts were exactly 1, 4, and 16 (container-list snapshots
+ per-container logs + `max_concurrent` from log timestamps). Aggregate
throughput over each run window: 0.599 → 1.731 → 3.678 pages/s, i.e.
**2.89× on 4× containers and 6.14× on 16× containers. Scaling is clearly
sublinear on this workload and NO linear-scaling claim is made.** The
dominant loss is cold-start amortization: every container pays 76–95 s of
Node/model readiness, and the 16-container arm's whole window was only 227 s,
so readiness consumed most of each container's life. Efficiency per
container-second (terminal pages / summed container activity incl. boot):
arm 3 ≈ 0.60, arm 4 ≈ 0.46, arm 5 ≈ 0.29 pages per container-second.

## Finding: the deterministic projection is NOT exact across parses — one isolated cause

§14.3 requires `stableDeterministicProjection` (everything except
`provenance.runId`, `provenance.createdAt`, and the OCR-dependent roots) to
be canonically EXACT across repeated parses. Measured:

- arm 3 vs arm 4 (same 100 request ids): critical-token delta **0**,
  raw-line delta **0**, OCR-derived projection exact wherever the score
  projection was exact, sha mismatches 0 — but the deterministic projection
  differed on 75/100 pairs (601/750 pages);
- arm 3 vs arm 5: identical picture (602/750 pages);
- arm 6 duplicates (same request id twice): 108/116 pages.

Every differing page differs **only** in pdf.js font resource labels of the
form `g_d<N>_f<M>` inside `nativeObservations[].font` (and lines derived
from them): masking that one pattern makes **0 of the 601 / 602 / 108
differing pages differ** (`font_mask_check.py` in the raw-results
directory). The `d<N>` component is pdf.js's per-worker-process document
counter — how many documents that worker process has opened before this
one — so it is process-lifetime state, not document content. It varies with
scheduling even under one configuration; it is the same class of volatile
identity as `runId`, but §14.3 fixed the exclusion list and this trial
applies §14.3 as written. OCR content, geometry, text, page identity, and
all derived evidence were exact.

Consequence: criteria 3 and 7 fail as specified. The candidate remedy —
name `font` (or its `g_d<N>` prefix) volatile identity, or normalize the
label at record time — is a §16 M4 "tune once" decision. It was **not**
applied here.

## Null tolerance (§14.3)

Derived from parsing the SAME 100-call manifest twice under the SAME
deployed configuration (arm 3 and arm 10, both mc=1, identical resource
settings), compared before judging arms 4/5:

- critical-token null tolerance: **0** (symmetric difference over 47,191 tokens)
- raw-line null tolerance: **0** (differing lines of 70,588; score sequences identical)

The null pair itself, however, showed the deterministic-projection font
difference on **172/750 pages** — establishing that the criterion-3 failure
occurs under ONE deployed configuration, not only across scaling arms.

Judged against it: arm 4 deltas 0/0 → within tolerance; arm 5 deltas 0/0 →
within tolerance; arm 6 duplicate pairs 0/0 → within tolerance. (OCR was
bit-identical across every comparison in this trial; the previous same-host
control's zero/zero is thereby reproduced on Modal, as evidence, not as a
hard-coded constant.)

## Failure arms

**Arm 7 — external one-shot container stop (§14.2 procedure, no
`--graceful`).** Marked input `m3-corr-04` (31 pages) spawned as
`fc-01M0R2NGN94X6FR80FVZ1KA6V0`; correlated to container
`ta-01M0R2NHCKX7QC7X45XPET3G5R` via `modal container list --json` and
`modal container logs --search` (archived in `arm7/kill-evidence/`);
`modal container stop --yes` issued exactly once at 19:50:06Z, ~12 s after
the marked input's `job_submitted` (19:49:54Z). Modal cancelled and
rescheduled: replacement container `ta-01M0R2RQ9E0BB27XSHGYB43HSR` appeared,
the marked input re-submitted there (reconciler: retried inputs = 1) and
completed on the SAME FunctionCall id with all 31 pages; the two queued
inputs also completed. No partial output was reported complete (criterion 4).

**Arm 8 — Node child terminated during 10 chosen inputs (M2 injection,
dev-app-gated).** `kill-node` on `m3-scale-004`: the child was killed
mid-document on both the original attempt and the configured single retry
(logs: `injected_failure kill-node:2`, `retiring node_child_died:2`, 11
`job_submitted` for 10 inputs); each attempt classified the death, retired
the instance via `stop_fetching_inputs`, and raised — the caller saw a
visible `RuntimeError: node child died mid-parse; instance retired` after
289.5 s total, **not** a hang to the 1,800 s method timeout (criterion 5).
The other 9 inputs completed across the two containers (three before the
first kill, the rest on the replacement; 85/85 pages).

**Arm 9 — forced application exception and method timeout.** Both
injections dev-app-gated (M2). The **timeout** input (`m3-corr-05`,
fc-01M0R3FE7DZBMM2Q96YHS7490N) hung as designed and the platform kill fired
at exactly **1,800 s on BOTH attempts** (injected at 20:03:55 and 20:34:00;
input attempt ids `…:1787515353363-0` and `…:1787517240445-0`), matching
`retries=1`; the caller received a visible
`FunctionTimeoutError: … hit its timeout of 1800s`. The ~30-min-per-attempt
wall is the point of this arm. The **exception** input (`m3-corr-06`,
fc-01M0R3FEYB7H3SR37Y4A508126) ran two attempts (20:33:55 and 21:04:00,
`injected_failure exception:2` in logs) and surfaced as a visible exception
to the caller. One capture-fidelity note: the original arm-9 harness
process was killed locally at ~10 minutes by the operator sandbox's
background-task limit — irrelevant to the calls themselves, which are
durable server-side; a re-attach script (`recover_arm9.py`, in the raw
directory) collected both terminal outcomes by FunctionCall id.
`spawned_at_ms` for these two captures is reconstructed from the
input-attempt-id timestamps; and because the re-attach script did not
import the adapter module, the exception deserialized locally as
`ExecutionError: Could not deserialize remote exception` wrapping the
remote `InjectedFailure` — still a visible terminal failure, counted as
such. The arm-9 container survived both method timeouts (Modal kills the
input, not the container), served the exception attempts in between, and
drained cleanly at scaledown (`service_stopped`, drain 31 ms).

**Probes (criteria 8/9 instruments, dev-gated).** `probe_scratch` during
arm 8's run: `clean: true`, disk used 201,785,344 bytes (≈0.19 GiB of the
512 GiB documented quota); after the run: `clean: true`, 193,978,368 bytes.
`probe_exit_drain` on a live arm-8 container: Node terminated by the @exit
drain, **survivors: [] (zero Node/worker/sidecar processes), scratch
removed, clean: true**.

## Cost (§10) and billing (criterion 12)

Whole-qualification billing report (MANDATORY, criterion 12): captured with
`modal billing report --start 2026-08-23 --end 2026-08-24 [-r h]
--show-resources --json` at 21:36Z (archived under
`.evaluation/modal-qualification/2026-08-23/billing/`). The report is
per-app, so each arm's app tag isolates its billed cost even though the
workspace ran unrelated workloads:

| arm app | billed USD |
|---|---|
| arm2 | $0.0254 |
| arm3 | $0.2249 |
| arm4 | $0.3330 |
| arm5 | $0.5058 |
| arm6 | $0.0841 |
| arm7 | $0.0488 |
| arm8 | $0.0522 |
| arm9 | $0.3975 |
| arm10 | $0.2567 |
| **total** | **$1.9284** (CPU $1.2008 + memory $0.7276) |

Pricing basis: https://modal.com/pricing retrieved 2026-08-23. No free
credits are netted into these figures. Caveat: the 21:00–22:00 UTC interval
was still open at capture time; the arm9/arm10 shares of that hour could
adjust marginally on a post-day re-read (state of capture honestly labeled
per §10). Billed cost runs well above the pure resource-time estimates
below because short runs are dominated by image pull, readiness, and
scaledown idle.

Resource-time cross-check (container activity from log timestamps +
measured readiness, at the dated provisioned rate $0.380448/container-h;
lower bounds — image pull and scaledown idle excluded):

| arm | est. container-s | est. USD |
|---|---|---|
| 2 | 119.6 | $0.0126 |
| 3 | 1,247.4 | $0.1318 |
| 4 | 1,634.9 | $0.1728 |
| 5 | 2,583.3 | $0.2730 |
| 6 | 423.4 | $0.0454 |
| 7 | 277.8 | $0.0294 |
| 8 | 283.7 | $0.0300 |
| 9 | 3,755.7 | $0.3969 |
| 10 | 1,664.6 | $0.1759 |

Trial cap: $15 (owner-approved). The §10 gates were followed: arm 3 ran
fully first; its measured cost projected arms 4/5 far under the cap before
they were deployed. No free credits are included in any unit figure.

Cost per terminal page (README formula, billed total / terminal pages):
**$1.9284 / 3,370 terminal pages = $0.000572 per page ≈ $572 per million
terminal pages** for the whole qualification including all failure arms
(arm 9 spent $0.3975 for 0 pages by design). Restricted to the four
steady 100-call parse arms (3/4/5/10): $1.3204 / 3,000 pages ≈ **$440 per
million terminal pages** — above the design doc's $80–146/M steady-compute
estimate because these short runs are cold-start- and idle-dominated; a
long-lived warm fleet would sit closer to the estimate (arm 3's marginal
warm-window rate: its billed $0.2249 over 750 pages ≈ $300/M, still
including its boot and idle).

## §14.4 acceptance criteria

| # | criterion | outcome | measured |
|---|---|---|---|
| 1 | every request id reconciles to a visible terminal result/exception; zero silent losses | **PASS** | 436 calls across arms 2–10; missing = 0 in every arm's reconciliation; the only exceptions are the injected ones (arm 8: 1, arm 9: 2), all visible to the caller |
| 2 | completed documents carry exactly the probed page count; every page canonical 0.6.0 or explicit failed record | **PASS** | validate-modal-captures over every arm: 3,370 pages schema-valid (0.6.0), 0 failed-page records needed, 0 violations; page-count mismatches 0 |
| 3 | ordinary repeats: hashes match; §14.3 exact/native + derived-null OCR rules | **FAIL (as written)** | hashes matched (0 sha mismatches) and OCR deltas were 0/0, but the deterministic projection differed on 75/100 arm3-vs-arm4 pairs — solely the pdf.js `g_d<N>_f<M>` font label (see Finding) |
| 4 | container kill → visible reschedule + valid terminal result; no partial output | **PASS** | arm 7: 1 retried input, same FunctionCall id, 31/31 pages on the replacement; archived CLI evidence |
| 5 | node-child kill classified and bounded | **PASS** | arm 8: classified `node_child_died`, retired, visible error at 289.5 s ≪ 1,800 s timeout |
| 6 | exception and timeout match configured retry count and are visible | **PASS** | both ran exactly 2 attempts (`retries=1`); timeout killed at 1,800 s each attempt → visible `FunctionTimeoutError`; exception → visible terminal exception; log-attested attempt ids |
| 7 | duplicates pass all three §14.3 projections; digests differ; duplicate compute counted; no paid enrichment | **FAIL (as written)** | duplicate compute counted (10 duplicate terminals, 232 pages billed-time); OCR rules passed 0/0; pageDigest values differ as expected; no enrichment call exists in the adapter (enrichment=off enforced; no GEMINI_API_KEY in the app) — but the deterministic projection differed on 108/116 pages, same single font-label cause as criterion 3 |
| 8 | zero surviving child processes after container exit (explicit probe) | **PASS** | probe_exit_drain: survivors [], scratch removed, clean |
| 9 | job state + uploaded PDF removed after every terminal method; recovered after forced timeout; peak disk below limit | **PASS** | cleanup failures 0 across all arms; probe_scratch clean during and after; the injected timeout fires pre-submit (M2 design) so it creates no job state — after both timeout kills the same container served later methods normally and its @exit drain removed scratch; mid-parse state disposal under kill is covered by arms 7/8 (fresh containers, entry sweep, 0 leftovers); peak observed disk 0.19 GiB ≪ 512 GiB |
| 10 | cold readiness, warm latency, throughput, queue wait, cost reported per arm; per-arm cost labeled billed vs estimate | **PASS** | tables above; per-arm cost is BILLED (the report is per-app, so arm app tags isolate it), with the resource-time table as a labeled cross-check; queue wait reported as the stated proxy (no platform per-input metric) |
| 11 | 1/4/16 arms show actual container counts; no unsupported linear claim | **PASS** | 1/4/16 actual; 0.599/1.731/3.678 pages/s reported as sublinear; no linear claim |
| 12 | billing reconciles with run window and terminal pages; total spend + cost/page stated | **PASS** | per-app billed rows all fall in the 19:00–22:00 UTC intervals of 2026-08-23, matching the recorded arm windows; total **$1.9284**, **$0.000572 per terminal page** ($572/M); open-interval caveat stated |

## Retention

Modal retains Function inputs and outputs (the PDF bytes and parsed
results) for up to 7 days; only approved public evaluation documents were
submitted. Every arm app was stopped immediately after its window (last:
arm10 at 21:35:07Z); the final `modal container list` shows **zero**
running containers and `modal app list` shows **zero** deployed
`pagespatial-parse-arm*` apps.

## What was not verifiable here

- Workspace plan limits: not exposed by the pinned CLI; nothing in the run
  approached a platform limit (max 16 containers requested and observed).
- The 21:00–22:00 UTC billing interval was still open at the 21:36Z
  capture; the arm9/arm10 rows could adjust marginally after day close.
  Everything else in the billing table comes from closed hourly intervals.
- Arm 9's local capture wall clocks are reconstructed (see arm 9 above);
  its two outcomes and retry counts are log- and FunctionCall-attested.

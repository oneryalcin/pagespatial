# Workstreams

The living board. **This document is meant to be edited**: when you pick up
a stream, put your name in the owner column on your branch; when a stream
ships or its status changes, update the row in the same PR that changes it.
GitHub issues carry the detail and the discussion; this page is the map —
one look answers "what is in flight, what is free, what is blocked on what".

Onboarding order: [principles](principles.md) →
[handoff](handoff.md) → [evaluation-debts](evaluation-debts.md) → this page
→ the issue for your stream.

## State snapshot (update the date when you touch this)

*As of 2026-08-26.*

- **main**: through PR #104 (`b96e891`). CI is green. Current record
  versions remain schema 0.6.0 and enrichment-0.2.0.
- **Internal Modal parse is ADOPTED**: the CPU/OpenVINO warm-`Cls` adapter
  passed its 12/12 qualification for controlled internal, parse-only jobs.
  Qualified bounds are 90 MiB input, 200 pages, 64 MiB serialized result,
  100 jobs per warm lifetime, and `max_containers` in `{1, 4, 16}`.
  Enrichment and public ingress remain off. The current Modal adapter has
  `min_containers=0`, `buffer_containers=0`, and no memory snapshot support;
  measured cold readiness remains 70–88 seconds. Trial:
  `docs/trials/2026-08-23-modal-qualification.md`.
- **GPU optimization workstream CLOSED without adoption (PR #104)**:
  M2 selected producer starvation; M3 showed thousands of small recognizer
  calls dominated by TensorRT enqueue and device-to-host transfer, while the
  independent CPU profile named repeated recognizer execution—not PDF
  rendering, crop generation, decoding, or Python scheduling—as the useful
  boundary. The direct treatment rejected B8 (12.7% slower than B1); B4 did
  not demonstrate a causal gain under 74.8% host drift. CPU/OpenVINO remains
  the deployment default. No H100 sweep, split-serving rewrite, M4 kernel
  analysis, or automatic M5 is justified. Trial:
  `docs/trials/2026-08-25-gpu-bottleneck-instrumentation.md`; follow-up issue
  #97 stays as a record, not an active commitment.
- **Standard/Flex service architecture recorded in #105**: private
  PostgreSQL is initially the authoritative job database and queue; object
  storage holds PDFs/results; provider workers use an authenticated
  worker-control API and never receive database credentials. Modal CPU is
  first. AWS Spot is only a measured cost candidate. Flex provisions no
  workers without queued demand. No SQS, Kubernetes, custom multi-cloud
  scheduler, or GPU tier is justified for v1.
- **Not public-service ready**: #76 owns auth, tenancy, quotas, storage and
  retention; #87 owns streaming upload, admission, idempotency and
  incremental polling; #105 owns the durable queue and demand-driven worker
  control; #83 owns runtime dependency slimming. The existing HTTP service
  is for a trusted caller and local disk is not a horizontally shared job
  store.
- **Retrieval thesis measured (issue #36 CLOSED)**: pre-registered
  outcome "flat everywhere" — trust metadata does NOT pay in ranking,
  not even the corroboration links (five-way ablation, n=101 queries,
  case series over system-conditioned queries). A trust-free
  duplicate-drop is the strong ingestion baseline (+13 hit@5); gating
  drops where it should downweight (7 answers structurally excluded).
  Redirect: answer verification/citation is where trust metadata's value
  is now hypothesized — future work in the trial doc.
- **Batch 6 sittings DONE (PR #47)**: annotator agreement **99.5%**
  (394 rows, drift 0, zero digit-class disagreements) — the ledger-wide
  noise floor is ~0.5%, 0% on digits. Silver spot-check: 0/30 →
  **silver error ≤9.5% at 95%** (quote the bound). Ledger rows updated;
  aggregates committed under `evaluation/gold/`.
- **Clean-rate preconditions** (from PR #44's closure review): no
  escalation-recall rate exists until (a) prior batches' clean pages get
  a no-miss re-review, and (b) prior outcomes are re-evaluated against
  the union run root. Stated in the evaluator's own caveats.
- **Recall figures corrected upward** (PR #35): a currency-symbol scoring
  bug made 135/145 "missed-by-both" tokens false misses. Batch 3
  86.1→98.8%, batch 4 67.8→95.9%, batch 5 95.7%. PR #30's description is
  stale on batch 4; the ledger carries the dated correction.
- **Row 9: instances confirmed, RATE WITHDRAWN** (correction to the
  previous snapshot, which quoted 6/16 / 18.8% from PR #35's pre-review
  description): 6 clean pages hold a token neither engine read, 3
  substantive — a case series refuting "clean = fully read". The batch-5
  sampler's selection is circular (eligibility keyed on `criticalCount`,
  computed from the extractors under measurement) and its denominator
  excludes silver-only clean successes, so **no rate is trustworthy yet**.
  See ledger row 9.

**READY FOR HANDOFF (2026-08-23): `docs/design/2026-08-23-service-deployment-and-enrichment.md`**
— the implementation brief for the two gaps between today's service and a
deployable one: **M1** container + Linux verification (`linux/amd64`;
OpenVINO is x86-only), **M2** request-plan extraction to the library,
**M3** service enrichment phase, **M4** real-corpus run. M1 and M2 are
parallel; each milestone has measurable acceptance criteria. Survived two
cold-review rounds (6 blockers + 6 follow-ups), notably: enrichment must
render its **own 150 dpi** raster (the service parses at 115.2 dpi and
Gemini bills by pixels — reusing the parse raster silently invalidates the
cost ladder), enrichment artifacts must not live in `pages/`
(`checkCompletion` counts files there), and `pdfPath` + enrichment is a
data-egress primitive and is refused. **Three open questions for the owner
are listed at the end of the doc — ANSWERED 2026-08-23** (enrichment
default off; cost-cap env defaults; dev-v13 stays authoritative on EP
surprises). The commercial API surface (auth, quotas, storage, tenancy)
is tracked-not-scheduled as **#76**. **ALL FOUR MILESTONES ARE
IMPLEMENTED AND MEASURED (2026-08-23)**: M1 container + Linux
verification (PR #82, `docs/trials/2026-08-23-linux-verification.md` —
all four criteria; see the M1 result block in the sidecar entry below);
M2 request-plan extraction (PR #80); M3 service enrichment phase
(PR #81); **M4 real-corpus enrichment run + all five workstream-2
acceptance criteria (`docs/trials/2026-08-23-m4-corpus-enrichment.md`):
routing parity zero-mismatch on the replayed dev-v13 records (84
qualifying of 162; 80 adj + 4 full), $0.001458/enriched page on the
container vs the reconciled ladder's $0.001454 (+0.3%), gold∩blocking
gain 332→338 (+6, committed floor +1), /v1/metrics exactly equal to the
job manifests, and enrichment costing ~3% of parse CPU (second 150 dpi
render pass ~0.34 core-s/page; enrichment wall is Gemini batch
turnaround). Total milestone spend $0.24. The cost-ladder discrepancy
the design flagged is reconciled: 11.4× at $0.000817 is correct (this
file was already right); the batch trial doc now carries the dated
correction.**

**Decision history and next actions (updated 2026-08-26; ranked by the
rabbit-hole test, principles §9):**

1. ~~First extractor-blind clean batch~~ **DONE (batch7-clean-v1,
   2026-08-22), CORRECTED same day (PRs #58/#60)**: the "1/15
   substantive miss" was a scoring artifact — every witness read the
   p144 ink; the tokenizer glued `+ 16` into a signed token bare `16`
   cannot match. **Corrected: 0/15 substantive, 95% CP upper bound
   18.1%.** The same re-check dissolved most of row 9's older case
   series (four glue classes catalogued: currency/sign/date/unit-tail);
   **the clean≠fully-read refutation survives on exactly ONE page**
   (osf p10: PP-OCR misread + no alarm; Tesseract saw the figures but
   is inadmissible by design). Fix location (tokenizer vs matcher) is
   an OPEN era-sensitive design decision — owner's call; a matcher-side
   "split glued alphanumeric boundaries" rule likely covers sign, date,
   and unit-tail at once. Remaining for the union rate: no-miss
   re-review of the 27 prior-labeled clean pages.
2. **Parse-service pivot: ALL THREE STREAMS SHIPPED (2026-08-22 night,
   PRs #53/#54/#55 — each through cold-review → fix → closure cycles):**
   - **#51 SVG reconstructor**: merged, issue closed. `reconstructSvg()`
     in the library; byte-honest text+layout skeleton with trust states
     drawn in.
   - **#22 skeleton**: merged. API (submit → ticket → progressive
     0.6.0 records), atomic disk-backed jobs, TWO-sided
     canonical-witness gate, mixed-document records impossible by
     construction, degraded-pool → 503. First bottleneck table: render
     p50 296ms (40× native), 8.9 pages/sec on 4 laptop workers,
     OCR column pending integration.
   - **#2-now server witness**: merged. Identical PP-OCR pipeline under
     Node (WASM EP): **near-equivalent with documented deltas**
     (91.7%/91.4% token agreement, IoU 0.922, gold +10 to node of
     1,223; JA preserved). NOT yet a "tie" — the McNemar
     discordant-pair analysis is the first post-merge task (issue #2),
     and the comparison is cross-engine-cross-host (browser=WebGPU,
     node=WASM — which IS the production swap, labeled as such).
     **3.7 s/page is the WASM-EP cost, not "the CPU cost"** — and once
     this witness wires in, **OCR dominates render ~12:1**, so the
     speed arms in order: native EP with the same models, THEN render
     batching, THEN (only if numbers demand) GPU. The skeleton's
     "render is the bottleneck" table was the stub era; do not optimize
     296ms while 3.7s burns.
   **#22 v1 COMPLETE (PR #62, 2026-08-22): witness swap ADOPTED by the
   owner** (conditions on #2: backend pinned in config+provenance — no
   'auto'; calibration diff before dev-v13). The service runs the real
   witness end to end: 176/176 canonical records, SVG endpoint live,
   second opinion engaging on starved pages. **Full-pipeline profile:
   OCR = 88% of wall (6.5 s/page p50 WASM under load), 0.54 pages/sec,
   budget ~2.3 GB OS-max RSS/worker (9 GB for 4).** *(Mac/WASM figures —
   superseded by the M1 target-hardware block below.)*
   **HPI GATE RUN (PR #64, Modal, 2026-08-23): the sidecar earns it.**
   *(Gate-run OCR-only figures — superseded by the M1 full-pipeline
   numbers below. Unit correction 2026-08-23: "vCPU" in this entry
   means Modal `cpu=N` = N PHYSICAL cores; the "1-vCPU packing unit"
   conclusion is retracted as a general claim — see the linux
   verification trial's correction block.)*
   HPI CPU (OpenVINO, v6-small) = 989 ms/page on 4 vCPU (~4
   core-s/page vs WASM's ~26 — ~6× core-efficiency; the 6.6× latency
   multiplier is cross-machine, stated as approximate). **GPU scope
   correction 2026-08-24:** the T4 arm was sequential default Paddle GPU in
   a separate function/container; it did not beat the tested OpenVINO arm.
   GPU HPI/FP16/batching/L4 were untested, and Small is ~7.7M combined
   parameters (1.5M is Tiny). The general “GPU dead” and L40 claims are
   retracted. **Bounded follow-up completed 2026-08-24:** on one L4, serial
   Tiny was 1.71x the CPU control and serial Small 1.13x. Recognition batching
   made Tiny another 1.72x faster within one window, but every faster batched
   arm failed the predeclared output-equivalence gate. CUDA 12.6 HPI selected
   default Paddle Inference and was slower; ONNX Runtime GPU was about 40%
   slower and non-equivalent. **TensorRT follow-up, same date:** the smaller
   official PaddlePaddle CUDA 11.8/cuDNN 8.9/TRT 8.6 image ran successfully
   with attested ORT detection and TensorRT recognition. On the fixed 32-page
   English diagnostic, Small reached 1.269 pages/s FP32 and 1.324 FP16 at B1
   versus 0.614 CPU; B4 was slower. Tiny reached 2.312 FP16 B1 and 2.424 B8
   versus 0.677 CPU. Precision and CPU comparisons cross app windows and are
   screening results, not causal effects. Every arm had zero repeat-to-repeat
   critical-token, raw-line, and score delta, but precision/batch changes failed the zero-noise
   equivalence gate. Small's diagnostic warm resource estimate is about
   $221-230/M prepared pages versus the 8-GiB harness CPU's $114/M; the
   end-to-end billed production cost gate was not run. Engine builds took
   351-931 seconds. **Smallest continuation, same date:** the runtime error was
   traced to UltraInfer destroying `IRuntime` before its deserialized engine.
   An integrity-pinned lifetime patch passed both fresh-build and cached-load
   L4 probes, but patched Small FP32 retained four critical-token multiset
   differences on an image-adjudicated page (`2023-04-04` became
   `2022-04-04`). **Owner acceptance amendment, same date:** raw OCR
   equivalence is diagnostic; the product gate is zero newly incorrect,
   missing, or unresolved critical values in trusted, non-escalated output. Replaying all
   32 frozen pages through the real native/OCR merge exposed and fixed a
   narrow standalone-numeric conflict blind spot. After the fix, both wrong
   dates create exact native-backed blocking conflicts in the default-GPU
   isolation comparison. The separate production-control replay uses CPU
   OpenVINO: 42 candidate-only and 40 control-only occurrences across 12
   pages; 81 are confined to pages escalated in both arms, and the sole
   trusted-output difference (`1|mayor`) is source-correct. All three repeats
   pass with 14/32 non-escalated pages in each arm and zero route changes. The
   complete 162-page
   baseline has zero escalated/non-escalated route transitions under the
   merge change; one advisory-only page becomes newly blocking, so future
   enrichment economics must include it. Small still stops before engine baking, B16/B32, producer
   concurrency, A2, and the 50-page run because its diagnostic prepared-page
   cost is about $221/M versus CPU's $114/M and Small batching is slower. No
   end-to-end 50-page result exists. No engine advanced to A2; CPU
   remains the deployment default and the candidate holdout stayed unopened. Design:
   `docs/design/2026-08-24-gpu-ocr-spike.md`; trial:
   `docs/trials/2026-08-24-gpu-ocr-spike.md`.
   v6-medium:
   no gold gain at 2× cost. Scaling curve (PR #66): latency FLAT 1–8
   vCPU → **1-vCPU workers are the packing unit, ~1.45 core-s/page
   (~18× WASM core-efficiency)**. *(Ad-hoc Modal OCR-only figures —
   superseded by the M1 full-pipeline numbers below.)*
   **ADOPTED AND INTEGRATED (owner decision 2026-08-22; PRs #67 + #69
   merged).** The sidecar is the service's canonical OCR witness:
   subprocess-per-worker JSONL protocol, hash-pinned models
   (refuse-to-boot on mismatch; det pin ceremony-observed, rec
   behaviorally validated), per-host-truthful provenance, group-kill
   child lifecycle with per-page recognize deadline — two demonstrated
   lifecycle HIGHs fixed and re-verified by repro. Integration-path
   sanity: 438/438 gold parity with the ceremony. WASM witness =
   explicit fallback; browser = dev environment. **dev-v13 CUT (PR #71)
   — see the reference-baseline line below. ~~Remaining era item:
   target-hardware (Linux/OpenVINO) re-measure at deploy + same-host EP
   control~~ **DONE (M1, 2026-08-23 —
   `docs/trials/2026-08-23-linux-verification.md`): same-host EP control
   is CLEAN — hpi/hpi bit-identical (null tolerance 0), cross-EP delta 0
   critical tokens / 1 raw line of 3,890, gold identical (413/560) in
   all three arms; the ceremony's ±4-token spread was container
   variance, not EP variance. `ep=hpi` now lands IN-BAND in every
   record's provenance (`useHpip` introspected from the pipeline
   object), closing the #64/#67 follow-up. Target-hardware numbers
   (which SUPERSEDE every Mac/WASM and ad-hoc Modal figure; unit
   correction 2026-08-23 — Modal `cpu=N` = N physical cores, not
   vCPUs): 3.0–5.5 requested-physical-core-s/page full-pipeline
   (shared-tenancy range); on one 4-physical-core allocation, four
   one-thread workers beat one four-thread worker by 2.7–4.9× —
   a single-allocation result, NOT a general packing unit, and fleet
   linearity is unmeasured; boot-to-ready 70–88 s cold (OpenVINO engine build),
   ~5 s on worker respawn in a warm container; ~2.7 GB per worker-pair
   (cgroup, 10.9 GB for 4). The committed Dockerfile is the deployment
   unit — linux/amd64, engine+weight pins asserted at build time, baked
   models failing the build on hash mismatch, `/health` readiness
   gating traffic, SIGTERM drain verified to leave ZERO surviving
   Python processes with the interrupted job resuming on restart —
   verified under Modal's (gVisor) init, not plain `docker run --init`,
   and with USER skipped by Modal, so the non-root user and the docker
   `--init` reaping path await a first-real-host smoke.**
   **MODAL DEPLOYMENT ADOPTED for internal parse jobs (owner decision
   2026-08-23, M4 tune-once)** — the warm-Cls adapter
   (`deploy/modal/`, PRs #88/#89/#90/#91) passed the §14 qualification
   **12/12** after one spec amendment (`nativeObservations[].font` is
   volatile identity — the two initial FAILs were 100% that field;
   re-judged from archived captures at zero cost). Measured: $1.93
   total gauntlet, $0.000572/terminal page (~$440/M steady, ~$300/M
   single-container 100-call billed arm — boot/idle-inclusive, not a
   measured warm-fleet marginal); 0.60/1.73/3.68 pages/s at 1/4/16 containers
   (sublinear, stated); every failure mode bounded and visible
   (platform timeout at exactly 1,800 s; container-kill reschedule
   clean; zero surviving processes). Prototype limits stand (90 MiB /
   200 pages / 64 MiB / 100 jobs/lifetime; enrichment OFF; no public
   ingress). Trial: `docs/trials/2026-08-23-modal-qualification.md`
   (+ M4 addendum). Production remote API (#76) and distributed
   enrichment remain gated per the design's §15/§13.
   Ceremony record (PR #67): Three
   witnesses on 90 pages: candidate ≡ server witness (2 discordant
   tokens of 1,223; 98.7% byte-identical raw lines), candidate-worse
   vs browser bounded at 0.74% at 95%; calibration drift negligible
   (no re-tuning); box-IoU 0.915, no drift pages. Integration
   preconditions (owed by the integration PR): model-revision PINNING
   (ceremony only OBSERVED det, rec unverified), in-band C++ backend
   capture, baked-model boot-cost measure, target-hardware re-measure,
   provenance pins, canonical gate unchanged, dev-v13 on first
   post-adoption corpus run. Output stability: ~±4 gold tokens across
   containers, not bit-stable. LOW follow-ups recorded on #22.
   The p144 differential RESOLVED the hypothesis by dissolving it (PR
   #58): no witness ever missed the ink — the scorer did (sign-glue).
   The render-sensitivity hypothesis is dead; see item 1 above for the
   corrected row-9 state. **Equivalence upgraded with earned stats (PR
   #59)**: McNemar p=0.25 on 36-vs-26 discordants; the quotable form is
   "near-equivalent, node-worse bounded at 0.5% of gold at 95%" — the
   direction the swap decision cares about.

Demoted (deliberate, not forgotten): #21 ingestion contract + the
**answer-faithfulness harness** (folded into #21) — both wait for the
service and a consumer; the #36 chunk-contract anchor is recorded on
#21 for when it unparks. Silver-bound tightening: only if a consumer
needs <9.5%.

Parked, unscheduled: the #4 chart triage hour (re-run batch 2 through the
current scorer; decides instrument-fix vs detector-project).
- **Row 4 retraction**: "272/272 correct" did not survive independent
  audit (25/29 agree); **"zero wrong-side" stands** and is the only form
  the economics quote. Furniture test now in prompt + audit page.
- **Reference baseline (sidecar era, current): `dev-v13-sidecar-2026-08-23`**
  (PR #71; 162/162 pages, 0 failures, dirty:false with the workspace hash
  reproducing from `git archive`, witness + model pins in every envelope,
  `backend: {paddle-default: 162}`). Browser-era reference stays
  `dev-v12-cross-family-2026-08-20`; **cross-era comparisons at gold level
  only** — the trial doc publishes the diagnostics deltas as the swap's
  fingerprint, and like-for-like most of them vanish (first-pass OCR counts
  20 apart of ~15,100; sourceMatches 3 apart; association coverage
  unchanged; native observations unchanged in count/text/geometry/identity).
  Gold: the 18-token gap splits into **−11 from the absent region-recovery
  layer** (worth ~0.9pp and missing server-side — #10/#13) and **−7 from the
  witness swap**, with the renderer confound killed by two controls
  (geometry identical on all 162 pages; Tesseract byte-identical on all 27
  second-opinion pages). New follow-ups: #72 (dist/ outside the workspace
  hash), #73 (schema fail-open seams), #74 (summary field duplication +
  generator-hash regeneration obligation).
- **Escalation economics CLOSED** (issues #17/#20): $0.0093 →
  **$0.000817/corpus page measured (11.4×; owner's 10× target exceeded)**
  under a test-enforced zero-interactive-calls invariant
  (`test/enrichment-runner.test.mjs`). Recall via the committed
  `scripts/evaluation/score-enrichment-recall.mjs`.

## Streams

| Stream | Issue | Status | Owner | Touches | Blocked by |
|---|---|---|---|---|---|
| Gold extension (human batches) | #1 | **in progress — batches 3–5 shipped (PRs #27/#30/#35)**: ~75 pages labelled incl. 27 clean; rows 1/4/7/8 measured. Known gaps: single annotator (**batch 6 amendment: double-label ~20 stratified pages for an inter-annotator noise floor** — see issue comment); row 1b uncollectable by the digit-only pre-labeler | — | evaluation/gold, review.html flow | nothing |
| Escalation recall (clean-page silent misses) | #29 | **instances confirmed, rate withdrawn (PR #35 review)**: sound sampling needs (a) selection from ALL non-escalated pages independent of extractor output, (b) a page-level "no miss found here" verdict in the review UI so verified negatives can enter a denominator | — | sampler tiering, review UI, diagnostics | nothing |
| Retrieval harness (does trust metadata move retrieval?) | #36 | **closed — measured flat**: trust metadata did not improve ranking; trust-free duplicate-drop is the ingestion baseline. Future hypothesis moved to answer verification/citation. | — | — | — |
| Malformed-PDF fuzz pass (fail-closed degradation) | #37 | open — bounded; synthetic hostile PDFs; one bad page must not kill a document | — | test/, scripts | nothing |
| Adjudication spot-check (audit the 272/272) | #31 | **shipped** (PR #33): 25/29 agree; "272/272" retracted, "zero wrong-side" survives. Optional follow-up: second batch on the digits-differ class (11/15) | — | — | — |
| Server-GPU OCR adapter (privacy-constrained deployments) | #2 | open — **gated: re-measure JA/chart recovery recall on current main first** (CMap fix + zoom-retry shipped since the motivating number; see issue comment) | — | new node/server module | the re-measure |
| Index ingestion spec (consumption contract) | #21 | open — design doc only | — | docs/ | nothing |
| Recovery tile budget (cost bound) | #13 | open — small, well-specified; good first task | — | src/browser/region-recovery.ts, tuning | nothing |
| Batch API + residue-crop rungs | #20 | **shipped** (PR #23) | session | — | — |
| Internal Modal parse deployment | #22 | **adopted within qualified bounds**: CPU/OpenVINO warm `Cls`, parse-only, no public ingress. Production service work is split into #76/#87/#105. | — | deploy/modal, service | public product contract |
| Standard/Flex service execution | #105 | **designed, not implemented**: PostgreSQL job/lease queue, object storage, authenticated worker-control API, demand-driven Modal CPU first; AWS Spot only after a measured cost win. | — | service API, job store, worker adapters | #76 and #87 product decisions |
| Public/commercial API | #76 | **open, tracked-not-scheduled**: auth, tenant isolation, quotas, retention, public API contract. | — | gateway, storage, service contract | real consumer requirements |
| HTTP admission and idempotency | #87 | **open**: stream uploads, reject overload before buffering, `429`, idempotency key, queue metrics, incremental polling. | — | service HTTP API | service-tier limits |
| Service dependency slimming | #83 | **open, bounded**: express real runtime dependencies and stop copying the full dev toolchain into the image. | — | package manifests, Dockerfile | nothing |
| GPU bottleneck follow-up | #97 | **parked**: instrumentation and B1/B4/B8 treatments did not earn a GPU deployment change. Resume only for a new measured hypothesis. | — | evaluation only | concrete throughput/cost trigger |
| pdf-inspector WASM in browser (markdown parity) | #25 | open — low priority; CJK/CMap gate first (monotaro p61); pair with native 1.14.2→1.15.0 bump | — | src/browser, package.json | nothing |
| Cross-family second opinion | PR #19 | **shipped** | session | — | — |
| Pictorial threshold + residue-severity data check | #14 | parked, gold-gated | — | tuning, ink.ts | #1 |
| Conflict triage taxonomy | #5 | parked, gold-gated | — | evaluation | #1 |
| Silver-tier spot check + review follow-ups | #8 | parked, gold-gated | — | evaluation | #1 |

## House rules (short form — principles.md is the law)

- **Measure before building**; every quoted number says what it measures
  and its sample size (evaluation-debts.md tracks thin-gold claims).
- **The independence check** (principles §8, five questions, answered in
  writing before a number is quoted): no instrument's denominator,
  eligibility, ranking, or presentation may read the system under test;
  confirmed negatives are recorded, never inferred from silence. Any
  violation makes the result a case series, said in the same sentence as
  the number. Broken three times in one week before it became a checklist.
- No threshold tuning without gold labels.
- Every PR gets an adversarial review pass before merge; findings are
  fixed or explicitly tracked, never quietly dropped.
- Schema/evidence-definition changes bump the version; prior-era records
  fail closed; baselines are comparable only within an era.
- Never mutate a canonical record — enrichment and second passes are
  separate, digest-bound revision records.
- Branch always; never commit to main; visible retraction when a
  published claim turns out wrong.

## Operational gotchas

- **Never `npm run build` while a corpus evaluation is running** — Vite
  serves the browser client from `dist/` and hot-reloads the page, which
  destroys the OCR bridge and fails the rest of the run.
- The working Gemini key is the `AQ.…` one (line 6 of the owner's fish
  env); `thinkingBudget: 0` + `responseSchema` are load-bearing for cost
  and JSON validity.
- `pdftoppm` (poppler) and `tesseract` must be on PATH for the harness's
  node-side passes.
- Corpus runs live under `.evaluation/` (gitignored, private text);
  committed summaries go to `evaluation/baselines/`.

# M1 Linux verification: the container earns its numbers

**Date:** 2026-08-23 · **Branch:** `m1-container-linux` · **Design:**
`docs/design/2026-08-23-service-deployment-and-enrichment.md` (workstream 1)
· **Issue:** deployment milestone M1

> **Correction (2026-08-23, cold review of the Modal scaling design):**
> every "vCPU" label in this document is wrong as a unit. Modal's `cpu=N`
> requests **N physical cores** (each shown as two vCPU threads on
> Modal's pricing page — [resources](https://modal.com/docs/guide/resources),
> [pricing](https://modal.com/pricing)), so "1 vCPU" below means
> `cpu=1.0` = one physical core, and "4-vCPU container" means `cpu=4.0`
> = four physical cores with 24 GiB. The **measured values stand** (wall
> times, pages/s, `/proc` CPU-seconds, and the within-allocation
> comparison), but the corrected, limited conclusions are:
> four one-thread service workers beat one four-thread worker by
> 2.7–4.9× **on the same Modal allocation of four physical cores**;
> "3.0–5.5 core-s/page" is **requested-physical-core-seconds per page**,
> not vCPU-seconds; and the result does **not** establish
> one-vCPU-per-worker packing on other platforms — the packing unit
> claim is retracted. Single-container measurements; fleet linearity
> unmeasured. Authoritative statement:
> `docs/design/2026-08-23-modal-scaling-and-deployment.md` §3.6.

First run of the parse service on its target platform (linux/amd64,
OpenVINO HPI). Four acceptance criteria from the design doc, each a
measurement. Committed instruments reproduce the whole run:
`scripts/evaluation/m1_linux_verification_modal.py` (measurement),
`scripts/evaluation/build-corpus-subset-pdfs.mjs` (input),
`scripts/evaluation/score-ep-control.mjs` (criterion 2 scoring). Raw
outputs (corpus-derived) live in gitignored `.evaluation/m1-linux/`; this
document carries counts only.

## Environment: the measurement environment IS the deployment unit

The Modal image is built **from the committed Dockerfile** —
`modal.Image.from_dockerfile` on Modal's linux/amd64 builder — not a
parallel environment claimed equivalent. Same pins (`paddleocr==3.7.0`,
`paddlepaddle==3.2.1`, ultra-infer-python 1.2.0 via
`paddleocr install_hpi_deps cpu`), same baked hash-verified models, same
env vars (`SERVICE_SIDECAR_PYTHON=/opt/paddle/bin/python`,
`SERVICE_SIDECAR_MODELS_DIR=/opt/models`), same Node (v26.7.0). The
Dockerfile therefore **builds, verifiably** — every stage ran, including
the model bake (fetch_models verify mode) and both build-time assertions.

Honest deviations of the Modal harness from a production `docker run`:

- Modal **skips `USER` and `EXPOSE`** ("unsupported by Modal container
  images") and runs the container as root under gVisor with Modal's own
  init — so the **non-root user and the `docker run --init` reaping path
  are built but not exercised here**. The SIGTERM drain below is measured
  with the server as a non-PID-1 child, which is also how it runs under
  tini. A plain-docker smoke of `--init` + non-root remains open (no
  local x86 Docker host; QEMU emulation of paddle was ruled prohibitive).
- Modal layers its client runtime (an added Python at `/usr/local`) on
  top of the image; the sidecar pipeline uses `/opt/paddle/bin/python`
  explicitly and is unaffected.
- Modal is shared tenancy: the HPI benchmark observed ±50% cross-container
  variance on per-config latency. Within-run comparisons (the EP control,
  the two packings run minutes apart) are the load-bearing ones.

Boot-time verification observed in the image (probe run): model pins on
disk match the ceremony lineage (det `106c9759…`, rec `bd619643…`),
sidecar `--check` exit 0, and — answering the ceremony's open boot-cost
item — **cold engine construction with baked models: `initS` 67.3 s on
1 vCPU** (no HF download; OpenVINO engine build dominates). The known
`cpu_num_threads=10` backend-internal default reappears (the accepted
`cpu_threads=1` kwarg does not reach the C++ layer; the cgroup caps real
parallelism), same as the ceremony.

### A build bug this verification caught

The first image build silently produced a **paddle-default** container:
`install_hpi_deps` shells out to a bare `paddlex` (not on PATH in that
`RUN`), and a trailing `|| true` swallowed the traceback. The Dockerfile
now puts the venv on PATH for that step, swallows nothing, and asserts
`import ultra_infer, paddle2onnx` at build time — the exact module
paddlex's own `is_dep_available("ultra-infer")` checks. A container
without the HPI engine can no longer build.

## Criterion 1 — in-band EP evidence: PASS

`ep=hpi` is captured **inside the result payload**, closing the PR #64/#67
follow-up. From a page record produced by the 4×1 corpus run (provenance
block, no log scraping involved):

```
provenance.ocrAdapter: "ppocrv6-small-sidecar@3.7.0#ep=hpi;threads=1"
provenance.configuration.ocrBackend: {
  executionProvider: "hpi", hpiRequested: true, useHpip: true,
  platform: "Linux", modelPins: { det: 106c9759…, rec: bd619643… } }
```

The chain is introspection all the way down: the sidecar child probes the
pipeline object's own `use_hpip` attribute (the attributes the adoption
ceremony verified), reports it in its meta line, and `descriptorFor`
derives `ep=` from that testimony — never asserted. The C++
engine-selection line remains **log-derived** and stays labeled as such in
`engineEvidence` (`Backend::OPENVINO in Device::CPU` observed on this
image's stderr); that channel is now corroboration, not the evidence.
`GET /health` additionally exposes each worker's `executionProvider: hpi`
before any job runs.

## Criterion 2 — same-host EP control: PASS, delta zero

One container (1 vCPU), one fixed page set (the 32-page hpi-bench set),
three passes through the REAL sidecar script with fresh engine instances:
`ep=hpi` twice, then `ep=paddle-default` once (`SIDECAR_DISABLE_HPI=1`,
the knob added for this control). In-band meta per run: `useHpip`
true/true/false. Scored two ways (`score-ep-control.mjs`;
`score-candidate-witness.mjs` per arm):

| comparison | critical-token symmetric difference | raw lines differing |
|---|---|---|
| hpi run A vs hpi run B (**derived null tolerance**) | **0** of 2,319 | 0 of 3,890 — byte-identical texts AND scores |
| hpi vs paddle-default (**cross-EP delta**) | **0** of 2,319 | 1 of 3,890 (non-critical text; max paired score delta 0.023374) |

The raw-line/score comparison is `score-ep-control.mjs`'s `rawLines_*`
blocks (position-wise per page, byte equality on text, exact equality on
scores) — first run ad-hoc during the review of the results, then
committed as part of the scorer and re-run to reproduce these exact
numbers (cold-review PR #82 provenance fix).

Gold framing (same scorer as the ceremony, dev-v12 reference + 560 gold
tokens on the 23 gold pages in-sample): **all three arms score identically
— 413/560 gold, 1966/2319 agreement, IoU 0.926 (default 0.924)**.

Verdict: on one host the EP changes **speed only** — hpi/hpi is
bit-stable, and the cross-EP delta (0 critical tokens, 1 raw line) sits at
the derived tolerance. The ceremony's "~±4 tokens across containers" was
therefore **container-to-container variance, not EP variance** — this
control separates the two for the first time. No era decision is
triggered; `dev-v13` remains authoritative (owner's standing answer), and
`ep=hpi` diagnostics may now be compared against the `paddle-default`
reference under the era rule, this control being on record.

Speed, same container (warm p50 ms/page, 1 vCPU): hpi 1,547 / 1,677 vs
paddle-default 8,519 — **~5.4× same-host**, the first clean same-host EP
multiplier (the benchmark's 6.6×/3.7× were cross-machine). Engine-build
cost: first hpi construction 70.4 s; the second **5.0 s** — the OpenVINO
engine cache is warm within a container, so a worker respawn after the
first boot does NOT re-pay the build (answering the restart-storm concern
from the benchmark's operational notes; a fresh container still pays it
once, see `/health` readiness times below).

## Criterion 3 — throughput and footprint on target hardware: measured, with stated variance

Full 162-page development corpus (23 per-document subset PDFs, qpdf-
lossless page copies — page numbering remapped, so these runs measure
throughput, never record-level parity), submitted to the real service over
HTTP, all records canonical, **162/162 ok, zero failures, zero retries**
in every run. Configuration stated per the criterion: 4-vCPU container,
worker count × `SERVICE_SIDECAR_THREADS` as below.

| packing | wall s | pages/sec | pages/sec/core | core-s/page | OCR p50 ms |
|---|---|---|---|---|---|
| **4×1 vCPU, run A** | 122.2 | 1.326 | 0.331 | 3.0 | 1,174 |
| **4×1 vCPU, run B** | 224.1 | 0.723 | 0.181 | 5.5 | 2,533 |
| **1×4 vCPU** | 605.0 | 0.268 | 0.067 | 14.9 | 1,980 |

- **The topology hypothesis is confirmed as a hypothesis-test, not
  assumed**: 4×1 beats 1×4 by **2.7–4.9×** on identical hardware — the
  model gains almost nothing from 4 threads (1×4's OCR p50 1,980 ms vs
  4×1's contended 1,174–2,533 ms), so N single-vCPU workers remain the
  packing unit.
- **Run-to-run variance on shared tenancy is large (run A vs run B: 1.8×
  same config, minutes apart)** — consistent with the benchmark's ±50%
  caveat. The honest target-hardware statement is a RANGE:
  **~3.0–5.5 core-s/page full-pipeline** (render + native + OCR +
  assembly + second opinions on 27 pages), i.e. **0.7–1.3 pages/sec on a
  4-vCPU box**. A production deployment on pinned hardware should
  re-measure once and record its own number; these figures replace the
  Mac/Modal figures in the living docs until then.
- Boot-to-ready (`/health`, includes model verification, sidecar `--check`,
  and a warm-up inference on every worker with the HPI engine build):
  **70–88 s cold container** across all runs. `saw503BeforeReady: true`
  in every run — readiness gating observed doing its job on Linux.
- Stage profile (4×1 run A p50): render 319 ms, native 44 ms, OCR
  1,174 ms, assembly 30 ms; Tesseract second opinion engaged on 27/162
  pages (the same 27-page count as dev-v13 — subsetting did not change
  escalation-driven engagement), p50 3,975 ms.

**Footprint (OS-derived, not process.memoryUsage).** gVisor's procfs
exposes no `VmHWM` and no cgroup peak file, so the numbers are 2 s-sampled
maxima of `/proc/<pid>/status VmRSS` (a **lower bound** on the true
high-water mark) plus the cgroup's live usage:

- cgroup total at end of the 4×1 run: **10.95 GB** for the whole container
  (server + 4 workers + 4 sidecars) — **~2.7 GB per worker-pair**
  amortized, in line with the ~2 GB/worker Mac budget plus contingency.
- Sampled per-process VmRSS maxima: sidecar Python 6.4–7.3 GB each,
  worker Node ~0.69–0.71 GB, server 0.37 GB. The per-process sidecar
  figures **sum to far more than the cgroup total**, so gVisor's per-
  process VmRSS multiply counts shared mappings; the cgroup figure is the
  deployable number, the per-process ones are labeled ranges only. A
  cgroup-v2 `memory.peak` reading on plain Docker/k8s remains the cleaner
  instrument — noted for the production host's one-time re-measure.

## Criterion 4 — failure behaviour under containerisation: PASS

All probes inside the container image, real sidecar engine, 2 workers
(`failure.json`; `failure_local` task):

| probe | result |
|---|---|
| SIGKILL a **worker** mid-job | job completed 9/9 ok; `maxAttempts: 2` — the in-flight page was requeued and finished on a fresh worker |
| SIGKILL a **Python sidecar** mid-job | `respawned: true`, job completed 11/11 ok (the kill landed between predicts — no page needed a retry; the mid-predict fail-closed path is separately pinned by the adapter unit tests) |
| SIGTERM **mid-job** | server exited 0 in **4.7 s**; PID probe over `/proc`: **zero** surviving `ppocr_sidecar` / `worker.mjs` / `server.mjs` processes |
| restart after that SIGTERM | boot resumed the interrupted job to `completed` (9/9) — disk-backed queue state survived the drain |
| corrupt page fails closed, siblings unaffected | page 2 `ok:false` after 2 attempts; pages 1 and 3 `ok:true` |
| two further SIGTERM drains (idle + post-resume) | exit 0, 3.1 s each, zero survivors |

Two honest labels:

- **The corrupt-page probe runs the stub adapter's failure hook**
  (`STUB_FAIL_PAGE`), not a crafted corrupt PDF: every synthetic corruption
  tried (zero/negative/gigantic MediaBox, missing/wrong-type page object)
  is *repaired* by the pdf.js/poppler stack rather than failed — the
  malformed-PDF degradation contract remains issue #37. What this probe
  verifies is the queue's fail-closed machinery (attempt cap → failed
  entry → siblings and job completion untouched) inside the container,
  which is adapter-independent by construction; the sidecar-tier per-page
  failure path (child error → page fails closed) is covered by the
  SIGKILL probe above and the adapter's unit tests.
- The SIGTERM drain runs under Modal's init (gVisor), with the server as a
  non-PID-1 child — the same process position it holds under
  `docker run --init`. A plain-docker `--init` smoke was not run (no x86
  Docker host available); the shutdown fix itself
  (`ParseService.shutdown()` awaiting every child's exit) is
  init-independent and regression-tested in `test/service-health.test.mjs`.

## Summary — the four criteria in one line each

1. **In-band EP**: PASS — `ep=hpi` inside every record's provenance,
   introspected from the pipeline object, log lines demoted to
   corroboration.
2. **Same-host EP control**: PASS — null tolerance 0 (hpi/hpi
   bit-identical), cross-EP delta 0 critical tokens / 1 raw line of
   3,890; gold identical (413/560) in all three arms; no era action.
3. **Throughput/footprint**: 162/162 pages, 4×1 packing wins 2.7–4.9×
   over 1×4; **3.0–5.5 core-s/page** (shared-tenancy range), container
   total ~10.9 GB for 4 workers; boot-to-ready 70–88 s.
4. **Failure behaviour**: PASS — worker SIGKILL requeues, sidecar SIGKILL
   respawns, SIGTERM drains in 3–5 s with zero surviving processes and
   the interrupted job resumes on restart; corrupt-page fail-closed
   verified via the queue's machinery (stub hook; honest label above).

## Provenance (§8)

- Every number above states its source run; raw JSON in
  `.evaluation/m1-linux/` (gitignored, corpus-derived):
  `ep-control.json` + `score-*.json` (criterion 2),
  `throughput-4x1.json` (run B; run A's summary is quoted from its
  console output — the rerun that added the RSS sampler overwrote run A's
  file), `throughput-1x4.json`, `failure.json`.
- Reproduction: `build-corpus-subset-pdfs.mjs` → the four
  `m1_linux_verification_modal.py` tasks → `score-ep-control.mjs` (its
  `rawLines_*` blocks are the bit-stability instrument) and
  `score-candidate-witness.mjs` per EP arm.
- **Code state of the measured runs.** The runs executed from the branch's
  original commits (`5ae1c2e` image content + throughput 4×1 run A / 1×4 /
  failure; `3362e9a` EP control; `64c8917` throughput 4×1 run B); the
  branch was subsequently rebased cleanly onto main twice (after PRs #80
  and #81 merged), so those SHAs are no longer reachable from the pushed
  branch — the SAME content lives at the current branch commits
  `66a7700`/`a34c49a`/`0d1e2aa`/`76accc4`/`e4c0390` (rebases were
  content-clean for every file the Dockerfile COPYs; the only conflicts
  were with M3's server/queue additions, resolved by composition). The
  build context had no untracked or modified files in any path the
  Dockerfile COPYs (the in-progress trial doc and evaluation tooling are
  excluded by `.dockerignore`). Modal image ids: the superseded pre-HPI-fix build was
  `im-VLInVXYHAMVT5I2TNEaa4o`; the fixed build's id was printed to a
  truncated stream and not retained — the image is reproducible from the
  Dockerfile at the SHAs above.
- Independence checklist: these are **operational measurements of the
  system's own behaviour** (throughput, RSS, process lifecycle), not
  accuracy rates — no gold denominator is quoted here. The EP control's
  denominator is the fixed 32-page hpi-bench set (chosen for the HPI
  benchmark by stratifying hard families from the gold∩record sample —
  system-conditioned, and therefore a **case series, not a rate**, exactly
  as its parent trial labels it).

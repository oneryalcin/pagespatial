# M1 Linux verification: the container earns its numbers

**Date:** 2026-08-23 · **Branch:** `m1-container-linux` · **Design:**
`docs/design/2026-08-23-service-deployment-and-enrichment.md` (workstream 1)
· **Issue:** deployment milestone M1

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

## Criterion 2 — same-host EP control (placeholder)

## Criterion 3 — throughput and footprint on target hardware (placeholder)

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

## Provenance (§8)

- Every number above states its source run; raw JSON in
  `.evaluation/m1-linux/` (gitignored, corpus-derived).
- Independence checklist: these are **operational measurements of the
  system's own behaviour** (throughput, RSS, process lifecycle), not
  accuracy rates — no gold denominator is quoted here. The EP control's
  denominator is the fixed 32-page hpi-bench set (chosen for the HPI
  benchmark by stratifying hard families from the gold∩record sample —
  system-conditioned, and therefore a **case series, not a rate**, exactly
  as its parent trial labels it).

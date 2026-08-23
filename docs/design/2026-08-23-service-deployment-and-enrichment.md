# Design: containerised service + escalation tier

**Status:** design, awaiting implementation · **Date:** 2026-08-23
**Scope:** two workstreams, independently shippable
**Audience:** the engineer picking this up — read
[principles](../principles.md) and [workstreams](../workstreams.md) first;
this document assumes them.

Two gaps stand between today's parse service and something deployable:

1. **It has never run on Linux and there is no container.** Every
   measurement we have comes from a Mac or an ad-hoc Modal container.
2. **The escalation tier is not wired in.** `grep -ri enrichment service/`
   returns nothing. The service *flags* uncertain pages and offers no path
   to *resolve* them — the product promise half-delivered.

**Explicitly out of scope** (tracked, not scheduled — issue #76): auth,
quotas, tenant isolation, object storage, public API versioning. The
service remains localhost/trusted-caller until a real consumer defines
those requirements.

---

# Workstream 1 — Container and Linux verification

## Why first

It unblocks everything else and pays for itself three times: it produces
the deployment unit, the OpenVINO throughput number that justified the
sidecar adoption in the first place, and the same-host EP control the era
rule now requires before any Linux diagnostics may be compared against
`dev-v13`.

## Shape

**One image, both runtimes.** The adopted architecture is
subprocess-per-worker: each Node page-worker spawns and group-kills its own
Python child (PR #69). Splitting Python into a separate container would
break that lifecycle guarantee — the one we fixed two demonstrated leaks to
earn — and buy nothing. Keep them co-resident.

**Multi-stage build:**

- *Builder stage*: `npm ci && npm run build` → `dist/`.
- *Runtime stage*: Debian slim + Node runtime + Python 3.11 +
  `poppler-utils` (pdftoppm) + `tesseract-ocr` (second opinion) + paddle
  deps; `pip install paddleocr==3.7.0 paddlepaddle==3.2.1`;
  `paddleocr install_hpi_deps cpu` for OpenVINO; production `node_modules`;
  `dist/`; `service/`.

**Models are baked, not downloaded at boot.** Build runs
`service/sidecar/fetch_models.py` against the committed
`service/sidecar/model-pins.json`; **the build fails on hash mismatch**.
Boot re-verifies the same hashes (existing two-sided check). A container
that starts is a container whose weights are the ones the adoption ceremony
validated.

**Worker topology: one container runs N single-vCPU workers, container
sized N vCPU.** The scaling curve (PR #66) showed latency flat from 1→8
vCPU, so a worker gets one core and parallelism comes from worker count.
Keeping the in-process queue means the hardened machinery — resumable
disk-backed jobs, crash requeue, degraded-pool 503, SIGTERM drain — works
unchanged. *Rejected for now:* one-worker-per-container with an external
queue. It is the right k8s-native shape eventually, but it requires
replacing the queue we just hardened, and there is no orchestrator yet.
Note it as the scale-out path.

**Health gating.** `/health` returns ready only after: model hashes
verified, a sidecar child started and reported meta, and one warm-up
inference completed. A container must never accept work with a broken
engine — and by the same logic the readiness probe, not just liveness,
should gate traffic.

**Hygiene:** non-root user, `.dockerignore` excluding `.evaluation/` and
`node_modules`, no corpus data in the image, an image-size budget noted in
the PR (paddle + OpenVINO is gigabyte-class; that is expected, see the HPI
trial doc).

## Acceptance criteria — measurements, not just "it runs"

1. **In-band EP evidence.** `ep=hpi` engaged, captured *inside* the result
   payload rather than scraped from stderr. This closes the standing
   follow-up from PR #64/#67 — and the image is the right place, because
   here we control the Python environment and can introspect the pipeline's
   own config objects. If it remains genuinely impossible in-band, say so
   with evidence and keep the log-derived label.
2. **Same-host EP control** (required by the era rule): on one Linux host,
   run both `ep=hpi` and `ep=paddle-default` over the same fixed page set
   (the 90 ceremony pages, or a stratified 32 if runtime is tight). Report
   gold-token and observation-count deltas. Expected: within the measured
   ±4-token stability. If it exceeds that, stop and report — that is an era
   decision for the owner, not a footnote.
3. **Throughput and footprint on target hardware**: full 162-page corpus
   through the containerised service. Report pages/sec/core, OS-max RSS per
   worker (not the page-boundary sample — see the PR #62 review), and the
   per-stage table. These numbers *replace* every Mac and Modal estimate
   currently in the docs; update the trial docs that quote them.
4. **Failure behaviour survives containerisation**: worker crash requeues,
   corrupt page fails closed with siblings unaffected, SIGTERM drains with
   zero surviving Python processes (the group-kill fix must hold under the
   container's init/PID-1 semantics — verify, because PID 1 changes signal
   defaults).

---

# Workstream 2 — Escalation tier in the service

## What exists and where

All the machinery is built and measured; none of it is connected:

| piece | lives in | status |
|---|---|---|
| Gemini adapter (transcribe / adjudicate / crops / batch) | `src/node/flash-ocr.ts` | library, tested |
| Enrichment record type + validation + digest binding | `src/enrichment.ts` | library, schema `enrichment-0.2.0` |
| Qualification predicate | `pageQualifiesForEscalatedEnrichment`, `blockingReasons` | library |
| **Rung routing + batch orchestration** | `scripts/evaluation/run-flash-enrichment.mjs` | **evaluation script only** |

The routing is three decisions made from a page's blocking reasons:
`critical-token-conflict` / `critical-token-omission` → **adjudication**;
`uncorroborated-ocr` → **full transcription**; `unread-ink-region` without
starvation → **residue crops**.

## Design decision 1: extract routing to the library, keep transport in the service

Move the *pure* routing decision (page → which rung, with what inputs) into
the library beside `pageQualifiesForEscalatedEnrichment`, where it is unit
testable and has one definition. Batch submission, polling, persistence and
cost accounting stay in the service.

The evaluation runner then imports the same routing. That matters: the
runner carries a test-enforced invariant (zero interactive calls under
`--batch`, added after two broken measurement runs) and a committed cost
ladder. If the service re-implements routing, the two drift and the
measured $0.000817/page stops describing what production does.

## Design decision 2: enrichment is a job-level second phase, batch-submitted

**Recommended.** The flow:

1. **Phase A — parse.** All pages through the existing pipeline; records
   stream back progressively exactly as today. Job reaches `parsed`.
2. **Phase B — enrich** (only when requested). Collect the job's pages that
   qualify, route each to its rung, submit **one Gemini batch per job**,
   poll, write enrichment records as separate artifacts. Job reaches
   `enriched`.

*Rejected: synchronous per-page enrichment.* It would roughly double the
cost (batch API is 50% priced, and the entire 11.4× economics arc rests on
batching) and put a multi-second LLM round trip inside every blocking
page's latency. Enrichment is asynchronous by design — principles §4 keeps
LLMs and humans out of the hot path.

*Rejected for v1: on-demand per-page enrichment.* Legitimate future
feature, but it forfeits batching economics and has no consumer yet.

**Consequence for the API contract**: a job now has two terminal states,
and clients must be able to consume parse results without waiting for
enrichment. Per-page enrichment status is exposed; the two never merge.

## Design decision 3: fail-open on enrichment, fail-closed on witnesses

If Gemini is unavailable, over budget, or returns malformed output, **the
job still completes** with canonical records and enrichment marked
`unavailable` per page. This is the opposite of the witness policy, and the
asymmetry is principled: a missing witness would silently weaken evidence,
so it fails closed; missing enrichment loses *additive* information and
cannot corrupt what the canonical record already asserts.

What must still fail closed inside enrichment: a `basePageDigest` mismatch
(the record changed under the enrichment), a malformed adjudication verdict
(→ `unsure`, never guessed), and any attempt to write an enrichment record
that fails schema validation.

## Design decision 4: enrichment never touches the canonical record

Enrichment records are separate, digest-bound revision artifacts. The
service must not merge them into `pageSpatial` at any layer — not in
storage, not in the API response. The client composes. A regression test
should assert canonical record bytes are identical with and without
enrichment enabled.

## API surface (additive, no breaking changes)

- `POST /v1/jobs` gains `enrichment: "off" | "batch"` — **default `off`**.
  Enrichment costs money and needs a key; opting in should be explicit.
  *(Owner decision — see open questions.)*
- `GET /v1/jobs/:id` gains job-level `enrichmentStatus`
  (`disabled | pending | submitted | complete | unavailable`) and per-page
  `enrichment: { status, ... }`.
- `GET /v1/jobs/:id/pages/:n/enrichment` → the enrichment record; 404 when
  none exists. Never folded into the page endpoint.
- `GET /v1/metrics` gains enrichment counters: pages routed per rung, batch
  wall time, token usage, estimated spend.

## Cost control (required, not optional)

- **Per-job cap**: maximum pages to enrich, or maximum estimated USD;
  exceeded → the job runs parse-only and reports why. A pathological
  document must not be able to spend unbounded money.
- **API key from environment only.** Per-request keys are a multi-tenancy
  feature and belong to #76.
- **Spend recorded per job** and aggregated in metrics, using the runner's
  existing per-source accounting (batch tokens at 0.5×).

## Resume and idempotency

Persist the batch operation name in the job directory at submission — the
same durable-manifest pattern the runner uses, which already recovered a
full paid batch after a client crash. A service restart mid-batch must
rejoin the operation, never resubmit. Enrichment writes go through the same
atomic temp+rename path as page records (PR #54's fix), and a partially
written enrichment record must be discarded on resume, not trusted.

## Test plan

The bar is the one the service already meets — behaviour tests over a
stubbed boundary, plus one real end-to-end:

1. Canonical records byte-identical with enrichment on vs off.
2. Batch mode fires **zero** interactive Gemini calls (port the runner's
   invariant test to the service; it exists because this broke twice).
3. Gemini unavailable → job completes, enrichment `unavailable`, no partial
   or forged records.
4. `basePageDigest` mismatch → enrichment refused for that page.
5. Restart mid-batch → rejoins the persisted operation, no double spend
   (assert one submission across the restart).
6. Cost cap exceeded → parse-only with a stated reason.
7. Routing parity: a fixture set routes identically through the library
   routing when called from the service and from the evaluation runner.
8. One real small-corpus run (a handful of blocking pages) against the live
   API, cost reported.

---

# Sequencing

| milestone | contents | independently shippable |
|---|---|---|
| **M1** | Container + Linux verification (workstream 1, all four acceptance criteria) | yes |
| **M2** | Routing extraction to the library + parity tests | yes |
| **M3** | Service enrichment phase, API additions, cost control, resume | yes |
| **M4** | Real-corpus enrichment run on the container; update every doc quoting Mac/Modal numbers | yes |

M1 and M2 are independent and can run in parallel. M3 depends on M2; M4
depends on both.

Each milestone follows the house pattern: PR, cold adversarial review,
findings fixed with the reviewer's repro as the regression test, then
merge.

# Open questions for the owner

1. **Enrichment default**: `off` (recommended — explicit opt-in for a paid
   feature) or `batch` (every job enriches by default)?
2. **Cost cap value**: what per-job ceiling should a pathological document
   hit? A page-count cap is simpler to reason about than a USD estimate.
3. **If the EP control shows record differences beyond ±4 tokens**: cut
   `dev-v14` on Linux/OpenVINO as the deploy-era reference, or treat
   `dev-v13` as authoritative and document the delta? (Only arises if the
   measurement surprises us.)

# Known gaps this design does not close

- Region recovery still absent server-side — worth ~0.9pp gold recall as
  quantified by the `dev-v13` cut (#10/#13).
- Malformed-PDF degradation contract unbuilt (#37).
- `dist/` outside the workspace authentication hash (#72); schema
  fail-open seams (#73); summary field duplication + generator-hash
  obligation (#74).
- Everything in #76 (auth, quotas, storage, tenancy).

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
service remains localhost/trusted-caller — with one exception forced by
this design, see [Egress](#egress-enrichment-changes-what-pdfpath-means).

---

# Workstream 1 — Container and Linux verification

## Why first

It unblocks everything else and pays for itself three times: it produces
the deployment unit, the OpenVINO throughput number that justified the
sidecar adoption, and the same-host EP control the era rule requires
before any Linux diagnostics may be compared against `dev-v13`.

## Target platform

**`linux/amd64`, stated up front because it is load-bearing.** OpenVINO
HPI is x86-only. Building on an M-series Mac without `--platform` produces
an arm64 image where `useHpip` is false, `descriptorFor`
(`service/adapters/ppocr-sidecar.mjs`) truthfully emits
`ep=paddle-default`, and acceptance criterion 1 fails for a reason nothing
in the logs explains. Build on an x86 host or with explicit
`--platform=linux/amd64`. An arm64 image may exist as a local dev artifact
**only**, and must never be used for the EP control in criterion 2.

## Shape

**One image, both runtimes.** The dispositive constraint is the transport,
not the lifecycle: the sidecar protocol passes pages as **filesystem paths
in a `mkdtemp` directory** (`ppocr-sidecar.mjs`), so a separate Python
container would need a shared volume and a rewritten transport before it
could work at all. Co-residency also preserves the group-kill child
lifecycle we fixed two demonstrated leaks to earn, but that argument is
secondary — group-kill works fine as long as the boundary is never
crossed.

**Multi-stage build:**

- *Builder*: `npm ci && npm run build` → `dist/`.
- *Runtime*: Debian slim + Node + Python 3.11 + `poppler-utils` (pdftoppm)
  + `tesseract-ocr` (second opinion) + paddle deps;
  `pip install paddleocr==3.7.0 paddlepaddle==3.2.1`;
  `paddleocr install_hpi_deps cpu`; production `node_modules`; `dist/`;
  `service/`.

**The image must set `SERVICE_SIDECAR_PYTHON` to the baked interpreter.**
`DEFAULT_PYTHON_CMD` is `['uv','run','--with','paddleocr==3.7.0',…]`; left
at the default, every worker re-resolves the environment through `uv` at
runtime — network at boot, in a container that already contains the
packages.

**Engine pins and weight pins currently live in different files.**
`service/sidecar/model-pins.json` holds only `notes` and `repos` (each
with a `revision` and per-file SHA-256s) — it contains no engine versions.
The engine versions are in `DEFAULT_PYTHON_CMD`
(`service/adapters/ppocr-sidecar.mjs`: `paddleocr==3.7.0`,
`paddlepaddle==3.2.1`) and are reported at runtime as
`meta.versions.*`. So: **the Dockerfile's pip pins must be asserted equal
to `DEFAULT_PYTHON_CMD`'s versions at build time.** Optionally add a
`runtime` block to `model-pins.json` carrying those versions so one file
is the whole pin manifest; if you don't, say plainly in the README that
weight pins and engine pins are pinned in separate places. Without the
assertion the "ceremony-validated" guarantee covers the weights but not
the engine that loads them.

**Models are baked, not downloaded at boot.** Build runs
`service/sidecar/fetch_models.py` against the committed pin manifest and
**fails on hash mismatch**; boot re-verifies (existing two-sided check). A
container that starts is one whose weights the adoption ceremony
validated.

**Worker topology: one container runs N single-vCPU workers, sized N
vCPU** *(unit correction 2026-08-23: the measurements behind this were
Modal `cpu=N` = N PHYSICAL cores, not vCPUs, and the packing-unit
generalization is retracted — the implemented M1 result is "four
one-thread workers beat one four-thread worker on one 4-physical-core
allocation"; see `2026-08-23-modal-scaling-and-deployment.md` §3.6)* —
keeping the in-process queue means the hardened machinery
(resumable disk-backed jobs, crash requeue, degraded-pool 503, SIGTERM
drain) works unchanged. *Rejected for now:* one-worker-per-container with
an external queue — the right k8s-native shape eventually, but it replaces
the queue we just hardened and there is no orchestrator yet.

**Honest basis for that topology:** the scaling curve
(`docs/trials/2026-08-23-hpi-benchmark.md`) is a **single-stream,
per-container** measurement, and its own addendum warns that per-config
deltas within ±50% should not be interpreted (the 1→2 vCPU step got
*worse*, 1,448 → 1,717 ms). The packed-throughput conclusion is **derived,
not measured**. Treat N-single-vCPU as the hypothesis to verify in
criterion 3, not as an established result.

**Shutdown must be fixed as part of this work, not merely verified.**
`ParseService.shutdown()` sends SIGTERM and returns **without awaiting
worker exit**, and `server.mjs` then calls `process.exit(0)` from the
`server.close` callback, which fires immediately on an idle server.
Workers must reach their own exit handler for the sidecar's `exit` hook to
group-kill Python. Required: `shutdown()` awaits each child's `exit` under
a bounded timeout, and the container runs an init that reaps
(`--init`/tini). An orphaned detached Python group reparented to a
non-reaping Node PID 1 is the failure mode; PID 1 also changes default
signal handling, so this cannot be assumed to work because it worked on a
Mac.

**Health gating.** `/health` **does not exist today** — it is a new
endpoint in this workstream, not an amendment. Ready only after: model
hashes verified, a sidecar child started and reported meta, and one warm-up
inference completed. Budget it honestly: `ensureChild` carries a 300 s meta
timeout, and warm-up is a real OCR run — with the baked interpreter it
costs seconds, without it, a package resolution. Readiness (not just
liveness) must gate traffic: a container must never accept work with a
broken engine.

**Hygiene:** non-root user, `.dockerignore` excluding `.evaluation/` and
`node_modules`, no corpus data in the image, image-size budget noted in
the PR (~2 GB is expected for paddle + OpenVINO — see
`docs/trials/2026-08-22-sidecar-adoption-ceremony.md`).

## Acceptance criteria — measurements, not smoke tests

1. **In-band EP evidence.** `ep=hpi` engaged, captured *inside* the result
   payload rather than scraped from stderr — closing the standing
   follow-up from PR #64/#67. The image is the right place: here we own
   the Python environment and can introspect the pipeline's own config
   objects. If it remains genuinely impossible in-band, say so with
   evidence and keep the log-derived label.
2. **Same-host EP control**, required by the era rule. On one Linux host,
   over one fixed page set: (a) run `ep=hpi` **twice** to derive the
   null-control tolerance for *this* page set, then (b) run
   `ep=paddle-default` and compare. Do not import the ±4-token window as
   the bar — it was measured as same-config cross-container variance on
   the HPI benchmark's 32-page subset, a different population and a
   different source of variance. Report the derived tolerance and the
   cross-EP delta against it. Exceeding it is an era decision for the
   owner, not a footnote.
3. **Throughput and footprint on target hardware**, with the configuration
   stated: container vCPU, worker count, threads per sidecar. Run at least
   two packings (e.g. 4×1 vCPU vs 1×4 vCPU) so the topology hypothesis is
   tested rather than assumed. Full 162-page corpus. Report pages/sec/core
   and **OS-max RSS** per worker — captured from the OS (e.g.
   `/proc/<pid>/status` VmHWM or cgroup peak), *not* the per-page
   `process.memoryUsage().rss` sample the PR #62 review rejected. These
   numbers **replace** every Mac and Modal figure currently quoted in the
   docs; update those docs in the same PR.
4. **Failure behaviour survives containerisation**: worker crash requeues;
   corrupt page fails closed with siblings unaffected; SIGTERM drains with
   **zero surviving Python processes**, verified by PID probe inside the
   container under its real init.

---

# Workstream 2 — Escalation tier in the service

## What exists and where

All the machinery is built and measured; none of it is connected:

| piece | lives in | status |
|---|---|---|
| Gemini adapter (transcribe / adjudicate / crops / batch) | `src/node/flash-ocr.ts` | library, tested |
| Enrichment record type, validation, digest binding | `src/enrichment.ts` (`enrichment-0.2.0`) | library |
| Qualification predicate | `pageQualifiesForEscalatedEnrichment`, `blockingReasons` | library |
| **Rung routing + batch orchestration** | `scripts/evaluation/run-flash-enrichment.mjs` | **evaluation script only** |

## Design decision 1: extract a *request plan*, not three booleans

Routing is not the clean three-way split it looks like. In the runner: a
page carrying several reason kinds gets **several** rungs; adjudication
additionally requires `page.conflicts.length`; crops additionally require
`residueRegions(page)` to be non-empty, which depends on
`renderedPixelsPerPoint` and a residue-minimum-side threshold **mirrored
from `src/tuning.ts` as a duplicated constant in the runner**.

So the extracted function returns a per-page **request plan** — which
rungs, with their conflict inputs and crop boxes — not a triple of
booleans. Extraction must **reunify `RESIDUE_MIN_SIDE_PT` and
`CROP_MARGIN_PT` with `src/tuning.ts`** (§9: every heuristic constant in
one place, with its rationale and unit).

The evaluation runner then imports the same plan builder. That matters:
the runner carries a test-enforced invariant (zero interactive calls under
`--batch`) and the committed cost ladder. If the service re-implements
routing, the two drift and the measured cost stops describing production.

## Design decision 2: enrichment renders its OWN raster at 150 dpi

**The single most expensive mistake available here.** The service renders
parse rasters at `RENDER_SCALE 1.6` = **115.2 dpi**; the enrichment runner
renders at **150 dpi**, and crops likewise. Every measured enrichment
number — the cost per page, the token counts, the validated prompt
revisions — was produced at 150 dpi, and Gemini bills image tokens by
pixel dimensions.

Reusing the parse raster is the obvious implementation and it silently
invalidates the ladder. Therefore: **enrichment performs its own render
pass at 150 dpi** (a second pdftoppm invocation), or the economics are
re-measured from scratch and every doc quoting them updated. Prefer the
first.

**That render must not run on the server's event loop.** The runner
renders with `execFileSync`; copied into the server — which decision 5
makes the polling owner — a 91-page job would block the HTTP loop for
minutes, making `/v1/jobs` and `/health` unresponsive and flapping the
readiness probe this design just introduced. Either use async `execFile`,
or dispatch enrichment renders to the worker pool as a distinct task kind.
State which in the implementation PR.

## Design decision 3: job-level second phase, batch-submitted, chunked

1. **Phase A — parse.** Unchanged; records stream back progressively. Job
   reaches `completed` (see H1 note below — the existing status vocabulary
   is not touched).
2. **Phase B — enrich**, only when requested. Collect qualifying pages,
   build request plans, submit **batches** (plural — see chunking), poll,
   write enrichment records as separate artifacts.

*Rejected: synchronous per-page enrichment.* Roughly doubles cost (batch
API is 50% priced, and the whole economics arc rests on batching) and puts
a multi-second LLM round trip inside every blocking page's latency, which
§4 exists to prevent.

*Rejected for v1: on-demand per-page enrichment.* Legitimate future
feature; forfeits batching economics and has no consumer yet.

*Rejected: enrichment as a separate co-resident process.* It genuinely has
a different failure domain and needs no OCR runtime — but it would need
its own job-state access and IPC, and §9 says don't add a process plane
without a profiled reason. Revisit if enrichment failures start taking
parse capacity with them.

**Chunking is mandatory, not an optimisation.** `runFlashBatch` inlines
every request — base64 PNGs and all — in a single body, and the poll reads
every response back inlined. The measured run was 91 pages. "One batch per
job" on a large document produces a multi-hundred-megabyte submit body and
an equally large in-memory poll response. Specify a maximum entries per
batch; a job's manifest therefore holds **several** operation names, which
the runner's single-`operationName` manifest shape does not generalise to
— design the manifest for a list, with per-chunk state, preserving the
never-resubmit guarantee.

## Design decision 4: storage layout that cannot corrupt job completion

`checkCompletion` decides a job is done by **counting files in
`<jobDir>/pages/`**; `resume()` treats every parseable file there as a
finished page; `jobStatus()` returns every file there as a page result.
Writing enrichment artifacts into `pages/` would mark jobs complete early
and inject non-page objects into the status payload.

Required layout:

```
<jobDir>/pages/NNNNNN.json            # canonical page records (untouched)
<jobDir>/enrichment/NNNNNN.json       # enrichment records
<jobDir>/enrichment/manifest.json     # batch chunks, operation names, state
```

`checkCompletion`, `resume`, and `jobStatus` stay scoped to `pages/`, with
a regression test that a job carrying enrichment records still reports the
correct `completedPages`. Enrichment writes use the same atomic
temp+rename path; a partially written enrichment record is discarded on
resume, never trusted.

## Design decision 5: who polls, and how a restart rejoins

**The server process owns polling.** Workers are per-page children that
die and respawn; the server is the only long-lived process. `awaitFlashBatch`
is a blocking in-process await loop, not a resumable poller, so the server
holds that promise.

**Restart recovery needs its own sweep.** `resume()` short-circuits on
`job.status === 'completed' || 'failed'` — and a job whose parse phase
finished is exactly such a job, so today's resume path would never revisit
it. Required: a **boot-time enrichment sweep** that scans job directories
for manifests with unresolved operations *independent of `job.status`*,
and rejoins them. Never resubmit: paid work is recovered, not repurchased
(this property already rescued a full paid batch once).

## Design decision 6: fail-open on enrichment, fail-closed on witnesses

If Gemini is unavailable, over budget, or malformed, **the job still
completes** with canonical records and enrichment marked unavailable. The
asymmetry is principled: a missing witness silently weakens evidence, so
it fails closed; missing enrichment loses *additive* information and
cannot corrupt what the record already asserts.

**But fail-open must not abandon paid work.** Distinguish:

- *Terminal* (401/403/404, explicit batch error): close the chunk out,
  mark unavailable.
- *Not finished yet* (deadline reached while the batch still runs): the
  chunk stays live in the manifest for the resume sweep. `awaitFlashBatch`
  throws at its deadline with the batch still billed and running — treating
  that as terminal would pay for work and discard it.

What still fails closed inside enrichment: `basePageDigest` mismatch, a
malformed adjudication verdict (→ `unsure`, never guessed), and any record
failing schema validation.

## Design decision 7: enrichment never touches canonical records

Enrichment records are separate, digest-bound revision artifacts, never
merged into `pageSpatial` at any layer — not in storage, not in the API
response. The client composes. Regression test: canonical record bytes are
**identical** with enrichment on and off.

**Two consequences that must be stated in the API:**

- **A failed page cannot be enriched.** A page with `ok:false` has no
  `pageSpatial`, no digest, and no blocking reasons. It must never be
  routed to full transcription as a "recovery" — that would substitute
  model output for missing evidence (§2). State it; test it.
- **Re-parsing invalidates enrichment.** If a page is requeued after a
  crash and re-parsed, the new record has a different `basePageDigest` and
  any stored enrichment for that page is permanently invalid. This is the
  one place the design could plausibly serve a stale enrichment against a
  fresh record: the sweep must detect the mismatch and mark the record
  `stale`, never serve it.

## API surface (additive — the existing `status` vocabulary is not touched)

`status` stays `processing | completed | failed`. All enrichment state
lives in new fields, so nothing breaks for existing clients:

- `POST /v1/jobs` gains `enrichment: "off" | "batch"` — **default `off`**
  (owner decision below).
- `GET /v1/jobs/:id` gains job-level `enrichmentStatus`
  (`disabled | pending | submitted | complete | partial | unavailable`)
  and per-page enrichment state.
- **Per-page enrichment states must distinguish "nothing to do" from
  "nobody looked"**, or escalation precision loses its denominator (§8's
  independence check, item 5): `not-qualified` (no blocking reasons),
  `no-eligible-region` (residue alarm fired but no crop-eligible region —
  the runner counts these explicitly), `pending`, `submitted`, `complete`,
  `stale`, `unavailable`.
- `GET /v1/jobs/:id/pages/:n/enrichment` → the record; 404 when none.
  Never folded into the page endpoint.
- `GET /health` (new — see workstream 1).
- `GET /v1/metrics` gains enrichment counters: pages per rung, batch wall
  time, token usage, estimated spend, and the `no-eligible-region` count.

*Not changed here, but noted:* `GET /v1/jobs/:id` returns the full pages
array on every poll, so a client watching a 162-page job re-downloads
everything each time, and this design adds per-page enrichment state to
that same payload. A cursor parameter or SSE is the fix. Deliberately
deferred — no consumer has complained, and #76 will revisit the transport
— but it is a known quadratic, not an oversight.

## Cost control — per job *and* per service

- **Per job**: maximum pages to enrich (a page cap is easier to reason
  about than a USD estimate); exceeding it runs parse-only and reports
  why.
- **Per service**: a concurrent-**chunk** limit (chunks, not jobs — chunks
  are what consume API concurrency and memory, and chunking is mandatory
  per decision 3) plus an aggregate spend ceiling. N concurrent jobs
  otherwise means many concurrent hour-long batches, each within its own
  per-job cap — bounded per document, unbounded per caller. When
  saturated, phase B queues; **phase A of new jobs proceeds normally**
  (disjoint resources — parse capacity is workers, enrichment capacity is
  remote).
- **API key from environment only.** Per-request keys are multi-tenancy
  (#76).
- **Spend recorded per job** and aggregated in metrics, using the runner's
  per-source accounting (batch tokens at 0.5×).

## Egress: enrichment changes what `pdfPath` means

`POST /v1/jobs` accepts `{"pdfPath": …}` pointing at any file the process
can read — a dev convenience the README already says must not reach
production, on a service with no authentication. **With enrichment on,
that stops being an access-control gap and becomes a data-egress
primitive**: name a local file, and the service renders it and ships it to
Google. §10 requires explicit authorization before anything private
reaches a remote model.

Required: **`enrichment: "batch"` is refused for jobs submitted via
`pdfPath`**, or `pdfPath` mode is removed in this milestone. Also carry
over the runner's `assertPdfMatchesRecord` check — re-verify bytes against
`documentSha256` immediately *before transmission*, not only at
submission.

## Test plan

1. Canonical records byte-identical with enrichment on vs off.
2. Batch mode fires **zero** interactive Gemini calls (port the runner's
   invariant test; it exists because this broke twice).
3. Gemini unavailable → job completes, enrichment unavailable, no partial
   or forged records.
4. `basePageDigest` mismatch → refused for that page.
5. Restart mid-batch → boot sweep rejoins the persisted operations, one
   submission across the restart (no double spend).
6. Deadline reached with batch still running → chunk stays live, not
   closed out.
7. Cost caps (job and service) → parse-only with a stated reason.
8. Job with enrichment records still reports correct `completedPages`.
9. Failed page is never routed to any rung.
10. Re-parsed page → stored enrichment marked `stale`, never served.
11. `pdfPath`-submitted job refuses enrichment.
12. Routing parity: a fixture set produces identical request plans from
    the service and the evaluation runner.

## Acceptance criteria for workstream 2

Tests prove behaviour; these prove the thing works:

1. **Routing parity on replayed records.** Feed **both** the service and
   the evaluation runner the *same fixed set of page records* — the
   dev-v13 baseline records, replayed — and require identical request
   plans page-for-page. This is essential: escalation reasons are a
   property of the records, and W1 criterion 2 exists precisely because
   the EP may change them. Compare freshly-produced records against the
   runner's baseline records and the criterion fails while the extraction
   is perfectly correct.
2. **Cost per *enriched* page** (~$0.0015 in the committed ladder), not
   per corpus page. $/corpus-page is spend ÷ 162 — a direct function of
   how many pages escalate, which is era-dependent, and the ladder's
   figure was measured on dev-v12's 91 blocking pages. Comparing across
   eras is exactly what the dev-v13 doc forbids. Report the **dev-v13
   blocking-page count as a new measurement**, not as a parity target.
3. **Token gain on replayed gold pages**: enrichment produces at least the
   committed scorer's token gain on the *same* 19 gold∩blocking pages,
   replayed. Not "within stated variance" — the committed figure is
   381 → 382, a one-token case-series signal with no variance band, where
   a true regression to +0 would be indistinguishable from noise. Same
   pages, same era, a checkable floor.
4. Spend and per-rung counts appear in `/v1/metrics` and reconcile with
   the job records.
5. **Enrichment's own cost accounted**: the M4 corpus run reports the
   parse-vs-enrichment split of wall time and CPU, including the second
   150 dpi render pass. (W1 criterion 3 measures parse throughput in M1,
   before enrichment exists — so this accounting belongs here, not there.)

---

# Sequencing

| milestone | contents | independently shippable |
|---|---|---|
| **M1** | Container, `linux/amd64`, shutdown fix, `/health`, all four acceptance criteria | yes |
| **M2** | Request-plan extraction to the library, constant reunification, parity tests | yes |
| **M3** | Service enrichment phase: storage layout, chunked batches, server-owned polling + boot sweep, cost caps, egress refusal, API additions | yes |
| **M4** | Real-corpus enrichment run on the container; workstream-2 acceptance criteria; update every doc quoting Mac/Modal numbers | yes |

M1 and M2 are independent and can run in parallel. M3 depends on M2; M4
depends on both.

Each milestone follows the house pattern: PR, cold adversarial review,
findings fixed with the reviewer's repro as the regression test, merge.

# Open questions — ANSWERED (owner, 2026-08-23)

1. **Enrichment default: `off`.** Explicit opt-in for a paid feature.
2. **Cost caps** (delegated to implementation; conservative,
   env-overridable defaults):
   - Per-job page ceiling: `ENRICH_MAX_PAGES_PER_JOB`, default **200**
     enriched pages. Exceeding it runs parse-only with a stated reason.
   - Service concurrent-chunk limit: `ENRICH_MAX_CONCURRENT_CHUNKS`,
     default **4**. When saturated, phase B queues; phase A proceeds.
   - Aggregate spend ceiling: `ENRICH_SPEND_CEILING_USD`, default **$10**
     per service process lifetime, estimated from the runner's per-source
     accounting. Reaching it marks further enrichment `unavailable`
     (fail-open) and surfaces prominently in `/v1/metrics`.
3. **EP control surprises: `dev-v13` stays authoritative** and the delta
   is documented in the trial record. No `dev-v14` cut on Linux/OpenVINO;
   the era rule (same-host EP control before comparing diagnostics)
   stands unchanged.

# Numbers cited here, and what they measure

Per §8, the provenance of every figure this design leans on:

- **Cost ladder**: the source trial
  (`docs/trials/2026-08-20-batch-and-residue-crops.md`) reports **11.3× at
  $0.000825/corpus page**; `docs/workstreams.md` quotes **11.4× at
  $0.000817**. Two figures for one endpoint — the implementing engineer
  should reconcile them and correct whichever is wrong before quoting
  either as the parity target in acceptance criterion 2.
- **Scaling curve**: single-stream per-container, ±50% caveat, packed
  throughput derived not measured (above).
- **±4-token stability**: same-config cross-container variance on 32
  pages — not a cross-EP tolerance (above).
- **~2 GB image size**: from the adoption ceremony trial doc, not the HPI
  benchmark.

# Known gaps this design does not close

- Region recovery absent server-side — ~0.9pp gold recall (#10/#13).
- Malformed-PDF degradation contract unbuilt (#37).
- `dist/` outside the workspace authentication hash (#72); schema
  fail-open seams (#73); summary field duplication + generator-hash
  obligation (#74).
- Auth, quotas, storage, tenancy, API versioning (#76) — with the
  `pdfPath` egress exception handled above.
- `GET /v1/jobs/:id` payload growth (quadratic polling) — noted, deferred.

# Design: Modal scaling and deployment

**Status:** proposed implementation contract; not production-qualified

**Date:** 2026-08-23

**Baseline:** main at merge `a9a44f8` — includes the host and `pdfPath`
hardening (PR #85, merge `b5b88c9`) and the physical-core record correction
(PR #86: `dca8812` plus closure fixes `73d714a`). Both M0 prerequisites are
merged.

**Scope:** parse-only Modal prototype, its qualification run, and the gated
path to a remote production API

**Audience:** the engineer implementing and reviewing the Modal adapter

This document is the source of truth for Modal deployment work. The earlier
[container and enrichment design](2026-08-23-service-deployment-and-enrichment.md)
and its trial records remain historical evidence. They do not define Modal
delivery semantics.

The governing rules are [measurements stay attributable](../principles.md#8-measurements-are-infrastructure),
[reject rabbit holes](../principles.md#9-ruthless-simplicity), and
[treat privacy and cost as design inputs](../principles.md#10-privacy-and-cost-are-design-inputs).

## 1. Decision

Build one small Modal adapter in this repository under `deploy/modal/`.

The first release shall:

- use one Modal asynchronous input per **document**, not per page;
- use a warm `modal.Cls` container and start the existing Node service once
  per container;
- keep `SERVICE_DATA_DIR` on private ephemeral container storage;
- allow one document at a time in each warm class container;
- pass a bounded PDF as the Function input and return one bounded result;
- keep enrichment off;
- have no public Web Function or `@modal.web_server` endpoint; and
- prove correctness on the existing 23-document corpus and behavior over a
  deterministic 100-call workload before any production or flash-crowd claim.

Do **not**:

- run the existing HTTP service directly behind a multi-replica Modal web
  server;
- mount a shared Modal Volume as live `/data`;
- split one document into one Modal call per page;
- add Modal imports to `src/` or `service/`;
- enable enrichment in the Modal prototype; or
- claim that 10,000 requests per minute are accepted, durable, or within an
  SLO until the missing workload contract is supplied and tested.

Prototype hard limits are 90 MiB Function input, 200 pages per document, 64 MiB
serialized result, one concurrent input per container, and 100 created Node
jobs per warm lifetime. These are qualification limits, not product promises.

### Decision labels

| label | meaning |
|---|---|
| **CONFIRMED** | directly supported by current code, a committed trial, or cited vendor documentation |
| **DECISION** | required by this design |
| **HYPOTHESIS** | must be measured in the prototype |
| **DEFERRED** | intentionally excluded until its stated trigger occurs |

## 2. Why this is the smallest useful design

Modal supplies an autoscaled Function input queue and disposable compute. It
does not make the current service stateless. The current service owns a local
job directory, an in-memory page queue, child workers, and a process-local
enrichment controller. Cloning that service behind round-robin HTTP routing
would clone ownership, not share it.

The adapter therefore uses Modal only at the document boundary:

```text
internal submitter
      |
      | Function.spawn(document)
      v
Modal asynchronous input queue
      |
      | one input per document
      v
warm ParseContainer instance
      |
      | localhost HTTP, private scratch
      v
existing Node service -> page workers -> canonical result bundle
```

This keeps the tested parser and its page scheduler intact. It adds only the
minimum layer needed to measure elastic document-level execution.

## 3. Current facts and corrections

### 3.1 Submission is not an instant acknowledgement

**CONFIRMED.** The current [`POST /v1/jobs`](../../service/server.mjs) reads
the complete request into memory up to 100 MiB. It then writes the upload,
opens the PDF, hashes it, probes its page count, creates its job manifest,
and only then returns `202`.

Therefore:

- acknowledgement latency includes upload and validation;
- 10,000 concurrent 100 MiB uploads could demand about 1 TiB of body memory
  before parser work starts; and
- the current Node endpoint is not a flash-crowd ingress.

The service accepts raw PDF bytes. It does not currently accept multipart
form data.

### 3.2 Queue and recovery scope

**CONFIRMED.** [`ParseService`](../../service/lib/queue.mjs) keeps the live
page queue in memory. It writes job and page state under
`SERVICE_DATA_DIR`. On process start it scans that directory and requeues
missing pages.

This supports process-restart recovery **only when the same data directory
survives**. It does not provide fleet-wide ownership. The state writer uses
temporary-file plus rename in [`atomic.mjs`](../../service/lib/atomic.mjs),
but does not call `fsync`. Do not describe it as power-loss durable.

### 3.3 Status polling is not fleet-efficient

**CONFIRMED.** `GET /v1/jobs/:id` synchronously reads and returns every page
record on every poll. Poll traffic therefore grows with both poll count and
document size. A production remote API needs summary-only status and
incremental result access. The prototype does not build that API.

### 3.4 Shared live storage would create duplicate owners

**CONFIRMED.** Every `ParseService` constructor scans its data directory,
resumes unfinished jobs, and starts the enrichment boot sweep. If multiple
replicas mount the same live directory, each can resume the same jobs.

Modal Volumes also require explicit commit/reload behavior for cross-container
visibility, use last-write-wins when containers write the same file, and are
not a distributed lock. Modal describes them as write-once/read-many storage.
See [Modal Volumes](https://modal.com/docs/guide/volumes).

**DECISION:** no shared Volume is mounted as `SERVICE_DATA_DIR`.

### 3.5 Enrichment controls are process-local

**CONFIRMED.** [`EnrichmentPhase`](../../service/lib/enrichment.mjs) keeps
active chunks, active jobs, and the spend ledger in process memory. Its
configured spend ceiling applies to one service process lifetime. At 1,000
containers, 1,000 independent ceilings could exist.

**DECISION:** `enrichment=off` is enforced by the Modal adapter. A distributed
enrichment design is separate work.

### 3.6 Correct Modal CPU unit

**CONFIRMED.** Modal's `cpu=` value means physical cores, not vCPUs. One
physical core is shown as two vCPUs on Modal's current pricing page. See
[Modal resources](https://modal.com/docs/guide/resources) and
[Modal pricing](https://modal.com/pricing).

The committed [Linux verification trial](../trials/2026-08-23-linux-verification.md)
labels `cpu=1.0` and `cpu=4.0` as one and four vCPUs. That label is wrong.
The wall times and observed pages per second remain valid. The following are
the corrected, limited conclusions:

- four one-thread service workers beat one four-thread service worker by
  2.7-4.9x on the same Modal allocation;
- the winning allocation requested 4 physical cores and 24 GiB memory;
- it observed 0.723-1.326 pages/s over two shared-tenancy runs; and
- multiplying wall time by four gives 3.0-5.5 requested physical-core-s/page,
  not vCPU-s/page.

These are single-container measurements. They do not prove fleet-linear
scaling. The dated correction is recorded in the trial and living documents
by `dca8812` and its closure fixes `73d714a` (PR #86, merged at `a9a44f8`);
the deployment branch must contain that correction before using the figures.

## 4. Required workload contract

The owner of the real workload must fill this table before a production API
is designed or a 10,000-request claim is made. `unknown` is an acceptable
prototype input. It is not an acceptable production assumption.

| input | required value | current value |
|---|---:|---:|
| steady documents/s | number | unknown |
| peak documents/s | number | unknown |
| burst duration | seconds | 60 s example only |
| PDF bytes p50 / p95 / maximum | bytes | unknown / unknown / 100 MiB current cap |
| pages per document p50 / p95 / maximum | pages | unknown |
| accepted-job acknowledgement p95 | seconds | unknown |
| first-page availability p95 | seconds | unknown |
| document completion p95 | seconds | unknown |
| maximum backlog age | seconds | unknown |
| overload policy | reject or accept-and-wait | unknown |
| result retention | duration | unknown |
| data residency and deletion requirement | policy | unknown |
| enrichment fraction | percent | 0% for prototype |
| monthly and per-burst spend limit | USD | unknown |

An example of “10,000 requests in one minute” gives only 166.7 documents/s.
It says nothing about bytes, pages, upload bandwidth, processing work,
retention, or acceptable drain time.

## 5. Options considered

| option | decision | reason |
|---|---|---|
| Run current server with `@modal.web_server` and scale replicas | reject | local job ownership makes status routing incorrect; Servers do not have the same queued Function-input semantics |
| One warm `modal.Cls` input per document | adopt for prototype | preserves existing page scheduler and amortizes 70-88 s observed cold initialization |
| One Modal input per page | reject | duplicates document open/state work and creates a result joiner before a need is proved |
| Shared Volume as live `/data` | reject | all replicas can resume the same jobs; commit/reload and last-write-wins are not job ownership |
| Bounded PDF bytes as Function argument | adopt for prototype | smallest internal path; Modal stores payloads over 2 MiB in object storage |
| Presigned upload plus object store plus small queued message | defer to production trigger | correct for a remote burst API, but adds auth, retention, idempotency, and a job index |
| Modal-native enrichment | reject for prototype | present quotas and spend ledger are not fleet-wide |

Official Modal documentation states that Server primitives do not have a
Function input queue or retry semantics; see [Modal Servers](https://modal.com/docs/guide/servers).

## 6. Repository and dependency boundary

Create only these deployment files in the first implementation:

```text
deploy/modal/
  modal_app.py       # Modal image, warm class, invocation and local test entrypoint
  README.md          # commands, parameters, operational limits
test/
  modal-boundary.test.mjs  # source-boundary and configuration invariants
```

The exact test language may change if the implementation adds a small Python
test setup. Do not add a deployment framework.

Required boundaries:

1. `src/` and `service/` contain zero `import modal` or `from modal` lines.
2. The adapter consumes the committed `Dockerfile` and the existing service
   HTTP contract. It does not copy parser logic.
3. Modal is a deployment dependency, not a runtime dependency of the npm
   package.
4. The image, model pins, schema, service, and adapter remain in this one
   repository so they change atomically.
5. A separate deployment repository is considered only when a different team
   owns deployment or multiple deployment targets need independent release
   cycles.

## 7. Prototype contract

### 7.1 Invocation surface

**DECISION:** the prototype exposes no public URL. An authorized internal
caller uses the Modal Python client and `Function.spawn()` or the class method
equivalent.

Input:

```python
{
    "request_id": "caller-generated UUID or test-manifest ID",
    "pdf_bytes": bytes,
    "source_uri": "optional non-secret provenance label",
    "expected_sha256": "lowercase hex",
    "schema_version": "0.6.0",
    "enrichment": "off",
}
```

Rules:

- reject missing or malformed `request_id`;
- reject an unsupported `schema_version`;
- reject any enrichment value other than `off`;
- reject an empty body or a body over 90 MiB before starting Node work;
- compute SHA-256 in the Modal method and reject a mismatch;
- never accept a server-side `pdfPath`; and
- do not log PDF bytes, extracted text, secrets, or full result bodies.

Output:

```python
{
    "request_id": str,
    "document_sha256": str,
    "page_count": int,
    "status": "completed" | "failed",
    "pages": list,
    "failure": None | {"class": str, "message": str},
    "timing": {
        "container_cold": bool,
        "queue_wait_ms": int | None,
        "service_ready_ms": int,
        "parse_ms": int,
        "total_method_ms": int,
    },
    "adapter_revision": str,
}
```

The maximum serialized output is 64 MiB. If an accepted 200-page document
exceeds it, return a visible `ResultTooLarge` terminal failure. Do not silently
truncate pages.

The adapter cannot enforce the page limit before the current service probes
the PDF. Add a deployment-neutral `SERVICE_MAX_PAGES_PER_JOB` check in
`ParseService.submit()` immediately after `openDocumentContext()` returns and
before job creation or page enqueue. `0` may preserve the current unlimited
local default; the Modal adapter must set it to `200`. The HTTP response must
be a visible client error, not an accepted job.

Modal stores asynchronous Function results for seven days, and Modal's
security policy states Function **inputs and outputs** may be retained for
up to seven days — so the PDF bytes and the parsed result both live on
Modal's side for up to that window. Acceptable for the internal prototype
with approved evaluation documents only; a production API owns its own
retention. See
[Function invocation methods](https://modal.com/docs/guide/function-invocation-methods)
and [Modal data retention](https://modal.com/docs/guide/security#data-retention).

The 90 MiB Function-input limit is intentionally below Modal's current 100 MB
gRPC payload limit so serialization and metadata have headroom. The service's
independent loopback HTTP cap remains 100 MiB. See
[Modal troubleshooting](https://modal.com/docs/guide/troubleshooting#413-content-too-large-errors).

### 7.2 Image contract

Use `modal.Image.from_dockerfile("Dockerfile", add_python="3.11")` from the
repository root. Pin the Modal Python dependency used to deploy.

The adapter must not assume Docker `CMD` starts the service. Modal Functions
do not run an image's `CMD`, and Modal ignores Dockerfile `USER`; see
[Using existing images](https://modal.com/docs/guide/existing-images).

The Node service is a private child of the Python class container:

- bind it to `127.0.0.1` on a chosen private port;
- set a fresh private `SERVICE_DATA_DIR` under `/tmp` for that container;
- set `SERVICE_ALLOW_PDF_PATH=0` or leave it unset;
- set the measured worker topology explicitly;
- capture stdout/stderr without allowing an unbounded pipe buffer; and
- send `SIGTERM`, await exit, then force-kill after a bounded shutdown grace.

The non-root Docker invariant must still be tested on a real Docker host.
Modal ignoring `USER` is not proof of that path.

Modal gives an exit hook 30 seconds before hard kill. The adapter's complete
normal shutdown, including Node drain and force-kill fallback, must fit inside
that window with margin. A hard container crash may skip `@exit`; process
namespace destruction, not the hook, is the final orphan boundary.

### 7.3 Warm class lifecycle

Use a `modal.Cls`, not a fresh Function process that boots Node for every
document.

```text
container start
  -> @enter: create private data dir
  -> @enter: start Node explicitly
  -> @enter: poll /health until 200 or fail startup
  -> @method: validate one document
  -> @method: POST bytes to loopback service
  -> @method: poll local job to terminal state
  -> @method: return bounded bundle
  -> @method: remove the job directory and uploaded PDF after constructing the result
  -> next document reuses warm Node and models
  -> @exit: SIGTERM Node, wait, verify child exit
```

The current service retains accepted jobs in its in-memory `jobs` map after
their files are removed. To bound that state without adding a service eviction
API, one prototype Node lifetime creates at most 100 Node jobs. Increment the
counter when the loopback `POST /v1/jobs` returns a job ID, not when the Modal
method terminates. At the limit, the adapter stops fetching inputs and lets
Modal replace the container. Use the pinned SDK's verified
`modal.experimental.stop_fetching_inputs()` until Modal provides a stable
equivalent. Isolate it in one helper and cover it with a test. Do not build a
Node restart manager.

Required settings for the first trial:

| setting | required prototype value |
|---|---|
| method input concurrency | 1 |
| `cpu` | 4.0 physical cores, matching the existing trial first |
| `memory` | 24,576 MiB first; tune only from measured peak |
| `startup_timeout` | explicit; greater than the measured cold readiness maximum plus margin |
| method `timeout` | explicit; derived from the maximum accepted document and excluding startup, no more than Modal's platform maximum |
| `retries` | 1 application retry for the failure trial; final value decided from results |
| `min_containers` | 0 |
| `buffer_containers` | 0 |
| `scaledown_window` | default, then record actual reuse |
| `max_containers` | 1, 4, and 16 in separate trial arms; never unbounded |
| memory snapshot | off for baseline |
| enrichment | forced off |
| created Node jobs per warm lifetime | 100 maximum |

Modal documents `cpu` as physical cores, memory in MiB, a five-minute default
Function timeout with a 24-hour maximum, and billing based on the larger of
requested and actual resource use. See [resources](https://modal.com/docs/guide/resources)
and [Functions](https://modal.com/docs/guide/functions).

Memory Snapshots are a later experiment. First prove that the Node child and
its model state are snapshot-compatible and measure the change. Do not assume
the documented 3-10x examples apply to this multi-process service; see
[Memory Snapshots](https://modal.com/docs/guide/memory-snapshots).

### 7.4 Private storage rules

Each warm container owns one private service data directory. Each method owns
one request subdirectory or one service job within it.

- no shared live job directory;
- no cross-container resume;
- no state survives container replacement in the prototype;
- a retried Modal input starts the document from the beginning; and
- cleanup removes both `data/<jobId>/` and its `uploads/upload_*.pdf` after a
  terminal output is constructed; and
- method entry removes abandoned job directories and uploaded PDFs from a
  prior exception or timeout before accepting new bytes.

Cleanup runs in `finally`, but a container crash can skip it. That is safe only
because scratch belongs to the disposable container. Qualification asserts
that both paths are absent after success, visible failure, timeout recovery,
and ordinary retry.

Modal's default ephemeral disk quota is currently 512 GiB. Disk exhaustion
still has to be bounded by input size, one-input concurrency, cleanup, and a
method-level free-space check. See [Modal resources](https://modal.com/docs/guide/resources).

## 8. Delivery and failure semantics

`spawn()` means durable asynchronous execution, not exactly-once execution.
Modal can reschedule an input after container failure or preemption. Application
exceptions retry only when `retries` is configured. The parser and any future
side effect must therefore be idempotent. See [Failures and retries](https://modal.com/docs/guide/retries)
and [Preemption](https://modal.com/docs/guide/preemption).

| event | required prototype behavior | production implication |
|---|---|---|
| `spawn()` returns a FunctionCall ID | caller stores ID and request ID | production writes the idempotency mapping before acknowledging |
| call accepted but submit response is lost | caller may submit again; duplicate parse cost is possible | tenant-scoped idempotency key must return the original job |
| container dies before terminal result | Modal reschedules; document restarts in new private scratch | output publication must be conditional/idempotent |
| Node child dies or `/health` degrades | stop fetching inputs, then fail; retry runs on a fresh container | classify child/pool failure separately from invalid input |
| parser returns per-page failures | return the complete canonical failed-page records | do not retry deterministic page failures at fleet level |
| method raises application exception | retry only as configured, then visible failed FunctionCall | status store records terminal failure |
| method timeout | call fails visibly; local container state is disposable | SLO and timeout derive from page distribution |
| duplicate request ID in 100-doc harness | both calls may compute, but hashes and results must agree | production must suppress duplicate paid work |
| deploy occurs with queued calls | recorded app revision remains attributable in each result | production deployment policy must define draining/versioning |
| Function result reaches seven-day expiry | prototype result is unavailable | production result store owns retention |

**No accepted-job guarantee exists between an external HTTP request and
`spawn()` in the prototype because the prototype has no external HTTP
endpoint.** This avoids pretending that two unjoined operations are a
transaction.

A dead Node child or degraded worker pool poisons that warm instance. The
adapter must stop it from fetching inputs before it raises. It accepts no
later document. Do not repair or restart a degraded service in place in v1.

## 9. Autoscaling and capacity model

Modal maintains an autoscaled pool per Function, scales it to zero by default,
and supports explicit `max_containers`, `min_containers`, and
`buffer_containers`. Current documentation states a hard 4,000-container limit
for one Function. Workspace-plan limits may be lower. See
[Scaling out](https://modal.com/docs/guide/scale) and verify the target
workspace before each trial.

Asynchronous invocation currently documents:

- up to 1,000,000 queued inputs;
- a baseline submission rate of 1,500 inputs/s; and
- `ResourceExhaustedError` when a platform limit is exceeded.

These are vendor limits, not PageSpatial acceptance guarantees. See
[Function invocation methods](https://modal.com/docs/guide/function-invocation-methods).

Use these equations only after workload measurements exist:

```text
arrival_pages_per_s = arrival_documents_per_s * mean_pages_per_document

requested_cores = arrival_pages_per_s * measured_physical_core_s_per_page

estimated_containers = ceil(
  requested_cores / requested_physical_cores_per_container
)

backlog_drain_s = backlog_pages / measured_aggregate_pages_per_s

effective_cost_per_page = total_billed_cost / terminal_pages
```

The second equation assumes perfect fleet efficiency. It is a first estimate,
not a capacity promise. The 1/4/16-container trial must measure the loss from
cold starts, skewed document sizes, shared tenancy, retries, and container
churn.

For the example 10,000-document minute, the ingress submission rate of about
166.7/s is below Modal's documented asynchronous baseline. This does **not**
prove that uploads, workspace limits, parse capacity, result storage, or the
completion SLO can sustain the workload.

## 10. Cost model

As of 2026-08-23, Modal lists:

- CPU: `$0.0000131` per physical core-second; and
- memory: `$0.00000222` per GiB-second.

At the existing trial request of 4 physical cores and 24 GiB, provisioned
compute is approximately:

```text
hourly = 4 * 3600 * 0.0000131 + 24 * 3600 * 0.00000222
       = $0.380448 per container-hour
```

Applying that dated price to the two observed single-container throughputs
gives a rough `$80-$146 per million pages` for steady parse compute. This is
an **estimate**, not a measured bill. It excludes cold initialization,
retries, regional multipliers, storage,
network, logs, failed documents, and enrichment.

The acceptance value is:

```text
actual_cost_per_million_terminal_pages =
  billing_report_total_usd / terminal_pages * 1_000_000
```

Give each trial arm a unique app/function tag and run it in a non-overlapping
completed billing interval. **Aggregate billed cost for the whole
qualification run is mandatory** (acceptance criterion 12 measures it);
**per-arm billed cost is required only where the billing report can
attribute it** — if hourly report granularity cannot isolate an arm, label
that arm's cost as a resource-time estimate and do not call it billed cost.
See
[Modal billing CLI](https://modal.com/docs/cli/latest/billing). Record the
pricing URL and retrieval date because rates can change.

Cost gates:

- set a workspace/environment budget before the 100-document run;
- set `max_containers` in code before deployment;
- run the one-container arm first;
- stop if output correctness fails;
- stop if projected 100-document cost exceeds the owner-approved trial cap;
- do not extrapolate price from CPU alone; and
- do not include free credits when reporting unit cost.

## 11. Security, privacy, and admission

The prototype uses Modal client authentication and has no public URL. It is
for internal/trusted use.

Required controls:

- deploy using a service identity with the least required Modal role;
- store Modal credentials and future provider keys outside the image;
- never place secrets in Function inputs or results;
- never log document content;
- reject `pdfPath` and enforce loopback for the child service;
- cap input bytes, page count, output bytes, method time, and containers;
- keep enrichment off and do not provide `GEMINI_API_KEY` to the parse app;
- record retention and deletion behavior in the trial report; and
- use only approved non-sensitive evaluation documents.

If a Web Function is later introduced, it must use Modal Proxy Auth or an
equivalent authenticated gateway. Web endpoint limits and timeouts are
different from asynchronous Function limits; verify them at implementation
time. See [Web Functions](https://modal.com/docs/guide/webhooks),
[Proxy Tokens](https://modal.com/docs/guide/webhook-proxy-auth), and
[request timeouts](https://modal.com/docs/guide/webhook-timeouts).

Admission for a production remote API must occur **before** the application
buffers the PDF. It must enforce tenant quota, bytes, concurrent uploads,
queued jobs, spend budget, and rate. Overload returns `429` with
`Retry-After`; platform exhaustion is not the normal admission mechanism.

## 12. Observability contract

Every method result or structured log event must include:

- request ID and document hash prefix;
- immutable application revision and image/model-pin revision;
- container cold/warm classification;
- Node readiness duration;
- page count;
- parse duration and total method duration;
- terminal successful/failed page counts;
- retry attempt when available;
- cleanup outcome; and
- resource configuration (`cpu`, memory, workers, thread count).

Trial aggregation must report:

- submitted, rejected, running, completed, and failed documents;
- submitted and terminal pages;
- duplicate inputs and duplicate terminal outputs;
- queue wait p50/p95/max when the platform exposes it;
- cold and warm method latency separately;
- cold starts and container reuse count;
- container count over time;
- document completion p50/p95/max;
- aggregate pages/s by trial arm;
- container crash, child crash, application retry, timeout, and OOM counts;
- cleanup failures and peak ephemeral-disk use; and
- billed CPU, memory, and total USD.

Metrics must reconcile to a manifest of submitted request IDs. Dashboard
counts without that reconciliation are not acceptance evidence.

## 13. Enrichment: explicit exclusion and later gate

The first Modal adapter shall reject enrichment rather than ignore it.

Enrichment may be designed only after parse deployment passes. That later
design must include:

- one idempotent enrichment operation per document;
- a persisted provider batch/operation ID;
- deterministic output identity bound to document digest and plan revision;
- duplicate-submission handling;
- a fleet-wide and provider-side spend ceiling;
- fleet-wide chunk/concurrency limits;
- recovery from an accepted provider batch when the poller dies;
- retention and deletion of images and provider outputs; and
- a failure rule that never mutates the canonical parse record.

The current process-local boot sweep and `$10` ceiling are not reused as
distributed coordination.

## 14. Qualification run: existing correctness corpus plus 100 calls

### 14.1 Fixed manifest

Use the existing fixed 23-document, 162-page development corpus for
correctness. Before deployment, commit or archive its manifest with:

- stable request ID;
- SHA-256;
- byte size;
- page count;
- document class;
- expected parser disposition, if known; and
- permission classification.

The manifest must be fixed before results are viewed. Publish text-free
distribution counts for bytes, pages, native/scanned/mixed content, rotation,
and known malformed inputs.

Create a deterministic 100-call scaling manifest by repeating those 23
documents in a fixed published order until there are 100 calls. Each call has
a distinct request ID and retains its source document hash. Repeats measure
delivery and scale only; they do not increase correctness coverage. New
documents may replace repeats later, but sourcing 100 distinct documents is
not a prerequisite for the adapter.

### 14.2 Trial arms

Run in this order:

1. local adapter tests with stub parser;
2. one real document through a deployed Function;
3. the 100-call manifest with `max_containers=1`;
4. the same manifest with `max_containers=4`;
5. the same manifest with `max_containers=16`;
6. duplicate 10 chosen inputs;
7. stop one observed container once from an external harness while chosen
   inputs are running;
8. terminate the Node child during 10 chosen inputs;
9. force one application exception and one method timeout; and
10. repeat one warm arm to measure ordinary variance.

Application-exception and timeout injection must be test-only adapter flags
that cannot be enabled in the production deployment configuration. Container
failure is injected once from outside the input. A deterministic “self-kill”
input would execute again after Modal reschedules it and could crash-loop
indefinitely.

The one-shot container-stop procedure is:

1. spawn one marked request and record its request ID and FunctionCall ID;
2. run `modal container list --app-id <app-id> --json`;
3. correlate the request ID to one container with the adapter's structured
   start log and `modal container logs <container-id> --search <request-id>`;
4. run `modal container stop --yes <container-id>` exactly once; and
5. archive the list/log/stop outputs plus FunctionCall history showing that
   the active input was cancelled, rescheduled, and reached a visible terminal
   result or failure.

Do not use `--graceful` in this failure probe. Modal documents that a normal
Function container stop cancels and reschedules its active inputs; see
[the container CLI](https://modal.com/docs/cli/latest/container).

### 14.3 Stable-result comparator

Do not compare `pageDigest()` across repeated parses. The digest deliberately
includes `provenance.runId` and `provenance.createdAt`, so a valid reparse has
a new digest.

Implement three named test projections:

1. `stableDeterministicProjection(page)` removes
   `provenance.runId`, `provenance.createdAt`, `nativeObservations[].font`,
   and the OCR-dependent roots listed below. Its canonical JSON must be
   exact. *(Amended 2026-08-23, M4 tune-once: the qualification run failed
   criteria 3/7 solely on `nativeObservations[].font` — pdf.js's
   session-local `g_d<N>_f<M>` resource label, a per-worker-process
   document counter present even in the same-config null pair; an
   independent path-diff put 100% of leaf differences at that field, and
   dev-v13's baseline review had already adjudicated it "metadata, not
   evidence". Excluded field-level in the comparator only — never
   normalized in the record (digest-era-breaking) and never via a
   serialized-JSON regex (could match legitimate document text).)*
2. `ocrScoreProjection(pages)` converts PageSpatial records to the existing
   EP scorer shape without changing observation order:

   ```js
   {
     perPage: pages.map((page) => ({
       page: page.pageNumber,
       lines: page.ocrObservations.map((item) => ({
         text: item.text,
         score: item.confidence ?? null
       }))
     }))
   }
   ```

3. `ocrDerivedProjection(page)` contains only these roots:

   ```text
   ocrObservations, sourceMatches, conflicts, spatialRows, derivedRelations,
   unreadInkRegions, secondOpinion, diagnostics, projection
   ```

The deterministic projection includes geometry, native observations, native
lines, document/page identity, and non-volatile provenance. It must remain
exact. If the OCR score projection is exact, the OCR-derived projection must
also be exact. If OCR varies, both complete pages must still pass schema
validation, and only the OCR-derived projection may differ.

Run the existing critical-token and raw-line scorer over
`ocrScoreProjection`. Derive the null tolerance by parsing the same manifest
twice under the same deployed configuration before comparing scaling arms. A
scale arm passes only when its critical-token and raw-line delta is no larger
than that run's null tolerance. The previous same-host control found zero
critical tokens and zero raw lines for its specific run; it is evidence, not a
universal hard-coded tolerance.

Comparator unit tests must include one OCR text/score variation inside the
allowed null tolerance and one native-field mutation. The first may pass; the
second must fail regardless of OCR score.

### 14.4 Acceptance criteria

The prototype passes only if all of these are true:

1. Every submitted request ID reconciles to one visible terminal FunctionCall
   result or one visible terminal exception. There are zero silent missing
   inputs.
2. Every successful document contains exactly its probed page count. Each page
   is canonical schema `0.6.0` or an explicit failed-page record.
3. For ordinary repeated inputs, document hashes match and stable page
   projections meet the exact/native and derived-null OCR rules in §14.3.
4. Container kill causes visible rescheduling and a valid terminal result or
   visible terminal failure. No partial output is reported as complete.
5. Node-child kill is classified and bounded. It does not leave the method
   hanging until the maximum Modal timeout.
6. Application exception and timeout behavior match the configured retry
   count and are visible to the caller.
7. Duplicate prototype calls pass all three §14.3 projection rules. Their full
   `pageDigest()` values are expected to differ. Duplicate compute is counted.
   No paid enrichment call occurs.
8. There are zero surviving Node or Python child processes after container
   exit in the explicit lifecycle probe.
9. Both private job state and the referenced uploaded PDF are removed after
   every terminal method and recovered after forced timeout. Peak disk remains
   below its documented limit.
10. Cold readiness, warm latency, aggregate throughput, queue wait, and cost
    are reported separately for each arm — per-arm cost as billed cost where
    the billing report attributes it, otherwise as a labeled resource-time
    estimate (§10).
11. The 1/4/16 arms show their actual container count. No linear scaling claim
    is made unless aggregate throughput and efficiency support it.
12. Actual Modal billing reconciles with the run window and terminal page
    count. The report states both total spend and cost per terminal page.

Passing this gate qualifies the adapter for controlled internal parse jobs.
It does not qualify a public API or a 10,000-request SLO.

## 15. Production remote API: conditional second design

**Trigger:** build this only when the workload contract requires remote burst
ingress, result retention beyond seven days, non-Python callers, tenant
controls, or “accept all” semantics.

Minimal target shape:

```text
client
  -> authenticated gateway: create upload + idempotency record
  -> direct presigned upload to object storage
  -> finalize: verify object size/hash and spawn small document message
  -> Modal warm parse class: download to private scratch, parse once
  -> conditional immutable result publish
  -> small job store: status, owner, call ID, object keys, terminal error
  -> client: summary status + cursor/page result access
```

The queued message contains object keys and metadata, not PDF bytes:

```json
{
  "jobId": "server-generated opaque ID",
  "tenantId": "authenticated tenant ID",
  "idempotencyKey": "tenant-scoped key",
  "inputKey": "immutable object key",
  "inputSha256": "hex",
  "outputKey": "deterministic immutable key",
  "schemaVersion": "0.6.0",
  "enrichment": "off"
}
```

Required invariants:

- acknowledgement occurs only after the upload is finalized, the idempotency
  mapping is durable, and the queued call ID is durably associated, or after a
  recovery record exists for the gap;
- the same tenant and idempotency key returns the same job;
- the same output key is published once with conditional create semantics;
- retries may recompute but cannot create conflicting terminal outputs;
- job status never depends on routing to a particular parse container;
- result endpoints do not return every page on every status poll;
- input and output retention are explicit and deletions are auditable; and
- the gateway can reject before accepting upload bytes.

Choosing S3, GCS, R2, DynamoDB, Postgres, or another job store is **not part of
this document**. Select the smallest service that meets the supplied workload,
conditional-write, retention, and residency requirements.

## 16. Implementation sequence

### M0 - correct the record and local trust boundary

Independent of Modal:

- merge the host-loopback and `pdfPath`-off-by-default fix — **done**,
  PR #85 (`b5b88c9`); and
- correct the physical-core labels and derived pricing claims in dated/living
  documentation — **done**, PR #86 (`a9a44f8`).

The first-real-Docker-host non-root and init smoke test is a **parallel
Docker-release gate, not an M1 dependency**: Modal Functions ignore the
Dockerfile `CMD` and `USER`, so that smoke proves the ordinary Docker
deployment path, which the Modal adapter does not exercise. Run it on real
linux/amd64 hardware before any plain-Docker release; do not burn time on
emulated builds.

### M1 - adapter skeleton

- add `deploy/modal/modal_app.py` and its README;
- build from the committed Dockerfile;
- implement explicit class enter/method/exit lifecycle;
- implement one-document input/output validation;
- enforce private scratch, loopback, parse-only, one-input concurrency, and
  bounded resources; and
- add source-boundary tests.

Acceptance: one approved PDF completes through a deployed asynchronous call,
and a second call reuses the warm container without restarting Node.

### M2 - failure and measurement instruments

- add structured timing and identity fields;
- add test-only failure injection;
- add manifest reconciliation;
- add cleanup and child-exit probes; and
- add billing-report capture instructions.

Acceptance: local/stub tests prove each failure path is reachable and bounded.

### M3 - 100-document qualification

Run §14 unchanged. Publish a dated trial report with raw result paths, app
revision, workspace plan/limits, Modal SDK version, pricing retrieval date,
resource settings, and all acceptance outcomes.

### M4 - decision checkpoint

Choose one:

- **adopt internal Modal parse:** qualification passes and cost/latency are
  useful;
- **tune once:** one named failed target has a small measured remedy; or
- **stop:** correctness, failure behavior, or economics do not justify more
  deployment code.

Do not start the production remote API merely because the prototype exists.

## 17. Review checklist for the implementation PR

- [ ] The Modal adapter is confined to `deploy/modal/`.
- [ ] No Modal import exists in `src/` or `service/`.
- [ ] The committed Dockerfile is the image source.
- [ ] Docker `CMD` and `USER` are not assumed to apply to Functions.
- [ ] Node starts once per warm class container and binds loopback.
- [ ] `/health` gates method readiness.
- [ ] Input concurrency is one.
- [ ] One Modal input owns one document.
- [ ] `SERVICE_DATA_DIR` is private ephemeral storage.
- [ ] No shared Volume is live job state or a lock.
- [ ] Input bytes, pages, output bytes, disk, time, retries, and containers are
      bounded.
- [ ] Node exit or degraded health retires the warm instance before it accepts
      another document.
- [ ] Normal warm reuse stops when 100 Node job IDs have been created,
      bounding the service job map even across failed methods.
- [ ] Container failure injection is external and one-shot.
- [ ] Cleanup covers both job state and uploaded PDF bytes.
- [ ] Repeat comparison excludes only run ID and creation time, then applies a
      measured OCR null tolerance.
- [ ] `pdfPath` and enrichment are rejected.
- [ ] Failure and retry behavior is tested, not inferred.
- [ ] Results include immutable code/image/model revision.
- [ ] No content or secret appears in logs.
- [ ] Actual billing evidence is captured.
- [ ] No public/10K/linear-scaling claim appears before its gate passes.
- [ ] User changes in the active security-hardening branch are not reverted or
      mixed into the deployment PR.

## 18. References

### Repository evidence

- [Current HTTP server](../../service/server.mjs)
- [Job store, resume, status, and page queue](../../service/lib/queue.mjs)
- [Atomic state write](../../service/lib/atomic.mjs)
- [Process-local enrichment controls](../../service/lib/enrichment.mjs)
- [Container image](../../Dockerfile)
- [M1 Modal/Linux harness](../../scripts/evaluation/m1_linux_verification_modal.py)
- [M4 Modal harness](../../scripts/evaluation/m4_corpus_enrichment_modal.py)
- [Linux verification trial](../trials/2026-08-23-linux-verification.md)
- [Project principles](../principles.md)

### Modal contracts, checked 2026-08-23

- [Function invocation methods](https://modal.com/docs/guide/function-invocation-methods)
- [Scaling out](https://modal.com/docs/guide/scale)
- [Functions and timeouts](https://modal.com/docs/guide/functions)
- [Failures and retries](https://modal.com/docs/guide/retries)
- [Preemption](https://modal.com/docs/guide/preemption)
- [CPU, memory, disk, and billing basis](https://modal.com/docs/guide/resources)
- [Current pricing](https://modal.com/pricing)
- [Passing local data](https://modal.com/docs/guide/local-data)
- [Using an existing Docker image](https://modal.com/docs/guide/existing-images)
- [Container lifecycle](https://modal.com/docs/guide/lifecycle-functions)
- [Troubleshooting and stopping a poisoned container](https://modal.com/docs/guide/troubleshooting)
- [Container list, logs, and stop CLI](https://modal.com/docs/cli/latest/container)
- [Volumes](https://modal.com/docs/guide/volumes)
- [Memory Snapshots](https://modal.com/docs/guide/memory-snapshots)
- [Servers](https://modal.com/docs/guide/servers)
- [Web Functions](https://modal.com/docs/guide/webhooks)
- [Web request timeouts](https://modal.com/docs/guide/webhook-timeouts)
- [Proxy Tokens](https://modal.com/docs/guide/webhook-proxy-auth)
- [Billing reports](https://modal.com/docs/cli/latest/billing)

## 19. One-sentence architecture record

PageSpatial will first use Modal as a bounded, at-least-once,
document-level execution queue around a warm, privately stateful copy of the
existing parser; it will add public ingress, shared durable results, and
distributed enrichment only after measured workload and qualification gates
require them.

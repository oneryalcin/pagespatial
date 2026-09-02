# PageSpatial engineering handoff

Date: 2026-09-02
Repository: `github.com/oneryalcin/pagespatial`
Baseline: `main` at `6179a72` after PR #127

## Purpose

This is the current operational map for the next engineer. It states what is
live, what is measured, what is only proposed, and what must not be inferred.
It does not replace API references, trial records, or architecture decisions;
it links to them.

PageSpatial has two related products:

1. An open-source TypeScript library that turns PDFs into evidence-backed,
   schema-valid records in browsers and Node.
2. A managed public-alpha service with Cloudflare Access, a small dashboard,
   an API, PostgreSQL, R2 object storage, and Modal CPU workers.

Do not mix their guarantees. The library can run without the managed service.
The managed service uses the library but also owns authentication, tenancy,
credits, job state, dispatch, storage, retention, and operations.

## Read this in order

1. [Principles](principles.md) — standing commitments. These win until a
   deliberate, recorded decision changes them.
2. This handoff — current system and operating state.
3. [Workstreams](workstreams.md) — living board and current measurements.
4. [README](../README.md) — library surfaces and examples.
5. [Architecture](architecture.md) — parser boundaries and evidence model.
6. [Service control-plane design](design/2026-08-26-service-control-plane.md)
   and [API contract](design/2026-08-26-service-m2-api-contract.md).
7. Linked trial records for the evidence behind a claim.

If documents disagree, use the newest dated correction or trial and the
current workstream board. Preserve the older record as history; do not silently
rewrite an earlier measurement.

## Current product surfaces

### Public site and browser demo

- `https://pagespatial.dev` and `https://www.pagespatial.dev` are hosted on
  Cloudflare Pages.
- The public demo parses at most four pages in the browser.
- The demo sends no PDF bytes to PageSpatial, R2, or Modal.
- It uses PDF.js and browser PP-OCR, preferring WebGPU with sticky WASM
  fallback.
- It is a product demonstration, not the managed service's compute path.

### Managed alpha

- `https://app.pagespatial.dev` is the dashboard behind Cloudflare Access.
- `https://api.pagespatial.dev` is the API behind bearer API-key auth.
- Public self-sign-up is enabled through Cloudflare Access one-time PIN.
- A new account receives 100 page credits exactly once.
- Users can submit a PDF in the dashboard or use the API.
- No payment, subscription, organization, team, or automatic credit-purchase
  flow exists. Credit top-ups are manually reviewed during alpha.
- Public enrichment is disabled. The current public profile is parse-only v1.

### Library

- Package version: `0.1.0`.
- The package is still experimental and is not a qualified public npm release.
- `PageSpatialDocument` is the canonical evidence record.
- Markdown, tables, hierarchy, chart relations, search chunks, and prompts are
  derived views. They are not source evidence.

## Deployed topology

```text
pagespatial.dev / www.pagespatial.dev
  Cloudflare Pages
  -> public browser-local demo (max 4 pages, no PDF upload)

browser
  -> Cloudflare Access one-time PIN
  -> app.pagespatial.dev -----------------------------+
                                                       |
API-key client                                         |
  -> api.pagespatial.dev ------------------------------+
                                                       v
                                             Cloudflare Tunnel
                                                       |
                                                       v
VPS: 51.195.149.152
  deploy/control-plane/compose.yaml
  +-- api container
  |    +-- dashboard and API
  |    +-- dispatcher every 5 seconds
  |    +-- reconciler every 60 seconds
  |    +-- migrations before listen
  +-- PostgreSQL 18
  +-- cloudflared
       no public host ports

api container
  +-- R2 input and result buckets
  +-- Modal JavaScript client
       -> pagespatial-parse-internal
          -> one document per Modal container call
          -> Node parse service
          -> four Node page workers
          -> four Python PP-OCRv6/OpenVINO sidecars
```

The root [`Dockerfile`](../Dockerfile) is the qualified Modal parse-worker
image. It is not the control-plane image. The control plane has its own image
at [`deploy/control-plane/Dockerfile`](../deploy/control-plane/Dockerfile).

## Stable parser invariants

These are load-bearing. Do not weaken them to improve a metric.

1. Native PDF extraction and OCR are independent witnesses. Keep their raw
   observations separate after matching.
2. PDF.js owns geometry. Transform all four source-box corners with the exact
   renderer viewport matrix. PDF Inspector is not the geometry authority.
3. Invalid geometry fails closed. Do not make it pass by clipping it to the
   page.
4. Markdown is derived, untrusted document content. Sanitize it before HTML
   rendering and delimit it in model prompts.
5. Derived records cite stable source observation IDs.
6. Diagnostics use closed typed vocabularies. Do not classify raw exception
   messages into public states.
7. Browser WebGPU can fall back to WASM, but the fallback is sticky for the
   parser lifetime and is explicit in diagnostics.
8. Human review belongs to evaluation and gold adjudication. Production
   escalation is an automated routing signal, not a human queue.

Core contracts are in:

- [`src/types.ts`](../src/types.ts)
- [`src/schema.ts`](../src/schema.ts)
- [`src/adapters.ts`](../src/adapters.ts)
- [`src/page-parser.ts`](../src/page-parser.ts)
- [`src/geometry.ts`](../src/geometry.ts)
- [`schemas/pagespatial.schema.json`](../schemas/pagespatial.schema.json)

## Managed job lifecycle

```text
create job
  -> authenticate tenant
  -> apply idempotency key
  -> reserve page allowance and credits
  -> return a presigned input PUT

browser/client PUTs PDF directly to R2
  -> finalize
  -> HEAD input object and validate deadline/size/digest
  -> queued
  -> dispatcher creates an attempt and spawns Modal
  -> reconciler polls Modal and inspects R2
  -> validate pointer, stored bytes, digest, identity, and public envelope
  -> atomically accept the first valid attempt
  -> succeeded or failed
```

The API process never buffers a customer PDF. The worker has no database
credentials.

### Dispatch and acceptance invariants

- PostgreSQL commit and Modal spawn cannot be atomic. Dispatch is at least
  once, and duplicate compute is an accepted property.
- Input key: `inputs/{job_id}.pdf`.
- Result prefix: `results/{job_id}/{attempt_id}`.
- Each execution writes an immutable
  `results/{job_id}/{attempt_id}/{execution_id}.json` object.
- Only the database acceptance fence makes a result authoritative.
- Cross-job acceptance is blocked in code and by the composite database
  relationship between job and attempt.
- A late successful attempt is recorded truthfully but cannot displace the
  accepted winner.
- An original `dispatch_unknown` attempt remains harvestable after a
  replacement starts. Failing it early can discard compute already paid for.
- At most one replacement attempt exists.
- Modal SDK output and R2 are both consulted before a permanent failure. The
  JavaScript Modal SDK does not expose a distinct expired-output error.
- Every non-terminal state has a bounded path to a terminal state. The job
  processing deadline is 24 hours.
- A reconciler failure on one attempt cannot block the rest of a pass.

The implementation is in [`service/api/src`](../service/api/src), especially
`dispatcher.mjs`, `reconciler.mjs`, `accept.mjs`, `lifecycle.mjs`, and
`r2-results.mjs`.

## Authentication, tenancy, and credits

### Dashboard

- Cloudflare Access is the identity provider and login surface.
- The origin trusts only `Cf-Access-Jwt-Assertion`, verified against the Access
  JWKS, issuer, audience, algorithm, and `type: app`.
- The email convenience header is not trusted.
- Dashboard mutations require an exact same-origin `Origin` header.
- Missing, malformed, foreign, and suspended identities fail closed.

### API

- API keys contain generated entropy and are stored as SHA-256 hashes with a
  display prefix. Plaintext is shown once.
- Bearer scheme matching is case-insensitive.
- Authentication failures return `401` and `WWW-Authenticate: Bearer`.
- Tenant-owned resources return `404` for both missing and foreign IDs.

### Open alpha

Production settings are:

```text
PAGESPATIAL_ALLOW_SELF_SIGNUP=1
PAGESPATIAL_TRIAL_PAGE_CREDITS=100
```

The first successful Access login creates the account and grants the trial
credit exactly once. Credits are reserved at admission so concurrent jobs
cannot overspend the allowance. The dashboard exposes available, used,
reserved, and granted pages.

The global active-job fuse is 100. It was derived from the measured
single-container throughput, 200-page maximum, 24-hour deadline, and a 50%
safety margin. Do not scale this limit from an assumed linear Modal fleet; that
linearity was not measured.

## Object storage and retention

The live topology uses separate input and result buckets and four credential
roles:

| Role | Input bucket | Result bucket |
| --- | --- | --- |
| API input | read/write | denied |
| API result | denied | read |
| Modal input | read | denied |
| Modal result | denied | read/write |

Startup checks reject identical buckets or reused access-key identities, but
they cannot prove provider ACLs. The live denial matrix caught a real
over-permissioned result credential. Rerun the matrix after every credential
rotation.

- Input and result objects are retained for up to two days by R2 lifecycle
  rules. R2 deletion is asynchronous, not an exact timestamp guarantee.
- Upload/finalize must complete within one hour of job creation.
- A queued job has a 24-hour processing deadline.
- Result access expires two days after the accepted object's R2
  `LastModified`, not after reconciliation time.
- Result download grants last at most five minutes.

## Modal worker

Current production app: `pagespatial-parse-internal`.

| Setting | Production value |
| --- | --- |
| CPU | 4 physical cores |
| Memory | 8,192 MiB |
| `min_containers` | 0 |
| `buffer_containers` | 0 |
| `max_containers` | 1 |
| Documents per call | 1 |
| Node page workers | 4 |
| OCR sidecars | 4 |
| OpenVINO threads per sidecar | 4 (allowlisted 1/2/4) |
| Input limit | 90 MiB |
| Page limit | 200 |
| Warm-lifetime limit | 100 jobs |
| Direct result limit | 64 MiB |
| R2 pointer result limit | 128 MiB |
| Memory snapshots | enabled |

`max_containers` is allowlisted to `{1, 4, 16}`. Memory is allowlisted to
`{8192, 12288, 16384, 24576}` MiB. Changing either value is an explicit
operational decision, not free-form configuration.

Deploy with:

```bash
PAGESPATIAL_MODAL_APP_NAME=pagespatial-parse-internal \
PAGESPATIAL_MAX_CONTAINERS=1 \
PAGESPATIAL_MEMORY_MIB=8192 \
PAGESPATIAL_ENABLE_MEMORY_SNAPSHOT=1 \
modal deploy deploy/modal/modal_app.py
```

Measured facts:

- A production snapshot-hit one-page call became ready in 7.7 seconds and
  parsed in 2.5 seconds.
- A new deploy or rebuilt image still measured 83.8–102.3 seconds before
  service readiness. This is not a latency SLA.
- Two 100-page 8 GiB runs completed 200/200 pages. Sampled peak RSS was
  5.92–6.01 GiB, leaving about 2 GiB of observed headroom.
- RSS sampling is a lower bound, not a kernel high-water mark. Keep the memory
  telemetry in result metadata and logs.
- PDF Inspector 1.17.0 is adopted and qualified on the live R2/Modal path.

The Python Modal deployment SDK and the control-plane JavaScript client are
different dependencies. The current deployment SDK is 1.5.3; the control
plane pins `modal@0.9.0`.

See [Modal deployment](../deploy/modal/README.md), the
[snapshot trial](trials/2026-09-01-modal-memory-snapshot-qualification.md),
and the [8 GiB trial](trials/2026-09-01-modal-memory-allocation.md).

## Control-plane operation

The VPS Compose project lives under [`deploy/control-plane`](../deploy/control-plane).
It contains `api`, `postgres:18.6-bookworm`, and `cloudflared`. It publishes no
host ports. The API container uses a read-only root filesystem, drops Linux
capabilities, and enables `no-new-privileges`.

```bash
cp deploy/control-plane/.env.example deploy/control-plane/.env
chmod 600 deploy/control-plane/.env
docker compose -f deploy/control-plane/compose.yaml build api
docker compose -f deploy/control-plane/compose.yaml up -d
docker compose -f deploy/control-plane/compose.yaml ps
```

The API applies migrations before it listens. The dispatcher runs every five
seconds. The reconciler runs every 60 seconds with a 45-second pass deadline.

Useful operations:

```bash
# Public health. The Modal field can represent a cached handle, not a fresh
# reachability test.
curl -fsS https://api.pagespatial.dev/health

# Configure browser uploads on the input bucket.
wrangler r2 bucket cors set "$R2_INPUT_BUCKET" \
  --file deploy/control-plane/r2-input-cors.json

# Grant alpha credits after manual review.
docker compose -f deploy/control-plane/compose.yaml exec api \
  npm run grant-credits -- user@example.com 100 "alpha top-up"
```

Never print or commit `.env`, R2 secrets, Modal tokens, Access credentials,
presigned URLs, API keys, or database passwords. Safe logs use allowlisted
tokens and deliberately omit exception messages and stacks.

## PostgreSQL: deliberate alpha compromise

PostgreSQL 18 runs on the VPS in a named Compose volume. This is an owner
decision for proof-of-value cost control, not the original managed-PostgreSQL
design.

What is proven:

- Schema migrations and concurrency tests run against native PostgreSQL.
- A manual off-site dump and byte-exact restore was demonstrated once.

What is not proven:

- There is no high availability.
- There is no scheduled off-site backup.
- There is no current RPO or RTO.
- VPS or volume loss can lose the job ledger and account state.

The accepted trigger is usage: move PostgreSQL to a managed service when real
usage justifies the recurring cost. Do not re-litigate this on architectural
preference alone. Also do not describe the current box as stateless or claim
vendor PITR.

## Parser and evaluation state

### Server parser

- TypeScript owns schema, orchestration, matching, diagnostics, and
  projections.
- PDF Inspector supplies preferred Markdown and unambiguous metadata.
- PDF.js supplies native text and geometry.
- Python PP-OCRv6/OpenVINO sidecars provide server OCR.
- The current sidecar reference baseline is
  `dev-v13-sidecar-2026-08-23`: 162/162 pages completed with zero failures.

### Browser parser

- PDF.js provides native extraction and rendering.
- PP-OCR uses WebGPU when verified, with sticky WASM fallback.
- Browser `dev-v12` and server `dev-v13` are different execution eras. Compare
  them only on independently adjudicated gold, not on raw route counts.

### Development corpus

The private corpus is hash-verified and materialized outside git. Reports are
committed only after the full expected tuple set succeeds. A failed or partial
run must not overwrite the last good aggregate.

```bash
npm run eval:corpus:check
npm run eval:corpus:dry-run
npm run eval:corpus:materialize
npm run eval:ocr-assets
npm run eval:baseline -- --backend webgpu
npm run eval:baseline:summary
```

Do not run `npm run build` while corpus evaluation is active; both use `dist/`.
`.evaluation/` is private and gitignored. `pdftoppm` and `tesseract` must be on
`PATH` for the local runner.

## Important measurements and non-conclusions

### ParseBench

The pinned Basic small-cohort run measured:

| Dimension | Score |
| --- | ---: |
| Content | 88.05 |
| Table | 41.22 |
| Semantic Formatting | 36.53 |
| Visual Grounding | 11.78 |
| Chart treatment | 0/23 |

This is evidence for where quality work should focus. It is not a universal
benchmark claim.

A bounded Gemini 3.7 Flash chart treatment passed 12/23 cases. One page was
0/8. This is promising research, not an adopted production tier.

### Retrieval

Trust metadata did not improve flat ranking in the measured harness.
Trust-free duplicate removal improved hit@5 by 13 points. The remaining trust
hypothesis belongs in answer verification and citation, not ranking.

### OCR performance

GPU work did not produce a deployable winner. Do not repeat a universal claim
that recognition batching is closed as a throughput lever. The prior result is
specific to the tested PaddleX/TensorRT path.

Issue [#126](https://github.com/oneryalcin/pagespatial/issues/126) records the
new evidence about recognizer output volume, OpenVINO thread configuration,
and a shadow-mode experiment plan. The owner un-parked it on 2026-09-02.
Step 1 (thread sweep) is done: the sidecar had never controlled its OpenVINO
pool and ran 10 threads per sidecar while reporting 1; 4 threads is now the
attested default, 1 thread was refuted, and the median gain is inside host
noise. See the [thread sweep](trials/2026-09-02-ocr-sidecar-thread-sweep.md).
Steps 2–5 are unstarted and authorize no recognition-policy change.

## Known product limitations

- Public alpha has no payment flow, subscriptions, teams, organizations, SSO
  providers beyond the current Access login method, or automated top-ups.
- Users download the result JSON. There is no rich evidence/result viewer.
- Cost shown in the dashboard is a stamped placeholder estimate, not an
  invoice or measured per-job cloud bill.
- Modal can scale to zero, so latency depends on snapshot and image state.
- `max_containers=1` bounds spend but also bounds production throughput.
- A dispatch outcome can remain honestly uncertain until the 24-hour job
  deadline when neither a Modal call ID nor an R2 result exists.
- Inputs and results expire after about two days.
- The current PostgreSQL topology is a single point of failure.
- The library and service remain alpha-quality. Do not promise an SLA from the
  current measurements.

## Deliberately parked or rejected work

- No provider-neutral worker-control protocol until a second compute provider
  is earned. The old pull-worker design added a second queue and could not
  wake a scale-to-zero Modal worker.
- No AWS Spot/Flex tier until measured demand and cost justify it.
- No Kubernetes, Redis, SQS, SPA framework, ORM, or generic plugin container.
- No Rust/C++ OCR rewrite without a profile proving the process boundary is a
  material bottleneck.
- No GPU production path from the existing trials.
- No production OCR skipping from native-coverage heuristics without
  adjudicated shadow evidence.
- No Stripe integration before manual alpha credit requests become a real
  operating burden.

## What the next engineer should do

### P0 — validate the product with real users

Invite three to five external alpha users. For each user, record only the
decision-relevant funnel:

1. Access sign-up completed.
2. First PDF submitted.
3. Job reached a terminal state.
4. Result was useful or not useful, with a concrete reason.
5. User returned for a second document or did not.

Fix blockers that prevent this loop. Do not add architecture before observing
the failures. The highest current risk is no longer component correctness; it
is whether the product solves a repeated user problem.

### Likely P1 — make results easier to inspect

The current result is a JSON download. A source-linked evidence viewer is the
most likely next product improvement, but build it only if alpha feedback shows
that raw JSON prevents evaluation or adoption. Reuse the canonical evidence
record; do not create a second result model.

### P1 safety — malformed-PDF fuzzing

Issue [#37](https://github.com/oneryalcin/pagespatial/issues/37) remains useful
before wider untrusted traffic. Keep the harness bounded and preserve exact
failing seeds.

### P2 maintenance — dependency boundaries

Issue [#83](https://github.com/oneryalcin/pagespatial/issues/83) tracks runtime
dependency slimming. Keep library, control-plane, browser-demo, and worker
dependencies separate. Do not move service-only dependencies into the root
library runtime set.

The authoritative priority board is [workstreams](workstreams.md). If this
section and the board disagree, update this handoff or follow the newer board.

## First-day checklist

```bash
git status --short --branch
git log -1 --oneline
node --version
npm ci
npm run check
```

Then:

1. Read the principles and current workstream snapshot.
2. Read the latest trial for the subsystem you will change.
3. Reproduce one existing acceptance test before changing behavior.
4. Create a branch from current `main`.
5. Keep the patch narrow. Add a test that names the production failure it
   prevents.

For changes to the live service, also run the native PostgreSQL suite. For
changes to `modal_app.py`, object transport, result envelopes, R2 credentials,
or Modal dependencies, rerun the live R2/Modal parity and ACL qualification.
For browser parser changes, run the browser demo and the relevant corpus gate.

## Change discipline

- Distinguish code committed locally, code pushed to GitHub, merged code, and
  deployed code. They are four different states.
- Preserve unrelated worktree changes and stage explicit paths.
- Keep SQL transition preconditions in the database as well as code when the
  invariant must survive bypass of an application helper.
- A returned object is not success. Validate status, identity, digest, shape,
  and source state before every transition.
- A failed external read is not proof that an object is absent or invalid.
- Use immutable per-execution result keys and database fencing.
- Test crash windows in the order that can expose the zombie result: crash,
  dispatch replacement, let replacement succeed, then let the original land.
- Do not claim parity, availability, ACL separation, or cold-start behavior
  from types or unit tests alone. Use the corresponding live gate.
- Update the workstream board when a stream changes state. Update this handoff
  when the deployed topology, source-of-truth order, stable invariants, or next
  engineer priority changes.

## Evidence index

- [Principles](principles.md)
- [Workstreams](workstreams.md)
- [Evaluation rubric](evaluation-rubric.md)
- [Development corpus guide](evaluation-corpus.md)
- [Security](../SECURITY.md)
- [Service control-plane design](design/2026-08-26-service-control-plane.md)
- [Service API contract](design/2026-08-26-service-m2-api-contract.md)
- [M2 live deployment](trials/2026-08-27-service-m2-live-deployment.md)
- [Open-alpha operation](../deploy/control-plane/README.md)
- [Modal object transport qualification](trials/2026-08-26-service-m1-object-qualification.md)
- [Modal memory snapshots](trials/2026-09-01-modal-memory-snapshot-qualification.md)
- [Modal 8 GiB qualification](trials/2026-09-01-modal-memory-allocation.md)
- [PDF Inspector 1.17 qualification](trials/2026-08-28-pdf-inspector-1-17-parsebench.md)
- [ParseBench adapter and small cohort](trials/2026-08-28-parsebench-basic-test-cohort.md)
- [OCR efficiency issue #126](https://github.com/oneryalcin/pagespatial/issues/126)
- [OCR sidecar thread sweep](trials/2026-09-02-ocr-sidecar-thread-sweep.md)

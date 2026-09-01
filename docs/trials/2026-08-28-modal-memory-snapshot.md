# Modal memory-snapshot cold-start trial — 2026-08-28

## Decision

Keep the existing Python Modal wrapper, Node service, four Node workers, and
four long-lived Python OCR sidecars. The experiment justifies a later
production qualification, but memory snapshots remain disabled and the
snapshot implementation is not landed in the production adapter yet. Do not
rewrite the service in Python, Rust, C, or C++ to address cold start.

The snapshot treatment reduced restored one-page cold calls from the existing
roughly 70–102 second band to a median of 7.1 seconds in this trial. Snapshot
population remains expensive: the first call on each of six CPU worker types
took 91.1–136.7 seconds.

## Scope

- App: `pagespatial-parse-m5-dev`
- Adapter revision: `e439637ca4ac-dirty`
- Image pin revision: `d6c482ff50c5`
- Modal client: `1.5.3`
- Resources: 4 vCPU, 24 GiB memory, one container maximum
- Input: generated one-page PDF
- Method: stop the container after every completed call, then invoke the
  deployed class again
- Primary metric: client-observed `spawn_to_result_s`, which includes Modal
  scheduling and snapshot restore
- Supporting metric: post-restore health time reported as `service_ready_ms`

The 182.4-second first image build is excluded. It is deployment work, not a
request cold start.

## Treatment

The class uses `enable_memory_snapshot=True`. The existing service startup runs
in `@modal.enter(snap=True)`. A separate `@modal.enter(snap=False)` hook checks
that the restored Node server, worker processes, and OCR sidecars are healthy
before a call is accepted.

No service topology, parser implementation, model, worker count, or request
contract changed.

## Results

### Snapshot population

Modal created six CPU memory snapshots. Each call completed with one successful
page.

| Snapshot | Model/process readiness | Client cold call |
| ---: | ---: | ---: |
| 1 | 82.234 s | 102.6 s |
| 2 | 86.065 s | 113.8 s |
| 3 | 84.077 s | 100.7 s |
| 4 | 104.684 s | 136.7 s |
| 5 | 78.246 s | 104.4 s |
| 6 | 78.094 s | 91.1 s |

Population client wall range: 91.1–136.7 seconds. Median: 103.5 seconds.

### Snapshot hits

Six calls landed on an existing snapshot. Each used a fresh container and
completed with one successful page.

| Call | Post-restore health | Parse | Client cold call |
| ---: | ---: | ---: | ---: |
| 1 | 0.580 s | 2.342 s | 6.9 s |
| 2 | 0.076 s | 2.534 s | 7.6 s |
| 3 | 0.027 s | 2.222 s | 7.3 s |
| 4 | 0.032 s | 2.227 s | 22.2 s |
| 5 | 0.006 s | 2.235 s | 6.5 s |
| 6 | 0.027 s | 2.317 s | 5.9 s |

Snapshot-hit client wall range: 5.9–22.2 seconds. Median: 7.1 seconds.
The 22.2-second sample shows that Modal scheduling and restore time still have a
long tail; 6–7 seconds is not a latency guarantee.

## Evidence from Modal logs

For each missing worker type, Modal logged:

```text
Creating CPU memory snapshot for Function.
Snapshot created. Restoring Function from memory snapshot.
Restoring Function from memory snapshot.
```

The application then emitted `service_started` with
`memory_snapshot=true`. Post-restore health was 6–580 ms across snapshot-hit
containers. This demonstrates that the existing multi-process Node/Python
topology survives snapshot restoration.

## What this proves

- Model and process initialization, not Node as a language, caused most of the
  cold-start delay.
- Modal can snapshot and restore the current Node server, Node worker pool, and
  Python OCR sidecars together.
- After the six CPU variants were populated, the measured median cold call was
  7.1 seconds rather than roughly 100 seconds.

## What this does not prove

- It does not qualify every corpus document or public-service failure path.
- It does not guarantee a 6–7 second cold start.
- A redeploy invalidates snapshots and repays the six-worker-type population
  cost.
- A first call can still take roughly 100 seconds while a missing snapshot is
  created.

## Production gate

Deferred by owner decision on 2026-09-01. A later change may add the reversible
flag and run the existing Modal qualification with snapshots enabled, including
a real document and pointer-mode R2 transport. Until that separate gate passes,
the deployed production app and committed production adapter keep snapshots
off. Do not create a second backend or rewrite the service.

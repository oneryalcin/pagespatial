# M1 object-transport qualification — 2026-08-26

## Decision

**PASS.** `ParseContainer.parse_object` may advance as the object transport for
the service job plane. It preserves the qualified parser output, returns a
small pointer instead of the full record, and gives every Modal execution an
immutable result key.

This decision applies only to the R2 -> Modal -> R2 transport. It does not
qualify the API dispatcher, reconciler, tenant authentication, or public API.

### Post-review scope note

This trial fixes revision `3b45b30c722c`: one read/write credential and one
bucket, with no pointer-specific result cap. A subsequent M1 hardening change
splits input and result buckets/credentials, adds a 128 MiB R2 result bound,
uses attempt identity for inner traces, and makes the harness assert successful
status before comparison. The original parity measurements below remain
evidence for the unchanged parse core. The fresh split-topology qualification
later in this record closes that post-review requirement.

## Fixed implementation

- Git revision: `3b45b30c722c` (`M1: add R2 pointer parse transport`)
- Modal app: `pagespatial-parse-m1-dev`
- Image pin revision reported by every result: `2bc95656cbe4`
- Modal SDK: `1.5.3`
- R2 client in the image: `boto3==1.43.74`
- Enrichment: off
- Container limit: one

The R2 credential values and bucket name are not recorded. The Modal secret is
named `pagespatial-r2-dev`. The harness removed every input and result object
that it created.

## Method

For each PDF, one warm-class lifetime received:

1. two `parse_document` calls with the PDF bytes;
2. two `parse_object` calls for the same R2 input and attempt;
3. GET and SHA-256 verification of both stored result envelopes;
4. LIST recovery of both execution objects under the attempt prefix; and
5. one `parse_object` call with a deliberately wrong input digest.

The two direct controls derive the allowed OCR null tolerance. The existing
three-projection Modal comparator then judges direct-versus-pointer and
pointer-versus-pointer. The wrong-digest call must fail before it publishes an
object.

The committed harness is
`scripts/service/qualify-modal-object.py`. Private captures are under
`.evaluation/service-m1-object/` and are not committed because they contain
document evidence.

## Inputs

| input | pages | bytes | SHA-256 |
|---|---:|---:|---|
| World Bank development PDF | 3 | 142,510 | `a2878cd9feaae81354b195463d76296ccb41d73c46462b6e5262bd0e7ecc667e` |
| fixed English A2 workload | 50 | 680,970 | `46ba5fc15613a260cf019ff6f9be0bb579279be4f5892694a76e02a536d8fcda` |

These are development inputs, not a correctness holdout.

## Correctness result

Both inputs produced `status=completed` with the expected page count.

| comparison | pages | critical-token delta | raw-line delta | deterministic exact | OCR-derived exact | schema failures |
|---|---:|---:|---:|---|---|---:|
| 3-page direct control | 3 | 0 | 0 | yes | yes | 0 |
| 3-page direct vs pointer | 3 | 0 | 0 | yes | yes | 0 |
| 3-page pointer repeat | 3 | 0 | 0 | yes | yes | 0 |
| 50-page direct control | 50 | 0 | 0 | yes | yes | 0 |
| 50-page direct vs pointer | 50 | 0 | 0 | yes | yes | 0 |
| 50-page pointer repeat | 50 | 0 | 0 | yes | yes | 0 |

The 50-page comparisons cover 2,902 critical OCR tokens and 4,951 raw OCR
lines. The direct-control null tolerance was zero critical tokens and zero raw
lines, so both pointer comparisons pass at tolerance `0/0`.

## Object and timing result

All values below are method-reported times. They exclude client-to-Modal queue
and transport time. This is a transport qualification, not a throughput
benchmark.

| input | execution | R2 download | parse method | R2 upload | total method | stored result | Modal pointer |
|---|---|---:|---:|---:|---:|---:|---:|
| 3 pages | pointer A | 745 ms | 6,065 ms | 229 ms | 7,592 ms | 826,132 B | 759 B |
| 3 pages | pointer B | 128 ms | 6,059 ms | 194 ms | 6,416 ms | 826,136 B | 759 B |
| 50 pages | pointer A | 253 ms | 66,017 ms | 520 ms | 67,665 ms | 6,367,495 B | 763 B |
| 50 pages | pointer B | 142 ms | 66,016 ms | 312 ms | 66,690 ms | 6,367,494 B | 763 B |

The 50-page warm repeat spent 454 ms in measured R2 transfer and 220 ms in
the remaining in-method work around a 66,016 ms parse. The pointer reduced the
Modal result boundary from about 6.37 MB to 763 bytes. Do not generalize the
two transfer samples into an R2 latency distribution.

The first direct call observed cold readiness of 78,089 ms for the 3-page run
and 84,097 ms for the 50-page run. These are consistent with the previously
measured cold-start order of magnitude, but two samples do not revise that
record.

## Failure and retry properties observed

- Two executions of one attempt produced different result keys.
- Both execution objects were recoverable by prefix LIST.
- The SHA-256 returned in each pointer matched the exact stored bytes.
- Envelope job, attempt, execution, input key, and input digest matched the
  request and pointer.
- A wrong input digest raised an error and published no result object.
- Test objects were deleted after each run.

The method does not claim exactly-once execution. Modal may retry. The safety
property is simpler: each execution writes a new immutable key, and the job
plane later chooses one accepted attempt/result.

## Operational observation

The first deployment attempt failed while Modal's internal PyPI mirror served
the 189 MB Paddle wheel at about 32 kB/s and pip hit a read timeout. Retrying
the identical committed deployment succeeded; the wheel then transferred at
about 177 MB/s. This was an image-build dependency incident, not a parser or
R2 failure. No Docker or timeout change was required.

## Fresh split-topology qualification

**PASS on 2026-08-26.** The hardened deployment at Git revision
`e2f38f88ce5c` used two private Western Europe R2 buckets and two independently
scoped Modal secrets:

- `pagespatial-dev`: worker credential has Object Read only;
- `pagespatial-results-dev`: separate worker credential has Object Read &
  Write.

The local control credential could write both development buckets but was not
attached to the Modal worker. Credential values are not recorded. `.env` was
restricted to local mode `0600` before use.

The self-contained run is
`.evaluation/service-m1-object/df82611d-957a-413c-a94f-1a62f3dce9b6/`.
It used the same 3-page World Bank input and removed every R2 object it
created. The harness now invokes the committed three-projection comparator
itself; transport success without a comparator verdict is no longer PASS.

### Boundary and correctness result

- control PUT to input and results buckets: allowed;
- input worker GET input: allowed;
- input worker PUT input: `AccessDenied`;
- input worker GET/PUT results: `AccessDenied` in an independent ACL probe;
- results worker GET/PUT results: allowed;
- results worker GET/PUT input: `AccessDenied`;
- both pointer calls: `status=completed`, 3 pages;
- wrong input digest: rejected, with no result object;
- two executions: distinct immutable keys, both recovered by prefix LIST;
- pointer digests: matched the exact stored bytes;
- direct-control null tolerance: 0 critical tokens / 0 raw lines;
- direct-versus-pointer: PASS at tolerance 0/0;
- pointer repeat: PASS at tolerance 0/0;
- comparison coverage: 402 critical OCR tokens and 724 raw OCR lines;
- deterministic projection, OCR-derived invariant, schema, and document SHA:
  no differences or failures.

### Fresh timing observation

| execution | R2 download | parse method | R2 upload | total method | stored result |
|---|---:|---:|---:|---:|---:|
| pointer A | 1,667 ms | 8,074 ms | 2,009 ms | 12,433 ms | 826,133 B |
| pointer B | 301 ms | 8,066 ms | 1,898 ms | 10,308 ms | 826,136 B |

The container reported a 92,102 ms cold readiness time. These are one
qualification lifetime on shared infrastructure, not a latency benchmark and
not a revision of the prior distribution. The development app was stopped
after the run.

## M2 public-result requalification

**PASS on 2026-08-26 at implementation revision `9141129d89cc`.** This
supersedes only the stored-result envelope shape qualified above. The transport
properties remain: immutable per-execution keys, pointer digest verification,
prefix recovery, and two-bucket credential isolation.

`parse_object` now stores the closed public envelope defined by
`PublicResultEnvelopeV1`; it no longer stores the internal parser result and
operator diagnostics together. The live run is
`.evaluation/service-m1-object/8ddc6804-a6de-4059-91f5-3750c49b86f2/`.
It used the same 142,510-byte, 3-page World Bank input. The harness removed all
objects it created and the `pagespatial-parse-m2-dev` app was stopped at zero
tasks.

Observed gates:

- direct-control null tolerance: 0 critical tokens / 0 raw lines;
- direct-versus-public-object: PASS at tolerance 0/0;
- public-object repeat: PASS at tolerance 0/0;
- comparison coverage: 397 critical OCR tokens and 715 raw OCR lines;
- both public results: 3 pages and 817,451 bytes;
- two executions: distinct immutable keys, both recovered by prefix LIST;
- wrong digest: returned typed `input_digest_mismatch` and published nothing;
- input credential PUT-input and GET/PUT-results probes: `AccessDenied`;
- results credential GET/PUT-input probes: `AccessDenied`;
- public envelopes contained only schema, job/attempt/execution identity,
  input digest, page count, and public page results; Modal timing, storage keys,
  revisions, resources, and raw diagnostics were absent.

Method-reported pointer observations were 6,222 ms and 5,006 ms total. The
first direct call reported 68,068 ms service readiness. These are one
qualification lifetime on shared infrastructure, not throughput or latency
benchmarks.

## Historical M1 follow-up

At the time of the first object qualification, the next slice was the
dispatcher and reconciler around the Postgres job/attempt tables. That work
later landed and was independently reviewed; this earlier trial did not
pre-approve it.

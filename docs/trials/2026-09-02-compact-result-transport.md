# Compact result transport

Date: 2026-09-02  
Scope: Stage A only. The public result grant still returns full evidence.

## Decision

Publish one compact companion beside each new immutable evidence object. The
compact object is a deterministic TypeScript-library projection containing
page identity, Markdown projection, stable extraction provenance, and the same
safe failed-page shape. It contains no observations, geometry, matches,
conflicts, diagnostics, tables, or search chunks.

The compact object is a transport representation, not evidence. The evidence
object remains authoritative, and compact is reproducible from evidence.

## Payload evidence

Measurements were content-free: no document text, user identity, object key,
URL, or digest was printed.

| sample | pages | evidence bytes | compact bytes | compact/evidence | reduction |
|---|---:|---:|---:|---:|---:|
| qualification object | 3 | 828,103 | 60,996 | 7.4% | 13.6x |
| non-fixture production object | 25 | 1,156,321 | 90,621 | 7.8% | 12.8x |
| small non-fixture production object | 1 | 3,718 | 1,612 | 43.4% | 2.3x |

The 25-page object was about six times smaller per page than the qualification
fixture. Do not generalize the fixture to 27 MB per 100 pages. In both
substantial objects, native observations, OCR observations, and source matches
dominated size; Markdown did not.

## Boundary and acceptance

- Node validates the completed page records and serializes both byte strings.
- Python uploads those strings as opaque bytes. It does not select compact
  fields or reconstruct either envelope.
- Compact uploads first. Evidence uploads second. A failure can leave an
  unaccepted compact orphan, but cannot expose a successful pointer.
- The control plane fetches and validates both objects before one SQL statement
  records the attempt and installs the winning pair.
- Migration `007_compact_results.sql` stamps pre-migration attempts as legacy.
  They remain harvestable from evidence alone. Every later attempt requires a
  valid pair. This closes the rolling-deployment window without a time guess.
- Recovery counts all objects under the bounded attempt prefix but treats only
  execution-scoped `.json` objects as evidence candidates.
- Existing clients still receive the accepted evidence grant. Compact has no
  public selector in Stage A.

## Local verification

- `npm run check`: PASS; 385 core tests and 122 API tests, with the two native
  PostgreSQL tests skipped in that command.
- PostgreSQL 18 suite: PASS; 130/130, including real two-connection acceptance,
  migration serialization, legacy backfill, and pool rollback.
- Modal unit and integration suites: PASS; 69/69.
- Focused compact, serializer, and real HTTP endpoint tests: PASS; 8/8.
- Python compilation and generated-schema checks: PASS.
- Independent Luna architect review: APPROVED after the legacy-attempt rollout
  fence was added.

## Live qualification

PASS on the isolated `pagespatial-parse-arm4-dev` app at commit
`1109d00099ec4c3c9aafcf67d8a8469e3ac5baeb`, with the production thread setting
of four:

- Direct versus object transport and duplicate object transport matched at
  zero tolerance across 402 critical tokens and 724 raw lines.
- Duplicate compact objects were byte-identical and digest-identical.
- Both 3-page runs produced 828,159 evidence bytes and 54,066 compact bytes, a
  15.3x reduction for this qualification document.
- The wrong-digest result was rejected, and bounded R2 listing recovered both
  objects.
- All five forbidden cross-role R2 operations returned `AccessDenied`.
- The qualification removed its temporary R2 objects, and the development app
  was stopped after the run.

This passed the code and object-transport gate.

## Production activation

Stage A activated at 2026-09-02T16:07:01Z (17:07:01 Europe/London):

- PR #130 merged as `853ae16e51a9c061a875130d0e38f2a48415d21c` after
  both CI runs passed.
- The production Modal worker deployed first with that revision, image pin
  `08928d6a48a6`, 8 GiB memory, and four sidecar threads.
- Immediately before migration, a 26,781-byte PostgreSQL 18 custom archive was
  copied from the VPS to a permission-restricted workstation path. Both copies
  had SHA-256
  `9faab201cb5926dc5dae3fbe875c2362881828294b1a88a8f630776380be0b85`.
  A disposable PostgreSQL 18 restore passed with 6 migrations, 8 jobs, and 4
  users before the production migration ran. The private paths are recorded on
  PR #130; database contents and credentials are not.
- API startup applied migration 007. The public health response returned
  `ready`, with R2 input, R2 results, and Modal all non-degraded.
- A real one-page production job succeeded with `requires_compact=true` and
  both accepted pointers present. The public result remained the full evidence
  envelope. Its temporary API keys were revoked, and its one consumed page
  credit was replaced.

Do not start Stage B before 2026-09-04T16:07:01Z. At or after that time, first
verify that every retained success created since activation has a valid compact
companion. The elapsed clock alone is not the gate.

## Deferred

The compact object is not yet the default and has no public API selector.
Result viewer, schema guide, result-bucket browser CORS, Avro, gRPC, callbacks,
long-polling, search, and landfill knowledge work are outside Stage A.

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

The isolated Modal/R2 qualification must prove full-result parity, exact
compact bytes and digest across duplicate calls, split-role ACL denial, and
wrong-digest rejection before Stage A can deploy to production.

## Deferred

The compact object is not yet the default and has no public API selector.
Result viewer, schema guide, result-bucket browser CORS, Avro, gRPC, callbacks,
long-polling, search, and landfill knowledge work are outside Stage A.

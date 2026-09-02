# Result envelope guide

This guide documents the Stage B result contract. The API returns one
short-lived download grant for the selected representation. The omitted
`view` and `view=compact` select the compact result. Use `view=evidence` when
you need the canonical evidence record. This omitted-default change is a
breaking change for alpha clients.

## Choose a representation

```text
GET /v1/jobs/{job_id}/result?view=compact   compact result (default)
GET /v1/jobs/{job_id}/result?view=evidence  full evidence result
```

The grant identifies only the selected object and includes its
representation, representation version, digest, byte count, and expiration.
The URL is a temporary bearer credential. Do not log it or send the API key to
it. Invalid view names return `400 invalid_request`; ownership and retention
rules still apply.

## Compact result

The service envelope is closed. It contains ordered page outcomes. A
successful page has a `page_compact` projection; a failed page has only the
safe public failure object.

```json
{
  "schema_version": "pagespatial-compact-v1",
  "representation": "compact",
  "job_id": "00000000-0000-4000-8000-000000000001",
  "attempt_id": "00000000-0000-4000-8000-000000000002",
  "input_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "page_count": 2,
  "pages": [
    {
      "page_number": 1,
      "ok": true,
      "page_compact": {
        "schemaVersion": "pagespatial-compact-v1",
        "documentId": "doc-123",
        "revisionId": "rev-7",
        "documentSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "pageId": "doc-123-p1",
        "pageNumber": 1,
        "projection": {
          "markdown": "# Untrusted extracted text",
          "format": "pagespatial-markdown-v1",
          "trust": "untrusted-document-content",
          "derived": true,
          "markdownSource": "pdf-inspector"
        },
        "provenance": {
          "parserName": "pagespatial",
          "parserVersion": "0.1.0",
          "nativeAdapter": "pdfjs",
          "ocrAdapter": "ppocrv6"
        }
      }
    },
    { "page_number": 2, "ok": false, "failure": {
      "code": "page_failed",
      "message": "Page could not be parsed."
    }}
  ]
}
```

The example is valid JSON. Page numbers are one-based, ordered, and
contiguous. Treat `projection.markdown` and all document-derived strings as
untrusted content.

Compatibility is explicit: reject an unknown `schema_version`; do not infer
new fields from a package version. Within `pagespatial-compact-v1`, keys are
closed. A new field or changed meaning requires a new representation version.

### Field map

| Field | Meaning |
| --- | --- |
| `schema_version` | Closed service-envelope version. Compact is `pagespatial-compact-v1`. |
| `representation` | Always `compact` in this envelope. |
| `job_id`, `attempt_id` | Service and accepted-attempt identity. |
| `input_sha256` | SHA-256 identity of the submitted document. |
| `page_count`, `pages` | Complete ordered outcome list. |
| `page_compact` | Deterministic `PageSpatial` projection for one successful page. |
| `projection` | Derived Markdown and its format, trust label, and source. |
| `provenance` | Stable parser, adapter, renderer, backend, and configuration identity when present. Volatile run timestamps and run IDs are excluded. |

## Compact versus evidence

Compact is a transport view for ordinary integrations and the result viewer.
It is reproducible from the accepted evidence object, but it is not evidence
and is not authoritative for observations, geometry, matches, conflicts,
diagnostics, or OCR provenance. The current compact contract also excludes
tables and search chunks.

Evidence is the complete accepted `PublicResultEnvelopeV1`. It retains each
`PageSpatial` page, including native and OCR observations, geometry, source
matches, conflicts, diagnostics, derived relations, projection, and complete
provenance. Download it explicitly for audit, reconstruction, spatial
inspection, or any operation that must cite source observations and boxes.

Both views refer to the same tenant-owned accepted attempt and input digest.
The evidence object remains the proof. Do not promote compact fields into a
new evidence model.

## TypeScript API example

```ts
type View = 'compact' | 'evidence';

async function readResult(apiKey: string, jobId: string, view: View = 'compact') {
  const grantResponse = await fetch(
    `https://api.pagespatial.dev/v1/jobs/${jobId}/result?view=${view}`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );
  if (!grantResponse.ok) throw new Error(`grant failed: ${grantResponse.status}`);
  const { result: grant } = await grantResponse.json() as {
    result: { representation: View; representation_version: string | number;
      digest: string; bytes: number; expires_at: string; download_url: string };
  };
  if (grant.representation !== view) throw new Error('wrong result view');
  const expectedVersion = view === 'compact' ? 'pagespatial-compact-v1' : 1;
  if (grant.representation_version !== expectedVersion) throw new Error('unsupported result version');

  const response = await fetch(grant.download_url);
  if (!response.ok) throw new Error(`download failed: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== grant.bytes) throw new Error('result size mismatch');
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== grant.digest) throw new Error('result digest mismatch');
  const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (view === 'compact') {
    if (result.schema_version !== 'pagespatial-compact-v1') throw new Error('unsupported compact version');
    for (const outcome of result.pages) {
      if (outcome.ok) {
        const page = outcome.page_compact;
        console.log(page.pageNumber, page.documentSha256, page.provenance.parserVersion);
      } else console.warn(outcome.page_number, outcome.failure.code);
    }
  }
  return result;
}
```

## Python API example

```python
import hashlib
import requests

def read_compact(api_key: str, job_id: str) -> dict:
    grant = requests.get(
        f"https://api.pagespatial.dev/v1/jobs/{job_id}/result",
        params={"view": "compact"},
        headers={"Authorization": f"Bearer {api_key}"},
        timeout=30,
    )
    grant.raise_for_status()
    result_grant = grant.json()["result"]
    if result_grant["representation"] != "compact":
        raise ValueError("wrong result view")
    if result_grant["representation_version"] != "pagespatial-compact-v1":
        raise ValueError("unsupported compact version")
    result = requests.get(result_grant["download_url"], timeout=60)
    result.raise_for_status()
    content = result.content
    if len(content) != result_grant["bytes"]:
        raise ValueError("result size mismatch")
    if hashlib.sha256(content).hexdigest() != result_grant["digest"]:
        raise ValueError("result digest mismatch")
    envelope = result.json()
    if envelope["schema_version"] != "pagespatial-compact-v1":
        raise ValueError("unsupported compact version")
    for outcome in envelope["pages"]:
        if outcome["ok"]:
            page = outcome["page_compact"]
            print(page["pageNumber"], page["documentSha256"],
                  page["provenance"]["parserVersion"])
        else:
            print(outcome["page_number"], outcome["failure"]["code"])
    return envelope
```

In an index, retain `documentSha256`, `revisionId`, `pageId`, and
`pageNumber` with each derived Markdown item. These fields preserve the link
back to the source page. Do not use Markdown text alone as provenance.

## Authoritative definitions

- [Compact JSON Schema](../schemas/pagespatial-compact.schema.json)
- [Full PageSpatial JSON Schema](../schemas/pagespatial.schema.json)
- [TypeScript types](../src/types.ts)
- [Compact projection and version](../src/compact.ts)
- [Public result serializer](../service/lib/public-result.mjs)

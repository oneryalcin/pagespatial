# PageSpatial API guide

This guide assumes you already have a PageSpatial API key. The API is
invite-only and currently supports one operation: parse a PDF into a
PageSpatial evidence record.

**API base URL:** `https://api.pagespatial.dev`

Send the API key only in the `Authorization: Bearer ...` header. Never put it
in a URL or query string.

## How a job works

```text
1. Hash PDF     2. Create job     3. PUT PDF to R2
      |                 |                  |
      +-----------------+------------------+
                                        finalize
                                           |
                              queued -> dispatched
                                           |
                                      succeeded
                                           |
                                  download result JSON
```

The PDF and result do not pass through the API server. The API returns
short-lived, single-purpose object-storage URLs for upload and download.

## Complete command-line example

Requirements: a modern `curl`, `jq`, `uuidgen`, and either `sha256sum` (Linux)
or `shasum` (macOS).

Set your PDF path and read the API key without putting it in shell history:

```bash
API_BASE=https://api.pagespatial.dev
PDF=./document.pdf
read -r -s -p "PageSpatial API key: " PAGESPATIAL_API_KEY
echo

if command -v sha256sum >/dev/null 2>&1; then
  PDF_SHA256=$(sha256sum "$PDF" | cut -d ' ' -f 1)
else
  PDF_SHA256=$(shasum -a 256 "$PDF" | cut -d ' ' -f 1)
fi

IDEMPOTENCY_KEY=$(uuidgen | tr '[:upper:]' '[:lower:]')
```

### 1. Create the job

```bash
SUBMIT_RESPONSE=$(curl --fail-with-body --silent --show-error \
  --request POST "$API_BASE/v1/jobs" \
  --header "Authorization: Bearer $PAGESPATIAL_API_KEY" \
  --header 'Content-Type: application/json' \
  --header "Idempotency-Key: $IDEMPOTENCY_KEY" \
  --data "{\"input_sha256\":\"$PDF_SHA256\"}")

echo "$SUBMIT_RESPONSE" | jq
JOB_ID=$(echo "$SUBMIT_RESPONSE" | jq -r '.job.id')
UPLOAD_URL=$(echo "$SUBMIT_RESPONSE" | jq -r '.upload.url')
```

A new submission returns HTTP `201`, a job in `uploading`, and an upload
grant. Retrying the same request with the same idempotency key and SHA-256
returns HTTP `200` and the original job. Reusing that key for different bytes
returns `idempotency_mismatch`.

On a replay, inspect `.job.state`. The `.upload` grant is present only while
the original job is still waiting for its PDF. If the job is already queued,
dispatched, succeeded, or failed, skip the upload and finalize steps and resume
from status polling.

### 2. Upload the PDF

```bash
curl --fail-with-body --silent --show-error \
  --request PUT "$UPLOAD_URL" \
  --header 'Content-Type: application/pdf' \
  --data-binary "@$PDF"
```

Do not send your PageSpatial API key to the upload URL. The URL itself is the
temporary upload credential. Keep it out of logs and messages.

The declared SHA-256 is verified by the parse worker after download. A PDF
whose bytes do not match finishes with `input_digest_mismatch`.

### 3. Finalize the upload

```bash
curl --fail-with-body --silent --show-error \
  --request POST "$API_BASE/v1/jobs/$JOB_ID/finalize" \
  --header "Authorization: Bearer $PAGESPATIAL_API_KEY" \
  --header 'Content-Type: application/json' \
  --data '{}'
```

Finalize checks that the object exists, is non-empty, is no larger than
90 MiB, and has content type `application/pdf`. It is safe to retry. A valid
upload normally returns HTTP `202` with state `queued`.

### 4. Poll job status

```bash
while :; do
  STATUS_RESPONSE=$(curl --fail-with-body --silent --show-error \
    "$API_BASE/v1/jobs/$JOB_ID" \
    --header "Authorization: Bearer $PAGESPATIAL_API_KEY")

  STATE=$(echo "$STATUS_RESPONSE" | jq -r '.job.state')
  echo "state=$STATE"

  case "$STATE" in
    succeeded) break ;;
    failed)
      echo "$STATUS_RESPONSE" | jq '.job.error'
      exit 1
      ;;
    uploading|queued|dispatched) sleep 5 ;;
    *) echo "Unexpected state: $STATE" >&2; exit 1 ;;
  esac
done
```

`dispatched` means Modal accepted the call. It does not claim that a worker is
currently executing it. The API does not publish an ETA or an invented
`running` state.

### 5. Download the result

```bash
RESULT_GRANT=$(curl --fail-with-body --silent --show-error \
  "$API_BASE/v1/jobs/$JOB_ID/result" \
  --header "Authorization: Bearer $PAGESPATIAL_API_KEY")

DOWNLOAD_URL=$(echo "$RESULT_GRANT" | jq -r '.result.download_url')

curl --fail-with-body --silent --show-error \
  "$DOWNLOAD_URL" \
  --output "pagespatial-$JOB_ID.json"

jq '{page_count, outcomes: [.pages[].ok]}' "pagespatial-$JOB_ID.json"
```

Do not send the PageSpatial API key to the download URL. A download grant
lasts at most five minutes. Request a new one if it expires while the retained
result is still available.

## Job status

`GET /v1/jobs/{job_id}` returns:

```json
{
  "job": {
    "id": "00000000-0000-4000-8000-000000000000",
    "state": "succeeded",
    "processing_profile": "parse-v1",
    "input_sha256": "64 lowercase hexadecimal characters",
    "input_bytes": 142336,
    "pages": 3,
    "estimated_cost_micros": 3000,
    "created_at": "2026-08-27T00:00:00.000Z",
    "queued_at": "2026-08-27T00:01:00.000Z",
    "completed_at": "2026-08-27T00:03:00.000Z",
    "processing_deadline_at": "2026-08-28T00:01:00.000Z",
    "retention_expires_at": "2026-08-29T00:03:00.000Z",
    "error": null
  }
}
```

The states are:

| State | Meaning |
| --- | --- |
| `uploading` | The API is waiting for the PDF and finalize request. |
| `queued` | Upload validation passed; dispatch is pending. |
| `dispatched` | Modal accepted the parse call; execution may still be queued. |
| `succeeded` | The validated result is available. |
| `failed` | The job is terminal; inspect `job.error`. |

`estimated_cost_micros` is a placeholder estimate in integer USD micros. It is
not an invoice or a measured per-job cloud bill.

## Result format

The downloaded JSON has this envelope:

```json
{
  "schema_version": 1,
  "job_id": "...",
  "attempt_id": "...",
  "execution_id": "...",
  "input_sha256": "...",
  "page_count": 2,
  "pages": [
    {
      "page_number": 1,
      "ok": true,
      "page_spatial": {}
    },
    {
      "page_number": 2,
      "ok": false,
      "failure": {
        "code": "page_failed",
        "message": "Page could not be parsed."
      }
    }
  ]
}
```

Treat `attempt_id` and `execution_id` as opaque fencing identities. Successful
`page_spatial` values follow
[`schemas/pagespatial.schema.json`](../schemas/pagespatial.schema.json).
Page failures remain in page order and do not remove successful siblings.

## Limits and retention

| Limit | Current value |
| --- | --- |
| PDF size | 90 MiB |
| PDF pages | 200 |
| Active jobs per user | 5 |
| Active jobs globally | 100 |
| Upload/finalize window | 1 hour |
| Processing deadline after queueing | 24 hours |
| Result download URL | at most 5 minutes |
| Input and result object lifecycle | 2 days |

The service is parse-only. Enrichment is off. It scales to zero, so the first
job after an idle period can spend roughly 70–102 seconds starting the parser.

There is currently no endpoint to list jobs or cancel a job. Save each job id
in your own system.

## Error handling

Every API error has one shape:

```json
{
  "error": {
    "code": "result_not_ready",
    "message": "Result is not ready.",
    "request_id": "..."
  }
}
```

Keep `request_id` when reporting a problem.

| Status | Typical action |
| --- | --- |
| `400` | Fix the request shape, header, idempotency key, or digest format. |
| `401` | Supply a valid, non-revoked API key. |
| `404` | Check the job id. Jobs owned by another user also return 404. |
| `409 upload_incomplete` | Wait briefly for the PUT to settle, then retry finalize. |
| `409 result_not_ready` | Continue polling the job. |
| `410` | The upload window or retained result expired; submit again if needed. |
| `413` | Split or reduce the PDF. |
| `422` | Do not blindly retry; inspect the typed error. |
| `429` | Wait for the `Retry-After` duration, then retry. |
| `503` | Retry with bounded exponential backoff and the same idempotency key. |

Preserve the same idempotency key for retries of one logical submission. Use a
new key only when you intentionally create a new job.

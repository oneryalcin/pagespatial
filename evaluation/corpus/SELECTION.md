# PageSpatial landfill selection

Date: 2026-08-19

This is a measured candidate pool for improving PageSpatial independently of Evidence Search. Source PDFs remain in `enterprise-document-landfill`; no PDF was copied or modified.

The authoritative remote source is the private Hugging Face dataset [`oneryalcin/enterprise-document-landfill`](https://huggingface.co/datasets/oneryalcin/enterprise-document-landfill), pinned at revision `e3ee38f067588644b11574ccc566843ca45f6d33`. A materializer must authenticate, request the exact selected path at this revision, and verify the per-file SHA-256 before use.

## Result

Three independent selectors inspected 36 PDFs with `pdfinfo`, `pdffonts`, `pdftotext`, `pdfimages`, hashes, and representative renders.

- Financial and investment documents: 12
- Government and procurement documents: 12
- Academic and irregular-layout documents: 12

Detailed source reports:

- [financial.json](./manifests/financial.json)
- [government.json](./manifests/government.json)
- [osf.json](./manifests/osf.json)

## Confirmed image-only coverage

Image-only discovery succeeded.

1. `legistar:seattle:2438:v0:attachment:6113` — 20 pages, zero text tokens, 20 images, zero fonts.
2. `legistar:seattle:1794:v0:attachment:3283` — 27 landscape pages, zero text tokens, 27 images, zero fonts.
3. `legistar:seattle:1958:v0:attachment:3310` — 17 landscape pages, zero text tokens, 17 images, zero fonts.
4. `legistar:seattle:1859:v0:attachment:3318` — 14 pages, zero text tokens, 14 images, zero fonts.
5. `osf:file:67898081d49db8de10c0e4b5:v1` — one rendered image-only figure; the one extracted character is an artefact.
6. `osf:file:607883db0c818200885135da:v1`, page 10 — effectively image-only within a mixed slide deck.

Near-image-only and sparse-overlay cases are also present in Seattle matters 2479, 2156, and 2159. The PA SERS LLR manager presentation is strongly raster-heavy: 1,384 image records and only 1,397 extracted characters across 11 pages.

## Split policy

The development and holdout split must occur at document-family level, not page level.

- Both MonotaRO language siblings stay in development.
- All three LLR packet members stay in development.
- Both NVIQ versions stay in development.
- Both ReAL-E versions stay in holdout.
- No page from a development document may appear in holdout.

This prevents page, translation, packet, and document-version leakage.

The normalized split is recorded in [selection.json](./manifests/selection.json). The generated runtime definition is [corpus.v1.json](../corpus.v1.json). The holdout is a candidate split until its labels, hashes, parser revision, and evaluation procedure are frozen. Do not call it sealed before then.

## Recommended execution

1. Run PageSpatial over the selected development pages using PDF Inspector plus PP-OCR where supported, retaining both raw sources.
2. Record actual backend, render scale, per-stage latency, memory, failures, conflicts, and escalation decisions.
3. Build independent labels for critical text, boxes, reading order, table cells, and chart relationships.
4. Improve only against development documents.
5. Freeze the holdout manifest and labels.
6. Run the holdout once per candidate release profile.

Association coverage remains a diagnostic. It is not OCR or parser accuracy.

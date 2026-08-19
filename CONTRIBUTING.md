# Contributing

Run the full local verification before committing:

```sh
npm ci
npm run check
```

Changes to geometry, matching, critical-token normalization, derived relations, or escalation policy require a focused regression test. Changes to the canonical schema require a schema-version change and a migration note.

Do not commit PDFs, rendered page images, OCR model archives, API keys, customer documents, or generated evaluation outputs unless redistribution is explicitly approved.


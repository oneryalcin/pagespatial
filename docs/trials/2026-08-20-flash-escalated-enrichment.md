# Flash escalated-tier enrichment

**Date:** 2026-08-20 · **Branch:** `flash-enrichment` · **Issue:** #2 (Flash half)

## What was built

The escalated tier: pages whose diagnostics carry **blocking** escalation
reasons are routed to a Gemini Flash transcription pass, and the result
lands as an explicit **enrichment revision record** — never a mutation of
the canonical page. The engineering meat is the revision semantics
(principles §2/§4/§5):

- **Fail-closed binding.** Each enrichment stores the SHA-256 of the
  canonical JSON of the exact PageSpatial record it was computed against
  (`basePageDigest`). A reparsed page no longer matches; stale enrichments
  are rejected, never silently reattached.
- **Text-only proposals.** The model's box claims are kept as an
  explicitly-labelled coarse hint (`modelBoxHint`) for highlight UX; they
  are never evidence geometry and never enter association
  (reject-don't-repair).
- **Derived corroboration.** Every proposal carries a status against the
  page's own witnesses — `corroborated-both/native/ocr` or `novel` —
  computed occurrence-consuming over critical tokens (same-ink
  canonicalization). `validateEnrichmentAgainstPage` re-derives identity,
  digest, trigger, and every status; a forged status or stale binding fails.
- **Blocking-only routing.** `buildEscalatedOcrEnrichment` refuses pages
  without a blocking reason: model spend goes to the blocking tier, never
  to advisory noise (principles §5).
- **Full provenance.** Model, media resolution, prompt revision, and
  thinking budget are all recorded — a changed prompt or budget is a
  changed extractor.

Components: `src/enrichment.ts` (core record, schema, derivation),
`src/node/flash-ocr.ts` (transcriber: ultra-high media resolution,
`thinkingBudget: 0`, schema-constrained decoding),
`scripts/evaluation/run-flash-enrichment.mjs` (routing + batch harness).

## Measured (dev-v11, 106 blocking pages, 0 failures)

| | |
|---|---|
| proposals | 9,254 — 7,167 corroborated-both, 465 native-only, 723 ocr-only, 899 novel |
| genuinely novel values | **92 value tokens** (899 novel = 92 values + 807 single-character fragments) |
| gold recall, gold∩blocking pages (20) | 437/440 → **440/440 (100%)** |
| corpus-wide gold | 464/468 → **467/468** |
| cost | ~$0.011/page typical (dense-page tier); $1.51 ledger-visible spend |
| latency | p50 6.9s, p95 44s (dense JA chart pages) — off the critical path by design |

The 92 novel value tokens are numbers no deterministic witness read — chart
digits, dense JA table values — now searchable downstream carrying their
`model-proposed, uncorroborated` trust metadata. The 807 single-character
digit-free fragments are prompt-violating model noise, kept on the record
(evidence is never silently discarded) but honestly unverifiable: an index
policy that ignores digit-free single-character novels loses nothing.

## Two operational findings

1. **Thinking off, schema on.** `thinkingBudget: 0` (transcription needs
   eyes, not reasoning) — but without a `responseSchema`, ~20% of dense
   pages returned malformed JSON (unescaped quotes inside transcriptions).
   Constrained decoding took the failure rate from 22/106 to 0/106.
   Both knobs are provenance.
2. **An escalation-recall data point.** The one gold token enrichment could
   not reach — `No.1` on ps:909b4674e9e8:p62 — sits on a page whose only
   reason is advisory `low-ocr-confidence`: the deterministic tier missed a
   token without raising a blocking flag, so the escalated tier never saw
   the page. One token in 468 is not a redesign signal, but it is the
   escalation-precision metric's counterpart (escalation *recall*) showing
   up in real data for the first time.

## Two-reviewer pass (Opus + Codex adversarial), absorbed

Both reviews attacked the record semantics; all findings fixed with
regression tests (134/134):

- **Tail-compatible corroboration.** The first matcher compared encoded
  `core|tail` tokens by string equality — the one thing `src/text.ts` says
  never to do — so unit-word segmentation ("1,234" vs "1,234 million")
  systematically inflated novelty. Matching now follows same-ink §6
  (missing tail = less ink, never disagreement; exact-tail occurrences
  consumed first). Re-derivation cut token-path novelty from 358 to 92.
  Known inherited trade: leading currency *words* (EUR vs USD) are outside
  the critical core by the two-channel token design; symbol currencies are
  protected. Enrichment deliberately shares the library-wide token
  semantics rather than forking its own.
- **Honest authenticity scope.** Validation guards staleness (page digest)
  and internal consistency (every label re-derives); it does NOT
  authenticate proposal content — the library holds no signing key, and
  the earlier prose overclaimed. Content authenticity is a deployment
  concern (sign or ACL the enrichment store).
- **Single-character containment was fake corroboration.** The digit-free
  fallback previously accepted any needle; a single character matches any
  prose page. Minimum two normalized characters — which is what exposed
  the 807 fragment noise above.
- Strict nested schemas (smuggled `proposals[].evidenceBox` etc. now
  rejected); validation returns the sanitized parsed record and reports
  schema failures as issues instead of throwing; `documentId` checked.
- Transcriber: 120s per-attempt deadline, retry with backoff +
  `Retry-After` on 429/5xx and network errors, caller abort terminal;
  telemetry accumulates across attempts (retried spend is real spend —
  the pre-fix $1.51 could not see retried/failed attempts' tokens).
- Runner: `mkdtempSync` (concurrent same-page renders could collide and
  silently attach another page's proposals); PDF bytes hashed and checked
  against `documentSha256` before anything is rendered or transmitted;
  `--skip-existing` re-validates stored records against their pages.
- Enrichment record published as `schemas/pagespatial-enrichment.schema.json`.

## Deliberately out of scope

The server-GPU privacy-constrained adapter (issue #2's other half) is
unchanged. Enrichment-aware projection/markdown and index-side merge
policy live downstream of the library boundary.

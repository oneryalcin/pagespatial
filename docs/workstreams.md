# Workstreams

The living board. **This document is meant to be edited**: when you pick up
a stream, put your name in the owner column on your branch; when a stream
ships or its status changes, update the row in the same PR that changes it.
GitHub issues carry the detail and the discussion; this page is the map —
one look answers "what is in flight, what is free, what is blocked on what".

Onboarding order: [principles](principles.md) →
[handoff](handoff.md) → [evaluation-debts](evaluation-debts.md) → this page
→ the issue for your stream.

## State snapshot (update the date when you touch this)

*As of 2026-08-20, end of day.*

- **main**: through PR #18 (escalation ladder). Era: schema 0.5.0,
  enrichment-0.2.0.
- **In review**: PR #19 `cross-family-corroboration` — schema 0.6.0
  (secondOpinion on the page record), two adversarial reviews absorbed,
  final run validated (`exp-second-opinion-d`: starved 27→4, blocking 91,
  gold 464/468).
- **Reference baseline**: `dev-v11-residue-honest-2026-08-20` (schema
  0.5.0 era). A dev-v12 cut is due after PR #19 merges (0.6.0 era —
  summaries of old eras fail current validation by design).
- **Escalation economics** (issue #17): $0.0093 → $0.00307/corpus page
  measured; ≤$0.0015 projected after #20.

## Streams

| Stream | Issue | Status | Owner | Touches | Blocked by |
|---|---|---|---|---|---|
| Gold extension (132 pages, human batches) | #1 | **open — highest leverage**: unblocks every row of evaluation-debts.md | — | evaluation/gold, review.html flow | nothing |
| Server-GPU OCR adapter (privacy-constrained deployments) | #2 | open | — | new node/server module | nothing |
| Index ingestion spec (consumption contract) | #21 | open — design doc only | — | docs/ | nothing |
| Recovery tile budget (cost bound) | #13 | open — small, well-specified; good first task | — | src/browser/region-recovery.ts, tuning | nothing |
| Batch API + residue-crop rungs | #20 | open | — | run-flash-enrichment.mjs, flash-ocr.ts | PR #19 merge |
| Production-scale offline ingestion service | #22 | open — design + throughput prototype | — | new service layer; coordinates with #21 | nothing |
| Cross-family second opinion | #17/PR #19 | in review | session | schema 0.6.0, parser, diagnostics | owner merge call |
| Pictorial threshold + residue-severity data check | #14 | parked, gold-gated | — | tuning, ink.ts | #1 |
| Conflict triage taxonomy | #5 | parked, gold-gated | — | evaluation | #1 |
| Silver-tier spot check + review follow-ups | #8 | parked, gold-gated | — | evaluation | #1 |

## House rules (short form — principles.md is the law)

- **Measure before building**; every quoted number says what it measures
  and its sample size (evaluation-debts.md tracks thin-gold claims).
- No threshold tuning without gold labels.
- Every PR gets an adversarial review pass before merge; findings are
  fixed or explicitly tracked, never quietly dropped.
- Schema/evidence-definition changes bump the version; prior-era records
  fail closed; baselines are comparable only within an era.
- Never mutate a canonical record — enrichment and second passes are
  separate, digest-bound revision records.
- Branch always; never commit to main; visible retraction when a
  published claim turns out wrong.

## Operational gotchas

- **Never `npm run build` while a corpus evaluation is running** — Vite
  serves the browser client from `dist/` and hot-reloads the page, which
  destroys the OCR bridge and fails the rest of the run.
- The working Gemini key is the `AQ.…` one (line 6 of the owner's fish
  env); `thinkingBudget: 0` + `responseSchema` are load-bearing for cost
  and JSON validity.
- `pdftoppm` (poppler) and `tesseract` must be on PATH for the harness's
  node-side passes.
- Corpus runs live under `.evaluation/` (gitignored, private text);
  committed summaries go to `evaluation/baselines/`.

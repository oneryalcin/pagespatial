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

*As of 2026-08-21, afternoon.*

- **main**: through PR #33 (adjudication audit). Era: schema 0.6.0,
  enrichment-0.2.0 (with `transport` provenance).
- **Row 4 retraction**: "272/272 correct" did not survive independent
  audit (25/29 agree); **"zero wrong-side" stands** and is the only form
  the economics quote. Furniture test now in prompt + audit page.
- **Reference baseline**: `dev-v12-cross-family-2026-08-20` (dirty:false;
  starved 4, blocking 91, gold 464/468; summary committed).
- **Escalation economics CLOSED** (issues #17/#20): $0.0093 →
  **$0.000817/corpus page measured (11.4×; owner's 10× target exceeded)**
  under a test-enforced zero-interactive-calls invariant
  (`test/enrichment-runner.test.mjs`). Recall via the committed
  `scripts/evaluation/score-enrichment-recall.mjs`.

## Streams

| Stream | Issue | Status | Owner | Touches | Blocked by |
|---|---|---|---|---|---|
| Gold extension (human batches) | #1 | **in progress — batches 3+4 shipped (PRs #27/#30)**: 60/162 pages; rows 1/4/7/8 measured, row 9 refuted (clean ≠ fully read, #29). Known gaps: single annotator; row 1b uncollectable by the digit-only pre-labeler; batch 5 should re-tier toward clean pages (#29) | — | evaluation/gold, review.html flow | nothing |
| Escalation recall (clean-page silent misses) | #29 | **open — new**: 2/7 clean pages carried unread verified tokens (two mechanisms); needs a clean-page-tiered gold batch for a real denominator | — | sampler tiering, diagnostics | nothing |
| Adjudication spot-check (audit the 272/272) | #31 | **shipped** (PR #33): 25/29 agree; "272/272" retracted, "zero wrong-side" survives. Optional follow-up: second batch on the digits-differ class (11/15) | — | — | — |
| Server-GPU OCR adapter (privacy-constrained deployments) | #2 | open | — | new node/server module | nothing |
| Index ingestion spec (consumption contract) | #21 | open — design doc only | — | docs/ | nothing |
| Recovery tile budget (cost bound) | #13 | open — small, well-specified; good first task | — | src/browser/region-recovery.ts, tuning | nothing |
| Batch API + residue-crop rungs | #20 | **shipped** (PR #23) | session | — | — |
| Production-scale offline ingestion service | #22 | open — design + throughput prototype | — | new service layer; coordinates with #21 | nothing |
| pdf-inspector WASM in browser (markdown parity) | #25 | open — low priority; CJK/CMap gate first (monotaro p61); pair with native 1.14.2→1.15.0 bump | — | src/browser, package.json | nothing |
| Cross-family second opinion | PR #19 | **shipped** | session | — | — |
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

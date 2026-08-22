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

*As of 2026-08-21, night.*

- **main**: through PRs #43/#44/#45 (retrieval harness; extractor-blind
  clean sampler + no-miss verdicts; batch-6 re-read instruments). Era:
  schema 0.6.0, enrichment-0.2.0 (with `transport` provenance). Each
  landed through cold-review → fix → closure-verification cycles; every
  finding and correction is in the trial docs.
- **Retrieval thesis measured (issue #36 CLOSED)**: pre-registered
  outcome "flat everywhere" — trust metadata does NOT pay in ranking,
  not even the corroboration links (five-way ablation, n=101 queries,
  case series over system-conditioned queries). A trust-free
  duplicate-drop is the strong ingestion baseline (+13 hit@5); gating
  drops where it should downweight (7 answers structurally excluded).
  Redirect: answer verification/citation is where trust metadata's value
  is now hypothesized — future work in the trial doc.
- **Batch 6 sittings DONE (PR #47)**: annotator agreement **99.5%**
  (394 rows, drift 0, zero digit-class disagreements) — the ledger-wide
  noise floor is ~0.5%, 0% on digits. Silver spot-check: 0/30 →
  **silver error ≤9.5% at 95%** (quote the bound). Ledger rows updated;
  aggregates committed under `evaluation/gold/`.
- **Clean-rate preconditions** (from PR #44's closure review): no
  escalation-recall rate exists until (a) prior batches' clean pages get
  a no-miss re-review, and (b) prior outcomes are re-evaluated against
  the union run root. Stated in the evaluator's own caveats.
- **Recall figures corrected upward** (PR #35): a currency-symbol scoring
  bug made 135/145 "missed-by-both" tokens false misses. Batch 3
  86.1→98.8%, batch 4 67.8→95.9%, batch 5 95.7%. PR #30's description is
  stale on batch 4; the ledger carries the dated correction.
- **Row 9: instances confirmed, RATE WITHDRAWN** (correction to the
  previous snapshot, which quoted 6/16 / 18.8% from PR #35's pre-review
  description): 6 clean pages hold a token neither engine read, 3
  substantive — a case series refuting "clean = fully read". The batch-5
  sampler's selection is circular (eligibility keyed on `criticalCount`,
  computed from the extractors under measurement) and its denominator
  excludes silver-only clean successes, so **no rate is trustworthy yet**.
  See ledger row 9.

**Next actions (owner-confirmed 2026-08-22; ranked by the rabbit-hole
test, principles §9):**

1. ~~First extractor-blind clean batch~~ **DONE (batch7-clean-v1,
   2026-08-22)**: 15 extractor-blind clean pages, all verdicted — **14
   verified no-miss, 1 page with 2 substantive silently-missed tokens.
   Residual-stratum miss rate 1/15 (6.7%), 95% upper bound 27.9% —
   quote the bound; n=15 is wide.** Remaining for the union rate: the
   no-miss re-review of the 27 prior-labeled clean pages. Follow-up
   worth an hour: why both engines dropped exactly the two `16`s on a
   page where they read every neighbouring number (osf p144).
2. **Parse-service pivot: ALL THREE STREAMS SHIPPED (2026-08-22 night,
   PRs #53/#54/#55 — each through cold-review → fix → closure cycles):**
   - **#51 SVG reconstructor**: merged, issue closed. `reconstructSvg()`
     in the library; byte-honest text+layout skeleton with trust states
     drawn in.
   - **#22 skeleton**: merged. API (submit → ticket → progressive
     0.6.0 records), atomic disk-backed jobs, TWO-sided
     canonical-witness gate, mixed-document records impossible by
     construction, degraded-pool → 503. First bottleneck table: render
     p50 296ms (40× native), 8.9 pages/sec on 4 laptop workers,
     OCR column pending integration.
   - **#2-now server witness**: merged. Identical PP-OCR pipeline under
     Node (WASM EP): **near-equivalent with documented deltas**
     (91.7%/91.4% token agreement, IoU 0.922, gold +10 to node of
     1,223; JA preserved). NOT yet a "tie" — the McNemar
     discordant-pair analysis is the first post-merge task (issue #2),
     and the comparison is cross-engine-cross-host (browser=WebGPU,
     node=WASM — which IS the production swap, labeled as such).
     **3.7 s/page is the WASM-EP cost, not "the CPU cost"** — and once
     this witness wires in, **OCR dominates render ~12:1**, so the
     speed arms in order: native EP with the same models, THEN render
     batching, THEN (only if numbers demand) GPU. The skeleton's
     "render is the bottleneck" table was the stub era; do not optimize
     296ms while 3.7s burns.
   Remaining #22 v1 integration: plug the canonical adapter into the
   service, wire the SVG endpoint, full-pipeline bottleneck re-measure.
   **Owner decision pending**: adopting the server witness for service
   runs is a run-configuration change (era rules; cross-swap comparisons
   at gold level only).
   Mechanism HYPOTHESIS on #29 (downgraded from "lead" — one page, two
   tokens, three variables changed at once): the server witness reads
   batch 7's osf-p144 missed tokens, suggesting render-path
   sensitivity. The clean differential (cross-feed tiles via
   dumpRecoveryTiles, half a day) is specced on #29; the fix direction
   does not move until it runs.

Demoted (deliberate, not forgotten): #21 ingestion contract + the
**answer-faithfulness harness** (folded into #21) — both wait for the
service and a consumer; the #36 chunk-contract anchor is recorded on
#21 for when it unparks. Silver-bound tightening: only if a consumer
needs <9.5%.

Parked, unscheduled: the #4 chart triage hour (re-run batch 2 through the
current scorer; decides instrument-fix vs detector-project).
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
| Gold extension (human batches) | #1 | **in progress — batches 3–5 shipped (PRs #27/#30/#35)**: ~75 pages labelled incl. 27 clean; rows 1/4/7/8 measured. Known gaps: single annotator (**batch 6 amendment: double-label ~20 stratified pages for an inter-annotator noise floor** — see issue comment); row 1b uncollectable by the digit-only pre-labeler | — | evaluation/gold, review.html flow | nothing |
| Escalation recall (clean-page silent misses) | #29 | **instances confirmed, rate withdrawn (PR #35 review)**: sound sampling needs (a) selection from ALL non-escalated pages independent of extractor output, (b) a page-level "no miss found here" verdict in the review UI so verified negatives can enter a denominator | — | sampler tiering, review UI, diagnostics | nothing |
| Retrieval harness (does trust metadata move retrieval?) | #36 | open — **pre-registered design in the issue**; deterministic paired scoring, stratified queries; 1–2 days; co-evolves the #21 chunk contract and $/trusted-chunk metric | — | scripts/evaluation, trial doc | nothing (gold bounds query pool; grows with #1) |
| Malformed-PDF fuzz pass (fail-closed degradation) | #37 | open — bounded; synthetic hostile PDFs; one bad page must not kill a document | — | test/, scripts | nothing |
| Adjudication spot-check (audit the 272/272) | #31 | **shipped** (PR #33): 25/29 agree; "272/272" retracted, "zero wrong-side" survives. Optional follow-up: second batch on the digits-differ class (11/15) | — | — | — |
| Server-GPU OCR adapter (privacy-constrained deployments) | #2 | open — **gated: re-measure JA/chart recovery recall on current main first** (CMap fix + zoom-retry shipped since the motivating number; see issue comment) | — | new node/server module | the re-measure |
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
- **The independence check** (principles §8, five questions, answered in
  writing before a number is quoted): no instrument's denominator,
  eligibility, ranking, or presentation may read the system under test;
  confirmed negatives are recorded, never inferred from silence. Any
  violation makes the result a case series, said in the same sentence as
  the number. Broken three times in one week before it became a checklist.
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

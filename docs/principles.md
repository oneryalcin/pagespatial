# PageSpatial principles

These are the standing commitments of this project. They change only by
deliberate decision recorded in this file's history — never by drift. When a
proposed change conflicts with one of these, the principle wins until the
principle itself is revisited. Operational rules that follow from them live
in [the handoff](handoff.md) (change rules) and [architecture](architecture.md).

## 1. The library feeds an index; it is not the product

PageSpatial exists to make enterprise search, retrieval, and answering
trustworthy. Its output is ingestion-grade evidence for a searchable index
(Evidence Search). Standalone, it is deliberately incomplete: persistence,
retrieval, answering, and UI live downstream.

The unique value delivered to the index is **per-chunk trust metadata** —
source observation IDs, page coordinates, corroboration state, escalation
severity and share, confidence — not the text alone. Any parser can dump
strings into an index. Stripping this metadata at the index boundary
discards the reason the library exists.

## 2. Evidence, not interpretation

Raw native-text and OCR observations are the record. Matches, conflicts,
reading order, tables, chart relations, and Markdown are derived views that
reference their source observations. Derived views are never promoted to
evidence; raw observations are never deleted, merged away, or "cleaned up" —
even after they match. Every downstream claim must be traceable to specific
ink on a specific page.

## 3. Escalate, don't vote

When the two extraction witnesses materially disagree, neither is trusted by
default — measured on gold, each witness was right only about half the time.
Disagreement is recorded and surfaced, never silently resolved by picking a
side. The worst failure this project recognizes is **false confidence**: a
wrong value served without a flag. A false alarm costs review effort; a
silent error costs trust in every answer the system ever gives.

## 4. Humans belong to the evaluation loop only

At enterprise scale (hundreds of thousands of PDFs), **no human reviews
anything in the production ingestion path**. Documents always flow.

- Escalation is a **routing signal, never a review queue**: blocking pages
  route to an automated stronger-model tier or are indexed carrying their
  conflict records; advisory pages are indexed with their confidence
  metadata attached. Risk is managed at query time by the metadata, not at
  ingest time by a person.
- Human effort exists solely to **measure and improve the library**: gold
  labeling, adjudication, spot checks, second-annotator protocols. Humans
  make the measuring stick; the pipeline runs alone.
- Never design, describe, or implement an escalation path that blocks
  ingestion on a person.

## 5. LLMs are edge tools, not the pipeline

The deterministic local pipeline (native extraction + local OCR + rule-based
association) handles every page: free, fast, reproducible, private. Models
enter only where deterministic methods are structurally blind (reading chart
ink, adjudicating disagreements) or during evaluation (gold pre-labeling) —
and every use is justified by measured cost and measured quality.

- Escalation **severity is the budget knob**: model spend goes to the
  blocking tier, not to advisory noise. Escalation precision is therefore a
  first-class economic metric — every false blocking escalation is wasted
  model spend at scale, every missed one is a wrong number in the index —
  and it is measured against gold, not assumed.
- Measured reference point: Gemini Flash pre-labeling ran at ~$0.01/page
  with 98.5% precision — excellent as a proposer or escalated-page
  fallback, **not** sufficient unattended for gold (the 1.5% included a
  misread digit, and a wrong digit in an answer key poisons every
  measurement downstream).
- The standing pattern for model-assisted labeling: **model proposes →
  a mechanically independent witness corroborates → a human judges only the
  uncorroborated residue.** Two witnesses that share failure modes (two
  vision models) corroborate nothing.

## 6. Same ink, engine variance only

Cross-engine comparison judges two transcriptions of the same printed
glyphs. Normalization heals only what the *engines* introduce — codepoint
variants, typographic whitespace, segmentation, case — and never touches
what is *printed*: separators, units, confusable characters. When a
difference could be either presentation or meaning, it is meaning, and it
conflicts. No unit whitelists, no locale guessing, no confusable folding.
An observation that merely covers less ink than its counterpart must never
conflict with one that covers more.

## 7. Reject, don't repair

Invalid geometry — non-finite, singular, mismatched, out-of-bounds — fails
closed. Nothing is clipped, defaulted, or fabricated to make a page pass.
Fabricated evidence is worse than missing evidence, because it is
indistinguishable from the real thing forever after.

## 8. Measured, then trusted

No number is quoted without saying what it measures: gold accuracy,
cross-engine corroboration, association coverage, or schema conformance are
different things and must be labeled. Beyond that:

- No threshold tuning, no broadened inference, and no release without
  independent gold labels. The candidate holdout is never accessed or tuned
  against before its single sealed run.
- Every parser change ships with a retained regression and, when it touches
  the evidence definition, a full baseline rerun under a new run id.
  Baselines are comparable only within one definition era.
- Historical baselines, failed runs, and trial reports are preserved, never
  overwritten. When a published claim turns out wrong, it is **retracted
  visibly** (banner + corrected trial), not silently edited — this project
  holds its own claims to the standard it demands of documents.
- A measurement pipeline is code: it gets the same adversarial review as
  the parser. A gold set whose criterion coincides with the system under
  test is not gold.

### The independence check

The rule above is not new, and it did not work. In one week it was broken
three times: silver used as its own denominator, an adjudication highlight
drawn from one of the two candidate readings it was meant to arbitrate, and
a clean-page sampler whose eligibility test read the extractors it existed
to audit. The third case is the instructive one — the conditioning was
*noticed and named in a code comment*, and naming it changed nothing. A
principle you can nod at is not a control.

So it is a checklist. Before any measurement's number is quoted anywhere,
its trial doc answers these in writing:

1. **What is the denominator, and how did a member get in?** Name the
   population, not the count.
2. **Does eligibility read the system under test?** If the thing being
   measured decides what gets sampled, total failures are excluded by
   construction — they are exactly the cases that score zero.
3. **Does ranking or ordering read it?** Sorting by what the system found
   over-represents what it handles well, even when eligibility is clean.
4. **Does the presentation read it?** A crop, a highlight, or a default
   ordering derived from one candidate answer decides the question before
   the human sees it.
5. **Are confirmed negatives recorded as such?** Absence of evidence is not
   a verified negative. If "nothing found here" and "nobody looked here"
   are the same value in the data, there is no denominator.

Any yes to 2, 3, or 4 means the result is a **case series, not a rate** —
and it is described that way in the same sentence as the number, not in a
caveat further down. A case series is still worth having: one verified
instance refutes a universal claim, which is often the claim that matters.
What it cannot do is estimate frequency.

## 9. Ruthless simplicity, explicit composition

Adapters are plain objects wired by imports — no registries, plugins, or
dependency injection. TypeScript owns orchestration; no second language or
data plane without a profiled bottleneck. Every heuristic constant lives in
one place (`src/tuning.ts`), carries its rationale and unit, and scales with
render resolution rather than assuming one. Elegance matters; simplicity
wins.

### The rabbit-hole test

The same rule governs effort, not just code. Before starting any piece of
work — a measurement, a refinement, an instrument — answer one question:
**what decision changes based on the result?** If no decision changes, or
the deciding consumer does not exist yet, the work is a rabbit hole no
matter how rigorous it is. Rigor is not the test; consequence is.

Applications that recur here:

- **Failure cost ranks the queue.** Work that bounds an expensive failure
  (a wrong number served from the index) outranks work that polishes a
  cheap one (an unnecessary escalation worth a fraction of a cent).
- **Bounds have a stopping rule.** Once a bound is tight enough that no
  decision changes by tightening it (a ≤9.5% bound nobody consumes does
  not need to become ≤4.9%), stop. Tighten it when a consumer needs it.
- **Measurement must not outrun the product.** When the measuring
  apparatus is more sophisticated than the thing it measures, the next
  unit of effort belongs to the product. Ship, then let real usage
  nominate the next measurement.
- **Tradeoffs are stated, not engineered away.** A simple design with an
  honestly documented limitation beats a complex one that hides it.

This section does not weaken §8: what IS measured gets measured honestly,
pre-registered where results could be argued with. It says: choose what to
measure by what it decides.

## 10. Privacy and cost are design inputs, not afterthoughts

Documents are untrusted content and private by default: local parsing paths
stay available, OCR assets are exact-hashed and caller-hosted, document text
never gains tool authority, and nothing private goes to a remote model
without explicit authorization. Performance is measured before architecture
changes in its name; cost is measured before a model is added in quality's
name.

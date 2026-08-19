# Gold pilot: first independent accuracy measurements

Date: 2026-08-19
Run evaluated: [dev-v8](../../evaluation/baselines/dev-v8-critical-ink-2026-08-19.summary.json)
Aggregates: [pilot-v1 metrics](../../evaluation/gold/pilot-v1.metrics.json), [batch2-v1 metrics](../../evaluation/gold/batch2-v1.metrics.json)

## What this is

The first P0 gold labels: 30 stratified development pages with human-verified
critical tokens, chart tuples, and conflict adjudications, evaluated against
the dev-v8 records. Until now every number in this repository was schema
conformance or cross-engine corroboration; these are the first measurements
against an external answer key.

## Method

1. Machine pre-labeling: Gemini 3.7 Flash (`gemini-3.7-flash`) transcribes
   every visible critical token verbatim with a normalized box, proposes chart
   tuples, and adjudicates recorded conflicts against the page image.
   Media resolution `high` per image, `ultra_high` for dense-table pages
   (quality saturates at `high` for ordinary pages; verified empirically).
   Corpus pages were sent to the Gemini API with the corpus owner's explicit
   authorization.
2. Human verification in a generated review UI. Batch 2 introduced tiered
   review: a token whose critical-token multiset also appears in the page's
   NATIVE text layer is auto-accepted — vision pre-labeler and embedded PDF
   bytes are mechanically independent witnesses. OCR agreement deliberately
   does not corroborate (it shares the pre-labeler's vision failure modes).
   The human reviews only uncorroborated tokens, which are by construction
   the tokens the native layer missed.
3. Evaluator joins verdicts to run records. Recall is text-containment under
   the library's own "same ink" canonicalization; box agreement is not yet
   scored.

Tooling: `scripts/evaluation/prelabel-gold-pilot.mjs`,
`build-gold-review.mjs`, `evaluate-gold-pilot.mjs`. Private inputs and
verdicts stay under `.evaluation/gold/` (not committed); only these text-free
aggregates are public.

Cost: ~100k Gemini input tokens + ~47k output (≈ $0.25) and roughly 45
minutes of human review across both batches. Pre-labeler precision against
the human: 338/343 correct in batch 1; tiering cut batch 2 review to 132 of
684 tokens.

## Results

Critical-token recall (verified tokens present in each engine's page text):

| Slice | Gold tokens | Native | OCR | Missed by both |
| --- | ---: | ---: | ---: | ---: |
| Batch 1 (16 mixed pages) | 325 | 28% | 42% | 175 (54%) |
| Batch 2 (14 Monotaro EN/JA pages) | 669 | 83% | 80% | 111 (17%) |
| — EN edition | 392 | 92% | 90% | 31 (8%) |
| — JA edition (same content) | 277 | 69% | 66% | 80 (29%) |

Findings, in order of importance:

1. **False confidence is real and now demonstrated.** The Monotaro JA
   financial-highlights page carries 106 gold numbers, nearly all inside
   chart graphics. The native layer holds only headings; PP-OCRv6 Tiny
   produced CJK garbage at 0.90+ confidence; with nothing to disagree with,
   the page did not escalate. Silently wrong is the rubric's worst failure
   class, and one gold page exposed it.
2. **CJK multiplies the chart-recall gap.** On identical content the miss
   rate rises from 8% (EN) to 29% (JA). The Tiny recognizer is the prime
   suspect; a multilingual or server-grade OCR adapter is the fix path.
3. **Neither engine deserves default trust.** Human-adjudicated conflicts
   across both batches: OCR right 23, native right 17, both wrong 6. A
   "trust native on disagreement" policy would have been wrong half the
   time; a "trust OCR" policy likewise. Escalation-not-voting is validated.
4. **The chart-relation detector matched 0 of 132 gold tuples** while
   emitting 28 relations. It is a measured-dead placeholder; rewrite or
   remove rather than tune.
5. **Escalation quality on the sample**: 14 of 22 escalated pages contained a
   confirmed real error; 5 of 8 non-escalated pages still had gold tokens
   missed by both engines — silence is not correctness.

## Caveats

- 30 pages, one annotator verifying machine proposals; no second annotator or
  adjudication protocol yet. Directional, not release-grade.
- Batch 2 is a single document family (Monotaro); its recall numbers describe
  chart-heavy bilingual reports, not the corpus.
- Recall is text-containment; geometry precision is unmeasured.
- The candidate holdout was not touched.

## Consequences

P1 priorities, now with data: (1) recall on chart-embedded and CJK content
(OCR adapter upgrade); (2) a coverage-starvation escalation diagnostic —
high-confidence OCR with near-zero native association should escalate, which
is exactly the false-confidence signature above; (3) chart-relation detector
rewrite or removal. A known review-UI defect (blank exported text for
collapsed rows) was fixed; the evaluator treats proposal text as
authoritative unless the human edited a row.

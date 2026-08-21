# Retrieval harness: trust metadata against its first downstream test

**Date:** 2026-08-21 · **Branch:** `retrieval-harness` · **Issue:** #36

The pre-registration in issue #36 is binding for this trial: paired
per-query design, deterministic scoring, stratified queries, distribution
reporting, chunk sweep as an output. This doc reports against it without
amendment.

## Corrections (v3 supersedes v2 supersedes v1 — visible-retraction rule)

Two independent reviews each invalidated a version of this trial before
merge:

1. **v1's headline ("trust-aware ingestion wins at citation granularity")
   was an artifact of a strawman baseline** (fairness review): the naive
   path interleaved BOTH witnesses so nearly every word was indexed twice,
   while the trust path quietly contained a *trust-free* duplicate-drop.
   Adding that one dedup to the baseline matches or beats the full trust
   path everywhere.
2. **v1/v2's scoring credited fake hits** (Codex review): hit@k used
   substring containment, so a currency-only answer (`$`) matched every
   chunk on its page as a rank-1 "hit", and short answers matched inside
   unrelated larger tokens. v3 drops unscoreable answers (**3 dropped**,
   all bare currency symbols) and matches at token boundaries via the
   recall test's own `consumeMatch` (exact first, detached currency
   forgiven, contradictory currency never, consume-once across multi-word
   answers) — never a new matching implementation.

All numbers below are v3 (`retrieval-harness-v3-token-boundary`), a
**case series over system-conditioned queries, not a rate** (see the §8
answers); every earlier table is superseded.

## Setup

`scripts/evaluation/retrieval-harness.mjs` (throwaway; never enters the
package) over the dev-v12 reference run (162 pages, schema 0.6.0, with its
91 escalated-tier enrichment records). One local BM25 retriever
(self-contained, deterministic, no network), one chunker (word windows),
five ingestion variants so every point of margin is attributed to a
mechanism:

- **A-raw** — every observation from both witnesses in reading order
  (v1's "naive"): duplicates, disputed readings, everything.
- **A-dedup** — A-raw plus the trust-free substring duplicate-drop and
  *nothing else*. Reads only the two witnesses' raw text.
- **A-srcdedup** — A-raw minus the OCR observations carrying a recorded
  `sourceMatches` link. The corroboration links ARE trust metadata — the
  one ingestion mechanism only the record can provide — so this variant
  isolates their ranking value.
- **B-noinject** — trust gating (adjudicated conflicts keep the winning
  side; unadjudicated/`unsure`/`both-wrong` drop both sides; 0.5
  confidence floor; duplicate-drop) without enrichment-text appends.
- **B-full** — B-noinject plus enrichment proposals + adjudication
  `inkText` appended (content no A variant receives).

**Queries (101 after drops, deterministic):** answer = a human-verified
gold token (all five batches; every gold page is in dev-v12); query = up
to 10 context words drawn from *both-witness-agreed* text nearest the
token's box, answer excluded, ≥4 words required. **Disclosed bias:**
agreed vocabulary is exactly what trust gating is guaranteed to retain,
so this construction shields B from its main cost (recall loss on gated
text) — it favours B; B loses to the fair baseline anyway. **Scoring
limitation:** chunks carry no observation ids, so a same-page *other
occurrence* of the answer at a token boundary still counts as the hit —
occurrence identity is best-effort. Per-query artifacts contain corpus
text and live in `.evaluation/retrieval/` — never committed.

Strata: **conflict** 79 queries, **escalated-other** 3, **clean** 19.

**Token-boundary honesty:** 21 of 101 answers do not appear at a token
boundary in ANY chunk of A-raw's index (split observations, divergent
segmentation) — under v1/v2 scoring some of these still "hit" by
substring. `answerNotInIndex`: A-raw 21, A-dedup 22, A-srcdedup 22,
B-full 22, **B-noinject 28** — gating structurally excludes 6 more
answers, and only enrichment re-injection brings B back to parity.

## Results (primary: 50-word chunks, hit@k /101 — a case series, not a rate)

| k | A-raw | **A-dedup** | A-srcdedup | B-noinject | B-full |
|---|---|---|---|---|---|
| 1 | 27 | **43** | 40 | 41 | 41 |
| 3 | 42 | **56** | 54 | 54 | 55 |
| 5 | 48 | **63** | 58 | 58 | 59 |
| 10 | 55 | **66** | 63 | 60 | 64 |

Headline pairwise, A-dedup vs B-full: B wins 3 / loses 5 (k=1), 4/5
(k=3), 2/6 (k=5), 3/5 (k=10). **The qualitative v2 ordering survived the
scoring fix**: the fair trust-free baseline matches or beats the full
trust path at every k — stated per §8 in the same sentence as the
numbers: these are case-series counts over system-conditioned queries,
not corpus rates.

Attribution:

- **Deduplication** (trust-free): A-raw 48 → A-dedup 63 at k=5 — still
  ~all of the old "trust win".
- **Corroboration links** (the fifth variant, Codex's question):
  A-srcdedup 58 vs A-dedup 63 at k=5, 40 vs 43 at k=1 — **the trust-side
  dedup does NOT beat the trust-free heuristic**; the substring drop
  removes duplicate text the linker never matched (3,144 string-dropped
  observations carry no recorded link) and that extra removal is worth
  more than the links' precision. Even the one ranking mechanism only the
  record could provide fails to out-rank a two-line heuristic here.
- **Trust gating + confidence floor**: A-dedup 63 → B-noinject 58 at
  k=5, and 6 answers structurally excluded — negative on its home
  stratum too (conflict @5: A-dedup 44, B-full 40).
- **Enrichment injection**: B-noinject 58 → B-full 59, `answerNotInIndex`
  28 → 22. The injection exists to paper over exclusions the gating
  created.
- **Clean stratum** (n=19): B-full 14 vs A-dedup 13 at k=1, level from
  k=3 up — no meaningful separation; v1's clean-stratum "trust win" was
  deduplication.

## Chunk sweep (hit@5 of 101) — granularity is an output

| chunk words | A-raw | A-dedup | A-srcdedup | B-noinject | B-full |
|---|---|---|---|---|---|
| 25 | 29 | **38** | **38** | **38** | 37 |
| 50 | 48 | **63** | 58 | 58 | 59 |
| 100 | 68 | **72** | 70 | 62 | 64 |
| 200 | **76** | 74 | 75 | 68 | 69 |

No crossover in B's favour at any width; at 200 words raw redundancy
saturates recall and even dedup is unnecessary. v1's "the chunk contract
decides whether trust metadata pays" remains unsupported.

## Pre-registered outcome (issue #36's table, applied honestly)

- **"B wins on the stratified tail" — did NOT occur** against the fair
  baseline (v1's claim was the strawman + scoring artifacts).
- **"Flat everywhere" — occurred**: B-full vs A-dedup is flat-to-negative
  under a query construction biased in B's favour. Per the
  pre-registration: strong evidence that trust metadata's value is **not
  in ranking** — sharpened by the fifth variant: *not even the
  corroboration links* out-rank a trust-free dedup. The value may still
  be in answer verification and citation, which this harness does not
  test. **Redirect, don't delete: the follow-up is an
  answer-faithfulness test, not more ranking work.**
- **"B loses anywhere" — occurred**: gating is net negative and
  structurally excludes 6 answers that only enrichment re-injection
  restores — a regression in the *gating design* (drop where
  downweighting would preserve rankability).

The positive finding, stated as such: **a trust-free duplicate-drop is
the strong ingestion baseline** (+15 at k=5 over raw interleaving at
citation granularity, in this case series); if trust semantics enter
ingestion they should *downweight, not drop*; enrichment/adjudication
text belongs in answer verification, not the ranking index.

**These are recommendations, not decisions.** No ingestion contract or
economic metric is decided from this case series. Deciding requires
queries whose eligibility does not read the system under test — future
work: (a) queries authored from document context independent of witness
agreement (e.g. from source-document metadata or an annotator reading
the rendered page), (b) an answer-faithfulness harness where trust
metadata gates what may be *cited*, not what is *ranked*, (c) an
embedding retriever replication.

## Independence check (principles §8, answered in writing)

1. **Denominator:** 101 queries (3 dropped as unscoreable: answers with
   no letters/digits after currency-stripping — reported, not silently
   excluded); a member is a human-verified gold token with a pre-labeler
   box and ≥4 both-witness-agreed context words nearby. Gold is the
   reference, not the system under test — conditioning on it is
   legitimate.
2. **Does eligibility read the system under test? Yes, in two places,
   both B-favouring:** (a) the ≥4-agreed-context-words requirement reads
   witness agreement, so tokens whose surroundings both engines misread
   never become queries; (b) context terms are drawn *exclusively* from
   agreed vocabulary — exactly what B's gating retains. **Any yes here
   makes the result a case series, and it is reported as one** — in the
   same sentence as every quoted number, not in a caveat below.
3. **Does ranking read it?** BM25 ranks over the ingested indexes — the
   indexes ARE the measured quantity, not an instrument bias. Ranking
   never reads gold.
4. **Does presentation read it?** No human judgment in the loop; scoring
   is token-boundary matching via the recall test's `consumeMatch`,
   identical rule for every variant (multiple matching chunks →
   best-ranked counts; same-page other-occurrence limitation stated
   above).
5. **Confirmed negatives:** every query is scored on all five variants;
   misses are recorded misses (rank beyond k or unranked, plus
   `answerNotInIndex` per variant), never inferred from silence.

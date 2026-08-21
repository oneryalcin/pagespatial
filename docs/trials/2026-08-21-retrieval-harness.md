# Retrieval harness: trust metadata against its first downstream test

**Date:** 2026-08-21 · **Branch:** `retrieval-harness` · **Issue:** #36

The pre-registration in issue #36 is binding for this trial: paired
per-query design, deterministic scoring, stratified queries, distribution
reporting, chunk sweep as an output. This doc reports against it without
amendment.

## Correction (v2 supersedes v1's conclusions — visible-retraction rule)

The first version of this trial reported "trust-aware ingestion wins at
citation granularity." **That headline was an artifact of a strawman
baseline**, found by an independent fairness review before merge: the
naive path interleaved BOTH witnesses so nearly every word was indexed
twice, while the trust path quietly contained a *trust-free* duplicate
drop — a mechanism that reads only the two witnesses' raw text, no record
semantics. Adding that one dedup to the baseline (and nothing else)
matches or beats the full trust path at every k and every chunk width.
Everything below reports the corrected four-variant ablation
(`retrieval-harness-v2-ablation`); v1's two-way tables are retained only
inside the ablation as `A-raw` vs `B-full`.

## Setup

`scripts/evaluation/retrieval-harness.mjs` (throwaway; never enters the
package) over the dev-v12 reference run (162 pages, schema 0.6.0, with its
91 escalated-tier enrichment records). One local BM25 retriever
(self-contained, deterministic, no network), one chunker (word windows),
four ingestion variants so every point of margin is attributed to a
mechanism:

- **A-raw** — every observation from both witnesses in reading order
  (v1's "naive"): duplicates, disputed readings, everything.
- **A-dedup** — A-raw plus the trust-free substring duplicate-drop and
  *nothing else*: no conflict gating, no confidence floor, no enrichment.
  This is the real baseline — any reasonable dual-witness ingestion
  deduplicates.
- **B-noinject** — trust gating (adjudicated conflicts keep the winning
  side; unadjudicated/`unsure`/`both-wrong` drop both sides; 0.5
  confidence floor; duplicate-drop) without enrichment-text appends.
- **B-full** — B-noinject plus enrichment proposals + adjudication
  `inkText` appended (content no A variant receives).

**Queries (104, deterministic):** answer = a human-verified gold token
(all five batches; every gold page is in dev-v12); query = up to 10
context words drawn from *both-witness-agreed* text nearest the token's
box, answer excluded, ≥4 words required. **Disclosed bias:** agreed
vocabulary is exactly what trust gating is guaranteed to retain, so this
construction shields B from its main cost (recall loss on gated text) —
it favours B. B loses to the fair baseline anyway, which strengthens the
conclusion. Per-query artifacts contain corpus text and live in
`.evaluation/retrieval/` — never committed.

Strata (page-level, from run diagnostics): **conflict** 82 queries,
**escalated-other** 3, **clean** 19. The skew mirrors the gold set's
debt-weighted sampling; escalated-other is too thin to read.

## Results (primary: 50-word chunks, hit@k /104)

| k | A-raw | **A-dedup** | B-noinject | B-full |
|---|---|---|---|---|
| 1 | 45 | **67** | 65 | 65 |
| 3 | 70 | **83** | 80 | 81 |
| 5 | 77 | **91** | 84 | 87 |
| 10 | 85 | **93** | 86 | 89 |

Headline pairwise, A-dedup vs B-full at 50 words: B wins 4 / loses 6 /
flat 94 at k=1; wins 2 / loses 6 at k=5. **The fair baseline beats the
full trust path at every k**, an artifact-corrected reversal of v1's
headline — stated per §8 in the same sentence as the number.

Attribution of the old "B beats A" margin:

- **Deduplication** (trust-free): A-raw 77 → A-dedup 91 at k=5. This was
  ~all of v1's "trust win".
- **Trust gating + confidence floor**: A-dedup 91 → B-noinject 84 at
  k=5 — net **negative seven**, including on the conflict stratum
  (A-dedup 71 vs B-full 67 at k=5), gating's home ground.
- **Enrichment injection**: B-noinject 84 → B-full 87, and
  `answerNotInIndex` 7 → 0. v1's "no structural exclusions (0/0)" claim
  was true only by virtue of this re-injection: for 7 conflict-stratum
  queries the gold answer survives in B's index *only* as a context-free
  appended string. Gating alone structurally excludes those answers.
- **Clean stratum**: A-dedup = B everywhere (15/17/18/18 across k) —
  the clean-stratum "trust win" of v1 was pure deduplication; those
  pages have nothing to gate.

## Chunk sweep (hit@5 of 104) — granularity is an output

| chunk words | A-raw | A-dedup | B-noinject | B-full |
|---|---|---|---|---|
| 25 | 56 | **65** | 64 | **65** |
| 50 | 77 | **91** | 84 | 87 |
| 100 | 97 | **100** | 91 | 93 |
| 200 | **102** | 101 | 95 | 97 |

Under the fair baseline **there is no crossover**: A-dedup matches or
beats B-full at every width (tie at 25). v1's "the chunk contract decides
whether trust metadata pays" conclusion is unsupported — what the sweep
actually shows is that *deduplication* pays most at citation granularity,
and gating costs recall at every width.

## Pre-registered outcome (issue #36's table, applied honestly)

- **"B wins on the stratified tail" — did NOT occur** against the fair
  baseline; v1's claim that it did was the strawman artifact.
- **"Flat everywhere" — occurred** (B-full vs A-dedup is flat-to-negative
  under a query construction biased in B's favour): per the
  pre-registration, strong evidence that trust metadata's value is **not
  in ranking** — it may still be in answer verification and citation,
  which this harness does not test. **Redirect, don't delete: the
  follow-up is an answer-faithfulness test, not more ranking work.**
- **"B loses anywhere" — occurred** (gating is net negative; two severe
  rank collapses where wholesale text-dropping destroyed the answer
  chunk's rankability): a regression in the *gating design* — v1 gating
  drops disputed/duplicate text where downweighting would preserve
  rankability, and enrichment text re-injected for ranking merely papers
  over exclusions it created.

The positive finding, stated as such: **a trust-free duplicate-drop is
the strong ingestion baseline** (+14 at k=5 over raw interleaving at
citation granularity); if trust semantics enter ingestion at all they
should *downweight, not drop*; and enrichment/adjudication text belongs
in answer verification, not in the ranking index.

Not over-read: n=104 from 75 debt-weighted gold pages, one corpus, one
lexical retriever; embedding retrievers and non-gold query distributions
untested. The negative on gating is a conditional result under a
B-favouring query construction — the true cost of gating on arbitrary
queries is *at least* what is measured here.

## Independence check (principles §8, answered in writing)

1. **Denominator:** 104 queries; a member is a human-verified gold token
   (all five batches) that has a pre-labeler box and ≥4 both-witness-
   agreed context words nearby. Gold is the reference, not the system
   under test — conditioning on it is legitimate.
2. **Does eligibility read the system under test? Yes, in two places,
   both B-favouring:** (a) the ≥4-agreed-context-words requirement reads
   witness agreement, so tokens whose surroundings both engines misread
   never become queries — the result is conditional on context both
   witnesses could read; (b) context terms are drawn *exclusively* from
   agreed vocabulary — exactly what B's gating retains — so the
   construction shields B from recall loss on gated text (v1 disclosed
   only (a)). Both biases favour the path that lost; the direction of the
   conclusion survives them.
3. **Does ranking read it?** BM25 ranks over the ingested indexes — the
   indexes ARE the measured quantity, not an instrument bias. Ranking
   never reads gold.
4. **Does presentation read it?** No human judgment in the loop; scoring
   is exact containment of the currency-stripped answer, identical rule
   for every variant (multiple matching chunks → best-ranked counts).
5. **Confirmed negatives:** every query is scored on all four variants;
   misses are recorded misses (rank beyond k or unranked, plus
   `answerNotInIndex` per variant), never inferred from silence.

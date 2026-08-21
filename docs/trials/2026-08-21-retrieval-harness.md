# Retrieval harness: trust metadata against its first downstream test

**Date:** 2026-08-21 · **Branch:** `retrieval-harness` · **Issue:** #36

The pre-registration in issue #36 is binding for this trial: paired
per-query design, deterministic scoring, stratified queries, distribution
reporting, chunk sweep as an output. This doc reports against it without
amendment.

## Setup

`scripts/evaluation/retrieval-harness.mjs` (throwaway; never enters the
package) over the dev-v12 reference run (162 pages, schema 0.6.0, with its
91 escalated-tier enrichment records). One local BM25 retriever
(self-contained, deterministic, no network), one chunker (word windows),
two ingestion paths:

- **A (naive):** every observation from both witnesses in reading order —
  duplicates, disputed readings, everything.
- **B (trust-aware):** the record's own semantics gate the index:
  adjudicated conflicts keep the winning side only (plus adjudicator
  `inkText`); unadjudicated / `unsure` / `both-wrong` conflicts drop BOTH
  sides (reject-don't-repair); OCR duplicates of native text are dropped;
  uncorroborated OCR under the 0.5 confidence floor is dropped; enrichment
  proposals are appended.

**Queries (104, deterministic):** answer = a human-verified gold token
(all five batches; every gold page is in dev-v12); query = up to 10
context words drawn from *both-witness-agreed* text nearest the token's
box, answer excluded, ≥4 words required. Agreed text is indexed
identically by both paths, so query construction cannot favour either.
Per-query artifacts contain corpus text and live in
`.evaluation/retrieval/` — never committed.

Strata (page-level, from run diagnostics): **conflict** 82 queries,
**escalated-other** 3, **clean** 19. The skew mirrors the gold set's
debt-weighted sampling; escalated-other is too thin to read.

## Results (primary: 50-word chunks, hit@k = gold-page chunk containing the answer in top k)

| k | A hits /104 | B hits /104 | B wins | B losses | flat |
|---|---|---|---|---|---|
| 1 | 45 | **65** | 28 | 8 | 68 |
| 3 | 70 | **81** | 20 | 9 | 75 |
| 5 | 77 | **87** | 17 | 7 | 80 |
| 10 | 85 | **89** | 11 | 7 | 86 |

By stratum at k=5: conflict A 60 → B **67** (13 wins / 6 losses), clean
A 15 → B **18** (3/0), escalated-other 2→2 on n=3 (uninformative). The
clean-stratum gain comes from deduplication alone — those pages have no
conflicts to gate — so part of B's edge is simply not double-counting
corroborated text.

**No structural exclusions:** the answer token remained in B's index for
all 104 queries (`answerNotInIndex: 0/0`). Every B loss is a ranking
shift, not a removal.

## The loss tail (pre-registration: "B loses anywhere" must be reported)

7 losses at k=5, all with the answer still indexed. Five are small slips
(rank 1–3 → 5–15) where dropping duplicate OCR text lowered the
answer-chunk's term frequencies. Two are severe (rank 1 → 800; rank 3 →
unranked): gating stripped enough of the page's disputed/duplicate text
that the surviving answer chunk no longer scores on the query's context
terms. Per the pre-registration this is **a finding about the gating
design, not the metadata**: v1 drops text wholesale where downweighting
would preserve rankability. The obvious v2 is weight-not-drop for
duplicates and undecided conflicts.

## Chunk sweep (hit@5 of 104) — granularity is an output

| chunk words | A | B |
|---|---|---|
| 25 | 56 | **65** |
| 50 | 77 | **87** |
| 100 | **97** | 93 |
| 200 | **102** | 97 |

The crossover is the #21-relevant finding. At coarse granularity a chunk
is most of a page, redundancy is free recall, and naive ingestion
saturates. At the fine granularity a citation-bearing index actually
needs — chunks small enough to point at evidence — trust-aware ingestion
wins decisively (+20 at k=1). **The chunk contract decides whether trust
metadata pays**: below ~50-word chunks it does, above ~100 it is washed
out by redundancy on this corpus.

## Pre-registered outcome

**"B wins on the stratified tail" — occurred.** B beats A overall at
every k at citation granularity, on the conflict stratum, and on the
clean stratum. Per the pre-registration: thesis validated; #21 proceeds
with the winning ingestion shape (trust-gated, fine-grained chunks);
$/trusted-chunk becomes the headline economic metric. **The "B loses
anywhere" clause also fired** on a 7-query tail, documented above as a
v1-gating design finding (drop vs downweight) — not softened away.

Not over-read: n=104 from 75 debt-weighted gold pages on one corpus, one
retriever family (lexical). The margin (28 wins vs 8 losses at k=1) is
large for this design, but embedding retrievers and non-gold query
distributions are untested.

## Independence check (principles §8, answered in writing)

1. **Denominator:** 104 queries; a member is a human-verified gold token
   (all five batches) that has a pre-labeler box and ≥4 both-witness-
   agreed context words nearby. Gold is the reference, not the system
   under test — conditioning on it is legitimate.
2. **Does eligibility read the system under test? Yes, in one place:**
   the ≥4-agreed-context-words requirement reads witness agreement, so
   tokens whose surroundings both engines misread never become queries.
   The result is therefore **conditional on context both witnesses could
   read** — stated here in the same breath as the headline: B wins at
   citation granularity *among queries whose context both witnesses
   read*. Pages failing that condition are exactly where escalation
   fires; their retrieval behaviour is unmeasured.
3. **Does ranking read it?** BM25 ranks over the ingested indexes — the
   indexes ARE the measured quantity here, not an instrument bias.
   Ranking never reads gold.
4. **Does presentation read it?** No human judgment in the loop;
   scoring is exact containment of the currency-stripped answer.
5. **Confirmed negatives:** every query is scored on both paths; misses
   are recorded misses (rank beyond k or unranked), never inferred from
   silence.

By the check, the conditioning in (2) makes the headline a conditional
rate, not a corpus-wide one — the sentence above carries the condition.

# Retrieval harness: trust metadata against its first downstream test

**Date:** 2026-08-21 · **Branch:** `retrieval-harness` · **Issue:** #36

The pre-registration in issue #36 is binding for this trial: paired
per-query design, deterministic scoring, stratified queries, distribution
reporting, chunk sweep as an output. This doc reports against it without
amendment.

## Corrections (v4 supersedes v3, v2, v1 — visible-retraction rule)

Independent reviews invalidated three versions of this trial before
merge; each correction is stated here, not buried:

1. **v1's headline ("trust-aware ingestion wins at citation granularity")
   was an artifact of a strawman baseline** (fairness review): the naive
   path interleaved BOTH witnesses so nearly every word was indexed twice,
   while the trust path quietly contained a *trust-free* duplicate-drop.
2. **v1/v2's scoring credited fake hits** (Codex review): substring
   containment let a currency-only answer (`$`) match every chunk on its
   page as a rank-1 "hit" and short answers match inside larger tokens.
   v3 dropped unscoreable answers (**3, all bare currency symbols**) and
   switched to token matching.
3. **v3's matcher over-corrected to over-strict** (verification review):
   whitespace-token equality rejected answers with trailing punctuation
   (`9/3/24,`), inside URLs, and — because CJK has no whitespace
   boundaries — silently made **every query on the sole Japanese document
   structurally unmeasurable** (`2010年` inside `2010年事業開始）`). 20 of
   v3's 21 "not in index" answers were matcher false negatives, not
   ingestion facts; v3's tables understated every variant.

v4 matches at **guarded boundaries**: the answer may not have a digit or
cased letter glued to either side (`5` never matches inside `2015` or
`5th`, `684,663` never inside `1,684,663`), while punctuation-, URL- and
CJK-adjacent occurrences count; CJK ideographs/kana are deliberately
outside the guard class. Currency keeps the recall test's rule (detached
forgiven, contradictory never — `$215.3` does not match OCR's misread
`s215.3`). All numbers below are v4
(`retrieval-harness-v4-boundary-guarded`), a **case series over
system-conditioned queries, not a rate** (see §8); every earlier table is
superseded.

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
occurrence* of the answer at a guarded boundary still counts as the hit —
occurrence identity is best-effort. Per-query artifacts contain corpus
text and live in `.evaluation/retrieval/` — never committed.

Strata: **conflict** 79 queries, **escalated-other** 3, **clean** 19.
The Japanese document's queries are measurable again under v4 (v3 had
structurally zeroed them).

**Index completeness (`answerNotInIndex`):** A-raw 3, A-dedup 3,
A-srcdedup 4, **B-noinject 10**, B-full 3. The three A-raw misses are one
genuine witness failure (OCR misread the currency amount) and two
answers whose currency symbol sits *inside* the token (`US$…`, `~$…`) —
scored as conservative misses symmetrically across every variant. Gating
structurally excludes **7 more** answers than the baseline, and only
enrichment re-injection brings B back to parity.

## Results (primary: 50-word chunks, hit@k /101 — a case series, not a rate)

| k | A-raw | **A-dedup** | A-srcdedup | B-noinject | B-full |
|---|---|---|---|---|---|
| 1 | 40 | **61** | 54 | 58 | 58 |
| 3 | 64 | **76** | 74 | 72 | 73 |
| 5 | 70 | **83** | 79 | 76 | 78 |
| 10 | 78 | **85** | 83 | 78 | 82 |

Headline pairwise, A-dedup vs B-full: B wins 3 / loses 6 (k=1), 5/8
(k=3), 2/7 (k=5), 2/5 (k=10). **The ordering survived both scoring
corrections** — the fair trust-free baseline matches or beats the full
trust path at every k — with the standing caveat that these are
case-series counts over system-conditioned queries, not corpus rates.

Attribution:

- **Deduplication** (trust-free): A-raw 70 → A-dedup 83 at k=5 — still
  ~all of the old "trust win".
- **Corroboration links** (the fifth variant): A-srcdedup 79 vs A-dedup
  83 at k=5, 54 vs 61 at k=1 — **the trust-side dedup does NOT beat the
  trust-free heuristic**; the substring drop removes 3,144 duplicate
  observations the linker never matched (verified against the run), and
  that extra removal outweighs the links' precision. Even the one
  ranking mechanism only the record can provide fails to out-rank a
  two-line heuristic here.
- **Trust gating + confidence floor**: A-dedup 83 → B-noinject 76 at
  k=5, with 7 answers structurally excluded — negative on its home
  stratum too (conflict @5: A-dedup 65, B-full 60).
- **Enrichment injection**: B-noinject 76 → B-full 78,
  `answerNotInIndex` 10 → 3. The injection exists to paper over
  exclusions the gating created.
- **Clean stratum** (n=19): level throughout (A-dedup 14/16/16/16,
  B-full 14/16/16/16) — v1's clean-stratum "trust win" was
  deduplication.

## Chunk sweep (hit@5 of 101) — granularity is an output

| chunk words | A-raw | A-dedup | A-srcdedup | B-noinject | B-full |
|---|---|---|---|---|---|
| 25 | 48 | 58 | **59** | 58 | 58 |
| 50 | 70 | **83** | 79 | 76 | 78 |
| 100 | 89 | **92** | 90 | 83 | 85 |
| 200 | **95** | 93 | 94 | 87 | 89 |

No crossover in B's favour at any width (A-srcdedup edges A-dedup by one
at width 25 — within noise for n=101); at 200 words raw redundancy
saturates recall. v1's "the chunk contract decides whether trust
metadata pays" remains unsupported.

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
  structurally excludes 7 answers that only enrichment re-injection
  restores — a regression in the *gating design* (drop where
  downweighting would preserve rankability).

The positive finding, stated as such: **a trust-free duplicate-drop is
the strong ingestion baseline** (+13 at k=5 over raw interleaving at
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
   is boundary-guarded matching with the recall test's currency rule,
   identical for every variant (multiple matching chunks → best-ranked
   counts; same-page other-occurrence limitation stated above).
5. **Confirmed negatives:** every query is scored on all five variants;
   misses are recorded misses (rank beyond k or unranked, plus
   `answerNotInIndex` per variant), never inferred from silence.

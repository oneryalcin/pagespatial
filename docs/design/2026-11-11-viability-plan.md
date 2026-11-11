# Plan: is PageSpatial worth pursuing, and what would make it viable

**Date:** 2026-11-11 · **Status:** proposed. The owner asked for this plan on 2026-11-11; nothing in it is decided until the [owner decisions](#owner-decisions) are answered. No code changes with this document.

## Why this plan exists

A review on 2026-11-11 (the repo's own measurements, a market survey, and a
cold read of the repo by a fresh agent) reached one conclusion twice:

- The problem is real. Extraction errors are silent, and on the one
  fact-level financial benchmark found (FinCriticalED, 859 pages), the best
  model parsers still miss over 1% of numeric facts.
- The current shape is not viable: a hosted parser that competes on speed and
  cost and emits a trust record nobody consumes. Measured compute is about
  $0.57 per 1,000 pages; the cheapest list prices are $0.50–$1.50 per 1,000,
  and buyers pay $10–$30 for accuracy.
- The part worth keeping is unoccupied and untested: an **independent second
  reading with a per-value agreement label**. The survey found no product or
  open-source tool that outputs both readings with a per-value label (an
  absence, so unverified).

What the repo's numbers say about the assumptions:

| Assumption | Evidence |
| --- | --- |
| The trust record improves the index | The one downstream test lost: trust-free duplicate-drop 83, full trust path 78 hits at 5, 101 queries, a case series built in the trust path's favour ([retrieval harness](../trials/2026-08-21-retrieval-harness.md)). It redirected to an answer-verification test, which was demoted and never run ([workstreams](../workstreams.md)). |
| A conflict means an error that matters | 172 of 272 adjudicated conflicts (63%) carry identical digits and differ only in a currency symbol ([debts](../evaluation-debts.md) row 4). 95 of 162 pages require escalation on dev-v13 (`evaluation/baselines/dev-v13-sidecar-2026-08-23.summary.json`). |
| The text layer lies often enough | Unmeasured. Broken fonts exist here only as synthetic fixtures, and the glyph audit withheld 0 pages over 20 stored runs. Nothing counts wrong digits caught per 1,000 real pages. |
| The consumer sees the dispute | It does not. A conflicting OCR reading is never matched (`src/merge.ts:163`), so the Markdown lists it under "Visual text recovered by OCR" and the native reading separately (`src/projection.ts:48`), with nothing saying they dispute each other. The compact view is that Markdown plus provenance (`src/compact.ts`). |
| Engineering is the risk | The [handoff](../handoff.md) has named "whether the product solves a repeated user problem" as the top risk since 2026-09-02. The repo records no user funnel since. |

## The hypothesis under test

PageSpatial is a **verifier for numbers**, not a parser: given a PDF, and
optionally any other parser's output for it, it says for each number whether
two independent readings agree, dispute, or only one exists, with the box. The reader models (PP-OCR today, Indra or others later)
are swappable parts. If this is true, better models help the product; if the
product is the reader, each new model erases it.

## Order and gates

Steps 1 and 2 are kill tests. Steps 3–5 are built only if they pass. Step 6
starts now. Each step states the decision its result changes
([principles](../principles.md) §9).

| # | Step | Decision it changes | Gate |
| --- | --- | --- | --- |
| 1 | Answer-verification test | Whether a labelled dispute prevents wrong answers. A null stops the trust-record line. | none; run first |
| 2 | Base rate on fresh pages | Whether there are enough wrong digits to verify, and where (digital, scans, charts). | none; needs owner labelling time |
| 3 | Make the alarm discriminating | The consumable view and the conflict definition. | step 1 passes |
| 4 | Bind chart values | Whether charts are a selling point or a stated limit. | steps 1 and 2 pass |
| 5 | One consumer | Whether the hosted service continues. | step 1 passes |
| 6 | Freeze the rest | Where time goes until 1 and 2 report. | owner accepts |

## Step 1 — answer-verification test

The test issue #36 pre-registered as the follow-up to a flat ranking result.
This section is the pre-registration; it is fixed before any run.

**Question.** Does an answer model give fewer wrong numbers when the context
labels disputed values than when it gets the same readings unlabelled?

**Items** (all from stored gold; no re-parse). Batches 3 and 4 only: their
272 adjudications bind to one run, `exp-second-opinion-d-2026-08-20` (on
disk), in one token era. The pilot and batch 2 (46 more) bind to dev-v8, an
earlier era, and are left out.

- **Digit-differing conflicts.** All 100 human-confirmed adjudications whose
  two readings differ in digits
  (`.evaluation/gold/batch{3,4}-v1/gold-verdicts.json`; readings in
  `proposals.json` under `conflictAdjudications`). The class split is the one
  `scripts/evaluation/score-adjudication-audit.mjs` already makes.
- **Symbol-only conflicts.** A seeded sample of 100 from the 172 whose digits
  are identical. A flag here is a false alarm; this stratum prices it.
- **Corroborated control.** A seeded sample of 50 human-verified tokens with
  no conflict, from the same pages.

**Composition of the 100** (counted before any model call; no text):

| Conflict reason | Human-confirmed side | Ink number one witness lacks | Both witnesses hold every ink number | Ink has no number |
| --- | --- | ---: | ---: | ---: |
| omission | OCR right | 16 | 0 | 4 |
| omission | text layer right | 1 | 0 | 2 |
| omission | both wrong | 2 | 0 | 0 |
| disagreement | OCR right | 5 | 17 | 0 |
| disagreement | text layer right | 51 | 1 | 0 |
| disagreement | both wrong | 1 | 0 | 0 |
| **Total** | | **76** | **18** | **6** |

The 6 items whose ink holds no number cannot be asked about and are dropped
and counted, leaving 94. Results are also reported by reason, by confirmed
side, and for the 76 alone.

**Target value.** Each item asks about one number: the first critical token
of the key ink that at least one witness lacks; if both hold every ink
number, the first critical token of the key ink. Tokens are those of
`criticalTokens` (`src/text.ts`).

**Answer key.** The human-confirmed ink reading. The blind audit of this key
agreed on only 11 of 15 digit-differing rows (debts row 4), so all 100
digit-differing keys get one fresh, blind human read from the crop before
any scored call (`build-gold-spotcheck.mjs`). An item is kept only when the
fresh read picks the same side as the stored key and, for both-wrong rows,
types ink with the same target. A fresh read that disagrees or is unsure
drops the item; drops are counted by cause.

**Questions.** One per item, written by `gemini-3.7-flash` shown the page
image, the value's box and the target value from the key, told to ask for
that value without stating it. It never sees a witness reading as such. A
question whose digits contain the target's digits is rejected and rewritten
once, then dropped and counted. A seeded 30 are checked by hand.

**Arms** (same answer model `gemini-3.7-flash`, same prompt, temperature 0,
closed JSON answer: a value, `disputed` with candidates, or `not found`).
All three contexts come from today's `projectMarkdown` over the stored
record, so they differ in content and not in format:

- **A, text layer only:** the projection with no OCR inputs.
- **B, both readings, unlabelled:** the projection with the stored OCR
  observations, matches, rows and relations. The stored records are from the
  browser era and hold no adapter Markdown, so this is native lines plus the
  OCR rows that matched nothing.
- **C, both readings, labelled:** B, with a marker appended to the native
  line and the OCR row of **every** conflict on the page, giving both
  readings. Markers are built only from the page's `conflicts`, the same way
  for each, so they do not point at the asked value. C's context format is
  the prototype for step 3.

**Scoring.** Deterministic, no model judge. The answer is a value, so its
critical tokens are compared with the target under the currency-tolerant
rule of `scripts/evaluation/lib/recall-match.mjs` (a detached currency
symbol is forgiven, a contradicting one is not; sign and percent are never
relaxed). This replaces the boundary-matching wording of an earlier draft,
which was a rule for finding an answer inside a chunk. Each answer is
correct, wrong (asserts a value that is not the target), or hedged
(`disputed` or `not found`).

**Shake-down.** Prompts and plumbing are tried only on the 46 pilot and
batch 2 conflicts, which are not scored.

**Stop rule.**

```text
prevented = 100 × (wrong in B − wrong in C) / items      digit-differing stratum
cost      = 100 × (correct in B and hedged in C) / items  symbol-only + control strata together
net       = prevented − cost
```

Continue if `net` is 5 or more. Below that, the trust-record line stops (see
[If it fails](#if-it-fails)). `items` are the scored items left after the
key read. Arm A is reported to show what the second reading adds with no
label at all.

The formula does not charge C for hedging on a digit-differing item that B
answered correctly. The full table of B outcome by C outcome is printed for
each stratum so that cost is visible; the stop rule is not changed.

**Independence check** (principles §8):

1. Denominator: adjudicated conflicts and verified tokens on gold pages.
2. Eligibility reads the system: only conflicts the system raised are
   members. The result is a **case series, not a rate**. A null is decisive
   because the set favours the record; a win earns steps 2 and 3, not a claim.
3. Ordering does not read it: samples are seeded.
4. Presentation: the question writer sees the page image and the key's
   target value, which it needs to know what to ask; it is not told which
   witness, if any, read that value.
5. Negatives: every item is scored in every arm; drops are counted.

**Cost.** About 250 questions over three arms; spend cap $10. One to two days.
Throwaway harness in `scripts/evaluation/`, result in `docs/trials/`.

## Step 2 — base rate on fresh pages

**Question.** How many wrong digits would a text-layer-only parser and a
model parser put in an index, and how many of them does the record flag?

- **Sample.** 300 pages from at least 30 public documents that are in neither
  the dev corpus nor the sealed holdout, drawn seeded and extractor-blind
  (page numbers chosen before any reader runs). Same document families as the
  corpus: annual and integrated reports, investor presentations, municipal
  and pension filings.
- **Readers.** (a) the text layer as the service extracts it; (b) one model
  parser, Gemini 3.7 Flash page-to-Markdown at the repo's pinned settings;
  (c) the PageSpatial record.
- **Truth.** A human judges, from crops, every digit-bearing token where (a)
  and (b) disagree with each other or with the OCR reading, plus a seeded 300
  tokens where all agree, to bound agree-on-wrong. The crop does not show
  which reader produced which reading. If disagreements exceed 600 crops, a
  seeded sample is judged and the rate is scaled.
- **Caught.** A wrong number from reader (a) or (b) counts as caught when, at
  that box, the record holds a different value or a state other than
  corroborated (disputed or single-witness).
- **Reported.** Wrong digit tokens per 1,000 digit-bearing tokens for (a) and
  for (b), counted over the judged disagreements and split by born-digital,
  scan and chart pages; the share of those caught; flags per page that mark
  no error.
- **Decision.** Continue as a verifier if at least one reader is wrong on 1
  or more tokens per 1,000 and the record catches at least half of them. If
  the text layer is clean on born-digital pages and errors sit in scans and
  charts, the product narrows to those pages. If neither holds, see
  [If it fails](#if-it-fails).
- **Independence check.**
  1. Denominator: digit-bearing tokens on pages drawn before any reader ran.
  2. Eligibility for judging reads the readers: an error is found only where
     readers disagree, and OCR is one of them. The caught share is therefore
     a **case series, not a rate**, and it leans in the record's favour.
  3. Ordering: seeded.
  4. Presentation: crops hide which reader gave which reading.
  5. Negatives: judged all-agree tokens are recorded as verified.
- **What the sample cannot show.** Zero wrong in 300 all-agree tokens bounds
  agree-on-wrong at about 1% (95%), ten times the threshold. The threshold
  applies to judged disagreements only; agree-on-wrong is reported as that
  bound.
- **Cost.** Spend cap $15 for the model parser. Two to three labelling
  sittings. Only public documents leave the machine.

## Step 3 — make the alarm discriminating (after step 1 passes)

Baseline: 95 of 162 pages require escalation and 454 conflicts on dev-v13;
63% of adjudicated conflicts are symbol-only. The cold review read 84
blocking pages off the board; pin blocking versus all escalations before
starting.

- Symbol-only disagreements (identical digit sequence) stop being critical
  conflicts and become a non-blocking note.
- The Markdown and compact views carry a per-value verdict (corroborated,
  disputed, single-witness) in the format arm C used.
- **Acceptance.** Every digit-differing adjudicated conflict is still
  flagged, checked by replaying the new rule over the stored records those
  adjudications bind to, not a fresh parse; escalated pages fall below the
  target in the owner decisions; gold recall does not drop.
- This changes the conflict definition, so it starts a new baseline era. The
  location of the sign, date and unit-tail glue fixes is a recorded, unmade
  owner decision; see the list below.

## Step 4 — bind chart values (after steps 1 and 2 pass)

Baseline: the relation detector has 25.2% recall and 96.4% precision on the
batch 2 gold tuples (issue #4); 0 of 23 ParseBench chart rules on three
pages with a dirty build; OCR reads 79 of 81 chart values, on 12 charts from
one document; one Flash call per page reached 12 of 23.

- Chart gold from more than one document comes first (one labelling sitting).
- Extend deterministic binding to donut and pie labels and to stacked and
  grouped bars, each as its own named method.
- A model may propose structure only. Every number in a proposed relation
  must be an OCR observation inside the chart region; a number with no ink
  behind it is dropped. (OneChart's unbacked values were 10% correct.)
- **Acceptance.** Issue #4's bar: recall well above 25% with precision at
  least 90% on gold tuples. ParseBench charts are reported second, on a clean
  build.

## Step 5 — one consumer (after step 1 passes)

Facts: `../evidence-search` has one commit (2026-08-18) and no `.js`,
`.mjs` or `.json` file there mentions PageSpatial; its README and four docs
do. Issue #21 (ingestion spec) is open and the
[migration plan](../evidence-search-migration.md) is unexecuted.

- Write `docs/index-ingestion.md` from step 1's result: the labelled context
  that won is the contract.
- Put PageSpatial behind a flag in Evidence Search (migration steps 2–7) and
  rerun step 1's metric inside the app.
- Run the handoff's P0: three to five outside users who have a numbers
  problem, with the five-line funnel recorded.
- **Decision.** If Evidence Search answers are no better and no outside user
  returns for a second document, the hosted service stops.

## Step 6 — freeze the rest (proposed, from the day the owner accepts)

Frozen until steps 1 and 2 report:

- OCR speed: issue #126, selective OCR (branch `feat/selective-ocr`),
  recognizer routing, fine-tuning or training a recognizer, swapping in Indra.
- GPU: issue #97.
- Infrastructure: issues #105, #22, #87, #76; dashboards.

Not frozen: deploying the two fixes from PR #145; bugs that block steps 1–5;
issue #37 (malformed-PDF fuzzing) before any wider outside traffic.

Wake triggers: steps 1 and 2 pass **and** a consumer names latency or cost as
what stops them; or measured load. A new reader model is then judged the
usual way, with `score-candidate-witness.mjs`.

## If it fails

- **Step 1 null:** stop the hosted service and the labelled view. Keep the
  library as an Evidence Search component, or shelve it.
- **Step 1 passes, step 2 finds too few errors on born-digital pages:**
  narrow to scans and charts, where there is one witness and the value is in
  reading at all, and re-plan step 4 as the product.
- **Both pass, step 5 finds no returning user:** keep it as an internal part
  of Evidence Search; no service.

## Owner decisions

Work proceeds on the defaults unless changed.

| # | Decision | Default |
| --- | --- | --- |
| 1 | Accept the freeze in step 6 | Yes, from today; PR #145's deploy excluded |
| 2 | Step 1 stop rule | 5 fewer wrong answers per 100, net of wrongly hedged |
| 3 | Step 1 answer model | The repo's pinned `gemini-3.7-flash`; repeat with a second model only if the result is within 3 of the threshold |
| 4 | Step 2 model parser and cap | Gemini 3.7 Flash page-to-Markdown; $15 |
| 5 | Step 2 thresholds | 1 wrong token per 1,000 and half of them flagged |
| 6 | Where the glue fixes live (step 3) | In the agreement rule (`criticalTokensAgree`), not the tokenizer, so records keep tokens as read |
| 7 | Step 3 escalation target | Below 30% of dev-corpus pages (my proposal; no measurement behind the number) |
| 8 | Labelling time | About four sittings: step 1 answer keys, step 2 crops (two), chart gold |
| 9 | Patent read by an attorney | Before the comparison is marketed; see below |

When the owner accepts, the affected rows of `docs/workstreams.md` change in
the same pull request as this document's status line.

## Patent note (facts only, no legal conclusion)

Sureprep LLC holds three related US patents, all with priority 2018-03-15 and
shown as active on Google Patents: US 10,489,645 (granted 2019-11-26,
adjusted expiry 2038-06-19), US 10,489,644 (2019-11-26, 2038-03-15) and
US 11,232,300 (2022-01-25, 2038-10-09).

- How they were read: all six independent claims (claims 1 and 11 of each)
  were read from the Claims section as Google Patents displays it, by a
  fetching agent that reported each element in quoted fragments. Nobody here
  has read the USPTO source or a full uninterrupted copy.
- Claim 1 of US 11,232,300: locate OCR-detected text in the text layer from
  its pixel coordinates in the image layer, detect the text there, and render
  "only the detected text in the text layer as an output" when the two do not
  match. Claim 11 is the same as a system.
- Claims 1 and 11 of US 10,489,645 add obtaining the document and the OCR
  text, and "using a pixel transformation" for the location; the final
  element is the same.
- Claims 1 and 11 of US 10,489,644 add normalization of both texts, and
  render or produce "only the normalized text-layer text" on a mismatch.
- No independent claim recites any output for the case where the texts
  match. Match and mismatch indicators, user correction and discarding the
  OCR text appear in dependent claims.
- The description treats the text layer as reliable because the document is
  native.

What PageSpatial does on a mismatch: it records a conflict, keeps both
readings in the record, and lists both in the Markdown. Whether that falls
inside or outside these claims, and whether the claims are valid, is for a
patent attorney.

# Coverage-starvation escalation: closing the false-confidence hole

Date: 2026-08-19
Baseline: [dev-v10](../../evaluation/baselines/dev-v10-coverage-starvation-2026-08-19.summary.json) (supersedes dev-v9; conflicts and matches identical).
Issue: #3. Adversarially reviewed pre-merge (Codex + one model reviewer); this document reflects the post-review state.

## The hole

The gold pilot demonstrated a page (Monotaro JA financial highlights) whose
OCR was confidently wrong — CJK garbage at 0.90+ confidence — while the
native layer held only headings. With nothing to disagree with, the page
never escalated: false confidence, the rubric's worst failure class.

## The diagnostic

A new escalation reason, `uncorroborated-ocr`, severity `blocking`
(schemaVersion 0.3.0): a page fires when it has at least
`UNCORROBORATED_OCR_MINIMUM_COUNT` (8) confident OCR observations
(confidence ≥ the existing `lowOcrConfidence` boundary — no new confidence
knob) and STRICTLY less than half of them engage the native layer (match or
conflict). Both thresholds are recorded per page in
`diagnostics.thresholds`; constants live in `src/tuning.ts`.

Per [principles](../principles.md) §4, this flag is a routing signal for an
automated stronger-model tier, never a human review queue.

### How the cutoff was chosen, honestly

The selection was outcome-informed, not purely definitional. A first
candidate (0.10, "near-total starvation") was implemented and measured: it
caught image-only scans but missed the motivating page, whose garbled
headings still matched native headings, leaving it at 29% engaged coverage.
The cutoff was then reconsidered against the corpus-wide distribution of
engaged coverage (pages with ≥8 confident OCR observations, 151 of 162):

| Engaged coverage | 0–9% | 10–19% | 20–29% | 30–39% | 40–49% | 50–59% | 60–69% | 70–79% | 80–89% | 90–100% |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Pages | 22 | 5 | 3 | 2 | 4 | 4 | 4 | 4 | 18 | 85 |

The distribution is bimodal on this corpus: a starved cluster below 50%, a
corroborated cluster above 80%, and a sparse middle. Any cutoff in the
40–80% region selects nearly the same page set; strict majority
(engaged coverage < 0.5) was chosen as the least arbitrary member. What
this does NOT establish: that the bimodality is intrinsic rather than a
property of this corpus mix, or how the cutoff behaves on other corpora.
Revisit with escalation precision/recall once gold coverage completes
(issue #1).

### Two situations, one flag

The rule fires on two structurally different page kinds, deliberately not
distinguished yet:

- **Native layer empty** (image-only scans): single-witness is the
  permanent, expected condition. No OCR adapter improvement can ever raise
  engaged coverage here — for this subclass the flag is effectively a
  durable "single-witness page" classifier, and only an architectural
  change (a second OCR witness) could retire it.
- **Native layer present but disjoint** (the Monotaro case, 29%): an
  association or OCR-quality failure. This subclass is exactly what a
  better OCR adapter (issue #2) should shrink.

A future refinement may split these into distinct reason types; today the
share and `nativeObservationCount` fields let a router distinguish them.

## dev-v10 results (162 pages, clean-commit run, dirty: false)

- Native 17,051 / OCR 14,797 / matches 11,072 / conflicts 627 — identical
  to dev-v9, demonstrating a diagnostics-only change. (An interim run
  during development differed by one OCR observation and one match:
  WebGPU OCR inference is not bit-deterministic across executions, which
  baseline comparisons should expect at ±1.)
- 36 pages fire `uncorroborated-ocr` (22%): all image-only scans, the
  Monotaro JA chart pages including the motivating page, scanned slide
  decks, and two dense World Bank procurement tables.
- Escalated pages 102 → 124; the 22 newly escalated are exactly the
  previously silent single-witness pages. No page sits on the exact 0.5
  tie, so the strict-majority boundary changed no outcome.

## Gold validation (30 labelled pages, evaluated against dev-v10, metrics v3)

The evaluator now counts every blocking-severity page in
`escalatedBlockingPages` and splits it into two disjoint subsets with
different confirmation criteria — they are not comparable to each other:

- **Conflict-blocking pages: 14, of which 14 confirmed real** by human
  conflict adjudication (the strong criterion).
- **Uncorroborated-only pages: 9, of which 8 carry at least one human-gold
  token both engines missed** (a deliberately weaker criterion — these
  pages have no conflict to adjudicate). Context: 43% of ALL gold pages
  carry such a token, so 8/9 is roughly a 2× lift — but the gold sample
  was curated toward suspected problem classes (CJK/chart/scan), the same
  classes the flag fires on, so the lift is partly baked into sampling.
- `cleanWithHumanGoldMissedByBoth` fell from 3 to 0: on this sample, every
  gold page that previously passed as clean while missing verified content
  is now flagged.

## Cost framing

The flag routes ~22% of this corpus mix to a stronger-model tier. At
measured vision-model prices (~$0.01/page) that is ~$0.002 per corpus page
amortized. Issue #2's OCR adapter can shrink only the native-present
subclass; the scan subclass is a permanent routing cost of single-witness
evidence unless a second witness is added.

## Known gaps and limits

- **Low-confidence starvation is not covered**: a native-empty page whose
  OCR self-reports below 0.5 yields only advisory reasons, so a
  blocking-only router still indexes the least verifiable pages whenever
  OCR is honest about its uncertainty — and a page can flip
  advisory↔blocking on a confidence wobble around 0.5. This is coupled to
  the recognitionThreshold/lowOcrConfidence pair recorded in
  `src/tuning.ts`; revisit together, with gold.
- The 8/9 hit rate is a 9-page curated sample, one annotator.
- Firing breadth is corpus-mix dependent: born-digital English corpora
  would fire rarely; scan-heavy corpora would route most pages — correct
  behavior for single-witness evidence, but priced accordingly.

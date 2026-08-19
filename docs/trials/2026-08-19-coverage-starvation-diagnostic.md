# Coverage-starvation escalation: closing the false-confidence hole

Date: 2026-08-19
Baseline: [dev-v10](../../evaluation/baselines/dev-v10-coverage-starvation-2026-08-19.summary.json) (supersedes dev-v9; conflicts unchanged).
Issue: #3.

## The hole

The gold pilot demonstrated a page (Monotaro JA financial highlights) whose
OCR was confidently wrong — CJK garbage at 0.90+ confidence — while the
native layer held only headings. With nothing to disagree with, the page
never escalated: false confidence, the rubric's worst failure class.

## The diagnostic

A new escalation reason, `uncorroborated-ocr`, severity `blocking`: a page
fires when it has at least `UNCORROBORATED_OCR_MINIMUM_COUNT` (8) confident
OCR observations (confidence ≥ the existing `lowOcrConfidence` boundary — no
new confidence knob) and the MAJORITY of them are single-witness — neither
matched to nor conflicting with the native layer. Both thresholds are
recorded per page in `diagnostics.thresholds` (self-describing records) and
defined in `src/tuning.ts`.

The coverage cutoff (0.5) is definitional, not fitted. The dev-corpus
distribution of engaged coverage is bimodal: a starved cluster at 0–40%
(scans, CJK chart pages, scanned slide decks), a corroborated cluster at
80–100%, and a sparse valley between — any cutoff inside the valley selects
the same cluster, and "majority" is its least arbitrary member. An earlier
candidate (0.10, "near-total starvation") was measured first and rejected:
it caught scans but missed the motivating page, which sits at 29% because
its garbled headings still matched native headings.

Per [principles](../principles.md) §4, this flag is a routing signal for an
automated stronger-model tier, never a human review queue.

## dev-v10 results (162 pages)

- Conflicts and matches unchanged from dev-v9 (627 / ~11,072): this is a
  diagnostics-only change.
- 36 pages carry `uncorroborated-ocr` (22% of the corpus): all image-only
  scans, the Monotaro JA chart pages including the motivating page, scanned
  slide decks, and two dense World Bank procurement tables.
- Escalated pages 102 → 124. The 22 newly escalated pages are exactly the
  previously silent single-witness pages; 14 starved pages already escalated
  for other reasons.

## Gold validation (30 labelled pages, evaluated against dev-v10)

- 9 gold pages escalate solely for `uncorroborated-ocr`; **8 of the 9 carry
  human-gold tokens that both engines missed** — the flag points at
  genuinely deficient pages.
- `cleanWithHumanGoldMissedByBoth` fell from 3 to **0**: every gold page
  that previously passed as clean while missing verified content is now
  flagged. On this sample, the measured false-acceptance hole is closed.
- Conflict-adjudicated blocking escalations remain 14/14 confirmed real.
- Escalation accounting now reports uncorroborated-only pages separately:
  they have no conflict a human could adjudicate, so their confirmation
  signal is human gold the engines missed, not conflict verdicts.

## Cost framing

At enterprise scale the flag routes ~22% of pages (on this corpus mix) to a
stronger-model tier. At vision-model pre-labeling prices (~$0.01/page
measured), that is ~$0.002 per corpus page amortized — and the routed set is
precisely the set a better OCR adapter (issue #2) will shrink: every page
class that fires is a page class the Tiny recognizer cannot corroborate.

## Interpretation limits

- The 8/9 gold hit rate is a 9-page sample, one annotator.
- Firing breadth is corpus-mix dependent: a corpus of born-digital English
  text would fire rarely; a scan-heavy corpus would route most pages, which
  is correct behavior for single-witness evidence but priced accordingly.
- The 0.5 cutoff should be revisited once issue #1 completes gold coverage,
  using escalation precision/recall rather than distribution shape.

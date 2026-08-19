# Adversarial review fixes: two-channel tokens and honest gold tiers

Date: 2026-08-19
Supersedes the results in [gold pilot trial](2026-08-19-gold-pilot-first-accuracy.md); baseline lineage continues from [dev-v8](../../evaluation/baselines/dev-v8-critical-ink-2026-08-19.summary.json) to [dev-v9](../../evaluation/baselines/dev-v9-two-channel-tokens-2026-08-19.summary.json).

## Why this trial exists

Four independent reviews of the audit/gold branch (two Codex passes, two
subagent passes) found that the parser-side work was sound but the
measurement tooling had defects that invalidated the gold pilot's headline
numbers in both directions. Full findings: repository issue #8. This trial
records the fixes and the regenerated numbers.

## Retractions from the previous gold trial

1. **"Chart detector matched 0/132 gold tuples — retire it" was false.** The
   evaluator join compared the detector's normalized `FY2024` category
   against verbatim gold `2024`; it could never match by construction.
   Corrected: batch 2 recall 25.2%, precision 96.4% (27/28 detections
   correct). The detector is narrow, not dead.
2. **"First independent accuracy measurements" overclaimed.** Auto-accepted
   tokens (native-corroborated) were folded into "native recall" — but the
   corroboration test and the recall test were the same containment check,
   so that tier's native recall was tautological. Metrics now report a
   human-verified tier (independent gold) and a silver tier (labeled
   tautology check) separately.
3. **Missed-by-both rates were inflated by tokenizer glue artifacts.**
   Word-glue was context- and segmentation-dependent, so a gold token like
   `112.6 billion` could not match a native layer that held `112.6` and
   `billion` as separate observations.
4. **Part of dev-v8's conflict rise (449→663) was glue artifact**, not
   recovered misreads: 36 of 663 conflicts dissolved under the corrected
   tokenizer (label misreads like `głosów`/`gtosów` next to agreeing
   numbers, `1.8x` vs `1.8` splits, a neighboring column's `S` glued on).

## Parser change: two-channel critical tokens (dev-v9)

A critical token now has a numeric CORE (sign, currency, digits, separators,
percent) that is always compared, and an optional TAIL — one adjacent
unit-like word — compared only when BOTH sides captured one. An observation
that merely covers less ink (a number without its unit word or label) can no
longer conflict with one that covers more; a real unit disagreement
(`$3.5mm` vs `$3.5m`, `million` vs `rnillion`, `2024E` vs `2024F`) still
blocks. Leading words are captured for neither side: they are labels, and
comparing them turned alphabetic OCR noise (`EBITDA` vs `EBlTDA`) into
blocking conflicts. Documented trade: a misread leading currency code
(`USD` vs `USO`) is no longer caught. Contract tests now include rows that
feed each side a different segmentation of identical ink.

Also landed: `schemaVersion` bumped to 0.2.0 (severity/share/markdownSource
are required fields; 0.1.0 records are not silently reinterpreted);
figure/punctuation-space grouping heal; U+2044 fraction-slash fold;
share compared with tolerance in schema semantic checks.

dev-v9 (same 162 pages, same OCR observations as dev-v8): 627 conflicts
(−36), 11,072 matches (+32), 102 escalated pages (−1), 0 failed closed.

## Measurement fixes

- Evaluator: occurrence-consuming matching (one extracted token satisfies
  one gold token), tail-compatible containment, SHA-256 fail-closed joins
  between verdicts/proposals/run records, duplicate-key rejection,
  severity-aware escalation accounting, chart tuples joined on token
  compatibility, dynamic caveats, validated input hashes recorded.
- Review UI: corroboration is now position-aware and occurrence-consuming
  (compatible token AND overlapping box, each native occurrence used once);
  human rows default to unreviewed and the evaluator rejects unreviewed
  verdicts (a do-nothing export can no longer agree with the machine);
  escalation status hidden from the annotator; chart values export edits and
  missed tuples; embedded JSON escapes `<`.

## Regenerated results (30 pages, evaluated against dev-v9)

Human-verified tier (independent gold — tokens a person actually confirmed):

| Slice | Gold tokens | Native | OCR | Union | Missed by both |
| --- | ---: | ---: | ---: | ---: | ---: |
| Batch 1 (16 mixed pages) | 339 | 37% | 63% | 64% | 123 (36%) |
| Batch 2 (14 Monotaro EN/JA) | 120 | 36% | 43% | 45% | 66 (55%) |
| — EN human tier | 33 | | | 97% | 1 (3%) |
| — JA human tier | 87 | | | 25% | 65 (75%) |

Silver tier (native-corroborated auto-accepts; native/union rates are
tautological by construction and quoted only as a consistency check): batch 2
558 tokens, union 99.5%.

Interpretation: the human tier in batch 2 is, by construction, the tokens the
native layer missed — overwhelmingly chart-embedded values. On identical
EN/JA content, both engines together miss 3% of those in English and 75% in
Japanese. The CJK/chart recall finding survives the corrections and is
starker than originally reported, on an honestly narrower denominator.

Other regenerated findings:

- **Blocking escalations are 14/14 confirmed real errors** across both
  batches (6/6 and 8/8); advisory-only escalations (8 pages) are now counted
  separately because they have no conflict for a human to adjudicate.
- Conflict adjudications unchanged: OCR right 23, native right 17, both
  wrong 6 — neither engine deserves default trust.
- Chart detector: 25.2% recall, 96.4% precision (batch 2; batch 1 pages
  produced no detections). Improve recall or scope; do not delete.
- 3 of 7 clean batch-1 pages still carry human-gold tokens missed by both
  engines — silence is not correctness.

## Caveats

- 30 pages, one annotator verifying machine proposals; no second annotator.
- Human/silver tier boundaries come from the earlier review UI (page-wide,
  position-blind corroboration); future batches use the position-aware rule.
- Recall is text-containment; geometry precision is unmeasured.
- Verdicts adjudicated dev-v8's conflict set; dev-v9 dissolved 36 of those
  conflicts, 4 of which were among the 46 adjudicated (label-misread
  artifacts next to agreeing numbers — the class the design change
  deliberately stopped blocking on). The conflict-composition table still
  counts them as adjudicated history.

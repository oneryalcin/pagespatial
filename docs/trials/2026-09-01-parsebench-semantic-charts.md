# ParseBench bounded Semantic chart trial — 2026-09-01

## Decision

The chart-only Semantic boundary is **promising but not product-qualified**.
Keep Basic deterministic and unchanged. Retain the narrow adapter and evidence,
but do not enable Gemini on all pages or claim a finished Semantic tier.

One `gemini-3.7-flash` call was made for each of the three pinned chart pages.
Basic passed 0/23 chart rules. Basic plus the schema-validated chart relations
passed **12/23 (52.2% micro pass rate)**. This is material uplift, but one page
still passed 0/8 because the returned series labels did not match the benchmark
labels closely enough. A larger, clean validation cohort and a production
trigger/cost contract are still required.

## Frozen scope

| Component | Revision or value |
| --- | --- |
| ParseBench | `run-llama/parse-bench@72f8882174e175b5f4db401ff0cff8047054f46b` |
| Dataset | pinned three-page `test/chart` cohort from the Basic trial |
| Basic pipeline | `pagespatial_basic`, enrichment off |
| Treatment pipeline | `pagespatial_semantic_chart` |
| Model | `gemini-3.7-flash` |
| Calls | exactly 3: one page image per call |

The prompt contained the rendered page image and a generic instruction to
transcribe visible chart relations. It did not contain ParseBench labels,
expected values, or ground truth. The model response used a closed JSON schema
for chart title plus category, series, value, and unit. The adapter appended
Markdown tables to a copy of the Basic output. SHA-256 checks confirmed that
the three stored Basic results did not change.

## Results

| Document | Basic | Semantic | Added latency | Relations | Total tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| OECD merger notifications | 0/10 | **7/10** | 18.029 s | 38 | 3,896 |
| ADL automotive attitudes | 0/8 | **0/8** | 9.955 s | 8 | 1,916 |
| Partner compensation | 0/5 | **5/5** | 22.949 s | 12 | 2,290 |
| **Total** | **0/23** | **12/23** | **50.933 s** | **58** | **8,102** |

The aggregate macro average reported by ParseBench is 56.7%; the micro count
is 12/23 = 52.2%. Use the micro count for this cohort because it states the
actual number of rules passed.

The first evaluation incorrectly reported 0/23 because the adapter updated
per-page Markdown but not ParseBench's document-level `output.markdown` field.
The stored treatment was reprojected and rescored without another Gemini call.
The corrected adapter now updates both fields. This was an adapter defect, not
a model rerun or prompt change.

## Failure interpretation

- Three OECD misses were absent or outside tolerance/association.
- The ADL values were present, but the model used shorter series labels such as
  `Favorable`; ParseBench expected labels such as `favorable attitude`. All
  eight rules therefore failed label association.
- The compensation chart passed every rule.

This suggests a typed label-normalization problem, but the three-page cohort is
too small to justify a resolver taxonomy. Do not classify raw strings or tune
against these benchmark labels.

## Product boundary

- Basic remains the canonical deterministic record and fallback.
- Semantic is a separate selective stage for chart pages, with its own model,
  latency, token use, validation, provenance, and price.
- This experiment does not justify running Gemini for tables, ordinary text,
  layout, or every page.
- Current provider usage is recorded; no current-price or customer-price claim
  is made here.

## Evidence

- `scripts/evaluation/parsebench-chart-semantic.mjs`
- `docs/trials/evidence/2026-09-01-parsebench-semantic-charts.json`
- `docs/trials/evidence/2026-09-01-parsebench-semantic-charts-evaluation.json`

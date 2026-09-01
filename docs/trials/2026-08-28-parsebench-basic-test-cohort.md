# ParseBench Basic test cohort

**Date:** 2026-08-28
**Status:** Exploratory measurement complete
**Decision:** Keep two product tiers. Basic remains deterministic. Semantic is a separate, selective Gemini 3.7 Flash stage and must not mutate the Basic record.

## Verdict

The two-tier product is technically coherent, but the tiers must have a strict boundary:

- **Basic** is the deterministic PageSpatial parse with `enrichment: "off"`. It produces the canonical evidence record and has no LLM dependency.
- **Semantic** starts from the completed Basic record and selectively invokes the repository's pinned `gemini-3.7-flash` resolver only for typed, blocking conflicts such as unresolved chart data. It writes a separate, provenance-bound enrichment. Basic remains available unchanged if Gemini fails.

Semantic must not be implemented as a request flag inside the currently qualified Modal parser. The current service deliberately accepts only `enrichment: "off"`. Selective semantic work is an asynchronous second stage with its own trigger count, latency, token use, and cost.

The small Basic cohort gives a decisive first result: PageSpatial is a strong deterministic text-evidence baseline, but it is not yet a complete ParseBench parser. It preserves most page text and some semantic formatting. Chart recovery and visual grounding remain weak, and two of three table cases still lack correct record structure.

## Frozen inputs

The machine-readable pins are in `scripts/evaluation/parsebench-pins-v1.json`.

| Component | Revision |
| --- | --- |
| ParseBench | `run-llama/parse-bench@72f8882174e175b5f4db401ff0cff8047054f46b` |
| ParseBench dataset | `llamaindex/ParseBench`, branch `test-data`, commit `68bbab242f749df2e2ef753daabcbbbe291d943e` |
| PageSpatial pipeline | `pagespatial_basic`, `enrichment: off` |
| Modal app | `pagespatial-parse-m5-dev` |
| Observed PageSpatial adapter | `e439637ca4ac-dirty` |
| Observed image pin | `d6c482ff50c5` |

The ParseBench code and dataset are reproducibly pinned. The observed PageSpatial build is explicitly dirty, so this run is exploratory only. A clean committed PageSpatial image must reproduce the result before an external or leaderboard claim.

## Adapter contract

`scripts/evaluation/parsebench_pagespatial.py` registers one deliberately narrow ParseBench pipeline:

- one provider: `pagespatial`;
- one pipeline: `pagespatial_basic`;
- one Modal method: `ParseContainer.parse_document`;
- schema version `0.6.0`;
- enrichment forced off;
- returned status and complete-page conditions validated before success;
- ParseBench Markdown projected from native structure, native text, unmatched OCR evidence, and typed chart-category-value relations;
- the final native structure extracted by its exact marker without treating document `##` headings as adapter sections;
- layout projected from typed absolute-pixel PageSpatial boxes.

The adapter does not use a model to rewrite output for the benchmark. It measures the deterministic record that exists today.

## Cohort

The pinned ParseBench `data/test` set contains three examples for each of the five headline dimensions. Content and formatting share three source pages, so the run evaluated 15 dimension cases across 12 unique one-page PDFs.

```sh
cd /private/tmp/ParseBench
PAGESPATIAL_PARSEBENCH_MODAL_APP=pagespatial-parse-m5-dev \
UV_CACHE_DIR=/private/tmp/uv-cache \
uv run --with modal python \
  /Users/mehmetoneryalcin/dev/personal/pagespatial/scripts/evaluation/parsebench_pagespatial.py run \
  pagespatial_basic \
  --input_dir=/private/tmp/ParseBench/data/test \
  --output_dir=/private/tmp/ParseBench/output/pagespatial_basic_test \
  --max_concurrent=2 \
  --force=true \
  --open_report=false
```

All 12 unique inference calls completed. No PDF or page parse failed.

## Results

The first report was invalidated on 2026-08-28. The adapter split its wrapper Markdown at every `##` heading. Real document headings therefore truncated two text cases and hid one complete table. A second deterministic adapter defect split one spanning table header across the header and first body row. Both adapter defects were fixed, and the stored inference records were reprojected and reevaluated. No PDF was reparsed and no Modal call was made for either correction.

| ParseBench headline dimension | Corrected Basic result | Invalid first result | Evidence |
| --- | ---: | ---: | --- |
| Charts: Data Point Match | **0.00%** | 0.00% | 0 of 23 chart-value rules passed; reports contained no usable chart table |
| Tables: GTRM composite | **41.22%** | 7.88% | GriTS content 49.10%; Table Record Match 33.33%; the repaired Clock table reached 100% on both metrics, but row records remain incomplete in the other cases |
| Content Faithfulness | **88.05%** | 68.08% | text correctness 88.49%; reading order 87.18%; 540 of 597 micro rules passed |
| Semantic Formatting | **36.53%** | 0.00% | normalized styling 36.95%; normalized title accuracy 54.17% |
| Visual Grounding: Element Pass Rate | **11.78%** | 11.78% | localization 31.01%; classification 23.29%; attribution 27.16% |

The corrected unweighted mean of these five small-cohort headline results is **35.52%**. This is not a leaderboard score: the cohort has only three cases per dimension, and the PageSpatial build was dirty.

The corrected non-table reports are under `/private/tmp/ParseBench/output/pagespatial_basic_cold_review/`. The final table treatment report is under `/private/tmp/ParseBench/output/pagespatial_basic_header_collapse_treatment/`; its freshly reevaluated unchanged control is under `/private/tmp/ParseBench/output/pagespatial_basic_header_fix/`. These are local diagnostic evidence, not committed benchmark artifacts. The earlier `pagespatial_basic_projection_fixed` directory includes an invalid broad header-flattening diagnostic and must not be quoted.

The broader layout rule pass rate was 27.25%, but ParseBench's stricter Element Pass Rate is the headline measure because the same element must be localized, classified, and attributed correctly. The corrected layout report is `layout/_evaluation_report.fixed.json`; the earlier generated layout report contains the pre-fix skipped cases and must not be quoted.

## Latency observation

The 12 stored one-page calls took 6.18 to 16.01 seconds each, with a median of 8.27 seconds and a mean of 9.15 seconds. These calls used shared Modal infrastructure and mixed container state. They are not an SLA or a cold-start distribution.

## Interpretation

The Basic result identifies the product boundary cleanly:

1. **Basic has real value.** Content Faithfulness at 88.05% shows that the deterministic pipeline preserves most page text while retaining inspectable evidence and geometry.
2. **Basic is not a complete semantic document parser yet.** Chart extraction remains absent. Formatting, table records, and grounding remain partial capabilities rather than zero-capability gaps.
3. **Charts are the best first Semantic target.** ParseBench requires structured label-value output. Basic emitted no usable chart tables, so a selective resolver has a clear, measurable job.
4. **Tables need a deterministic typed projection first.** Two failed cases retained row-wise positioned evidence but collapsed it in the Markdown table. Gemini must not compensate for an adapter or projection defect.
5. **Do not run Gemini on every page.** Tables and layout need typed deterministic improvements too. Broad model use would mix unrelated failure modes, cost, and latency before chart recovery is proven.

## Deterministic PDF Inspector follow-up

A bounded follow-up tested whether more of the existing PDF Inspector evidence could improve tables or grounding before the Semantic experiment.

### Structure roles

The 12 stored pages contained 1,022 native observations. Of these, 970 had no structure role, 51 were `P`, and one was `Span`. There were no useful heading, table, figure, header, or footer roles in this cohort. Role-to-ontology mapping therefore cannot materially improve the current ParseBench result and was not added.

### Item geometry

The control projects `nativeLines` plus unmatched OCR rows. Some `nativeLines` visibly merge text across columns, so a candidate projected individual `nativeObservations` instead.

| Layout projection | Element Pass Rate | Localization | Classification | Attribution | Mean predictions/page |
| --- | ---: | ---: | ---: | ---: | ---: |
| `nativeLines` control | **11.78%** | 31.01% | **23.29%** | 27.16% | 44.7 |
| individual observations | 7.94% | **33.97%** | 18.90% | **30.05%** | 152.7 |

The item projection slightly improved localization and attribution in isolation, but it over-segmented paragraph-sized ground truth and reduced the strict same-element pass rate by 3.84 percentage points. **Decision: reject.** The experiment-only layout mode was removed instead of retained as unused configuration.

### Table recovery

PDF Inspector's deterministic region-table API was probed on each pinned table page without using benchmark labels:

| Page | Full-page region result | Decision |
| --- | --- | --- |
| Clock datasheet | No table; the small table was lost among two-column prose | Do not use full-page extraction |
| Interstate form | Recovered the central two-column list, but also promoted surrounding headings, body text, and the signature into table rows | Do not accept without a deterministic region locator |
| Texas form | Recovered clean rows for the populated class/relativity pair | Useful evidence, but not safe as a global full-page rule |

The vector-grid probe also produced a false grid on the unruled Interstate form. Therefore neither `extractTablesInRegions` nor vector-grid detection is added globally. A future deterministic table-region locator can call the region API only after it supplies and validates a bounded region.

One adapter-only repair did pass the measurement gate. PDF Inspector represented the Clock table with a mostly empty spanning-header row followed by a complete column-header row. Conservatively merging those rows only when a strict majority of the first header is empty raised Clock GriTS from **89.36% to 100%**, made its record match perfect, and raised cohort GTRM composite from a freshly reevaluated **22.78% control to 41.22%**. The historical invalid report was 7.88%. Ordinary blank-header tables remain unchanged. **Decision: keep.**

The ParseBench paper evaluated `gemini-3-flash`, not PageSpatial's pinned `gemini-3.7-flash`. Its reported Gemini results support the hypothesis that a VLM can recover chart semantics, but they do not establish PageSpatial Semantic quality, cost, or latency. Those must be measured on our exact model, prompt, trigger, and output contract.

Historical PageSpatial enrichment records put selective Gemini work in the approximate range of $0.0015 to $0.011 per enriched page, depending on the experiment and batching method. Those are different historical eras, not current pricing promises. Semantic billing must record actual enriched pages and actual provider usage for each job.

## Next bounded experiment

Run one paired Basic-versus-Semantic experiment on only the three pinned chart pages:

1. run and preserve the Basic record;
2. trigger Gemini 3.7 Flash only when the deterministic result has chart evidence but no complete typed chart-category-value relation set;
3. require the Semantic stage to emit a closed, schema-validated label-value structure with provenance back to the Basic page;
4. evaluate both variants against the same 23 ParseBench chart rules;
5. report trigger rate, passed rules, added wall time, input/output tokens, provider cost, validation failures, and fallback behavior;
6. keep the chart resolver only if it produces material rule uplift without changing the Basic result.

Do not broaden Semantic to tables, layout, or all pages until this three-page chart experiment proves that the selective boundary works. This is the smallest experiment that can answer whether the second tier earns its complexity and cost.

## Scope limits

This run does not qualify:

- a public ParseBench leaderboard result;
- the Semantic tier;
- current Gemini pricing;
- multi-page throughput or a latency SLA;
- a clean production PageSpatial build;
- a claim that all missing chart data requires an LLM.

It does establish a reproducible Basic adapter, frozen upstream inputs, a measured five-dimension floor, and the exact next Semantic experiment.

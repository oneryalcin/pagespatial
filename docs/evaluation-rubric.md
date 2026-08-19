# PageSpatial production evaluation rubric

Status: required release gate for parser and routing changes

## Purpose

This rubric evaluates whether a PDF ingestion pipeline preserves source evidence well enough for enterprise search, grounded answers, highlights, and selective vision escalation. It applies to deterministic extraction, OCR, native/OCR merging, generated structure, retrieval, and fallback routing.

`PageSpatial` is the evidence record. Markdown, search chunks, tables, chart summaries, and model prompts are derived views. A derived view cannot receive a passing result when its claims cannot be traced to raw observations and page geometry.

## Evaluation rules

1. Use a sealed corpus with independently labelled ground truth. Do not tune against the release test set.
2. Report every metric by document class and as a corpus aggregate. A strong native-PDF score cannot hide failures on scans, rotations, tables, or multilingual pages.
3. Report unavailable measurements as `not evaluated`. Never convert missing evidence into zero, success, or an empty-error count.
4. Do not collapse the rubric into one weighted score. A candidate must pass the safety gates before latency or cost can determine the preferred implementation.
5. Preserve raw native and OCR observations. Score inferred reading order, table structure, chart relationships, and model output separately from source extraction.
6. Bind every result to the source-file hash, corpus version, parser and model versions, configuration, implementation revision, and evaluation-run ID.
7. Retain failed trials and escalation outcomes. Report confidence and routing decisions even when parsing fails.

## Required corpus classes

The sealed corpus must contain real retained documents for:

- native text PDFs;
- image-only scans at several qualities;
- mixed native and raster pages;
- rotated pages and shifted crop boxes;
- multi-column and irregular reading order;
- dense and merged-cell tables;
- single-series and multi-series charts;
- diagrams and text embedded in figures;
- multilingual and mixed-script text;
- handwriting or degraded text where supported;
- long documents and repeated templates;
- malformed or partially recoverable PDFs.

Record page-level class labels so results can be sliced without relying only on document-level classification.

## 1. Text fidelity

Measure:

- character error rate (CER) and word error rate (WER);
- text-region detection precision, recall, and F1;
- bidirectional critical-token precision and recall;
- exact critical-token preservation.

Critical tokens include numbers, signs, accounting negatives, dates, actual/estimate suffixes, currencies, percentages, units, magnitude suffixes, identifiers, and other corpus-specific values that can materially change an answer.

`Bidirectional` means checking both directions:

- every gold critical token must appear correctly in the extracted evidence;
- every extracted critical token presented as source evidence must correspond to the gold page content.

An accepted native/OCR association is not proof of OCR accuracy. Report native-OCR association coverage separately as a diagnostic.

## 2. Geometry fidelity

Measure:

- box or polygon precision, recall, and F1 at declared intersection-over-union thresholds;
- small-token localization using a declared center-point or containment rule where IoU is unsuitable;
- page assignment accuracy;
- native/OCR association precision and recall against labelled correspondences;
- coordinate-transform correctness for rotation, crop-box translation, and render scaling;
- highlight coverage and spill outside the gold evidence region.

All geometry must be expressed in a documented canonical coordinate system and remain reversible to the rendered page.

## 3. Reading order and hierarchy

Measure:

- pairwise reading-order accuracy or rank correlation;
- adjacent-block ordering F1;
- column assignment accuracy;
- heading, paragraph, list, caption, footnote, and figure-role accuracy when those structures are produced;
- hierarchy edge accuracy for parent/child relationships.

Score raw text recovery separately from inferred order. Correct words in the wrong column are not a correct page representation.

## 4. Tables, charts, and derived relationships

For tables, measure:

- cell detection precision and recall;
- row, column, header, and spanning-cell assignment accuracy;
- cell text exact match and critical-token preservation;
- table-level structural similarity where an appropriate benchmark metric is available.

For charts, measure labelled relation triples such as:

```text
(series, category, value, unit)
```

Report precision, recall, and F1 for category-to-value, legend-to-series, axis-to-unit, and footnote relationships. A correct value connected to the wrong year or series is a material failure.

Every derived relationship must retain its component source observation IDs, method/version, confidence, and ambiguity. Derived relationships are never counted as raw source evidence.

## 5. Retrieval and answer quality

Measure retrieval independently from generation:

- page and evidence-region Recall@k;
- nDCG@k and MRR where ranked relevance labels exist;
- critical-evidence recall before answer generation;
- duplicate and contradictory evidence rates.

For answers, measure:

- exact or task-specific answer accuracy;
- numeric tolerance only where the evaluation question explicitly permits derivation;
- evidence precision and recall;
- citation completeness and page/box correctness;
- unsupported-claim and contradiction rates;
- distinction between document-stated facts and derived analysis.

An answer can be correct by chance while citing the wrong evidence. Answer accuracy and grounding must pass separately.

## 6. Operational performance

Measure cold and warm paths separately:

- time to first searchable page at p50 and p95;
- per-page and full-document latency at p50 and p95;
- sustained pages per second under declared concurrency;
- peak browser, CPU, GPU, and server memory;
- CPU/GPU utilization and backend actually selected;
- bytes downloaded and cache effectiveness;
- cost per page, per document, per escalated page, and per successfully grounded answer;
- timeout, crash, retry, and partial-page failure rates.

Record document length, page dimensions, render scale, hardware, browser/runtime, batch sizes, and concurrent workload for every performance run.

## 7. Escalation and confidence safety

Every evaluated page or region needs both a gold routing label and the parser's routing decision:

| Gold condition | System decision | Outcome |
| --- | --- | --- |
| Needs escalation | Escalated | Correct escalation |
| Needs escalation | Accepted | False acceptance; dangerous false confidence |
| Does not need escalation | Escalated | Unnecessary cost and latency |
| Does not need escalation | Accepted | Correct deterministic acceptance |

Measure:

- escalation precision, recall, and rate;
- false-accept rate and false-escalation rate;
- severity-weighted false-accept rate;
- calibration of reported confidence against observed correctness;
- fallback success, timeout, and residual-error rates.

A material false acceptance is a hard release failure. The system must prefer an explicit unsupported or escalation result over a confidently wrong source representation.

## Release decision

A candidate can be promoted only when:

- every mandatory corpus class has sufficient labelled coverage;
- critical-token, geometry, relationship, retrieval, grounding, and routing gates pass independently;
- no material false acceptance appears in the sealed release set;
- all failures and unsupported cases are represented in the report;
- operational measurements meet the declared product budget;
- the complete run is reproducible from retained inputs, configuration, hashes, and code revision.

Exact numeric thresholds belong in a versioned release profile after the first representative corpus baseline. Changing a threshold creates a new rubric/profile version and requires a complete rerun.

## Trial record template

Each trial must retain:

- trial ID, date, objective, and hypothesis;
- corpus and gold-label version;
- source hashes and permitted data handling;
- implementation revision and dirty state;
- parser/model/runtime versions and configuration;
- hardware, browser, backend, and concurrency;
- metrics by document class and aggregate;
- routing confusion matrix and material failures;
- latency, memory, and cost;
- raw output and evaluator hashes;
- decision: reject, continue research, adopt behind a flag, or promote;
- limitations and the next falsifiable trial.

## Current sample classification

The `1-pager_Example.pdf` result is feasibility evidence only:

- `127 / 146` is **native-OCR association coverage** under the candidate algorithm, not labelled OCR or geometry accuracy;
- zero detected critical conflicts or omissions is bounded by the observations and candidates the implementation produced;
- the retained pages are unrotated, while rotation and transform handling currently have synthetic unit coverage;
- the Gemini image result is a separate image-understanding comparator and does not validate the PageSpatial merge;
- metrics without independent gold labels remain `not evaluated` under this rubric.


# Trial: table rows that bind values from different printed lines

**Date:** 2026-11-08

**Status:** closed

**Decision:** **ADOPT.** The projection no longer uses adapter (pdf-inspector)
table markdown when any table row holds numbers that no single printed line
carries. The page falls back to native lines and says why.

## Why

An OCR-routing write-up (Isaac Flath, "OCR model routing") showed its
largest model, Qwen, placing `8.2` and `9.8` on maturity 2046 instead of
2047. Every value was right; only the row was wrong. Token corroboration
cannot see that class of error.

PageSpatial's canonical record makes no row claims (each observation has its
own box), Flash proposals are single values, and chart relations are
already published as unverified with an ambiguity score. The one unchecked
row claim was the adapter table markdown in the projection, which is what
an index consumes.

## Measurement

Replay over the 162 stored pages (latest record per page across
`.evaluation/runs`) with `misboundTableRows` (`src/table-rows.ts`): a markdown
table row is misbound when it holds two or more numbers (two or more digits)
found in the native text, and no native line holds all of them.

| | count |
|---|---:|
| pages using adapter markdown | 148 |
| pages whose adapter markdown has tables | 56 |
| pages falling back | 29 |
| misbound rows | 81 |

A random sample of 25 flagged rows held almost exclusively real defects: printed rows
collapsed into one (`|LLR 5|2018|$75.0 $205.0|20.3 19.2%|…`), whole rows
of values in one cell, prose merged into cells, and scrambled-text tables on
World Bank pages. Borderline cases: a two-line header, and an OSF table
whose values are printed between two label rows, where geometry
cannot say which label they belong to. In both, falling back is the
conservative choice.

## Cost

Those 29 pages lose column structure in the projection; native lines keep
each printed line intact with evidence boxes. No schema change: the
fallback is visible as `markdownSource: pagespatial-native-lines` plus a
"Native table structure omitted" note in the markdown.

## Limits

A row that passes can still have wrong columns; the check proves only that
a row does not mix printed lines. Single-digit numbers are ignored.

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
`.evaluation/runs`) with `misboundTableRows` (`src/adapter-markdown.ts`): a markdown
table row is misbound when its value cells (cells without a word of two or
more letters) hold two or more numbers (two or more digits) found in the
native text, and no native line holds all of them.

| | first version (all cells) | adopted (value cells only) |
|---|---:|---:|
| pages using adapter markdown | 148 | 148 |
| pages whose adapter markdown has tables | 56 | 56 |
| pages falling back | 29 | **14** |
| misbound rows | 81 | **35** |

The first version counted numbers inside row labels. On mostly-good tables
(1 bad row in 10–21) the flags were largely false: a year in a wrapped
label (`… na dzień 1 stycznia 2025`) printed on another line than the
values, or a two-line header. Restricting to value cells removed those.
Every remaining flagged row collapses values from different printed rows:
`|LLR 5|2018|$75.0 $205.0|20.3 19.2%|…`, `(7 246,0) (3 937,4)`, whole rows
of values in one cell, scrambled-text tables on a World Bank page. One OSF
table prints values between two label rows, so geometry cannot say which
label they belong to; falling back is the conservative choice there.

Dropping only the bad rows was considered and rejected: their values would
vanish from the projection, and a table with one collapsed row usually
has its neighbours shifted too.

## Cost

Those 14 pages lose column structure in the projection; native lines keep
each printed line intact with evidence boxes. No schema change: the
fallback is visible as `markdownSource: pagespatial-native-lines` plus a
"Native table structure omitted" note in the markdown.

## Limits

A row that passes can still have wrong columns; the check proves only that
a row does not mix printed lines. Single-digit numbers are ignored. Tables
that are prose merged into cells (e.g. Ares p48, a 10-Q narrative page) mostly
pass, because their numbers sit in wordy cells; that is a different defect,
not caught here.

## Follow-up: two more adapter markdown defects

Two more failure modes of the pdf-inspector markdown, found while reviewing
the flagged rows, now trigger the same fallback (`adapterMarkdownDefects`).

**Words not in the native text.** On World Bank procurement plans the PDF
text layer is intact (`Activity Reference No. / Description`), but
pdf-inspector interleaves the letters of two tiny-font lines
(`ActivitD|yeRsecfreipre tinocne`). This is not a broken CMap, so the
letter-by-letter audit does not fire. Share of adapter-markdown words (Latin,
Cyrillic or Greek, 3+ letters) absent from the native text: the four World Bank
pages 17–48%, every other page under ~5% (a Japanese page reached 13% before
scripts without spaces were excluded). Cut-off: 10%.

**Prose in a table cell.** On narrative 10-Q pages (Ares p48) pdf-inspector
turns the whole page into one table: paragraphs in one cell, wrapped tail
lines pulled into the first column. Numbers are not misplaced, so the row
check passes it. Longest cell per page: prose-merged pages 47–377 words,
legitimate long cells (procurement descriptions, survey questions) at most 43.
Cut-off: 45 words.

| check | pages |
|---|---:|
| misbound row | 14 |
| prose in a cell | 11 |
| words not in native text | 4 |
| **any (fallback)** | **22 of 56 table pages** |

Both cut-offs were chosen on these 162 pages. The gaps around them are wide,
but recheck them on a fresh corpus.

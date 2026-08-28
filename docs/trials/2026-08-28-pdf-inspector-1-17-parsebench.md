# PDF Inspector 1.17 ParseBench experiment

Date: 2026-08-28

## Decision

Adopt exact `@firecrawl/pdf-inspector` 1.17.0 for the Linux worker. Version
1.15.0 is neutral on this cohort. Version 1.17.0 improves one difficult table
without a measured regression in the other four dimensions.

This decision is based on output quality. Native extraction timing is not part
of the claim because the retained extraction artifacts contain only three
rotated repeats. Gemini Semantic remains a separate experiment.

## Revisions and arms

- ParseBench: `72f8882174e175b5f4db401ff0cff8047054f46b`
- ParseBench test data: `68bbab242f749df2e2ef753daabcbbbe291d943e`
- 1.14.2: current control
- 1.15.0: latest documented GitHub release
- 1.17.0: latest exact npm package

GitHub publishes release notes through 1.15.0. npm also publishes 1.16.0 and
1.17.0. The npm 1.17.0 artifact names upstream git commit
`32555d23356f7892762a38edb3a5b0cad7ec326b`; that commit exists in the
`firecrawl/pdf-inspector` repository, but no matching GitHub tag or release
page existed when this experiment ran.

## Method

The cohort is the pinned ParseBench `data/test` set: 12 unique one-page PDFs,
three each for charts, layout, tables, and text. Content and formatting share
the text documents, producing 15 dimension cases.

Each arm called the same three PDF Inspector APIs used by PageSpatial:

- `extractPagesMarkdownAsync`
- `extractTextWithPositions`
- `extractStructureElements`

The comparison froze the existing PageSpatial OCR evidence, geometry, source
matches, and derived relations. It replaced only native structure Markdown,
then reran the committed deterministic adapter and ParseBench evaluator. The
adapter renders only explicit pipe-table headers. It does not infer that an
ordinary data row is a header and does not delete or promote rows.

The first sandboxed evaluator attempt was invalid because local multiprocessing
semaphores were unavailable. The valid runs had semaphore access and produced
fresh reports for every arm. The compact evidence manifest records hashes for
the raw extraction artifacts and evaluator reports; the large raw artifacts
remain outside git because they contain benchmark text.

## macOS arm64 results

| Headline dimension | 1.14.2 control | 1.15.0 | 1.17.0 |
| --- | ---: | ---: | ---: |
| Charts: Data Point Match | 0.00% | 0.00% | 0.00% |
| Tables: GTRM composite | 22.78% | 22.78% | **36.06%** |
| Content Faithfulness | 88.05% | 88.08% | 88.08% |
| Semantic Formatting | 36.53% | 36.53% | 36.53% |
| Visual Grounding: Element Pass Rate | 11.78% | 11.78% | 11.78% |
| Unweighted five-dimension mean | 31.83% | 31.83% | **34.49%** |

The table gain is localized. On
`SERFF_Interstate_random_pages 1_page276`, 1.14.2 flattened the table into two
large cells. Version 1.17.0 recovered the heading and nine key-value rows. Its
GriTS content score increased from 0.0808 to 0.8781. The other two table cases
were unchanged. Table-record match remained zero in the strict evaluator; this
is a content and row-structure improvement, not complete record recovery.

Version 1.15.0 changed three of 12 Markdown outputs through small
de-hyphenation changes. Version 1.17.0 changed four: the same three cases plus
the actuarial table. Three rotated repeats per arm produced identical Markdown
hashes, text-item counts, and structure-element counts.

Evidence:
`docs/trials/evidence/2026-08-28-pdf-inspector-parsebench-macos.json`.

## Compatibility gate

A clean archive installed exact 1.17.0. The branch then passed TypeScript
compilation, the repository checks, Modal unit tests, and Modal integration
tests. Exact current counts belong to the PR checks rather than this record.

## Linux x86-64 and live object-path gate

The clean Modal worker used committed revision `78e7869d0ae7`, image pin
`535bed0b1547`, Linux x86-64, and exact PDF Inspector 1.17.0. All 12 cohort
documents completed. After the same leading/trailing whitespace normalization
used by the committed adapter, native PDF Inspector Markdown matched the macOS
1.17.0 arm on all 12 pages.

| Headline dimension | macOS arm64 | Linux x86-64 |
| --- | ---: | ---: |
| Charts: Data Point Match | 0.00% | 0.00% |
| Tables: GTRM composite | 36.06% | 36.06% |
| Content Faithfulness | 88.08% | 87.80% |
| Semantic Formatting | 36.53% | 36.53% |
| Visual Grounding: Element Pass Rate | 11.78% | 11.78% |
| Unweighted five-dimension mean | 34.49% | 34.44% |

The small content difference is not a PDF Inspector parity failure. The
ParseBench projection also includes unmatched OCR evidence from the full
PageSpatial worker, and that evidence can vary across platforms. The isolated
native PDF Inspector Markdown is byte-identical after the adapter's documented
whitespace normalization; the normalized byte strings match on all 12 pages.

The existing live object-path qualification also passed on the clean worker:

- direct-versus-R2 and repeat execution matched at zero tolerance across 402
  critical tokens and 724 raw lines;
- duplicate executions wrote distinct immutable result keys and both were
  recoverable by prefix LIST;
- the wrong-digest probe published no result; and
- all five forbidden cross-role R2 operations returned `AccessDenied`.

The harness removed every test object. Compact evidence and hashes are in
`docs/trials/evidence/2026-08-29-pdf-inspector-parsebench-linux.json`.

No production app is changed by this experiment.

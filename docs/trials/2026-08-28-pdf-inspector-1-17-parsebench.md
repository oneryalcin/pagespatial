# PDF Inspector 1.17 ParseBench experiment

Date: 2026-08-28

## Decision

Adopt exact `@firecrawl/pdf-inspector` 1.17.0 for the Linux worker. Do not adopt
1.15.0: it is neutral on this cohort. Version 1.17.0 materially improves one
difficult table and cuts native extraction time without a measured regression
in the other ParseBench dimensions.

The macOS arm64 scoring result is now backed by a Linux x86-64 Modal image and
the existing live R2 object-path qualification. This record does not claim a
new service-throughput result or a production deployment: the qualified app
was the isolated `pagespatial-parse-m6-dev` app.

## Versions

The PageSpatial Node dependency is now pinned to 1.17.0. GitHub publishes
release notes through 1.15.0. npm also publishes 1.16.0 and 1.17.0. The npm 1.17.0
artifact names upstream git commit
`32555d23356f7892762a38edb3a5b0cad7ec326b`; that commit exists in the
`firecrawl/pdf-inspector` repository, but there is no corresponding GitHub tag
or release page as of this experiment.

The tested arms were:

- 1.14.2: current control
- 1.15.0: latest documented GitHub release
- 1.17.0: latest exact npm package

## Method

The cohort was the pinned ParseBench `data/test` set: 12 unique one-page PDFs,
three each for charts, layout, tables, and text. Content and formatting share
the text documents, producing 15 dimension cases.

Each version called the same three APIs used by PageSpatial's Node adapter:

- `extractPagesMarkdownAsync`
- `extractTextWithPositions`
- `extractStructureElements`

The ParseBench comparison froze the existing PageSpatial records, OCR evidence,
geometry, source matches, and derived relations. It replaced only the native
structure Markdown and reran the deterministic adapter projection and
ParseBench evaluation. No Modal inference call or new OCR pass occurred.

The 1.14.2 reconstruction reproduced the accepted baseline, including the
41.22% table composite. This was the control gate for the treatment scores.

The first sandboxed evaluator attempt was invalid: ParseBench's category loop
continued after local multiprocessing semaphore failures and returned zero.
The reports were absent. The valid runs gave the evaluator its required local
semaphore access, produced all five reports, and reproduced the control.

## ParseBench results

| Headline dimension | 1.14.2 control | 1.15.0 | 1.17.0 |
| --- | ---: | ---: | ---: |
| Charts: Data Point Match | 0.00% | 0.00% | 0.00% |
| Tables: GTRM composite | 41.22% | 41.22% | **54.50%** |
| Content Faithfulness | 88.05% | 88.08% | 88.08% |
| Semantic Formatting | 36.53% | 36.53% | 36.53% |
| Visual Grounding: Element Pass Rate | 11.78% | 11.78% | 11.78% |
| Unweighted five-dimension mean | 35.51% | 35.52% | **38.18%** |

The table gain is localized and intelligible. On
`SERFF_Interstate_random_pages 1_page276`, 1.14.2 flattened the table into two
large cells. Version 1.17.0 recovered the heading and nine key-value rows. Its
GriTS content score increased from 0.0808 to 0.8781. The other two table cases
were unchanged. Average table-record match remained 0.3333; the improvement is
content and row structure, not a claim that all table records are complete.

Version 1.15.0 made small de-hyphenation changes to three documents but produced
no material headline change. Version 1.17.0 changed four of 12 Markdown outputs:
the same three de-hyphenation cases plus the recovered actuarial table. Five
repeat passes per version produced identical Markdown hashes, text-item counts,
and structure-element counts.

## Native extraction timing

Timing covers all three PDF Inspector API calls for the 12 one-page PDFs. It is
not full PageSpatial latency and excludes PDF.js geometry, OCR, reconciliation,
and Modal startup. Twenty rotated rounds were run per version; the table reports
warm rounds 2 through 20.

| Version | Warm median per 12-document round | p10-p90 | Change from control |
| --- | ---: | ---: | ---: |
| 1.14.2 | 175.1 ms | 173.4-176.3 ms | control |
| 1.15.0 | 177.4 ms | 173.3-180.3 ms | +1.3% |
| 1.17.0 | **76.1 ms** | 74.3-77.5 ms | **-56.5%** |

The gain is concentrated in two complex pages. This is consistent with the
upstream changes between the 1.15 commit and the npm 1.17 commit, including
per-page line-based table extraction and table-layout fixes. It must not be
extrapolated to full-document service throughput without a Linux worker run.

## Compatibility gate

A clean archive of PageSpatial `HEAD` installed exact 1.17.0 and passed the
initial compatibility gate. The dependency was then pinned in the working tree
and the current tree passed:

- TypeScript compilation
- 380 core tests; zero failures and two environment-gated skips
- 108 API tests; zero failures and two native-Postgres skips
- schema-current verification
- 37 Modal unit tests
- 21 Modal integration tests

## Linux/Modal object-path qualification

The isolated Linux x86-64 worker was rebuilt and deployed as
`pagespatial-parse-m6-dev` with one maximum container and memory snapshots
disabled. The image pin was `ee110672752b`; the adapter identified the dirty
experimental tree as `e439637ca4ac-dirty`. The deployment completed in 166.3
seconds, including a 138.5-second rebuild of the 2.4 GB base image.

The existing qualification used the three-page World Bank witness with SHA-256
`a2878cd9feaae81354b195463d76296ccb41d73c46462b6e5262bd0e7ecc667e`.
It passed all gates:

- two direct controls established zero tolerance
- direct-versus-object parity passed with 397 OCR-derived critical tokens and
  715 raw lines compared; both deltas were zero
- the repeated object result passed at the same zero tolerance
- both object executions returned `completed`, used distinct immutable result
  keys, and were recovered by prefix LIST
- the wrong-digest request returned the typed failure and published no result
- all five cross-role credential probes returned `AccessDenied`
- the harness deleted the input and result objects after verification

The first direct call reported 70,122 ms of cold service readiness and 6,216 ms
of parse time. The warm direct call reported 4,040 ms of parse time. The two
R2-backed calls reported total method times of 5,967 ms and 4,686 ms,
respectively. These are one shared-infrastructure lifetime on a three-page
witness, not a throughput benchmark or an SLA.

The retained evidence is under
`.evaluation/service-m1-object/b2c9820b-d58b-48e5-af98-de399b717d01/`.
Gemini Semantic remains a separate later experiment; this result qualifies the
deterministic Basic path only.

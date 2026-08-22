# dev-v13: the sidecar-era reference baseline

**Date:** 2026-08-23 · **Branch:** `dev-v13-baseline` · **Closes:** the standing
era item from the witness adoption (#2)

The first full corpus run through the adopted witness path, frozen as the
reference every future sidecar-era measurement compares against. dev-v12
remains the browser-era reference; **cross-era comparisons are valid at gold
level only** — the diagnostics section below is published as the swap's
fingerprint, explicitly *not* as regressions.

## The run

`dev-v13-sidecar-2026-08-23`, **162/162 pages, 0 failures**, authenticated:
`implementation.dirty: false` at commit `04c2043`, corpus dataset revision
pinned, per-document SHA-256s recorded, and the witness pinned in every
record's provenance:

| field | value |
|---|---|
| ocrAdapter | `ppocrv6-small-sidecar@3.7.0#ep=paddle-default;threads=1` |
| nativeAdapter | `pdf-inspector-markdown-pdfjs-geometry@1.14.2+pdfjs.5.5.207` |
| model pins | det `106c9759…` (ceremony-observed), rec `bd619643…` |
| host | Apple M4 Max |

**Host caveat, stated up front:** this baseline was cut on macOS, where the
sidecar truthfully records `ep=paddle-default` rather than Linux's OpenVINO.
That is a *speed* difference, not a reading one — the HPI benchmark measured
HPI and default as accuracy-identical (engine changes speed, not output), and
the integration sanity check scored 438/438 against the ceremony. Target-
hardware throughput re-measurement remains a deploy-time task; it does not
affect this baseline's records.

Era differences by design, all service-path properties rather than choices
made here: no region recovery and no unread-ink analysis (both are
browser-harness render-side features), pdftoppm rendering at pdf.js-parity
fractional dpi, and the pinned Python sidecar as the OCR witness.

## Gold-level comparison (the valid cross-era one)

Same evaluator, same gold, both run roots — 1,191 human-verified tokens
across six batches:

| run | gold hits | missed by both |
|---|---|---|
| dev-v12 (browser witness **+ recovery layer**) | 1,147 (96.3%) | 44 |
| dev-v12, first-pass only (recovery stripped) | 1,136 (95.4%) | 55 |
| **dev-v13 (sidecar, no recovery)** | **1,129 (94.8%)** | **62** |

The 18-token gap against dev-v12 decomposes into two unrelated causes, which
is why it is reported split rather than as one number:

- **−11 tokens: the absent recovery layer.** dev-v12 carries 4,322
  recovery observations from the browser harness's zoom-retry pass; the
  service path has no such stage. Stripping recovery from dev-v12 and
  re-running the *unmodified* evaluator reproduces this exactly (44 → 55).
  This is an architecture gap, not a witness property — and it is the
  actionable finding of this baseline: **region recovery is worth ~0.9pp of
  gold recall and does not exist server-side** (issue #10/#13 territory).
- **−7 tokens (−0.59%): the witness swap itself**, first-pass vs first-pass.
  Consistent with the adoption ceremony's bound (candidate-worse ≤0.74% of
  gold at 95%) and with its finding that the two witnesses are statistically
  indistinguishable; this is the expected size of that residual, not a new
  signal.

Per-batch detail (missed-by-both counts): pilot 6/11/13, batch2 18/20/21,
batch3 5/8/9, batch4 10/11/14, batch5-clean 3/3/3, batch7-clean 2/2/2 for
v12 / v12-first-pass / v13 respectively. batch7-clean's 2 are the known
sign-glue scoring artifacts, unchanged across eras as expected.

## Instrument fingerprint (NOT regressions — cross-era diagnostics are invalid)

| metric | dev-v12 | dev-v13 | note |
|---|---|---|---|
| nativeObservations | 17,393 | **17,393** | identical — the native witness did not change |
| ocrObservations | 19,434 | 15,132 | v12 includes 4,322 recovery obs; first-pass 15,112 vs 15,132 = **20 apart (0.13%)** |
| sourceMatches | 12,600 | 12,280 | |
| criticalConflicts | 470 | 454 | |
| pagesRequiringEscalation | 107 | 95 | |
| association coverage (mean / p50) | 0.609 / 0.676 | 0.742 / 0.901 | fewer fragmented OCR observations associate more cleanly |

Two of these deserve emphasis. **Native observations are byte-identical
across eras** — a strong internal check that only the OCR witness moved. And
the two witnesses' *first-pass* OCR observation counts differ by 20 out of
~15,100 (0.13%), independently corroborating the ceremony's equivalence
finding from a completely different direction.

Escalation dropping 107 → 95 pages must not be read as improvement: with no
recovery stage and cleaner association, different pages cross different
thresholds. That is the fingerprint. Any claim about escalation behaviour
belongs to within-era comparisons against this baseline, not across it.

## What this baseline is for

From now on, sidecar-era measurements compare against **dev-v13**. dev-v12
stays in the record as the browser-era reference; crossing the line is
allowed at gold level only, because human-verified tokens are
instrument-independent. Both eras' backends are machine-checkable in the
committed summaries (`backend: {webgpu: 162}` vs `{paddle-default: 162}`),
so the boundary needs no tribal knowledge.

Committed summary: `evaluation/baselines/dev-v13-sidecar-2026-08-23.summary.json`
(generated by the existing `generate-baseline-summary.mjs`, whose fail-closed
artifact-graph walk verified the run unchanged from the browser era).

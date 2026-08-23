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
`implementation.dirty: false` at commit `04c2043` — and the recorded
workspace hash reproduces byte-for-byte from `git archive` of that commit, so
cleanliness is verified, not asserted. Corpus dataset revision pinned,
per-document SHA-256s recorded, and the witness pinned in every page
envelope's provenance (not merely in the run invocation):

| field | value |
|---|---|
| ocrAdapter | `ppocrv6-small-sidecar@3.7.0#ep=paddle-default;threads=1` |
| nativeAdapter | `pdf-inspector-markdown-pdfjs-geometry@1.14.2+pdfjs.5.5.207` |
| model pins | det `106c9759…` (independently observed in the adoption ceremony); rec `bd619643…` (pinned post-ceremony — the ceremony captured no rec revision — and behaviourally validated by the integrated-path sanity check, 438/438) |
| host | Apple M4 Max |

Model weights are content-verified at boot (per-file SHA-256 in
`service/sidecar/model-pins.json`; the adapter refuses to construct on
mismatch), and those files are tracked, so they sit inside the workspace
hash.

**Known authentication gap, inherited from the browser era:** the workspace
hash covers tracked files only, and `dist/` — which is what actually executes
— is gitignored. A stale or hand-edited `dist/` would still record
`dirty: false`. Not introduced here and not exercised by this run, but it is
the last hole in a run whose selling point is authentication (issue #72).

Era differences by design, all service-path properties rather than choices
made here: no region recovery and no unread-ink analysis (both are
browser-harness render-side features), pdftoppm rendering at pdf.js-parity
fractional dpi, and the pinned Python sidecar as the OCR witness.

### Host and execution provider

This baseline was cut on macOS, where the sidecar truthfully records
`ep=paddle-default`; production targets Linux/OpenVINO (`ep=hpi`). The
evidence that EP does not change *records* is weaker than "identical": the
HPI benchmark scored 409 (HPI) vs 413 (default) gold hits of 560 and
explicitly labels itself a case series over 32 system-conditioned pages, and
the ceremony measured output stability at **~±4 tokens across containers, not
bit-stable**. Four tokens on 560 is the same order as the −7 this baseline
attributes to the witness swap.

**Era rule that follows:** an `ep=hpi` run must carry a same-host EP control
before its *diagnostics* are compared against this `paddle-default`
reference. The committed summary's `backend: {paddle-default: 162}` makes the
condition machine-checkable.

## Gold-level comparison (the valid cross-era one)

Same evaluator, same gold, both run roots — 1,191 human-verified tokens
across six batches. **These are case-series rates, not population rates:**
the gold *pages* were selected by the sampler's debt tiers (`starved` =
fired uncorroborated-ocr, `conflict`, `pictorial`) for pilot–batch4, and by
the inverse `--profile clean` — selected *because* nothing escalated — for
batches 5 and 7; all against browser-era run roots
(`exp-second-opinion-d` for batches 3–5, dev-v12 for batch 7). Both
directions read the system under test, per the principles §8 checklist. The *token proposals* within those pages are
extractor-blind (proposed from the rendered image), and — decisively for what
follows — the same denominator is applied to both eras, so the **deltas** are
sound even though the absolute percentages are conditioned.

| run | gold hits | missed by both |
|---|---|---|
| dev-v12 (browser witness **+ recovery layer**) | 1,147 | 44 |
| dev-v12, first-pass only (recovery stripped) | 1,136 | 55 |
| **dev-v13 (sidecar, no recovery)** | **1,129** | **62** |

The 18-token gap against dev-v12 decomposes into two unrelated causes, which
is why it is reported split rather than as one number:

- **−11 tokens: the absent recovery layer.** dev-v12 carries 4,322 recovery
  observations from the browser harness's zoom-retry pass; the service path
  has no such stage. Stripping recovery from dev-v12 and re-running the
  *unmodified* evaluator reproduces this exactly (44 → 55 missed). This is an
  architecture gap, not a witness property — and it is the actionable finding
  of this baseline: **region recovery is worth ~0.9pp of gold recall and does
  not exist server-side** (issue #10/#13 territory).
- **−7 tokens (−0.59% of these 1,191 union-recall tokens): the witness swap
  itself**, first-pass vs first-pass.

### Why the −7 is attributable to the reader, not the camera

Asserting that split needs a control, because renderer, host and execution
provider all changed alongside the witness. Two facts from the runs
themselves supply it:

- **Page geometry is identical on all 162 pages** (same render scale, pixel
  dimensions and viewport transform in both eras).
- **The Tesseract second opinion ran on the same 27 pages in both eras and
  its readings are byte-identical on all 27.** A *fixed* reader consuming the
  two rasters produced exactly the same output — which is as close to a
  camera-fixed control as an after-the-fact comparison can get.

The renderer confound is therefore empirically dead, and the residual belongs
to the OCR witness.

Deliberately *not* claimed here: that −0.59% is "consistent with the adoption
ceremony's ≤0.74% bound". That bound measures OCR-only token discordance
against the browser witness, while −0.59% is a union (native ∨ OCR) recall
delta buffered by the native channel — different quantities on different
scales. The two also run over the *same* 90 pages, so quoting one as
corroboration of the other would dress a re-measurement up as an independent
sample.

Per-batch missed-by-both counts (v12 / v12-first-pass / v13): pilot 6/11/13,
batch2 18/20/21, batch3 5/8/9, batch4 10/11/14, batch5-clean 3/3/3,
batch7-clean 2/2/2. batch7-clean's 2 are the known sign-glue scoring
artifacts, unchanged across eras as expected.

## Instrument fingerprint (NOT regressions — cross-era diagnostics are invalid)

The same decomposition discipline the gold table uses applies here: two of
these rows are contaminated by recovery observations sitting in dev-v12's
denominator, so the like-for-like column is the one that means anything.

| metric | dev-v12 (all) | dev-v12 first-pass | dev-v13 | like-for-like reading |
|---|---|---|---|---|
| nativeObservations | 17,393 | 17,393 | 17,393 | unchanged — see below |
| ocrObservations | 19,434 | 15,112 | 15,132 | **20 apart of ~15,100 (0.13%)** |
| sourceMatches | 12,600 | 12,277 | 12,280 | **3 apart** — the apparent −320 is recovery |
| association coverage (mean / p50) | 0.609 / 0.676 | 0.743 / 0.902 | 0.742 / 0.901 | **unchanged** — the apparent improvement is entirely recovery in v12's denominator |
| criticalConflicts | 470 | 470 | 454 | −16, a genuine first-pass difference (no v12 conflict arises from a recovery observation) |
| pagesRequiringEscalation | 107 | — | 95 | −12 |

p50 cells use `generate-baseline-summary.mjs`'s own `percentile()`
(`sorted[min(len-1, ceil(len·r)-1)]`), so the v12 column matches that
summary's committed `associationCoverageDiagnostic.p50` exactly; a
re-checker using a different median convention will land a cell or two away.

Two rows deserve emphasis, stated precisely:

- **Native observations are unchanged in count, text, geometry and identity**
  (17,393 in both eras) — a strong internal check that only the OCR witness
  moved. They are *not* byte-identical: 8,725 of them differ in the `font`
  field, which carries pdf.js's session-local resource labels (`g_d0_f2` vs
  `g_d18_f2`). Nothing in the pipeline compares that field; it is metadata,
  not evidence. Anyone re-verifying this claim with a naive byte comparison
  will see a false alarm, hence the precision.
- **The two witnesses' first-pass OCR observation counts differ by 20 out of
  ~15,100 (0.13%)**, independently corroborating the adoption ceremony's
  equivalence finding from a completely different direction.

Escalation dropping 107 → 95 pages must not be read as improvement. With no
recovery stage, different pages cross different thresholds — and note that
association coverage, which one might expect to explain it, is *unchanged*
like-for-like. Any claim about escalation behaviour belongs to within-era
comparisons against this baseline, not across it.

## What this baseline is for

From now on, sidecar-era measurements compare against **dev-v13**. dev-v12
stays in the record as the browser-era reference; crossing the line is
allowed at gold level only, because human-verified tokens are
instrument-independent. Both eras' backends are machine-checkable in the
committed summaries (`backend: {webgpu: 162}` vs `{paddle-default: 162}`), so
the boundary needs no tribal knowledge.

Committed summary: `evaluation/baselines/dev-v13-sidecar-2026-08-23.summary.json`
(generated by the existing `generate-baseline-summary.mjs`, whose fail-closed
artifact-graph walk verified the run unchanged from the browser era —
regenerating a browser-era summary with this branch's generator reproduces
the committed file in every field but the generator's own self-hash, which
necessarily differs because the generator hashes itself). Re-running the
generator on this run root reproduces the committed v13 summary byte for
byte under generator hash `6138f990…`; a future change to the generator
must regenerate the summaries it invalidates, or that property lapses
silently.

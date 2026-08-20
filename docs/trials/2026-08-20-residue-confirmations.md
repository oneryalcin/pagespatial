# Residue honesty: confirmations and text-capable geometry

**Date:** 2026-08-20 · **Branch:** `residue-confirmations` · **Issue:** #14

## The problem

After PR #12 merged, the blocking `unread-ink-region` escalation fired on
82 of 162 corpus pages. An alarm that fires half the time is not an alarm —
consumers learn to route around it, and the genuinely unreadable page then
slips through with everyone desensitized. Escalation precision is this
library's first-class economic metric; a devalued flag is the worst
available failure.

Inspection showed two distinct noise populations, each with its own honest
cure — and a hard constraint over both: after the three-reviewer fixes,
residue is *derived* from evidence in the record (forgery-proof), and any
cure had to preserve that.

## Cure 1 — confirmation receipts (schema 0.5.0)

Population: solid filled table-header bars whose white text both witnesses
had already read. The ink mask flags the fill extending past the text's
read boxes; recovery re-reads the bar, produces the same text, dedup
correctly discards the duplicate — and the region alarms on "nothing
recovered". The alarm fired precisely when the system re-confirmed what it
already knew.

Design: recovery now returns **confirmation receipts** — the `{box, text}`
of readings it dropped as duplicates of existing evidence. Receipts attach
to the region each overlaps most and are **self-verifying**: a confirmation
only counts when it actually duplicates a retained first-pass observation
(same place, same reading — the `duplicatesFirstPass` rule). A forged
receipt must therefore match real evidence at that location, which would
make the region genuinely corroborated; a receipt matching nothing fails
schema validation outright. The forgery-proof invariant survives intact.

A structured region with zero recoveries but valid confirmations is
corroborated (typically fill around read text) and does not escalate.

## Cure 2 — text-capable geometry (`INK_RESIDUE_MIN_SIDE_PT = 8`)

Population: drawn divider rules and underlines — 450–920px wide, ~10px
(~6pt) tall strips whose ink is fully explained by the stroke itself. A
region physically too thin to hold legible text cannot be an evidence
desert.

The blocking reason now additionally requires the region's narrow side to
be at least 8pt. Deliberately *not* a detection change: the strip is still
detected, still re-read at 4× zoom (real tiny text keeps its second chance
— anything found records as recovery or confirmation), and still on the
record. Only the nothing-found alarm needs text-capable geometry. One
shared `regionEligibleForResidue()` keeps diagnostics and schema identical.

## Results (162 pages, small tier, recovery on)

| | before | confirmations | + geometry |
|---|---|---|---|
| residue pages (blocking) | 82 | 72 | **18 (11%)** |
| true-desert regions | — | 132 | **24** |
| gold recall (28 verified pages) | 461/468 | 461/468 | 461/468 |

The 24 surviving regions are the population the alarm exists for: 20–70px
bars and blocks that could hold text and where nothing was read — including
solid dark bars (blackstone p12/13/15) whose text the first pass missed
entirely. blackstone p17's header bars now carry their receipts
(`Real`/`Estate`/`Total`) and no longer alarm.

## Contract changes

- schemaVersion **0.5.0**; 0.4.0 records rejected by version.
- `UnreadInkRegion.confirmations: {box, text}[]` (required; empty allowed).
- `recoverPage` returns `{ observations, confirmations }`.
- Blocking residue = structured ∧ narrow side ≥ 8pt ∧ zero recoveries ∧
  zero valid confirmations.
- Pictorial regions may not carry confirmations.

## What stays open (issue #14)

The pictorial-threshold question is untouched and remains data-gated on
gold extension (#1). The per-page tile budget is #13.

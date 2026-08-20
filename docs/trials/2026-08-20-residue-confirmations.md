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
to the region each overlaps most and are **self-verifying**: validation
re-derives, from the record alone, that each receipt (a) has a positive,
in-page box, (b) attributes to the region it is stored on by the same
largest-overlap rule the parser used, (c) duplicates a retained first-pass
observation — same place, same reading, AND agreeing critical tokens (a
re-read differing in one digit is new evidence, never a confirmation), and
(d) consumes a distinct retained observation (one observation backs at
most one receipt). The parser prunes receipts through the identical
derivation before assembly, so a misbehaving adapter cannot produce an
invalid record. Two independent adversarial reviews attacked this property
(copied-from-elsewhere receipts, zero-area boxes, receipt reuse,
critical-token near-misses); each attack is now a regression test.

Honest scope note: this guards the record's *internal consistency* — you
cannot clear the alarm while leaving the region honestly recorded. An
editor willing to delete or relabel the region itself is out of scope:
regions derive from a raster that is not in the record, so nothing can
re-derive their existence.

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

## Geometry contract hardening

The reviews also surfaced that every point-denominated heuristic assumes
one scalar pixels-per-point. `assertPageGeometry` now rejects anisotropic
and sheared viewport transforms outright (conformal-only), rather than
letting physical-size gates silently skew on one axis.

## What stays open (issue #14)

The pictorial-threshold question is untouched and remains data-gated on
gold extension (#1). The per-page tile budget is #13.

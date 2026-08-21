# Deterministic SVG reconstruction (issue #51)

**Date:** 2026-08-22 · **Branch:** `svg-reconstruct-51`

`reconstructSvg(page)` re-renders a page from its PageSpatial record alone
— no PDF access, no inference, identical bytes for identical records. The
acid test of the format: anything visible on the PDF but absent from the
SVG is something the record failed to capture.

## What it draws (everything from the record, nothing else)

- Native observations as ink-colored text at their recorded boxes; font
  size derived from box height; over-long lines compressed with
  `textLength` (never stretched).
- OCR observations only when NOT source-matched to a native reading
  (a matched duplicate is corroboration, already placed by the native
  drawing), in a muted blue.
- Conflicted observations outlined dashed red — both disputed readings
  visible.
- Unread-ink regions as hatched labeled placeholders (structured /
  corroborated / pictorial distinguished from record fields).
- `secondOpinion` readings excluded by default (unauthenticated per the
  honest-scope note); `includeSecondOpinion: true` draws them labeled.
- A legend generated only from states actually present on the page.

Coordinate space is **rendered pixels** (`geometry.width × height`) —
the space every box on the record lives in, post-rotation, so no rotation
math exists to get wrong (the 90° crop bug shape). Point dimensions are
provenance, not drawing input; a regression test pins this with a
landscape-rotated fixture.

## Real example (monotaro p61, dev-v12)

252 native + 299 OCR observations, 2 conflicts, 11 unread-ink regions.
Rendered SVG (kept out of git — corpus text): the KPI dashboard is fully
recognizable — every chart's value labels and year axes in position,
section headers, the chart bodies themselves as labeled hatched regions
(bars are pictorial ink the engines don't read — honestly absent, not
faked), conflicts dash-outlined on the exact disputed numbers.

Honest fidelity notes:

- **What carries:** all recorded text at true positions; spatial grouping
  (which number belongs to which chart/year); trust states at a glance.
- **The stated ceiling:** no fonts, colors, images, bars, or vector art —
  the record does not store look, so the reconstruction cannot have it.
- **An honest artifact, not a bug:** where the witnesses read the same
  header but were not source-matched, both texts draw and visibly smear.
  That doubling is the association coverage made visible — the SVG shows
  the record's actual state, which is the point.

## Independence note (principles §8)

This is a rendering of stored evidence, not a measurement — no
denominator, no rate. If it is ever used as an eval (e.g. human compares
SVG to PDF), the comparison protocol needs its own five-question pass.
LLM-based reconstruction remains out of scope: fidelity an LLM adds
beyond the record would be hallucination.

# PageSpatial dashboard visual direction

**Decision:** Ivory Ledger

**Accepted:** 2026-08-27

Ivory Ledger is the M3 visual direction. It uses warm ivory surfaces, ink
text, compact ledger-like tables, a restrained green action colour, and a
small apricot registration mark in the wordmark. Red is reserved for failure.
The dashboard is a customer product, not an infrastructure console.

The canonical visual reference is
[`assets/2026-08-27-dashboard-jobs-concept-v2.png`](assets/2026-08-27-dashboard-jobs-concept-v2.png)
plus the written
[`dashboard product brief`](2026-08-27-dashboard-product-brief.md). The image
shows hierarchy and tone; the written brief controls behavior and data
semantics.

## Rules

- Use system fonts, warm neutral surfaces, fine borders, low-radius panels,
  ordinary underlined links, and static status marks.
- Use monospace only for machine values such as identifiers, secrets, and
  money.
- Keep red exclusive to failed states. Use green for actions and links,
  ochre for waiting states, and dark green for in-progress states.
- Unknown pages and cost render as an em dash. Never invent progress, cost,
  filenames, provider state, or infrastructure metadata.
- Use ordinary GET filters with an explicit Apply button. M3 has a fixed 25
  rows per page; the selector shown in the concept is not a feature.
- Mobile uses labelled records instead of a compressed table. Controls and
  links must remain keyboard accessible and have visible focus.
- Use no JavaScript, SPA framework, chart library, remotely hosted font,
  analytics script, or external stylesheet in M3.
- Do not add gradients, neon, glow, large KPI cards, pastel status pills,
  charts, side rails, or grouped administration menus.

## Rejected directions

Earlier dark console and generic enterprise-dashboard studies are not M3
implementation references. They remain outside the committed product record
because the owner selected Ivory Ledger before implementation.

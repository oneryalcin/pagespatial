# Design: selective OCR ("auto" mode) without losing precision

**Date:** 2026-11-07 · **Status:** proposal, not built

## Product requirement (owner, 2026-11-07)

> PageSpatial promises good precision and explainability. If a middle ground
> doesn't compromise this, we can have some auto mode. But it's especially
> important to fetch the stuff in charts, tables, etc.

Today every page is read twice, native text layer and OCR, and the two are
compared. OCR is about 80% of page time, and most of that is recognizer calls,
one per text line ([attribution](../trials/2026-11-07-ocr-time-attribution.md)).
An auto mode saves time only by skipping recognizer calls. This design skips
them only where the record can still say exactly why the value is trusted.

## Guarantee

Every value in the record is either **corroborated by both witnesses**, or
carries an **explicit label naming why OCR did not read it** and which evidence
stands in. No value is trusted silently.

## Mechanism

1. **The detector runs on every page.** It costs about 17% of OCR time,
   gives independent geometry, and keeps the unread-ink analysis
   (`src/ink.ts`) unchanged. Skipping happens per detected box, at the
   recognizer.
2. **Always recognize**:
   - pages with little or no native text (scans), and pages pdf-inspector
     routes to OCR (`ocrReasonsByPage`, e.g. `suspected_garbled_text`);
   - every box not mostly covered by native text: charts, images,
     vector-drawn text and image tables. Chart and table reading is
     therefore unchanged;
   - every box whose native text contains a critical (digit-bearing) token,
     per `criticalTokens` in `src/text.ts`. Every number, including every
     digital table cell, stays two-witness.
3. **Font audit for the rest.** Text-layer corruption is per font and per
   glyph (a broken or missing ToUnicode/CMap; see
   [2026-08-20 CMap root cause](../trials/2026-08-20-unread-ink-recovery-and-cmap-root-cause.md)).
   Per document and per font, pick audit lines greedily so they cover every
   glyph that font uses in the document, and recognize them. Any
   disagreement means recognizing every box in that font. If the audit
   passes, the remaining digit-free boxes in that font are labelled
   `corroboration: font-audited` with pointers to the audit observations.
4. **Ink check on skipped boxes.** A cheap luminance test that the native box
   actually has painted ink catches white or hidden text and glyphs that
   render as nothing.
5. **Invisible OCR layers count as scans.** Scanned PDFs often carry an
   invisible text layer made by some earlier OCR tool. It looks sane but is
   unverified machine OCR. A page whose ink is mostly one image while native
   text exists is OCR'd in full. The detection signal is still to be chosen:
   pdf.js text render mode 3, or an image covering most of the page.

## Expected gain

On the 162 pages of the 23 evaluation PDFs (pypdfium2 text lines, as an
approximation of detector boxes), 130 pages have a text layer. On those
pages, digit-free lines are 60% of lines and **55% of recognizer characters**.
That is the ceiling before audit lines are subtracted. It is very uneven:
memos and reports are 90%+ skippable, while financial table pages such as
Blackstone 2026 Q1 are only 14%. The 32 scan or image-only pages save
nothing. The gain multiplies with the Tiny-recognizer candidate.

## Acceptance gate (before building beyond a prototype)

Using existing baselines and gold:

- every native/OCR conflict and every `wrong` or `edited` gold token in the
  current full-OCR baselines lands in a box selective mode would still
  recognize. Critical-token conflicts are 100% by construction; measure and
  report the prose-conflict miss rate;
- the skip share and pages/s on the same corpus.

Changing witness coverage starts a new baseline era if adopted.

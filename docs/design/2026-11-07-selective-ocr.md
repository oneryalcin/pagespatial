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

## Replay against existing full-OCR runs (2026-11-07)

[`scripts/evaluation/selective_ocr_replay.py`](../../scripts/evaluation/selective_ocr_replay.py)
applies the skip rule retroactively to every OCR box in a run's records,
deciding from native evidence only, as a live mode would before
recognition. Final rule, coverage ≥ 0.6: skip recognition only when the page
has a usable native layer, native boxes cover the detector box, and no
native **line** touching the box contains a Unicode numeral, or a control,
private-use, unassigned or replacement character. Recovery-pass reads always
run. The font audit is not simulated.

The rule was refined three times on dev-v12, so dev-v12 is the tuning set:

1. Checking only native fragments inside the box missed digits just outside
   it, such as margin line numbers and trailing table values. The fix was to
   check the whole native line.
2. ASCII `\d` missed circled numerals (❷, ①). The fix was any Unicode
   numeral.
3. A broken subscript (`CO\x16` for CO₂) passed. The fix was to treat
   control, private-use and unassigned characters as suspicious.

| Run (162 dev pages each) | OCR text skipped | Conflicts whose OCR box is skipped | Real native errors among them |
|---|---:|---:|---:|
| dev-v12 (tuning set) | 36.4% | 1 of 470 | 0 |
| dev-v13 (server sidecar) | 43.3% | 1 of 454 | 0 |
| dev-v10 | 42.4% | 7 of 627 | 0 |
| dev-v7 | 42.4% | 5 of 449 | 0 |

Every skipped conflict was OCR inventing a digit while the native text was
right: `(i)` → `(1)`, `$` → `5`, `M.I.N.I.` → `M.1.N.I.`, `Amount` → `1ount`,
`newly` → `neely 1`, and form underscores read as `1`.

Prose disagreements raise no conflict, so they were measured directly. On
dev-v12's 2,665 skippable boxes, the share of the OCR reading contained in
the native text (NFKC-normalised) is median 1.00, p05 0.97, p01 0.85. Only 13
boxes fall below 0.8, all glyph variants (☐/□, ・/·, quote styles) or OCR
misreads. The worst, native `”` against OCR `55`, was inspected on the
render: it is a large closing quote that OCR misread at confidence 0.61.

### Font audit prototype

Two audit criteria were tried offline in `selective_ocr_replay.py`, over
records where OCR exists for every line, plus the broken-CMap fixtures
([trial](../trials/2026-11-07-broken-cmap-prose-fixture.md)):

- **Line-level** (`font_audit`): greedy lines covering each letter once; fail
  if any line's native-in-OCR containment is below 0.8. It catches the heavy
  e↔o swap (worst 0.65) but **passes the subtle v↔y swap** (0.95), so it is
  not sufficient.
- **Glyph-level** (`glyph_audit`, adopted): greedy lines until each letter
  appears at least twice; align native against OCR per character; fail the
  font when some letter is replaced by the *same* OCR character in at least
  half of its at-least-2 occurrences. Broken CMaps are systematic, OCR noise
  mostly is not.

| Input | Glyph audit |
|---|---|
| clean fixture | pass |
| e↔o fixture | **fail**: `o`→`e` 64/84, `e`→`o` 31/41 |
| v↔y fixture | **fail**: `y`→`v` 13/13 |
| dev-v12, 170 (document, font) groups | 14 fail, reading 21% of native lines |
| dev-v13, 170 groups | 12 fail |

Every dev failure is a systematic **OCR** misread, not a text-layer fault:
Polish `ą`→`q` (17/21, Asseco), and Japanese kanji read in simplified-Chinese
form (値→值, 増→增, Monotaro). Such failures cost only speed, because the font
falls back to full recognition. Limit: a letter that occurs fewer than k=2
times in a font's document text can never fail the audit, so rare glyphs
are unaudited by construction. The live mode should OCR any box that
contains such a letter. A Japanese/Chinese variant-equivalence
table would recover most of them.

Net effect (`net_skip`): after the audit, about **25% (dev-v12) to 31%
(dev-v13) of first-pass OCR text** would be skipped. On recognizer-dominated
OCR time that is about **1.3x** on this corpus. It is modest because the
corpus is table-heavy, and larger on prose-heavy documents. It multiplies
with the Tiny-recognizer candidate. The audit has value on its own: it closes
the broken-CMap gap in full mode.

**Limits:** all four runs cover the same 162 dev pages, and the locked
holdout was not used. The pipeline has never been tested on a corpus with
corrupted prose text layers, which is the case the font audit exists for. A
fixture with a deliberately broken ToUnicode map is needed before the audit
can be trusted.

## Acceptance gate (before building beyond a prototype)

Using existing baselines and gold:

- every native/OCR conflict and every `wrong` or `edited` gold token in the
  current full-OCR baselines lands in a box selective mode would still
  recognize. Critical-token conflicts are 100% by construction; measure and
  report the prose-conflict miss rate;
- the skip share and pages/s on the same corpus.

Changing witness coverage starts a new baseline era if adopted.

# Prior art

External projects reviewed for ideas PageSpatial can reuse. Each entry gives
the pinned commit reviewed, what it is, what we take (with exact references),
and what we deliberately leave. "Take" means a trial worth running, not an
adoption — every item still has to earn its place by measurement.

## Layout reconstructors with no machine-learning models (reviewed 2026-11-07)

Neither project has a second witness: both reconstruct layout from the PDF's
own text layer and check their output against that same layer. That is a
consistency check, not corroboration, so neither is a candidate witness or
dependency. Both fail on designed pages: on monotaro integrated report
pp.10–11 (corpus `public-comps:monotaro:2025-fy:004`), papero promoted
diagram labels to headings and merged diagram text into single blocks;
nativepdf-structurer emitted the page-10 "Growth Cycle" diagram as a 6×3
table with duplicated text, interleaved figure-internal columns, and output a
ligature-garbled `profti` ("profit"). One document — an anecdote, not a
measurement.

### papero (`beatrizalmeidaf/papero-pdf-text-extractor`)

- Reviewed at `08a45ed`. MIT. Python engine on PDFium (`src/papero_extract/`)
  plus a pdf.js port in the browser (`web/assets/engine.js`) kept in step by a
  parity test. Targets academic papers. About 0.3 s/page measured locally
  (`tika=False, ocr="off"`).
- **Take — column-aware reading order** → #133.
  `web/assets/columns.js` (`gutters`, `columns`), Python twin
  `src/papero_extract/columns.py:18`. Gutters come from a text-height coverage
  histogram over block boxes; full-width blocks are counted separately;
  narrow pseudo-columns are dropped. Boxes only, so it works for both native
  and OCR rows.
- **Take — running header/footer detection** → #134.
  `_mark_furniture`, `src/papero_extract/layout.py:2565` (JS `markFurniture`,
  `engine.js:1864`): top/bottom 9% band, digit-stripped text recurring on at
  least max(2, 30%) of pages, page-number regex, side-margin stamps, logos by
  quantized box.
- **Take — invisible native text** → #135.
  `_visible`, `src/papero_extract/layout.py:2437`; pdf.js fill colour and
  render mode at `engine.js:1511`, `visibleOnly` at `engine.js:1600`. papero
  drops the text; we would record it as a trust signal (native text with no ink
  under it).
- Noted, not scheduled:
  - Spacing-accent composition, `_compose_accents`, `layout.py:921`
    (`a` + `˜` → `ã` in LaTeX output). Relevant only if non-English LaTeX
    documents enter the corpus.
  - Vector chart regions from the PDF's drawing paths, `chart_regions` /
    `_plot_frames`, `layout.py:1648–1677`. A cheap pre-OCR chart locator,
    but the raster unread-ink detector (`src/ink.ts`) already covers the
    need.
- Leave: Tika/Tesseract, table/formula/LaTeX reconstruction, Word/Excel
  export, the browser editor, the fidelity report (checks itself against
  itself).

### nativepdf-structurer (`crunz-ailab/nativepdf-structurer`)

- Reviewed at `ac5f349` (10 commits, started 2026-08). Apache-2.0, but built
  on PyMuPDF (`pymupdf-lite`), which is **AGPL** — ideas only, no code
  reuse in the hosted service. Targets manufacturer manuals. About 1.3 s/page
  measured locally.
- **Take — repeated image/vector template detection** → #134.
  `build_header_footer_templates` / `detect_page_header_footer_bands`,
  `nativePDF_structurer/header_footer.py:404,605`. Builds templates of
  header/footer images and drawings from the first pages and excludes the
  matching bands. Relevant if repeated logos turn out to cause unread-ink
  residue.
- **Take — GapTree reading order** → #133 (alternative to papero's gutters).
  Vendored at `nativePDF_structurer/_vendor/gap_tree.py`; upstream
  `hiroi-sora/GapTree_Sort_Algorithm`, MIT, ~330 lines, built for OCR boxes.
- Noted: detector-priority "Claim" ownership (`claims.py`,
  `cross_detector_ownership.py`) — a neat way to decide which detector owns
  which element; our provenance model already covers it.
- Leave: everything PyMuPDF-coupled, table/visual-region reconstruction.

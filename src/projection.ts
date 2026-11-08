import type { DerivedRelation, NativeLine, NativeObservation, OcrObservation, PageProjection, SourceMatch, SpatialRow } from './types.js';
import { buildNativeLines } from './reading-order.js';
import { adapterMarkdownDefects, type AdapterMarkdownDefect } from './adapter-markdown.js';

function describeDefect(defect: AdapterMarkdownDefect): string {
  switch (defect.type) {
    case 'misbound-row':
      return `${defect.count} table row(s) put values printed on different lines into one row, attaching values to the wrong labels.`;
    case 'words-not-in-native':
      return `${Math.round(defect.share * 100)}% of its words do not occur in the PDF text (letters of neighbouring lines interleaved).`;
    case 'prose-in-cell':
      return `A table cell holds ${defect.words} words: running text was swallowed into a table.`;
  }
}

function evidenceComment(input: {
  pageNumber: number;
  sourceIds: readonly string[];
  box: readonly number[];
  confidence: number | null;
  derived: boolean;
}): string {
  const confidence = input.confidence === null ? 'unknown' : input.confidence.toFixed(4);
  return `<!-- evidence page=${input.pageNumber} source_ids=${input.sourceIds.join(',')} bbox=${input.box.join(',')} confidence=${confidence} derived=${input.derived} -->`;
}

export function projectMarkdown(input: {
  pageNumber: number;
  nativeObservations: readonly NativeObservation[];
  nativeLines?: readonly NativeLine[];
  ocrObservations: readonly OcrObservation[];
  sourceMatches: readonly SourceMatch[];
  spatialRows: readonly SpatialRow[];
  derivedRelations: readonly DerivedRelation[];
  nativeMarkdown?: string;
  nativeMarkdownSource?: string;
  pixelsPerPoint?: number;
  /**
   * Native observations whose font OCR strongly contradicts letter by letter
   * (src/glyph-audit.ts). Their text stays in the record but out of the
   * projection, so a consumer indexing the markdown never indexes it.
   */
  withheldNative?: { ids: readonly string[]; fonts: readonly string[] };
}): PageProjection {
  const withheld = new Set(input.withheldNative?.ids ?? []);
  const nativeLines = (input.nativeLines ?? buildNativeLines(input.nativeObservations, input.pixelsPerPoint))
    .filter((line) => !line.sourceIds.some((id) => withheld.has(id)));
  const matchedOcr = new Set(input.sourceMatches.map((match) => match.ocrId));
  const recoveredRows = input.spatialRows.filter((row) => row.sourceIds.some((id) => !matchedOcr.has(id)));
  const sections: string[] = [`# Page ${input.pageNumber}`];

  if (recoveredRows.length) {
    sections.push('## Visual text recovered by OCR');
    for (const row of recoveredRows) {
      sections.push(`${evidenceComment({
        pageNumber: input.pageNumber,
        sourceIds: row.sourceIds,
        box: row.box,
        confidence: row.confidence,
        derived: false
      })}\n${row.text}`);
    }
  }

  if (input.derivedRelations.length) {
    sections.push('## Unverified derived relationships');
    sections.push('These relationships are navigation hypotheses, not source observations.');
    const table = ['| Category | Value | Source IDs |', '| --- | ---: | --- |'];
    for (const relation of input.derivedRelations) {
      table.push(`| ${relation.attributes.category ?? ''} | ${relation.attributes.value ?? ''} | ${relation.sourceIds.join(', ')} |`);
    }
    sections.push(table.join('\n'));
  }

  // Adapter markdown is one opaque string and cannot be filtered per line, so
  // a page with withheld native text, or whose adapter markdown misrepresents
  // the native text (src/adapter-markdown.ts), falls back to the native lines.
  const defects = input.nativeMarkdown?.trim() && !withheld.size
    ? adapterMarkdownDefects(input.nativeMarkdown, input.nativeObservations, nativeLines)
    : [];
  const usesAdapterMarkdown = Boolean(input.nativeMarkdown?.trim()) && !withheld.size && !defects.length;
  if (withheld.size) {
    sections.push('## Withheld native text');
    sections.push(`Native text in font(s) ${input.withheldNative!.fonts.join(', ')} is withheld: OCR systematically reads its letters as different letters, so the PDF text layer for that font is not trusted (diagnostics: native-glyph-mismatch).`);
  }
  if (defects.length) {
    sections.push('## Native table structure omitted');
    sections.push(`The extracted structure misrepresents this page, so native lines are shown instead; each keeps one printed line intact. ${defects.map(describeDefect).join(' ')}`);
  }
  if (usesAdapterMarkdown) {
    sections.push('## Native structure reference');
    sections.push(input.nativeMarkdown!.trim());
  } else if (nativeLines.length) {
    sections.push('## Native observations');
    sections.push(nativeLines.map((line) => `${evidenceComment({
      pageNumber: input.pageNumber,
      sourceIds: line.sourceIds,
      box: line.box,
      confidence: null,
      derived: false
    })}\n${line.text}`).join('\n\n'));
  }

  if (!input.nativeObservations.length && !recoveredRows.length) {
    sections.push('_No text observations were produced for this page._');
  }

  return {
    markdown: sections.join('\n\n'),
    format: 'pagespatial-markdown-v1',
    trust: 'untrusted-document-content',
    derived: true,
    markdownSource: usesAdapterMarkdown
      ? input.nativeMarkdownSource ?? 'native-adapter'
      : 'pagespatial-native-lines'
  };
}

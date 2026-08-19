import type { DerivedRelation, NativeLine, NativeObservation, OcrObservation, PageProjection, SourceMatch, SpatialRow } from './types.js';
import { buildNativeLines } from './reading-order.js';

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
}): PageProjection {
  const nativeLines = input.nativeLines ?? buildNativeLines(input.nativeObservations);
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

  if (input.nativeMarkdown?.trim()) {
    sections.push('## Native structure reference');
    sections.push(input.nativeMarkdown.trim());
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
    derived: true
  };
}

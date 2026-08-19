import type { DerivedRelation, NativeObservation, OcrObservation, PageProjection, SourceMatch, SpatialRow } from './types.js';

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
  ocrObservations: readonly OcrObservation[];
  sourceMatches: readonly SourceMatch[];
  spatialRows: readonly SpatialRow[];
  derivedRelations: readonly DerivedRelation[];
  nativeMarkdown?: string;
}): PageProjection {
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
  } else if (input.nativeObservations.length) {
    sections.push('## Native observations');
    sections.push(input.nativeObservations.map((observation) => observation.text).join('\n\n'));
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

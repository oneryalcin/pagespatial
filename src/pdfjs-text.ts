import type { TextItem } from 'pdfjs-dist/types/src/display/api.js';
import type { Box, NativePointObservationInput } from './types.js';

export interface PdfJsTextMetadata {
  mcid?: number | null;
  structureRole?: string | null;
  font?: string;
  fontSize?: number;
  isBold?: boolean;
  isItalic?: boolean;
}

export function pdfJsTextItemPointBox(item: TextItem): Box {
  if (item.transform.length !== 6 || item.transform.some((value) => !Number.isFinite(value))) {
    throw new Error('PDF.js returned an invalid text transform.');
  }
  const [a, b, c, d, x, y] = item.transform;
  const horizontalLength = Math.hypot(a!, b!);
  const verticalLength = Math.hypot(c!, d!);
  // Reject, don't repair: a zero-length axis means the item has no real extent
  // in that direction, and any substituted height/width would be fabricated
  // evidence (PDF.js derives item.height from this same vector).
  if (horizontalLength === 0 || verticalLength === 0) {
    throw new Error('PDF.js returned a singular text transform.');
  }
  const widthX = (a! / horizontalLength) * item.width;
  const widthY = (b! / horizontalLength) * item.width;
  const heightX = c!;
  const heightY = d!;
  const points = [
    [x!, y!],
    [x! + widthX, y! + widthY],
    [x! + heightX, y! + heightY],
    [x! + widthX + heightX, y! + widthY + heightY]
  ];
  const xs = points.map((point) => point[0]!);
  const ys = points.map((point) => point[1]!);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function pdfJsPageMarkdown(items: readonly TextItem[]): string {
  const rows: Array<{ y: number; items: TextItem[] }> = [];
  const uniqueItems: TextItem[] = [];
  const seenVisuals = new Set<string>();
  for (const item of items) {
    const key = `${item.str.normalize('NFKC')}|${pdfJsTextItemPointBox(item).join(',')}`;
    if (seenVisuals.has(key)) continue;
    seenVisuals.add(key);
    uniqueItems.push(item);
  }
  for (const item of uniqueItems) {
    const y = item.transform[5]!;
    // Baseline y in PDF points (scale-independent): items whose baselines sit
    // within a quarter of a typical 10pt line are treated as one markdown row.
    const row = rows.find((candidate) => Math.abs(candidate.y - y) <= 2.5);
    if (row) row.items.push(item);
    else rows.push({ y, items: [item] });
  }
  return rows
    .sort((left, right) => right.y - left.y)
    .map((row) => row.items
      .sort((left, right) => left.transform[4]! - right.transform[4]!)
      .map((item) => item.str)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim())
    .filter(Boolean)
    .join('\n\n');
}

export function pdfJsTextObservations(
  items: readonly TextItem[],
  pageNumber: number,
  metadata?: (item: TextItem, index: number) => PdfJsTextMetadata | undefined
): NativePointObservationInput[] {
  return items.map((item, index) => {
    const itemMetadata = metadata?.(item, index);
    return {
      id: `pdfjs:${pageNumber}:${index}`,
      pageNumber,
      text: item.str,
      pointBox: pdfJsTextItemPointBox(item),
      mcid: itemMetadata?.mcid ?? null,
      structureRole: itemMetadata?.structureRole ?? null,
      font: itemMetadata?.font ?? item.fontName,
      fontSize: itemMetadata?.fontSize ?? Math.max(1, Math.hypot(item.transform[2]!, item.transform[3]!)),
      ...(itemMetadata?.isBold === undefined ? {} : { isBold: itemMetadata.isBold }),
      ...(itemMetadata?.isItalic === undefined ? {} : { isItalic: itemMetadata.isItalic })
    };
  });
}

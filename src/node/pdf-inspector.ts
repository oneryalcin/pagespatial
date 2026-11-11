import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import type { TextItem } from 'pdfjs-dist/types/src/display/api.js';
import type { NativePageAdapter } from '../adapters.js';
import { pdfJsPageMarkdown, pdfJsTextObservations, type PdfJsTextMetadata } from '../pdfjs-text.js';
import { SELECTIVE_OCR_PAGE_IMAGE_SHARE } from '../tuning.js';
import { openNodePdfSession, type NodePdfSession, type NodePdfSessionOptions } from './pdf-session.js';

interface InspectorTextItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  font: string;
  fontSize: number;
  page: number;
  isBold: boolean;
  isItalic: boolean;
  itemType: string;
  mcid?: number;
}

interface InspectorStructure {
  page: number;
  mcid: number;
  role: string;
}

interface InspectorPageMarkdown {
  page: number;
  markdown: string;
}

interface InspectorExtraction {
  textItems: InspectorTextItem[];
  structure: InspectorStructure[];
  markdownPages: InspectorPageMarkdown[];
  /** 1-indexed pages pdf-inspector would send to OCR, with its reasons when it gives any. */
  ocrReasons: Map<number, string[]>;
}

interface PackageMetadata {
  version: string;
}

const require = createRequire(import.meta.url);
const pdfInspectorVersion = (require('@firecrawl/pdf-inspector/package.json') as PackageMetadata).version;
const pdfJsVersion = (require('pdfjs-dist/package.json') as PackageMetadata).version;

export const pdfInspectorNativeAdapterIdentity =
  `pdf-inspector-markdown-pdfjs-geometry@${pdfInspectorVersion}+pdfjs.${pdfJsVersion}`;

export interface PdfInspectorAdapterOptions {
  /** Whole-document extraction is cached once per PDF.js session. */
  cache?: boolean;
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

function textKey(text: string): string {
  return text.normalize('NFKC').replace(/\s+/gu, '');
}

export function createPdfInspectorNativeAdapter(options: PdfInspectorAdapterOptions = {}): NativePageAdapter<NodePdfSession> {
  const cache = new WeakMap<NodePdfSession, Promise<InspectorExtraction>>();

  const extract = (session: NodePdfSession): Promise<InspectorExtraction> => {
    if (options.cache !== false) {
      const existing = cache.get(session);
      if (existing) return existing;
    }
    const pending = (async () => {
      const inspector = await import('@firecrawl/pdf-inspector');
      const buffer = Buffer.from(session.bytes.buffer, session.bytes.byteOffset, session.bytes.byteLength);
      const [markdown, textItems, structure] = await Promise.all([
        inspector.extractPagesMarkdownAsync(buffer),
        Promise.resolve().then(() => inspector.extractTextWithPositions(buffer)),
        Promise.resolve().then(() => inspector.extractStructureElements(buffer))
      ]);
      const ocrReasons = new Map<number, string[]>(
        (markdown.pagesNeedingOcr as number[]).map((page) => [page, []]));
      for (const entry of markdown.ocrReasonsByPage as Array<{ page: number; reasons: string[] }>) {
        ocrReasons.set(entry.page, entry.reasons);
      }
      return {
        textItems: textItems as InspectorTextItem[],
        structure: structure as InspectorStructure[],
        markdownPages: markdown.pages as InspectorPageMarkdown[],
        ocrReasons
      };
    })();
    if (options.cache !== false) cache.set(session, pending);
    return pending;
  };

  return {
    name: 'pdf-inspector-markdown-pdfjs-geometry',
    version: `${pdfInspectorVersion}+pdfjs.${pdfJsVersion}`,
    async extractPage(source, pageNumber, extractOptions) {
      abortIfNeeded(extractOptions?.signal);
      const [page, extraction] = await Promise.all([
        source.data.getPage(pageNumber, extractOptions?.signal),
        extract(source.data)
      ]);
      abortIfNeeded(extractOptions?.signal);
      const content = await page.getTextContent();
      abortIfNeeded(extractOptions?.signal);
      const viewport = page.getViewport({ scale: 1 });
      const [viewX0, viewY0, viewX1, viewY1] = page.view;
      if (![viewX0, viewY0, viewX1, viewY1].every(Number.isFinite) || viewX1! <= viewX0! || viewY1! <= viewY0!) {
        throw new Error('PDF.js returned invalid page bounds.');
      }
      const roleByMcid = new Map(
        extraction.structure
          .filter((entry) => entry.page === pageNumber)
          .map((entry) => [entry.mcid, entry.role])
      );
      const inspectorByText = new Map<string, InspectorTextItem[]>();
      for (const item of extraction.textItems) {
        if (item.page !== pageNumber || item.itemType !== 'Text' || !item.text.trim()) continue;
        const key = textKey(item.text);
        inspectorByText.set(key, [...(inspectorByText.get(key) ?? []), item]);
      }
      const items = content.items.filter((item): item is TextItem => 'str' in item && Boolean(item.str.trim()));
      const pdfTextCounts = new Map<string, number>();
      for (const item of items) {
        const key = textKey(item.str);
        pdfTextCounts.set(key, (pdfTextCounts.get(key) ?? 0) + 1);
      }
      const inspectorMatch = (item: TextItem): InspectorTextItem | undefined => {
        const key = textKey(item.str);
        const candidates = inspectorByText.get(key);
        return pdfTextCounts.get(key) === 1 && candidates?.length === 1 ? candidates[0] : undefined;
      };
      // The font label is what the glyph audit and selective OCR pool letter
      // evidence by, so it must name one font. PDF.js's font id does (one per
      // font object) but is opaque; pdf-inspector's name is readable but is
      // only known for items matched by text, and two font objects can share
      // it. So: where the matched items pair a PDF.js font with one name and
      // that name with no other PDF.js font, every item of the font carries
      // the name, matched or not. Where a name covers several PDF.js fonts,
      // the label is the name qualified by the PDF.js id.
      const namesByPdfJsFont = new Map<string, Set<string>>();
      const pdfJsFontsByName = new Map<string, Set<string>>();
      for (const item of items) {
        const matched = inspectorMatch(item);
        if (!matched) continue;
        (namesByPdfJsFont.get(item.fontName) ?? namesByPdfJsFont.set(item.fontName, new Set()).get(item.fontName)!).add(matched.font);
        (pdfJsFontsByName.get(matched.font) ?? pdfJsFontsByName.set(matched.font, new Set()).get(matched.font)!).add(item.fontName);
      }
      const fontLabel = (item: TextItem): string => {
        const names = namesByPdfJsFont.get(item.fontName);
        if (names?.size !== 1) return item.fontName;
        const [name] = names;
        return pdfJsFontsByName.get(name!)!.size === 1 ? name! : `${name} (${item.fontName})`;
      };
      const observations = pdfJsTextObservations(items, pageNumber, (item): PdfJsTextMetadata | undefined => {
        const matched = inspectorMatch(item);
        if (!matched) return { font: fontLabel(item) };
        return {
          mcid: matched.mcid ?? null,
          structureRole: matched.mcid === undefined ? null : roleByMcid.get(matched.mcid) ?? null,
          font: fontLabel(item),
          fontSize: matched.fontSize,
          isBold: matched.isBold,
          isItalic: matched.isItalic
        };
      });
      const visualKeys = observations.map((observation) => `${observation.text.normalize('NFKC')}|${observation.pointBox.join(',')}`);
      const hasCoincidentOverlay = new Set(visualKeys).size !== visualKeys.length;
      const inspectorMarkdown = extraction.markdownPages.find((candidate) => candidate.page === pageNumber - 1)?.markdown ?? '';
      const useInspector = !hasCoincidentOverlay && Boolean(inspectorMarkdown.trim());
      const markdown = useInspector ? inspectorMarkdown : pdfJsPageMarkdown(items);
      const markdownSource = useInspector ? 'pdf-inspector' : 'pdfjs-deduplicated';
      // Image items are positioned in points from the page's top-left corner.
      const pageWidth = viewX1! - viewX0!;
      const pageHeight = viewY1! - viewY0!;
      const imageArea = extraction.textItems
        .filter((item) => item.page === pageNumber && item.itemType === 'Image')
        .reduce((sum, item) => sum
          + Math.max(0, Math.min(pageWidth, item.x + item.width) - Math.max(0, item.x))
          * Math.max(0, Math.min(pageHeight, item.y + item.height) - Math.max(0, item.y)), 0);
      const inspectorReasons = extraction.ocrReasons.get(pageNumber);
      const textLayerDistrust = inspectorReasons
        ? `pdf-inspector:${inspectorReasons.join('+') || 'needs-ocr'}`
        : imageArea >= SELECTIVE_OCR_PAGE_IMAGE_SHARE * pageWidth * pageHeight ? 'page-image' : undefined;
      return {
        pageNumber,
        geometry: {
          pointBounds: [viewX0!, viewY0!, viewX1!, viewY1!],
          pointWidth: viewX1! - viewX0!,
          pointHeight: viewY1! - viewY0!,
          rotation: viewport.rotation
        },
        observations,
        markdown,
        markdownSource,
        ...(textLayerDistrust ? { textLayerDistrust } : {})
      };
    }
  };
}

export { openNodePdfSession, type NodePdfSession, type NodePdfSessionOptions };

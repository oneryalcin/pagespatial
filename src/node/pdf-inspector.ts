import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import type { TextItem } from 'pdfjs-dist/types/src/display/api.js';
import type { NativePageAdapter } from '../adapters.js';
import { pdfJsPageMarkdown, pdfJsTextObservations, type PdfJsTextMetadata } from '../pdfjs-text.js';
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
      return {
        textItems: textItems as InspectorTextItem[],
        structure: structure as InspectorStructure[],
        markdownPages: markdown.pages as InspectorPageMarkdown[]
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
      const observations = pdfJsTextObservations(items, pageNumber, (item): PdfJsTextMetadata | undefined => {
        const key = textKey(item.str);
        const candidates = inspectorByText.get(key);
        const matched = pdfTextCounts.get(key) === 1 && candidates?.length === 1 ? candidates[0] : undefined;
        if (!matched) return undefined;
        return {
          mcid: matched.mcid ?? null,
          structureRole: matched.mcid === undefined ? null : roleByMcid.get(matched.mcid) ?? null,
          font: matched.font,
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
        markdownSource
      };
    }
  };
}

export { openNodePdfSession, type NodePdfSession, type NodePdfSessionOptions };

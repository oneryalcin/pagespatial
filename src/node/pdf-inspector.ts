import { Buffer } from 'node:buffer';
import type { NativePageAdapter } from '../adapters.js';
import type { NativePointObservationInput } from '../types.js';
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

export interface PdfInspectorAdapterOptions {
  /** Whole-document extraction is cached once per PDF.js session. */
  cache?: boolean;
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
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
    name: 'firecrawl-pdf-inspector-native',
    version: '1.14.2',
    async extractPage(source, pageNumber, extractOptions) {
      abortIfNeeded(extractOptions?.signal);
      const [page, extraction] = await Promise.all([
        source.data.getPage(pageNumber, extractOptions?.signal),
        extract(source.data)
      ]);
      abortIfNeeded(extractOptions?.signal);
      const viewport = page.getViewport({ scale: 1 });
      if (viewport.rotation % 360 !== 0) {
        throw new Error(`PDF Inspector native geometry for rotated page ${pageNumber} is not enabled until a real rotated fixture passes conformance.`);
      }
      const [viewX0, viewY0, viewX1, viewY1] = page.view;
      if (![viewX0, viewY0, viewX1, viewY1].every(Number.isFinite)) throw new Error('PDF.js returned invalid page bounds.');
      if (viewX0 !== 0 || viewY0 !== 0) {
        throw new Error(`PDF Inspector native geometry for cropped or shifted page ${pageNumber} is not enabled until a real fixture passes conformance.`);
      }
      const roleByMcid = new Map(
        extraction.structure
          .filter((entry) => entry.page === pageNumber)
          .map((entry) => [entry.mcid, entry.role])
      );
      const observations: NativePointObservationInput[] = extraction.textItems
        .filter((item) => item.page === pageNumber && item.itemType === 'Text' && item.text.trim())
        .map((item, index) => ({
          id: `pdf-inspector:${pageNumber}:${index}`,
          pageNumber,
          text: item.text,
          pointBox: [
            item.x,
            item.y,
            item.x + item.width,
            item.y + item.height
          ],
          mcid: item.mcid ?? null,
          structureRole: item.mcid === undefined ? null : roleByMcid.get(item.mcid) ?? null,
          font: item.font,
          fontSize: item.fontSize,
          isBold: item.isBold,
          isItalic: item.isItalic
        }));
      const markdown = extraction.markdownPages.find((candidate) => candidate.page === pageNumber - 1)?.markdown ?? '';
      return {
        pageNumber,
        geometry: {
          pointWidth: viewport.width,
          pointHeight: viewport.height,
          rotation: viewport.rotation
        },
        observations,
        markdown
      };
    }
  };
}

export { openNodePdfSession, type NodePdfSession, type NodePdfSessionOptions };

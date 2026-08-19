import { createHash } from 'node:crypto';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/types/src/display/api.js';
import type { DocumentIdentity, DocumentSource } from '../types.js';

export interface NodePdfSessionOptions {
  documentId?: string;
  revisionId?: string;
  sourceUri?: string;
  maxBytes?: number;
  maxPages?: number;
}

export interface NodePdfSession {
  readonly bytes: Uint8Array;
  readonly document: PDFDocumentProxy;
  source: DocumentSource<NodePdfSession>;
  getPage(pageNumber: number, signal?: AbortSignal): Promise<PDFPageProxy>;
  dispose(): Promise<void>;
}

const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_PAGES = 2_000;

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

export async function openNodePdfSession(input: Uint8Array | ArrayBuffer, options: NodePdfSessionOptions = {}): Promise<NodePdfSession> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('maxBytes must be a positive safe integer.');
  if (input.byteLength > maxBytes) throw new Error(`PDF is ${input.byteLength} bytes; limit is ${maxBytes}.`);
  const view = input instanceof Uint8Array ? input : new Uint8Array(input);
  // Buffer is a Uint8Array subclass whose slice() remains a Buffer. PDF.js
  // rejects Buffer even when the public contract accepts Uint8Array, so always
  // copy into a plain Uint8Array.
  const bytes = new Uint8Array(view.byteLength);
  bytes.set(view);
  if (bytes.byteLength > maxBytes) throw new Error(`PDF is ${bytes.byteLength} bytes; limit is ${maxBytes}.`);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjs.getDocument({ data: bytes.slice() });
  let pdf: PDFDocumentProxy;
  try {
    pdf = await loadingTask.promise;
  } catch (error) {
    await loadingTask.destroy().catch(() => undefined);
    throw error;
  }
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
    await pdf.destroy();
    throw new Error('maxPages must be a positive safe integer.');
  }
  if (pdf.numPages > maxPages) {
    await pdf.destroy();
    throw new Error(`PDF has ${pdf.numPages} pages; limit is ${maxPages}.`);
  }
  const hash = createHash('sha256').update(bytes).digest('hex');
  const identity: DocumentIdentity = {
    documentId: options.documentId ?? `sha256:${hash}`,
    revisionId: options.revisionId ?? `sha256:${hash}`,
    sha256: hash,
    pageCount: pdf.numPages,
    ...(options.sourceUri ? { sourceUri: options.sourceUri } : {})
  };
  const pages = new Map<number, Promise<PDFPageProxy>>();
  let disposed = false;
  let disposing: Promise<void> | undefined;
  let session!: NodePdfSession;
  session = {
    bytes,
    document: pdf,
    source: undefined as unknown as DocumentSource<NodePdfSession>,
    async getPage(pageNumber, signal) {
      abortIfNeeded(signal);
      if (disposed) throw new Error('Node PDF session was disposed.');
      if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pdf.numPages) {
        throw new Error(`Page ${pageNumber} is outside document page count ${pdf.numPages}.`);
      }
      let pending = pages.get(pageNumber);
      if (!pending) {
        pending = pdf.getPage(pageNumber).catch((error: unknown) => {
          pages.delete(pageNumber);
          throw error;
        });
        pages.set(pageNumber, pending);
      }
      const page = await pending;
      abortIfNeeded(signal);
      if (disposed) throw new Error('Node PDF session was disposed.');
      return page;
    },
    async dispose() {
      if (disposing) return disposing;
      disposed = true;
      pages.clear();
      disposing = pdf.destroy();
      return disposing;
    }
  };
  session.source = { identity, data: session, mimeType: 'application/pdf' };
  return session;
}

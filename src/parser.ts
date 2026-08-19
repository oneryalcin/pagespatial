import type { ParserAdapters } from './adapters.js';
import { buildDiagnostics, resolveDiagnosticOptions, type DiagnosticOptions } from './diagnostics.js';
import { pointBoxToRenderedBox, roundBox } from './geometry.js';
import { createObservationId, createPageId } from './ids.js';
import { associateNativeAndOcr, type AssociationOptions } from './merge.js';
import { projectMarkdown } from './projection.js';
import { buildSpatialRows } from './reading-order.js';
import { inferSimpleYearValueRelations } from './relations.js';
import { documentIdentitySchema, pageSpatialDocumentSchema, pageSpatialSchema } from './schema.js';
import type {
  DocumentIdentity,
  DocumentSource,
  ExtractionProvenance,
  NativeObservation,
  NativeObservationInput,
  NativePageResult,
  NativePointObservationInput,
  OcrObservation,
  OcrObservationInput,
  PageGeometry,
  PageSpatial,
  PageSpatialDocument
} from './types.js';

export interface BuildPageSpatialInput {
  document: DocumentIdentity;
  pageNumber: number;
  geometry: PageGeometry;
  nativeObservations: Array<NativeObservationInput | NativePointObservationInput>;
  ocrObservations: OcrObservationInput[];
  nativeMarkdown?: string;
  provenance: ExtractionProvenance;
  association?: AssociationOptions;
  diagnostics?: DiagnosticOptions;
}

export interface ParseOptions {
  concurrency?: number;
  renderScale?: number;
  signal?: AbortSignal;
  onPage?: (page: PageSpatial) => void | Promise<void>;
  association?: AssociationOptions;
  diagnostics?: DiagnosticOptions;
  runId?: string;
}

function normalizeNative(
  document: DocumentIdentity,
  pageNumber: number,
  geometry: PageGeometry,
  inputs: Array<NativeObservationInput | NativePointObservationInput>
): NativeObservation[] {
  for (const input of inputs) {
    if (input.pageNumber !== pageNumber) {
      throw new Error(`Native observation for page ${input.pageNumber} was supplied while building page ${pageNumber}.`);
    }
  }
  const suppliedIds = inputs.flatMap((input) => input.id ? [input.id] : []);
  if (new Set(suppliedIds).size !== suppliedIds.length) {
    throw new Error(`Native adapter supplied duplicate observation IDs on page ${pageNumber}.`);
  }
  const duplicateCounts = new Map<string, number>();
  return inputs
    .filter((input) => input.text.trim())
    .map((input) => {
      const transformed = input.pointBox
        ? pointBoxToRenderedBox(input.pointBox, geometry)
        : { box: roundBox(input.box!), method: 'rendered-input-v1' as const };
      const duplicateKey = `${input.text.normalize('NFKC')}|${transformed.box.join(',')}`;
      const occurrence = duplicateCounts.get(duplicateKey) ?? 0;
      duplicateCounts.set(duplicateKey, occurrence + 1);
      const id = createObservationId({
        documentSha256: document.sha256,
        pageNumber,
        source: 'native',
        text: input.text,
        box: transformed.box,
        occurrence
      });
      return {
        ...input,
        id,
        adapterId: input.id,
        pageNumber,
        text: input.text.trim(),
        box: transformed.box,
        pointBox: input.pointBox,
        mcid: input.mcid ?? null,
        structureRole: input.structureRole ?? null,
        geometryMethod: transformed.method
      };
    });
}

function normalizeOcr(document: DocumentIdentity, pageNumber: number, inputs: OcrObservationInput[]): OcrObservation[] {
  for (const input of inputs) {
    if (input.pageNumber !== pageNumber) {
      throw new Error(`OCR observation for page ${input.pageNumber} was supplied while building page ${pageNumber}.`);
    }
  }
  const suppliedIds = inputs.flatMap((input) => input.id ? [input.id] : []);
  if (new Set(suppliedIds).size !== suppliedIds.length) {
    throw new Error(`OCR adapter supplied duplicate observation IDs on page ${pageNumber}.`);
  }
  const duplicateCounts = new Map<string, number>();
  return inputs
    .filter((input) => input.text.trim())
    .map((input) => {
      const box = roundBox(input.box);
      const duplicateKey = `${input.text.normalize('NFKC')}|${box.join(',')}`;
      const occurrence = duplicateCounts.get(duplicateKey) ?? 0;
      duplicateCounts.set(duplicateKey, occurrence + 1);
      return {
        ...input,
        id: createObservationId({
          documentSha256: document.sha256,
          pageNumber,
          source: 'ocr',
          text: input.text,
          box,
          occurrence
        }),
        adapterId: input.id,
        pageNumber,
        text: input.text.trim(),
        box,
        confidence: Math.max(0, Math.min(1, input.confidence))
      };
    });
}

export function buildPageSpatial(input: BuildPageSpatialInput): PageSpatial {
  documentIdentitySchema.parse(input.document);
  if (input.pageNumber < 1 || input.pageNumber > input.document.pageCount) {
    throw new Error(`Page ${input.pageNumber} is outside document page count ${input.document.pageCount}.`);
  }
  const pageId = createPageId(input.document.sha256, input.pageNumber);
  const nativeObservations = normalizeNative(input.document, input.pageNumber, input.geometry, input.nativeObservations);
  const ocrObservations = normalizeOcr(input.document, input.pageNumber, input.ocrObservations);
  const association = associateNativeAndOcr(nativeObservations, ocrObservations, input.association);
  const spatialRows = buildSpatialRows(ocrObservations);
  const derivedRelations = inferSimpleYearValueRelations(pageId, ocrObservations);
  const diagnostics = buildDiagnostics({
    nativeObservations,
    ocrObservations,
    sourceMatches: association.sourceMatches,
    conflicts: association.conflicts,
    derivedRelations,
    options: input.diagnostics
  });
  const projection = projectMarkdown({
    pageNumber: input.pageNumber,
    nativeObservations,
    ocrObservations,
    sourceMatches: association.sourceMatches,
    spatialRows,
    derivedRelations,
    nativeMarkdown: input.nativeMarkdown
  });

  const page: PageSpatial = {
    schemaVersion: '0.1.0',
    documentId: input.document.documentId,
    revisionId: input.document.revisionId,
    documentSha256: input.document.sha256,
    pageId,
    pageNumber: input.pageNumber,
    geometry: input.geometry,
    nativeObservations,
    ocrObservations,
    nativeLines: association.nativeLines,
    sourceMatches: association.sourceMatches,
    conflicts: association.conflicts,
    spatialRows,
    derivedRelations,
    diagnostics,
    projection,
    provenance: input.provenance
  };
  return pageSpatialSchema.parse(page) as PageSpatial;
}

function mergeGeometry(nativePage: NativePageResult | undefined, rendered: PageGeometry): PageGeometry {
  return {
    ...nativePage?.geometry,
    ...rendered,
    width: rendered.width,
    height: rendered.height
  };
}

function documentDiagnostics(pages: readonly PageSpatial[]): PageSpatialDocument['diagnostics'] {
  const ocrObservationCount = pages.reduce((sum, page) => sum + page.ocrObservations.length, 0);
  const sourceMatchCount = pages.reduce((sum, page) => sum + page.sourceMatches.length, 0);
  return {
    pageCount: pages.length,
    pagesParsed: pages.length,
    pagesRequiringEscalation: pages.filter((page) => page.diagnostics.requiresEscalation).map((page) => page.pageNumber),
    ocrObservationCount,
    nativeObservationCount: pages.reduce((sum, page) => sum + page.nativeObservations.length, 0),
    sourceMatchCount,
    nativeOcrAssociationCoverage: ocrObservationCount ? sourceMatchCount / ocrObservationCount : 0,
    criticalConflictCount: pages.reduce((sum, page) => sum + page.diagnostics.criticalConflictCount, 0),
    criticalOmissionCount: pages.reduce((sum, page) => sum + page.diagnostics.criticalOmissionCount, 0)
  };
}

function abortIfNeeded(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

export function createParser<TSource = unknown, TRaster = unknown>(adapters: ParserAdapters<TSource, TRaster>): {
  parse(source: DocumentSource<TSource>, options?: ParseOptions): Promise<PageSpatialDocument>;
} {
  return {
    async parse(source, options = {}) {
      const document = documentIdentitySchema.parse(source.identity) as DocumentIdentity;
      const controller = new AbortController();
      const forwardAbort = (): void => controller.abort(options.signal?.reason);
      if (options.signal?.aborted) forwardAbort();
      else options.signal?.addEventListener('abort', forwardAbort, { once: true });
      try {
        abortIfNeeded(controller.signal);
        const pages = new Array<PageSpatial>(document.pageCount);
        const concurrency = Math.max(1, Math.min(document.pageCount, Math.floor(options.concurrency ?? 1)));
        const renderScale = options.renderScale ?? 1.6;
        if (!Number.isFinite(renderScale) || renderScale <= 0) throw new Error('renderScale must be a positive finite number.');
        const runId = options.runId ?? `run:${Date.now().toString(36)}`;
        let nextPage = 1;
        let firstError: unknown;

        const fail = (error: unknown): void => {
          if (firstError === undefined) firstError = error;
          if (!controller.signal.aborted) controller.abort(error);
        };

        const worker = async (): Promise<void> => {
          try {
            while (!controller.signal.aborted) {
              const pageNumber = nextPage;
              nextPage += 1;
              if (pageNumber > document.pageCount) return;
              const [nativeResult, renderedResult] = await Promise.allSettled([
                adapters.native.extractPage(source, pageNumber, { signal: controller.signal }),
                adapters.renderer.render(source, pageNumber, {
                  signal: controller.signal,
                  scale: renderScale
                })
              ]);
              if (nativeResult.status === 'rejected') {
                if (renderedResult.status === 'fulfilled') await renderedResult.value.release?.();
                throw nativeResult.reason;
              }
              if (renderedResult.status === 'rejected') throw renderedResult.reason;
              const nativePage = nativeResult.value;
              const rendered = renderedResult.value;
              try {
                if (nativePage.pageNumber !== pageNumber) {
                  throw new Error(`Native adapter returned page ${nativePage.pageNumber} while parsing page ${pageNumber}.`);
                }
                for (const observation of nativePage.observations) {
                  if (observation.pageNumber !== pageNumber) {
                    throw new Error(`Native page ${pageNumber} contains an observation for page ${observation.pageNumber}.`);
                  }
                }
                if (rendered.pageNumber !== pageNumber) {
                  throw new Error(`Renderer returned page ${rendered.pageNumber} while parsing page ${pageNumber}.`);
                }
                const ocr = await adapters.ocr.recognize(rendered, { signal: controller.signal });
                if (ocr.pageNumber !== pageNumber) {
                  throw new Error(`OCR adapter returned page ${ocr.pageNumber} while parsing page ${pageNumber}.`);
                }
                for (const observation of ocr.observations) {
                  if (observation.pageNumber !== pageNumber) {
                    throw new Error(`OCR page ${pageNumber} contains an observation for page ${observation.pageNumber}.`);
                  }
                }
                abortIfNeeded(controller.signal);
                const provenance: ExtractionProvenance = {
                  parserName: 'pagespatial',
                  parserVersion: '0.1.0',
                  runId,
                  createdAt: new Date().toISOString(),
                  nativeAdapter: `${adapters.native.name}@${adapters.native.version}`,
                  renderer: `${adapters.renderer.name}@${adapters.renderer.version}`,
                  ocrAdapter: `${adapters.ocr.name}@${adapters.ocr.version}`,
                  backend: ocr.backend,
                  configuration: {
                    renderScale,
                    concurrency,
                    diagnosticPolicy: resolveDiagnosticOptions(options.diagnostics)
                  }
                };
                const page = buildPageSpatial({
                  document,
                  pageNumber,
                  geometry: mergeGeometry(nativePage, rendered.geometry),
                  nativeObservations: nativePage.observations,
                  ocrObservations: ocr.observations,
                  nativeMarkdown: nativePage.markdown,
                  provenance,
                  association: options.association,
                  diagnostics: options.diagnostics
                });
                pages[pageNumber - 1] = page;
                await options.onPage?.(page);
              } finally {
                await rendered.release?.();
              }
            }
          } catch (error) {
            fail(error);
          }
        };

        await Promise.all(Array.from({ length: concurrency }, () => worker()));
        if (firstError !== undefined) throw firstError;
        abortIfNeeded(controller.signal);
        const completed = pages.filter((page): page is PageSpatial => Boolean(page));
        const provenance: ExtractionProvenance = {
          parserName: 'pagespatial',
          parserVersion: '0.1.0',
          runId,
          createdAt: new Date().toISOString(),
          nativeAdapter: `${adapters.native.name}@${adapters.native.version}`,
          renderer: `${adapters.renderer.name}@${adapters.renderer.version}`,
          ocrAdapter: `${adapters.ocr.name}@${adapters.ocr.version}`,
          configuration: {
            renderScale,
            concurrency,
            diagnosticPolicy: resolveDiagnosticOptions(options.diagnostics)
          }
        };
        const result: PageSpatialDocument = {
          schemaVersion: '0.1.0',
          document,
          pages: completed,
          diagnostics: documentDiagnostics(completed),
          provenance
        };
        return pageSpatialDocumentSchema.parse(result) as PageSpatialDocument;
      } finally {
        options.signal?.removeEventListener('abort', forwardAbort);
      }
    }
  };
}

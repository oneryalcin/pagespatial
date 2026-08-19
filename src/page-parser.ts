import { buildDiagnostics, type DiagnosticOptions } from './diagnostics.js';
import { pointBoxToRenderedBox, roundBox } from './geometry.js';
import { createObservationId, createPageId } from './ids.js';
import { associateNativeAndOcr, type AssociationOptions } from './merge.js';
import { projectMarkdown } from './projection.js';
import { buildSpatialRows } from './reading-order.js';
import { inferSimpleYearValueRelations } from './relations.js';
import { documentIdentitySchema, pageSpatialSchema } from './schema.js';
import type {
  DocumentIdentity,
  ExtractionProvenance,
  NativeObservation,
  NativeObservationInput,
  NativePageResult,
  NativePointObservationInput,
  OcrObservation,
  OcrObservationInput,
  OcrPageResult,
  PageGeometry,
  PageSpatial,
  RenderedPage
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

/**
 * Internal seam for assembling one page from adapter results.
 *
 * This module is intentionally absent from the package export map. Evaluation
 * code in this repository can import it directly without expanding the public
 * API surface.
 */
export interface AssemblePageSpatialInput {
  document: DocumentIdentity;
  pageNumber: number;
  nativePage: NativePageResult;
  renderedPage: Pick<RenderedPage, 'pageNumber' | 'geometry'>;
  ocrPage: OcrPageResult;
  runId: string;
  nativeAdapter: string;
  renderer: string;
  ocrAdapter: string;
  configuration?: Record<string, unknown>;
  createdAt?: string;
  association?: AssociationOptions;
  diagnostics?: DiagnosticOptions;
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

function mergeGeometry(nativePage: NativePageResult, rendered: PageGeometry): PageGeometry {
  return {
    ...nativePage.geometry,
    ...rendered,
    width: rendered.width,
    height: rendered.height
  };
}

function assertPageResultIdentity(input: AssemblePageSpatialInput): void {
  const { pageNumber, nativePage, renderedPage, ocrPage } = input;
  if (nativePage.pageNumber !== pageNumber) {
    throw new Error(`Native adapter returned page ${nativePage.pageNumber} while parsing page ${pageNumber}.`);
  }
  for (const observation of nativePage.observations) {
    if (observation.pageNumber !== pageNumber) {
      throw new Error(`Native page ${pageNumber} contains an observation for page ${observation.pageNumber}.`);
    }
  }
  if (renderedPage.pageNumber !== pageNumber) {
    throw new Error(`Renderer returned page ${renderedPage.pageNumber} while parsing page ${pageNumber}.`);
  }
  if (ocrPage.pageNumber !== pageNumber) {
    throw new Error(`OCR adapter returned page ${ocrPage.pageNumber} while parsing page ${pageNumber}.`);
  }
  for (const observation of ocrPage.observations) {
    if (observation.pageNumber !== pageNumber) {
      throw new Error(`OCR page ${pageNumber} contains an observation for page ${observation.pageNumber}.`);
    }
  }
}

export function assemblePageSpatial(input: AssemblePageSpatialInput): PageSpatial {
  assertPageResultIdentity(input);
  const provenance: ExtractionProvenance = {
    parserName: 'pagespatial',
    parserVersion: '0.1.0',
    runId: input.runId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    nativeAdapter: input.nativeAdapter,
    renderer: input.renderer,
    ocrAdapter: input.ocrAdapter,
    backend: input.ocrPage.backend,
    configuration: input.configuration
  };
  return buildPageSpatial({
    document: input.document,
    pageNumber: input.pageNumber,
    geometry: mergeGeometry(input.nativePage, input.renderedPage.geometry),
    nativeObservations: input.nativePage.observations,
    ocrObservations: input.ocrPage.observations,
    nativeMarkdown: input.nativePage.markdown,
    provenance,
    association: input.association,
    diagnostics: input.diagnostics
  });
}

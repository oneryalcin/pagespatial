import { buildDiagnostics, type DiagnosticOptions } from './diagnostics.js';
import { assertBoxWithin, assertPageGeometry, pointBounds, pointBoxToRenderedBox, renderedPixelsPerPoint, roundBox } from './geometry.js';
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
  RenderedPage,
  UnreadInkRegion
} from './types.js';

export interface BuildPageSpatialInput {
  document: DocumentIdentity;
  pageNumber: number;
  geometry: PageGeometry;
  nativeObservations: Array<NativeObservationInput | NativePointObservationInput>;
  ocrObservations: OcrObservationInput[];
  nativeMarkdown?: string;
  nativeMarkdownSource?: string;
  unreadInkRegions?: UnreadInkRegion[];
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
  unreadInkRegions?: UnreadInkRegion[];
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

function assertPolygonMatchesBox(
  polygon: readonly (readonly [number, number])[] | undefined,
  box: readonly [number, number, number, number],
  geometry: PageGeometry,
  label: string
): void {
  assertBoxWithin(box, [0, 0, geometry.width, geometry.height], label);
  if (!polygon) return;
  if (polygon.length < 3) throw new Error(`${label} polygon must contain at least three points.`);
  const xs = polygon.map((point) => point[0]);
  const ys = polygon.map((point) => point[1]);
  if (polygon.some((point) => !Number.isFinite(point[0]) || !Number.isFinite(point[1]))) {
    throw new Error(`${label} polygon contains a non-finite point.`);
  }
  const envelope = roundBox([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
  assertBoxWithin(envelope, [0, 0, geometry.width, geometry.height], `${label} polygon`);
  if (envelope.some((value, index) => Math.abs(value - box[index]!) > 0.01)) {
    throw new Error(`${label} polygon does not match its evidence box.`);
  }
}

function validateNormalizedGeometry(
  geometry: PageGeometry,
  nativeObservations: readonly NativeObservation[],
  ocrObservations: readonly OcrObservation[]
): void {
  for (const observation of nativeObservations) {
    assertPolygonMatchesBox(observation.polygon, observation.box, geometry, 'Native observation');
  }
  for (const observation of ocrObservations) {
    assertPolygonMatchesBox(observation.polygon, observation.box, geometry, 'OCR observation');
  }
}

export function buildPageSpatial(input: BuildPageSpatialInput): PageSpatial {
  documentIdentitySchema.parse(input.document);
  if (input.pageNumber < 1 || input.pageNumber > input.document.pageCount) {
    throw new Error(`Page ${input.pageNumber} is outside document page count ${input.document.pageCount}.`);
  }
  assertPageGeometry(input.geometry);
  const pageId = createPageId(input.document.sha256, input.pageNumber);
  const nativeObservations = normalizeNative(input.document, input.pageNumber, input.geometry, input.nativeObservations);
  const ocrObservations = normalizeOcr(input.document, input.pageNumber, input.ocrObservations);
  validateNormalizedGeometry(input.geometry, nativeObservations, ocrObservations);
  const pixelsPerPoint = renderedPixelsPerPoint(input.geometry);
  const association = associateNativeAndOcr(nativeObservations, ocrObservations, {
    pixelsPerPoint,
    ...input.association
  });
  const spatialRows = buildSpatialRows(ocrObservations, pixelsPerPoint);
  const derivedRelations = inferSimpleYearValueRelations(pageId, ocrObservations, pixelsPerPoint);
  const unreadInkRegions = input.unreadInkRegions;
  const diagnostics = buildDiagnostics({
    nativeObservations,
    ocrObservations,
    sourceMatches: association.sourceMatches,
    conflicts: association.conflicts,
    derivedRelations,
    unreadInkRegions,
    pixelsPerPoint,
    options: input.diagnostics
  });
  const projection = projectMarkdown({
    pageNumber: input.pageNumber,
    nativeObservations,
    nativeLines: association.nativeLines,
    ocrObservations,
    sourceMatches: association.sourceMatches,
    spatialRows,
    derivedRelations,
    nativeMarkdown: input.nativeMarkdown,
    nativeMarkdownSource: input.nativeMarkdownSource,
    pixelsPerPoint
  });

  const page: PageSpatial = {
    schemaVersion: '0.5.0',
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
    unreadInkRegions,
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

function assertCoordinateBasisAgreement(nativePage: NativePageResult, rendered: PageGeometry): void {
  if (!nativePage.observations.some((observation) => observation.pointBox)) return;
  const nativeBounds = pointBounds(nativePage.geometry);
  const renderedBounds = pointBounds(rendered);
  if (!nativeBounds || !renderedBounds) return;
  const agrees = nativeBounds.every((value, index) => {
    const other = renderedBounds[index]!;
    return Math.abs(value - other) <= Math.max(1, Math.abs(value), Math.abs(other)) * 1e-6;
  });
  if (!agrees) {
    throw new Error('Native and rendered PDF point bounds do not describe the same coordinate basis.');
  }
}

export function validateNativePageGeometry(
  pageNumber: number,
  nativePage: NativePageResult,
  renderedPage: Pick<RenderedPage, 'pageNumber' | 'geometry'>
): PageGeometry {
  if (nativePage.pageNumber !== pageNumber || renderedPage.pageNumber !== pageNumber) {
    throw new Error('Native and rendered page identities must match before geometry validation.');
  }
  assertCoordinateBasisAgreement(nativePage, renderedPage.geometry);
  const geometry = mergeGeometry(nativePage, renderedPage.geometry);
  assertPageGeometry(geometry);
  const suppliedIds = nativePage.observations.flatMap((observation) => observation.id ? [observation.id] : []);
  if (new Set(suppliedIds).size !== suppliedIds.length) {
    throw new Error(`Native adapter supplied duplicate observation IDs on page ${pageNumber}.`);
  }
  for (const observation of nativePage.observations) {
    if (observation.pageNumber !== pageNumber) {
      throw new Error(`Native page ${pageNumber} contains an observation for page ${observation.pageNumber}.`);
    }
    if (observation.pointBox) {
      if (observation.polygon) throw new Error('Native point observations cannot carry an undeclared polygon coordinate space.');
      pointBoxToRenderedBox(observation.pointBox, geometry);
    } else {
      assertPolygonMatchesBox(observation.polygon, roundBox(observation.box!), geometry, 'Native observation');
    }
  }
  return geometry;
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
  const geometry = validateNativePageGeometry(input.pageNumber, input.nativePage, input.renderedPage);
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
    geometry,
    nativeObservations: input.nativePage.observations,
    ocrObservations: input.ocrPage.observations,
    nativeMarkdown: input.nativePage.markdown,
    nativeMarkdownSource: input.nativePage.markdownSource,
    unreadInkRegions: input.unreadInkRegions,
    provenance,
    association: input.association,
    diagnostics: input.diagnostics
  });
}

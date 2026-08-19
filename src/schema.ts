import { z } from 'zod';
import { assertPageGeometry, pointBounds, pointBoxToRenderedBox } from './geometry.js';

const boxSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);
const pointSchema = z.tuple([z.number(), z.number()]);
const polygonSchema = z.array(pointSchema).min(3);
const viewportTransformSchema = z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number()]);

export const documentIdentitySchema = z.object({
  documentId: z.string().min(1),
  revisionId: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/iu, 'Expected a hexadecimal SHA-256 digest.'),
  pageCount: z.number().int().positive(),
  sourceUri: z.string().optional()
});

export const pageGeometrySchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
  pointBounds: boxSchema.optional(),
  pointWidth: z.number().positive().optional(),
  pointHeight: z.number().positive().optional(),
  rotation: z.number().optional(),
  viewportTransform: viewportTransformSchema.optional()
}).superRefine((geometry, context) => {
  try {
    assertPageGeometry(geometry);
  } catch (error) {
    issue(context, [], error instanceof Error ? error.message : String(error));
  }
});

const observationBase = {
  id: z.string().min(1),
  pageNumber: z.number().int().positive(),
  text: z.string(),
  box: boxSchema,
  polygon: polygonSchema.optional()
};

export const nativeObservationSchema = z.object({
  ...observationBase,
  adapterId: z.string().optional(),
  pointBox: boxSchema.optional(),
  mcid: z.number().int().nullable(),
  structureRole: z.string().nullable(),
  geometryMethod: z.enum(['rendered-input-v1', 'pdfjs-viewport-matrix-v1', 'axis-aligned-fallback-v1']),
  font: z.string().optional(),
  fontSize: z.number().optional(),
  isBold: z.boolean().optional(),
  isItalic: z.boolean().optional()
});

export const ocrObservationSchema = z.object({
  ...observationBase,
  adapterId: z.string().optional(),
  confidence: z.number().min(0).max(1),
  model: z.string().optional()
});

const nativeLineSchema = z.object({
  id: z.string(), pageNumber: z.number().int().positive(), text: z.string(), sourceIds: z.array(z.string()), box: boxSchema
});

const sourceMatchSchema = z.object({
  id: z.string(),
  pageNumber: z.number().int().positive(),
  nativeIds: z.array(z.string()),
  ocrId: z.string(),
  nativeCandidateType: z.enum(['line', 'item']),
  method: z.literal('text-geometry-v1'),
  textSimilarity: z.number(),
  geometryOverlap: z.number(),
  confidence: z.number()
});

const conflictSchema = z.object({
  id: z.string(), pageNumber: z.number().int().positive(), nativeIds: z.array(z.string()), ocrId: z.string(),
  nativeText: z.string(), ocrText: z.string(), nativeCriticalTokens: z.array(z.string()),
  ocrCriticalTokens: z.array(z.string()), geometryOverlap: z.number(),
  reason: z.enum(['critical-token-disagreement', 'critical-token-omission'])
});

const spatialRowSchema = z.object({
  id: z.string(), pageNumber: z.number().int().positive(), text: z.string(), sourceIds: z.array(z.string()),
  box: boxSchema, confidence: z.number().nullable()
});

const componentSchema = z.object({ role: z.string(), sourceId: z.string(), text: z.string(), box: boxSchema });
const relationSchema = z.object({
  id: z.string(), pageNumber: z.number().int().positive(), kind: z.literal('chart-category-value'),
  method: z.string(), confidence: z.number(), ambiguity: z.number(), sourceIds: z.array(z.string()), box: boxSchema,
  components: z.array(componentSchema), attributes: z.record(z.string(), z.string()), derived: z.literal(true)
});

const escalationReasonSchema = z.object({
  type: z.enum(['critical-token-conflict', 'critical-token-omission', 'ambiguous-derived-relation', 'low-ocr-confidence', 'uncorroborated-ocr']),
  severity: z.enum(['blocking', 'advisory']),
  sourceIds: z.array(z.string()), count: z.number().int().nonnegative(),
  share: z.number().min(0).max(1)
});

const diagnosticsSchema = z.object({
  thresholds: z.object({
    lowOcrConfidence: z.number().min(0).max(1),
    minimumRelationConfidence: z.number().min(0).max(1),
    maximumRelationAmbiguity: z.number().min(0).max(1),
    uncorroboratedOcrMinimumCount: z.number().int().positive(),
    uncorroboratedOcrMaximumCoverage: z.number().min(0).max(1)
  }),
  ocrObservationCount: z.number().int().nonnegative(), nativeObservationCount: z.number().int().nonnegative(),
  sourceMatchCount: z.number().int().nonnegative(), nativeOcrAssociationCoverage: z.number().min(0).max(1),
  sourceUnmatchedOcrCount: z.number().int().nonnegative(), criticalConflictCount: z.number().int().nonnegative(),
  criticalOmissionCount: z.number().int().nonnegative(), lowConfidenceOcrCount: z.number().int().nonnegative(),
  requiresEscalation: z.boolean(), escalationReasons: z.array(escalationReasonSchema)
});

const provenanceSchema = z.object({
  parserName: z.string(), parserVersion: z.string(), runId: z.string(), createdAt: z.string(),
  nativeAdapter: z.string().optional(), ocrAdapter: z.string().optional(), renderer: z.string().optional(),
  backend: z.string().optional(), configuration: z.record(z.string(), z.unknown()).optional()
});

const pageSpatialBaseSchema = z.object({
  schemaVersion: z.literal('0.2.0'), documentId: z.string(), revisionId: z.string(), documentSha256: z.string().regex(/^[a-f0-9]{64}$/iu),
  pageId: z.string(), pageNumber: z.number().int().positive(), geometry: pageGeometrySchema,
  nativeObservations: z.array(nativeObservationSchema), ocrObservations: z.array(ocrObservationSchema),
  nativeLines: z.array(nativeLineSchema), sourceMatches: z.array(sourceMatchSchema), conflicts: z.array(conflictSchema),
  spatialRows: z.array(spatialRowSchema), derivedRelations: z.array(relationSchema), diagnostics: diagnosticsSchema,
  projection: z.object({ markdown: z.string(), format: z.literal('pagespatial-markdown-v1'), trust: z.literal('untrusted-document-content'), derived: z.literal(true), markdownSource: z.string().min(1) }),
  provenance: provenanceSchema
});

function issue<T>(context: z.core.$RefinementCtx<T>, path: PropertyKey[], message: string): void {
  context.addIssue({ code: 'custom', path, message });
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function validBox(box: readonly number[], width: number, height: number): boolean {
  return box.every(Number.isFinite)
    && box[0]! >= 0
    && box[1]! >= 0
    && box[2]! > box[0]!
    && box[3]! > box[1]!
    && box[2]! <= width
    && box[3]! <= height;
}

function closeEnough(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-9;
}

export const pageSpatialSchema = pageSpatialBaseSchema.superRefine((page, context) => {
  const expectedPageId = `ps:${page.documentSha256.slice(0, 12)}:p${page.pageNumber}`;
  if (page.pageId !== expectedPageId) issue(context, ['pageId'], `Expected canonical page ID ${expectedPageId}.`);

  const nativeIds = page.nativeObservations.map((observation) => observation.id);
  const ocrIds = page.ocrObservations.map((observation) => observation.id);
  const allObservationIds = [...nativeIds, ...ocrIds];
  if (!unique(nativeIds)) issue(context, ['nativeObservations'], 'Native observation IDs must be unique on the page.');
  if (!unique(ocrIds)) issue(context, ['ocrObservations'], 'OCR observation IDs must be unique on the page.');
  if (!unique(allObservationIds)) issue(context, ['ocrObservations'], 'Native and OCR observation IDs must not collide.');
  if (!unique(page.nativeLines.map((line) => line.id))) issue(context, ['nativeLines'], 'Native line IDs must be unique.');
  if (!unique(page.sourceMatches.map((match) => match.id))) issue(context, ['sourceMatches'], 'Source match IDs must be unique.');
  if (!unique(page.conflicts.map((conflict) => conflict.id))) issue(context, ['conflicts'], 'Conflict IDs must be unique.');
  if (!unique(page.spatialRows.map((row) => row.id))) issue(context, ['spatialRows'], 'Spatial row IDs must be unique.');
  if (!unique(page.derivedRelations.map((relation) => relation.id))) issue(context, ['derivedRelations'], 'Derived relation IDs must be unique.');

  const nativeIdSet = new Set(nativeIds);
  const ocrIdSet = new Set(ocrIds);
  const allIdSet = new Set(allObservationIds);
  const validatePageAndBox = (item: {
    pageNumber: number;
    box: readonly number[];
    polygon?: readonly (readonly number[])[];
  }, path: PropertyKey[]): void => {
    if (item.pageNumber !== page.pageNumber) issue(context, [...path, 'pageNumber'], 'Evidence page number must match its parent page.');
    if (!validBox(item.box, page.geometry.width, page.geometry.height)) {
      issue(context, [...path, 'box'], 'Evidence box must be ordered, finite, and within page bounds.');
    }
    item.polygon?.forEach((point, pointIndex) => {
      if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])
        || point[0]! < 0 || point[1]! < 0
        || point[0]! > page.geometry.width || point[1]! > page.geometry.height) {
        issue(context, [...path, 'polygon', pointIndex], 'Polygon points must be finite and within page bounds.');
      }
    });
    if (item.polygon) {
      const xs = item.polygon.map((point) => point[0]!);
      const ys = item.polygon.map((point) => point[1]!);
      const envelope = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      if (envelope.some((value, index) => Math.abs(value - item.box[index]!) > 0.01)) {
        issue(context, [...path, 'polygon'], 'Polygon envelope must match its evidence box.');
      }
      const area = Math.abs(item.polygon.reduce((sum, point, index) => {
        const next = item.polygon![(index + 1) % item.polygon!.length]!;
        return sum + point[0]! * next[1]! - next[0]! * point[1]!;
      }, 0)) / 2;
      if (!Number.isFinite(area) || area <= 0) issue(context, [...path, 'polygon'], 'Polygon must have positive finite area.');
    }
  };
  const validateSourceIds = (ids: readonly string[], allowed: ReadonlySet<string>, path: PropertyKey[]): void => {
    if (!ids.length) issue(context, path, 'Source references must not be empty.');
    if (!unique(ids)) issue(context, path, 'Source references must be unique.');
    for (const id of ids) if (!allowed.has(id)) issue(context, path, `Unknown source reference ${id}.`);
  };

  page.nativeObservations.forEach((item, index) => {
    validatePageAndBox(item, ['nativeObservations', index]);
    if (item.pointBox && item.geometryMethod === 'rendered-input-v1') {
      issue(context, ['nativeObservations', index, 'geometryMethod'], 'Point-space native evidence must declare a point-to-rendered geometry method.');
    }
    if (!item.pointBox && item.geometryMethod !== 'rendered-input-v1') {
      issue(context, ['nativeObservations', index, 'geometryMethod'], 'Rendered native evidence cannot claim a point-space geometry method.');
    }
    if (item.pointBox && item.polygon) {
      issue(context, ['nativeObservations', index, 'polygon'], 'Point-space native evidence cannot carry a polygon with an undeclared coordinate space.');
    }
    if (item.pointBox) {
      const expectedMethod = page.geometry.viewportTransform ? 'pdfjs-viewport-matrix-v1' : 'axis-aligned-fallback-v1';
      if (item.geometryMethod !== expectedMethod) {
        issue(context, ['nativeObservations', index, 'geometryMethod'], `Expected ${expectedMethod} for the page geometry.`);
      }
    }
    if (item.pointBox) {
      const bounds = pointBounds(page.geometry);
      const ordered = item.pointBox.every(Number.isFinite)
        && (bounds === null || item.pointBox[0] >= bounds[0])
        && (bounds === null || item.pointBox[1] >= bounds[1])
        && item.pointBox[2] >= item.pointBox[0]
        && item.pointBox[3] >= item.pointBox[1];
      if (!ordered || (bounds !== null && item.pointBox[2] > bounds[2])
        || (bounds !== null && item.pointBox[3] > bounds[3])) {
        issue(context, ['nativeObservations', index, 'pointBox'], 'Native point box must be ordered, finite, and within declared PDF point bounds.');
      } else {
        try {
          const transformed = pointBoxToRenderedBox(item.pointBox, page.geometry).box;
          if (transformed.some((value, boxIndex) => Math.abs(value - item.box[boxIndex]!) > 0.01)) {
            issue(context, ['nativeObservations', index, 'pointBox'], 'Native point box must transform to its rendered evidence box.');
          }
        } catch (error) {
          issue(context, ['nativeObservations', index, 'pointBox'], error instanceof Error ? error.message : String(error));
        }
      }
    }
  });
  page.ocrObservations.forEach((item, index) => validatePageAndBox(item, ['ocrObservations', index]));
  page.nativeLines.forEach((item, index) => {
    validatePageAndBox(item, ['nativeLines', index]);
    validateSourceIds(item.sourceIds, nativeIdSet, ['nativeLines', index, 'sourceIds']);
  });
  page.sourceMatches.forEach((item, index) => {
    if (item.pageNumber !== page.pageNumber) issue(context, ['sourceMatches', index, 'pageNumber'], 'Match page must equal its parent page.');
    validateSourceIds(item.nativeIds, nativeIdSet, ['sourceMatches', index, 'nativeIds']);
    if (!ocrIdSet.has(item.ocrId)) issue(context, ['sourceMatches', index, 'ocrId'], `Unknown OCR reference ${item.ocrId}.`);
  });
  page.conflicts.forEach((item, index) => {
    if (item.pageNumber !== page.pageNumber) issue(context, ['conflicts', index, 'pageNumber'], 'Conflict page must equal its parent page.');
    validateSourceIds(item.nativeIds, nativeIdSet, ['conflicts', index, 'nativeIds']);
    if (!ocrIdSet.has(item.ocrId)) issue(context, ['conflicts', index, 'ocrId'], `Unknown OCR reference ${item.ocrId}.`);
  });
  page.spatialRows.forEach((item, index) => {
    validatePageAndBox(item, ['spatialRows', index]);
    validateSourceIds(item.sourceIds, ocrIdSet, ['spatialRows', index, 'sourceIds']);
  });
  page.derivedRelations.forEach((item, index) => {
    validatePageAndBox(item, ['derivedRelations', index]);
    validateSourceIds(item.sourceIds, allIdSet, ['derivedRelations', index, 'sourceIds']);
    item.components.forEach((component, componentIndex) => {
      if (!allIdSet.has(component.sourceId)) {
        issue(context, ['derivedRelations', index, 'components', componentIndex, 'sourceId'], `Unknown component source ${component.sourceId}.`);
      }
      if (!validBox(component.box, page.geometry.width, page.geometry.height)) {
        issue(context, ['derivedRelations', index, 'components', componentIndex, 'box'], 'Component box must be within page bounds.');
      }
    });
  });
  page.diagnostics.escalationReasons.forEach((reason, index) => {
    validateSourceIds(reason.sourceIds, allIdSet, ['diagnostics', 'escalationReasons', index, 'sourceIds']);
  });

  const matchedOcrIds = new Set(page.sourceMatches.map((match) => match.ocrId));
  const conflictedOcrIds = new Set(page.conflicts.map((conflict) => conflict.ocrId));
  if (matchedOcrIds.size !== page.sourceMatches.length) {
    issue(context, ['sourceMatches'], 'An OCR observation may participate in at most one source match.');
  }
  if (conflictedOcrIds.size !== page.conflicts.length) {
    issue(context, ['conflicts'], 'An OCR observation may participate in at most one conflict.');
  }
  for (const ocrId of matchedOcrIds) {
    if (conflictedOcrIds.has(ocrId)) issue(context, ['conflicts'], `OCR observation ${ocrId} cannot be both matched and conflicting.`);
  }
  const unmatchedCount = page.ocrObservations.filter((observation) =>
    !matchedOcrIds.has(observation.id) && !conflictedOcrIds.has(observation.id)).length;
  const conflictCount = page.conflicts.filter((conflict) => conflict.reason === 'critical-token-disagreement').length;
  const omissionCount = page.conflicts.filter((conflict) => conflict.reason === 'critical-token-omission').length;
  const expectedCoverage = page.ocrObservations.length ? page.sourceMatches.length / page.ocrObservations.length : 0;
  const expectedDiagnostics = {
    ocrObservationCount: page.ocrObservations.length,
    nativeObservationCount: page.nativeObservations.length,
    sourceMatchCount: page.sourceMatches.length,
    sourceUnmatchedOcrCount: unmatchedCount,
    criticalConflictCount: conflictCount,
    criticalOmissionCount: omissionCount
  } as const;
  for (const [key, expected] of Object.entries(expectedDiagnostics)) {
    if (page.diagnostics[key as keyof typeof expectedDiagnostics] !== expected) {
      issue(context, ['diagnostics', key], `Expected ${key} to equal ${expected}.`);
    }
  }
  if (!closeEnough(page.diagnostics.nativeOcrAssociationCoverage, expectedCoverage)) {
    issue(context, ['diagnostics', 'nativeOcrAssociationCoverage'], `Expected association coverage ${expectedCoverage}.`);
  }
  if (page.diagnostics.requiresEscalation !== (page.diagnostics.escalationReasons.length > 0)) {
    issue(context, ['diagnostics', 'requiresEscalation'], 'Escalation flag must agree with escalation reasons.');
  }

  const lowConfidenceIds = page.ocrObservations
    .filter((observation) => observation.confidence < page.diagnostics.thresholds.lowOcrConfidence)
    .map((observation) => observation.id);
  if (page.diagnostics.lowConfidenceOcrCount !== lowConfidenceIds.length) {
    issue(context, ['diagnostics', 'lowConfidenceOcrCount'], `Expected lowConfidenceOcrCount to equal ${lowConfidenceIds.length}.`);
  }
  const criticalConflictIds = page.conflicts
    .filter((conflict) => conflict.reason === 'critical-token-disagreement')
    .flatMap((conflict) => [conflict.ocrId, ...conflict.nativeIds]);
  const criticalOmissionIds = page.conflicts
    .filter((conflict) => conflict.reason === 'critical-token-omission')
    .flatMap((conflict) => [conflict.ocrId, ...conflict.nativeIds]);
  const ambiguousRelationIds = page.derivedRelations
    .filter((relation) =>
      relation.confidence < page.diagnostics.thresholds.minimumRelationConfidence
      || relation.ambiguity > page.diagnostics.thresholds.maximumRelationAmbiguity)
    .flatMap((relation) => relation.sourceIds);
  const ambiguousCount = page.derivedRelations.filter((relation) =>
    relation.confidence < page.diagnostics.thresholds.minimumRelationConfidence
    || relation.ambiguity > page.diagnostics.thresholds.maximumRelationAmbiguity).length;
  const ocrCount = page.ocrObservations.length;
  const ocrShare = (count: number): number => ocrCount ? count / ocrCount : 0;
  const expectedReasons = new Map<string, { severity: 'blocking' | 'advisory'; count: number; share: number; sourceIds: string[] }>([
    ['critical-token-conflict', { severity: 'blocking', count: conflictCount, share: ocrShare(conflictCount), sourceIds: [...new Set(criticalConflictIds)] }],
    ['critical-token-omission', { severity: 'blocking', count: omissionCount, share: ocrShare(omissionCount), sourceIds: [...new Set(criticalOmissionIds)] }],
    ['ambiguous-derived-relation', {
      severity: 'advisory',
      count: ambiguousCount,
      share: page.derivedRelations.length ? ambiguousCount / page.derivedRelations.length : 0,
      sourceIds: [...new Set(ambiguousRelationIds)]
    }],
    ['low-ocr-confidence', { severity: 'advisory', count: lowConfidenceIds.length, share: ocrShare(lowConfidenceIds.length), sourceIds: lowConfidenceIds }]
  ]);
  const engagedOcrIds = new Set([...matchedOcrIds, ...conflictedOcrIds]);
  const confidentOcr = page.ocrObservations.filter((observation) =>
    observation.confidence >= page.diagnostics.thresholds.lowOcrConfidence);
  const uncorroboratedOcr = confidentOcr.filter((observation) => !engagedOcrIds.has(observation.id));
  const engagedCoverage = confidentOcr.length
    ? (confidentOcr.length - uncorroboratedOcr.length) / confidentOcr.length
    : 1;
  const starvationFires = confidentOcr.length >= page.diagnostics.thresholds.uncorroboratedOcrMinimumCount
    && engagedCoverage <= page.diagnostics.thresholds.uncorroboratedOcrMaximumCoverage;
  expectedReasons.set('uncorroborated-ocr', {
    severity: 'blocking',
    count: starvationFires ? uncorroboratedOcr.length : 0,
    share: starvationFires ? ocrShare(uncorroboratedOcr.length) : 0,
    sourceIds: starvationFires ? uncorroboratedOcr.map((observation) => observation.id) : []
  });
  for (const [type, expected] of expectedReasons) {
    const actual = page.diagnostics.escalationReasons.filter((reason) => reason.type === type);
    if (expected.count === 0 && actual.length) {
      issue(context, ['diagnostics', 'escalationReasons'], `Unexpected ${type} escalation reason.`);
      continue;
    }
    if (expected.count > 0 && actual.length !== 1) {
      issue(context, ['diagnostics', 'escalationReasons'], `Expected exactly one ${type} escalation reason.`);
      continue;
    }
    if (actual[0] && (actual[0].count !== expected.count
      || actual[0].severity !== expected.severity
      || !closeEnough(actual[0].share, expected.share)
      || JSON.stringify([...actual[0].sourceIds].sort()) !== JSON.stringify([...expected.sourceIds].sort()))) {
      issue(context, ['diagnostics', 'escalationReasons'], `${type} escalation details do not match source evidence.`);
    }
  }
});

const pageSpatialDocumentBaseSchema = z.object({
  schemaVersion: z.literal('0.2.0'),
  document: documentIdentitySchema,
  pages: z.array(pageSpatialSchema),
  diagnostics: z.object({
    pageCount: z.number().int().nonnegative(), pagesParsed: z.number().int().nonnegative(),
    pagesRequiringEscalation: z.array(z.number().int().positive()), ocrObservationCount: z.number().int().nonnegative(),
    nativeObservationCount: z.number().int().nonnegative(), sourceMatchCount: z.number().int().nonnegative(),
    nativeOcrAssociationCoverage: z.number().min(0).max(1), criticalConflictCount: z.number().int().nonnegative(),
    criticalOmissionCount: z.number().int().nonnegative()
  }),
  provenance: provenanceSchema
});

export const pageSpatialDocumentSchema = pageSpatialDocumentBaseSchema.superRefine((document, context) => {
  if (document.pages.length !== document.document.pageCount) {
    issue(context, ['pages'], `Expected ${document.document.pageCount} parsed pages.`);
  }
  const pageNumbers = document.pages.map((page) => page.pageNumber);
  if (!unique(pageNumbers.map(String))) issue(context, ['pages'], 'Page numbers must be unique.');
  const expectedPageNumbers = Array.from({ length: document.document.pageCount }, (_, index) => index + 1);
  if (pageNumbers.some((pageNumber, index) => pageNumber !== expectedPageNumbers[index])) {
    issue(context, ['pages'], 'Pages must be ordered and complete from 1 through pageCount.');
  }
  if (!unique(document.pages.map((page) => page.pageId))) issue(context, ['pages'], 'Page IDs must be unique.');
  for (const [index, page] of document.pages.entries()) {
    if (page.documentId !== document.document.documentId) issue(context, ['pages', index, 'documentId'], 'Page document ID must match document identity.');
    if (page.revisionId !== document.document.revisionId) issue(context, ['pages', index, 'revisionId'], 'Page revision ID must match document identity.');
    if (page.documentSha256 !== document.document.sha256) issue(context, ['pages', index, 'documentSha256'], 'Page SHA-256 must match document identity.');
    if (page.provenance.runId !== document.provenance.runId) issue(context, ['pages', index, 'provenance', 'runId'], 'Page and document run IDs must match.');
  }

  const ocrObservationCount = document.pages.reduce((sum, page) => sum + page.ocrObservations.length, 0);
  const nativeObservationCount = document.pages.reduce((sum, page) => sum + page.nativeObservations.length, 0);
  const sourceMatchCount = document.pages.reduce((sum, page) => sum + page.sourceMatches.length, 0);
  const criticalConflictCount = document.pages.reduce((sum, page) => sum + page.diagnostics.criticalConflictCount, 0);
  const criticalOmissionCount = document.pages.reduce((sum, page) => sum + page.diagnostics.criticalOmissionCount, 0);
  const pagesRequiringEscalation = document.pages
    .filter((page) => page.diagnostics.requiresEscalation)
    .map((page) => page.pageNumber);
  const expectedCoverage = ocrObservationCount ? sourceMatchCount / ocrObservationCount : 0;
  const expectedDiagnostics = {
    pageCount: document.document.pageCount,
    pagesParsed: document.pages.length,
    ocrObservationCount,
    nativeObservationCount,
    sourceMatchCount,
    criticalConflictCount,
    criticalOmissionCount
  } as const;
  for (const [key, expected] of Object.entries(expectedDiagnostics)) {
    if (document.diagnostics[key as keyof typeof expectedDiagnostics] !== expected) {
      issue(context, ['diagnostics', key], `Expected ${key} to equal ${expected}.`);
    }
  }
  if (!closeEnough(document.diagnostics.nativeOcrAssociationCoverage, expectedCoverage)) {
    issue(context, ['diagnostics', 'nativeOcrAssociationCoverage'], `Expected association coverage ${expectedCoverage}.`);
  }
  if (JSON.stringify(document.diagnostics.pagesRequiringEscalation) !== JSON.stringify(pagesRequiringEscalation)) {
    issue(context, ['diagnostics', 'pagesRequiringEscalation'], 'Escalation page list must agree with page diagnostics.');
  }
});

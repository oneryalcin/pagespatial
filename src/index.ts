export type * from './types.js';
export type * from './adapters.js';
export type { AssociationOptions, AssociationResult } from './merge.js';
export type { DiagnosticOptions } from './diagnostics.js';
export type { BuildPageSpatialInput, ParseOptions } from './parser.js';

export { assertBox, assertBoxWithin, assertPageGeometry, boxArea, intersectionArea, overlapOverSmaller, pointBounds, pointBoxToRenderedBox, renderedPixelsPerPoint, roundBox, transformPoint, unionBoxes } from './geometry.js';
export { createDerivedId, createObservationId, createPageId } from './ids.js';
export { criticalTokens, criticalTokensAgree, criticalTokensCompatible, normalizeEvidenceText, sameTokenMultiset, textSimilarity } from './text.js';
export { buildNativeLines, buildSpatialRows, readingOrder } from './reading-order.js';
export { associateNativeAndOcr } from './merge.js';
export { inferSimpleYearValueRelations } from './relations.js';
export { buildDiagnostics, resolveDiagnosticOptions } from './diagnostics.js';
export { attributeConfirmations, countConfirmedRegions, countRecoveredObservations, duplicatesFirstPass, findUnreadInkRegions, mapRecoveredBox } from './ink.js';
export type { RasterData } from './ink.js';
export { projectMarkdown } from './projection.js';
export { buildPageSpatial, createParser } from './parser.js';
export { documentIdentitySchema, nativeObservationSchema, ocrObservationSchema, pageGeometrySchema, pageSpatialDocumentSchema, pageSpatialSchema } from './schema.js';

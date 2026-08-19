export type Box = readonly [number, number, number, number];
export type Point = readonly [number, number];
export type Polygon = readonly Point[];
export type ViewportTransform = readonly [number, number, number, number, number, number];

export interface DocumentIdentity {
  documentId: string;
  revisionId: string;
  sha256: string;
  pageCount: number;
  sourceUri?: string;
}

export interface DocumentSource<TData = unknown> {
  identity: DocumentIdentity;
  /** Browser File/ArrayBuffer, server object-store handle, byte stream, or adapter-specific reference. */
  data: TData;
  mimeType?: string;
}

export interface PageGeometry {
  width: number;
  height: number;
  /** PDF user-space bounds [x0, y0, x1, y1]. Defaults to [0, 0, pointWidth, pointHeight] for legacy callers. */
  pointBounds?: Box;
  pointWidth?: number;
  pointHeight?: number;
  rotation?: number;
  viewportTransform?: ViewportTransform;
}

export interface ObservationBase {
  id?: string;
  pageNumber: number;
  text: string;
  box: Box;
  polygon?: Polygon;
}

export interface NativeObservationInput extends ObservationBase {
  pointBox?: Box;
  mcid?: number | null;
  structureRole?: string | null;
  font?: string;
  fontSize?: number;
  isBold?: boolean;
  isItalic?: boolean;
}

export interface NativePointObservationInput extends Omit<NativeObservationInput, 'box'> {
  box?: Box;
  pointBox: Box;
}

export interface NativeObservation extends ObservationBase {
  id: string;
  adapterId?: string;
  pointBox?: Box;
  mcid: number | null;
  structureRole: string | null;
  geometryMethod: 'rendered-input-v1' | 'pdfjs-viewport-matrix-v1' | 'axis-aligned-fallback-v1';
  font?: string;
  fontSize?: number;
  isBold?: boolean;
  isItalic?: boolean;
}

export interface OcrObservationInput extends ObservationBase {
  confidence: number;
  model?: string;
}

export interface OcrObservation extends OcrObservationInput {
  id: string;
  adapterId?: string;
}

export interface NativeLine {
  id: string;
  pageNumber: number;
  text: string;
  sourceIds: string[];
  box: Box;
}

export interface SourceMatch {
  id: string;
  pageNumber: number;
  nativeIds: string[];
  ocrId: string;
  nativeCandidateType: 'line' | 'item';
  method: 'text-geometry-v1';
  textSimilarity: number;
  geometryOverlap: number;
  confidence: number;
}

export type ConflictReason = 'critical-token-disagreement' | 'critical-token-omission';

export interface EvidenceConflict {
  id: string;
  pageNumber: number;
  nativeIds: string[];
  ocrId: string;
  nativeText: string;
  ocrText: string;
  nativeCriticalTokens: string[];
  ocrCriticalTokens: string[];
  geometryOverlap: number;
  reason: ConflictReason;
}

export interface SpatialRow {
  id: string;
  pageNumber: number;
  text: string;
  sourceIds: string[];
  box: Box;
  confidence: number | null;
}

export interface RelationComponent {
  role: string;
  sourceId: string;
  text: string;
  box: Box;
}

export interface DerivedRelation {
  id: string;
  pageNumber: number;
  kind: 'chart-category-value';
  method: string;
  confidence: number;
  ambiguity: number;
  sourceIds: string[];
  box: Box;
  components: RelationComponent[];
  attributes: Record<string, string>;
  derived: true;
}

export type EscalationReasonType =
  | 'critical-token-conflict'
  | 'critical-token-omission'
  | 'ambiguous-derived-relation'
  | 'low-ocr-confidence';

export interface EscalationReason {
  type: EscalationReasonType;
  sourceIds: string[];
  count: number;
}

export interface PageDiagnostics {
  thresholds: {
    lowOcrConfidence: number;
    minimumRelationConfidence: number;
    maximumRelationAmbiguity: number;
  };
  ocrObservationCount: number;
  nativeObservationCount: number;
  sourceMatchCount: number;
  nativeOcrAssociationCoverage: number;
  sourceUnmatchedOcrCount: number;
  criticalConflictCount: number;
  criticalOmissionCount: number;
  lowConfidenceOcrCount: number;
  requiresEscalation: boolean;
  escalationReasons: EscalationReason[];
}

export interface ExtractionProvenance {
  parserName: string;
  parserVersion: string;
  runId: string;
  createdAt: string;
  nativeAdapter?: string;
  ocrAdapter?: string;
  renderer?: string;
  backend?: string;
  configuration?: Record<string, unknown>;
}

export interface PageProjection {
  markdown: string;
  format: 'pagespatial-markdown-v1';
  trust: 'untrusted-document-content';
  derived: true;
}

export interface PageSpatial {
  schemaVersion: '0.1.0';
  documentId: string;
  revisionId: string;
  documentSha256: string;
  pageId: string;
  pageNumber: number;
  geometry: PageGeometry;
  nativeObservations: NativeObservation[];
  ocrObservations: OcrObservation[];
  nativeLines: NativeLine[];
  sourceMatches: SourceMatch[];
  conflicts: EvidenceConflict[];
  spatialRows: SpatialRow[];
  derivedRelations: DerivedRelation[];
  diagnostics: PageDiagnostics;
  projection: PageProjection;
  provenance: ExtractionProvenance;
}

export interface DocumentDiagnostics {
  pageCount: number;
  pagesParsed: number;
  pagesRequiringEscalation: number[];
  ocrObservationCount: number;
  nativeObservationCount: number;
  sourceMatchCount: number;
  nativeOcrAssociationCoverage: number;
  criticalConflictCount: number;
  criticalOmissionCount: number;
}

export interface PageSpatialDocument {
  schemaVersion: '0.1.0';
  document: DocumentIdentity;
  pages: PageSpatial[];
  diagnostics: DocumentDiagnostics;
  provenance: ExtractionProvenance;
}

export interface NativePageResult {
  pageNumber: number;
  geometry: Partial<PageGeometry>;
  observations: Array<NativeObservationInput | NativePointObservationInput>;
  markdown?: string;
}

export interface NativeDocumentResult {
  pageCount: number;
  pages: NativePageResult[];
}

export interface RenderedPage<TData = unknown> {
  pageNumber: number;
  geometry: PageGeometry;
  /** Runtime-specific transferable canvas, bitmap, byte buffer, or server handle. */
  data: TData;
  mimeType?: string;
  release?: () => void | Promise<void>;
}

export interface OcrPageResult {
  pageNumber: number;
  observations: OcrObservationInput[];
  backend?: string;
}

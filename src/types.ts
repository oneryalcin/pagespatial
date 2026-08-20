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
  /**
   * Set when the observation came from a deliberate second extraction pass
   * (e.g. 'zoom-retry-v1' over an unread-ink region). Second-pass evidence is
   * known single-witness by construction and is excluded from the
   * coverage-starvation denominator.
   */
  recoveryMethod?: string;
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
  | 'low-ocr-confidence'
  | 'uncorroborated-ocr'
  | 'unread-ink-region';

/**
 * Derived from the reason type, never from a threshold: contradictory
 * evidence (critical-token reasons) and unverifiable-by-construction evidence
 * (uncorroborated single-witness pages) block; individually weak evidence
 * (low confidence, ambiguous relations) advises. Lets a downstream router
 * adopt "blocking only" without PageSpatial choosing for it.
 */
export type EscalationSeverity = 'blocking' | 'advisory';

export interface EscalationReason {
  type: EscalationReasonType;
  severity: EscalationSeverity;
  sourceIds: string[];
  count: number;
  /** count over its denominator (OCR observations, or derived relations for ambiguity), 0..1. */
  share: number;
}

export interface PageDiagnostics {
  thresholds: {
    lowOcrConfidence: number;
    minimumRelationConfidence: number;
    maximumRelationAmbiguity: number;
    /** Minimum confident OCR observations before coverage starvation can fire. */
    uncorroboratedOcrMinimumCount: number;
    /** Maximum engaged share of confident OCR below which the page is single-witness. */
    uncorroboratedOcrMaximumCoverage: number;
  };
  ocrObservationCount: number;
  /** Second-pass observations (recoveryMethod set) within ocrObservationCount. */
  recoveredObservationCount: number;
  nativeObservationCount: number;
  sourceMatchCount: number;
  /**
   * sourceMatches over first-pass OCR observations only: recoveries are
   * single-witness by construction and sit outside this ratio entirely.
   */
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
  regionRecoveryAdapter?: string;
  renderer?: string;
  backend?: string;
  configuration?: Record<string, unknown>;
}

export interface PageProjection {
  markdown: string;
  format: 'pagespatial-markdown-v1';
  trust: 'untrusted-document-content';
  derived: true;
  /**
   * Which extractor produced the native-structure section, e.g.
   * 'pdf-inspector' or 'pdfjs-deduplicated'. 'pagespatial-native-lines' means
   * no adapter markdown was available and native lines were rendered instead.
   * Recorded so adapter-fallback rates are measurable per page.
   */
  markdownSource: string;
}

/**
 * A page area that carries ink but no observations from either engine — an
 * evidence desert. Structured regions (bimodal print) are candidates for
 * second-pass recovery; pictorial regions (continuous-tone) are recorded but
 * not re-read.
 */
/**
 * A recovery reading that duplicated evidence the record already holds
 * (same place, similar text). The duplicate itself is not persisted as an
 * observation — this receipt is what remains, and it is self-verifying:
 * a confirmation is only valid when it actually duplicates a retained
 * observation, so a forged receipt would have to match real evidence at
 * that location, which would make the region genuinely corroborated.
 */
export interface RecoveryConfirmation {
  /** Where the duplicate reading landed, in rendered pixels. */
  box: Box;
  /** What the second pass read there. */
  text: string;
}

export interface UnreadInkRegion {
  /** Region bounds in rendered pixels. */
  box: Box;
  kind: 'structured' | 'pictorial';
  inkDensity: number;
  midToneFraction: number;
  recoveredObservationCount: number;
  /**
   * Receipts for recovery output that duplicated existing evidence.
   * A structured region with zero recoveries but valid confirmations is
   * corroborated (typically a filled background around read text) and does
   * not escalate; a structured region with neither is an evidence desert
   * and escalates as blocking unread-ink residue.
   */
  confirmations: RecoveryConfirmation[];
}

export interface PageSpatial {
  schemaVersion: '0.5.0';
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
  /**
   * Present when unread-ink analysis ran (a region-recovery adapter was
   * installed); absent means the analysis never happened. An empty array is
   * a positive claim — the page was analyzed and no unread ink was found.
   */
  unreadInkRegions?: UnreadInkRegion[];
  diagnostics: PageDiagnostics;
  projection: PageProjection;
  provenance: ExtractionProvenance;
}

export interface DocumentDiagnostics {
  pageCount: number;
  pagesParsed: number;
  pagesRequiringEscalation: number[];
  ocrObservationCount: number;
  /** Second-pass observations (recoveryMethod set) within ocrObservationCount. */
  recoveredObservationCount: number;
  nativeObservationCount: number;
  sourceMatchCount: number;
  /**
   * sourceMatches over first-pass OCR observations only: recoveries are
   * single-witness by construction and sit outside this ratio entirely.
   */
  nativeOcrAssociationCoverage: number;
  criticalConflictCount: number;
  criticalOmissionCount: number;
}

export interface PageSpatialDocument {
  schemaVersion: '0.5.0';
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
  /** Which extractor produced `markdown` (e.g. 'pdf-inspector', 'pdfjs-deduplicated'). */
  markdownSource?: string;
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

import type {
  DerivedRelation,
  EvidenceConflict,
  NativeObservation,
  OcrObservation,
  PageDiagnostics,
  SourceMatch
} from './types.js';

export interface DiagnosticOptions {
  lowOcrConfidence?: number;
  minimumRelationConfidence?: number;
  maximumRelationAmbiguity?: number;
}

export function resolveDiagnosticOptions(options: DiagnosticOptions = {}): Required<DiagnosticOptions> {
  return {
    lowOcrConfidence: options.lowOcrConfidence ?? 0.5,
    minimumRelationConfidence: options.minimumRelationConfidence ?? 0.7,
    maximumRelationAmbiguity: options.maximumRelationAmbiguity ?? 0.25
  };
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

export function buildDiagnostics(input: {
  nativeObservations: readonly NativeObservation[];
  ocrObservations: readonly OcrObservation[];
  sourceMatches: readonly SourceMatch[];
  conflicts: readonly EvidenceConflict[];
  derivedRelations: readonly DerivedRelation[];
  options?: DiagnosticOptions;
}): PageDiagnostics {
  const policy = resolveDiagnosticOptions(input.options);
  const lowThreshold = policy.lowOcrConfidence;
  const relationThreshold = policy.minimumRelationConfidence;
  const ambiguityThreshold = policy.maximumRelationAmbiguity;
  const matched = new Set(input.sourceMatches.map((match) => match.ocrId));
  const conflictIds = new Set(input.conflicts.map((conflict) => conflict.ocrId));
  const sourceUnmatched = input.ocrObservations.filter((observation) => !matched.has(observation.id) && !conflictIds.has(observation.id));
  const lowConfidence = input.ocrObservations.filter((observation) => observation.confidence < lowThreshold);
  const criticalConflicts = input.conflicts.filter((conflict) => conflict.reason === 'critical-token-disagreement');
  const criticalOmissions = input.conflicts.filter((conflict) => conflict.reason === 'critical-token-omission');
  const ambiguousRelations = input.derivedRelations.filter((relation) =>
    relation.confidence < relationThreshold || relation.ambiguity > ambiguityThreshold);
  const escalationReasons: PageDiagnostics['escalationReasons'] = [];

  if (criticalConflicts.length) escalationReasons.push({
    type: 'critical-token-conflict',
    sourceIds: uniqueIds(criticalConflicts.flatMap((conflict) => [conflict.ocrId, ...conflict.nativeIds])),
    count: criticalConflicts.length
  });
  if (criticalOmissions.length) escalationReasons.push({
    type: 'critical-token-omission',
    sourceIds: uniqueIds(criticalOmissions.flatMap((conflict) => [conflict.ocrId, ...conflict.nativeIds])),
    count: criticalOmissions.length
  });
  if (ambiguousRelations.length) escalationReasons.push({
    type: 'ambiguous-derived-relation',
    sourceIds: uniqueIds(ambiguousRelations.flatMap((relation) => relation.sourceIds)),
    count: ambiguousRelations.length
  });
  if (lowConfidence.length) escalationReasons.push({
    type: 'low-ocr-confidence',
    sourceIds: lowConfidence.map((observation) => observation.id),
    count: lowConfidence.length
  });

  return {
    thresholds: {
      lowOcrConfidence: lowThreshold,
      minimumRelationConfidence: relationThreshold,
      maximumRelationAmbiguity: ambiguityThreshold
    },
    ocrObservationCount: input.ocrObservations.length,
    nativeObservationCount: input.nativeObservations.length,
    sourceMatchCount: input.sourceMatches.length,
    nativeOcrAssociationCoverage: input.ocrObservations.length
      ? input.sourceMatches.length / input.ocrObservations.length
      : 0,
    sourceUnmatchedOcrCount: sourceUnmatched.length,
    criticalConflictCount: criticalConflicts.length,
    criticalOmissionCount: criticalOmissions.length,
    lowConfidenceOcrCount: lowConfidence.length,
    requiresEscalation: escalationReasons.length > 0,
    escalationReasons
  };
}

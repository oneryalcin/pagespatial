import { UNCORROBORATED_OCR_MAXIMUM_COVERAGE, UNCORROBORATED_OCR_MINIMUM_COUNT } from './tuning.js';
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
  uncorroboratedOcrMinimumCount?: number;
  uncorroboratedOcrMaximumCoverage?: number;
}

export function resolveDiagnosticOptions(options: DiagnosticOptions = {}): Required<DiagnosticOptions> {
  return {
    lowOcrConfidence: options.lowOcrConfidence ?? 0.5,
    minimumRelationConfidence: options.minimumRelationConfidence ?? 0.7,
    maximumRelationAmbiguity: options.maximumRelationAmbiguity ?? 0.25,
    uncorroboratedOcrMinimumCount: options.uncorroboratedOcrMinimumCount ?? UNCORROBORATED_OCR_MINIMUM_COUNT,
    uncorroboratedOcrMaximumCoverage: options.uncorroboratedOcrMaximumCoverage ?? UNCORROBORATED_OCR_MAXIMUM_COVERAGE
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
  const ocrShare = (count: number): number => input.ocrObservations.length ? count / input.ocrObservations.length : 0;

  if (criticalConflicts.length) escalationReasons.push({
    type: 'critical-token-conflict',
    severity: 'blocking',
    sourceIds: uniqueIds(criticalConflicts.flatMap((conflict) => [conflict.ocrId, ...conflict.nativeIds])),
    count: criticalConflicts.length,
    share: ocrShare(criticalConflicts.length)
  });
  if (criticalOmissions.length) escalationReasons.push({
    type: 'critical-token-omission',
    severity: 'blocking',
    sourceIds: uniqueIds(criticalOmissions.flatMap((conflict) => [conflict.ocrId, ...conflict.nativeIds])),
    count: criticalOmissions.length,
    share: ocrShare(criticalOmissions.length)
  });
  if (ambiguousRelations.length) escalationReasons.push({
    type: 'ambiguous-derived-relation',
    severity: 'advisory',
    sourceIds: uniqueIds(ambiguousRelations.flatMap((relation) => relation.sourceIds)),
    count: ambiguousRelations.length,
    share: input.derivedRelations.length ? ambiguousRelations.length / input.derivedRelations.length : 0
  });
  if (lowConfidence.length) escalationReasons.push({
    type: 'low-ocr-confidence',
    severity: 'advisory',
    sourceIds: lowConfidence.map((observation) => observation.id),
    count: lowConfidence.length,
    share: ocrShare(lowConfidence.length)
  });
  // Coverage starvation: confident OCR that neither matches nor conflicts
  // with the native layer is single-witness evidence. When almost all of a
  // page's confident OCR is single-witness, nothing on the page could have
  // caught a confidently-wrong reading, so the page escalates as
  // unverifiable-by-construction (blocking).
  const engaged = new Set([...matched, ...conflictIds]);
  const confident = input.ocrObservations.filter((observation) => observation.confidence >= lowThreshold);
  const uncorroborated = confident.filter((observation) => !engaged.has(observation.id));
  const engagedCoverage = confident.length ? (confident.length - uncorroborated.length) / confident.length : 1;
  if (confident.length >= policy.uncorroboratedOcrMinimumCount
    && engagedCoverage <= policy.uncorroboratedOcrMaximumCoverage) {
    escalationReasons.push({
      type: 'uncorroborated-ocr',
      severity: 'blocking',
      sourceIds: uncorroborated.map((observation) => observation.id),
      count: uncorroborated.length,
      share: ocrShare(uncorroborated.length)
    });
  }

  return {
    thresholds: {
      lowOcrConfidence: lowThreshold,
      minimumRelationConfidence: relationThreshold,
      maximumRelationAmbiguity: ambiguityThreshold,
      uncorroboratedOcrMinimumCount: policy.uncorroboratedOcrMinimumCount,
      uncorroboratedOcrMaximumCoverage: policy.uncorroboratedOcrMaximumCoverage
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

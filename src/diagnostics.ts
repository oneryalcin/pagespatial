import { countConfirmedRegions, countRecoveredObservations, regionEligibleForResidue } from './ink.js';
import { REFERENCE_RENDER_SCALE, UNCORROBORATED_OCR_MAXIMUM_COVERAGE, UNCORROBORATED_OCR_MINIMUM_COUNT } from './tuning.js';
import type {
  DerivedRelation,
  EvidenceConflict,
  NativeObservation,
  OcrObservation,
  PageDiagnostics,
  SourceMatch,
  UnreadInkRegion
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
  unreadInkRegions?: readonly UnreadInkRegion[];
  /** Rendered pixels per PDF point, for geometric residue eligibility. */
  pixelsPerPoint?: number;
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
  // Second-pass recoveries (recoveryMethod set) are deliberately extracted
  // from regions known to be single-witness; counting them here would let
  // successful recovery re-trigger the very alarm it answers.
  const confident = input.ocrObservations.filter((observation) =>
    observation.confidence >= lowThreshold && !observation.recoveryMethod);
  const uncorroborated = confident.filter((observation) => !engaged.has(observation.id));
  const engagedCoverage = confident.length ? (confident.length - uncorroborated.length) / confident.length : 1;
  if (confident.length >= policy.uncorroboratedOcrMinimumCount
    && engagedCoverage < policy.uncorroboratedOcrMaximumCoverage) {
    escalationReasons.push({
      type: 'uncorroborated-ocr',
      severity: 'blocking',
      sourceIds: uncorroborated.map((observation) => observation.id),
      count: uncorroborated.length,
      // share uses ALL OCR observations as its denominator, consistent with
      // every other reason; the firing condition uses confident observations
      // only, so share and (1 - engagedCoverage) differ on mixed-confidence
      // pages.
      share: ocrShare(uncorroborated.length)
    });
  }
  // Residue: structured unread-ink regions that recovery could not read are
  // evidence deserts with no witness at all — blocking. Pictorial regions
  // are recorded on the page but never alarm. Residue is DERIVED from the
  // retained recovered observations (never from the regions' self-declared
  // counts) so editing a count cannot silently clear the escalation.
  const regions = input.unreadInkRegions ?? [];
  const derivedCounts = countRecoveredObservations(regions, input.ocrObservations);
  // A region whose recovery output all duplicated existing evidence is
  // corroborated, not unread: valid confirmation receipts clear residue.
  const confirmedCounts = countConfirmedRegions(regions, [
    ...input.nativeObservations.map((observation) => ({ box: observation.box, text: observation.text })),
    ...input.ocrObservations
      .filter((observation) => !observation.recoveryMethod)
      .map((observation) => ({ box: observation.box, text: observation.text }))
  ]);
  const residue = regions.filter((region, index) =>
    region.kind === 'structured'
    && regionEligibleForResidue(region, input.pixelsPerPoint ?? REFERENCE_RENDER_SCALE)
    && derivedCounts[index] === 0 && confirmedCounts[index] === 0);
  const structuredCount = regions.filter((region) => region.kind === 'structured').length;
  if (residue.length) {
    escalationReasons.push({
      type: 'unread-ink-region',
      severity: 'blocking',
      sourceIds: [],
      count: residue.length,
      // Fraction of structured regions still unread; pictorial regions are
      // not recoverable by design and stay out of the denominator.
      share: structuredCount ? residue.length / structuredCount : 0
    });
  }

  const recoveredIds = new Set(input.ocrObservations
    .filter((observation) => observation.recoveryMethod)
    .map((observation) => observation.id));
  const corroboratableCount = input.ocrObservations.length - recoveredIds.size;

  return {
    thresholds: {
      lowOcrConfidence: lowThreshold,
      minimumRelationConfidence: relationThreshold,
      maximumRelationAmbiguity: ambiguityThreshold,
      uncorroboratedOcrMinimumCount: policy.uncorroboratedOcrMinimumCount,
      uncorroboratedOcrMaximumCoverage: policy.uncorroboratedOcrMaximumCoverage
    },
    ocrObservationCount: input.ocrObservations.length,
    recoveredObservationCount: recoveredIds.size,
    nativeObservationCount: input.nativeObservations.length,
    sourceMatchCount: input.sourceMatches.length,
    // Coverage over first-pass observations only: recoveries are
    // single-witness by construction and sit outside the ratio entirely.
    nativeOcrAssociationCoverage: corroboratableCount
      ? input.sourceMatches.filter((match) => !recoveredIds.has(match.ocrId)).length / corroboratableCount
      : 0,
    sourceUnmatchedOcrCount: sourceUnmatched.length,
    criticalConflictCount: criticalConflicts.length,
    criticalOmissionCount: criticalOmissions.length,
    lowConfidenceOcrCount: lowConfidence.length,
    requiresEscalation: escalationReasons.length > 0,
    escalationReasons
  };
}

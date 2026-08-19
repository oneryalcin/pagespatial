import { overlapOverSmaller } from './geometry.js';
import { buildNativeLines } from './reading-order.js';
import { criticalTokens, criticalTokensAgree, textSimilarity } from './text.js';
import {
  ASSOCIATION_BUCKET_PT,
  ASSOCIATION_GEOMETRY_WEIGHT,
  ASSOCIATION_MIN_GEOMETRY_OVERLAP,
  ASSOCIATION_MIN_TEXT_SIMILARITY,
  ASSOCIATION_TEXT_WEIGHT,
  CONFLICT_MIN_GEOMETRY_OVERLAP,
  CONFLICT_MIN_TEXT_SIMILARITY,
  REFERENCE_RENDER_SCALE
} from './tuning.js';
import type {
  Box,
  EvidenceConflict,
  NativeLine,
  NativeObservation,
  OcrObservation,
  SourceMatch
} from './types.js';

interface Candidate {
  id: string;
  text: string;
  sourceIds: string[];
  box: Box;
  memberBoxes: Box[];
  type: 'line' | 'item';
}

export interface AssociationOptions {
  /** Rendered pixels per PDF point; spatial defaults scale with it. Explicit bucketSize wins. */
  pixelsPerPoint?: number;
  bucketSize?: number;
  minimumTextSimilarity?: number;
  minimumGeometryOverlap?: number;
  criticalCandidateTextSimilarity?: number;
  criticalCandidateGeometryOverlap?: number;
}

export interface AssociationResult {
  nativeLines: NativeLine[];
  sourceMatches: SourceMatch[];
  conflicts: EvidenceConflict[];
  matchedOcrIds: Set<string>;
}

function geometryOverlap(candidate: Candidate, ocrBox: Box): number {
  return Math.max(...candidate.memberBoxes.map((box) => overlapOverSmaller(box, ocrBox)));
}

export function associateNativeAndOcr(
  nativeObservations: readonly NativeObservation[],
  ocrObservations: readonly OcrObservation[],
  options: AssociationOptions = {}
): AssociationResult {
  const pixelsPerPoint = options.pixelsPerPoint ?? REFERENCE_RENDER_SCALE;
  if (!Number.isFinite(pixelsPerPoint) || pixelsPerPoint <= 0) {
    throw new Error('pixelsPerPoint must be a positive finite number.');
  }
  const bucketSize = options.bucketSize ?? ASSOCIATION_BUCKET_PT * pixelsPerPoint;
  const minimumText = options.minimumTextSimilarity ?? ASSOCIATION_MIN_TEXT_SIMILARITY;
  const minimumGeometry = options.minimumGeometryOverlap ?? ASSOCIATION_MIN_GEOMETRY_OVERLAP;
  const criticalText = options.criticalCandidateTextSimilarity ?? CONFLICT_MIN_TEXT_SIMILARITY;
  const criticalGeometry = options.criticalCandidateGeometryOverlap ?? CONFLICT_MIN_GEOMETRY_OVERLAP;
  if (!Number.isFinite(bucketSize) || bucketSize < 1 || bucketSize > 4096) {
    throw new Error('Association bucketSize must be between 1 and 4096.');
  }
  for (const [label, value] of [
    ['minimumTextSimilarity', minimumText],
    ['minimumGeometryOverlap', minimumGeometry],
    ['criticalCandidateTextSimilarity', criticalText],
    ['criticalCandidateGeometryOverlap', criticalGeometry]
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be between 0 and 1.`);
  }
  const nativeLines = buildNativeLines(nativeObservations, pixelsPerPoint);
  const boxById = new Map(nativeObservations.map((item) => [item.id, item.box]));
  const candidates: Candidate[] = [
    ...nativeLines.map((line) => ({
      id: line.id,
      text: line.text,
      sourceIds: line.sourceIds,
      box: line.box,
      memberBoxes: line.sourceIds.map((id) => boxById.get(id)!),
      type: 'line' as const
    })),
    ...nativeObservations.map((item) => ({
      id: `item:${item.id}`,
      text: item.text,
      sourceIds: [item.id],
      box: item.box,
      memberBoxes: [item.box],
      type: 'item' as const
    }))
  ];

  const buckets = new Map<number, Candidate[]>();
  for (const candidate of candidates) {
    const first = Math.floor(candidate.box[1] / bucketSize);
    const last = Math.floor(candidate.box[3] / bucketSize);
    for (let bucket = first; bucket <= last; bucket += 1) {
      const entries = buckets.get(bucket) ?? [];
      entries.push(candidate);
      buckets.set(bucket, entries);
    }
  }

  const sourceMatches: SourceMatch[] = [];
  const conflicts: EvidenceConflict[] = [];
  const matchedOcrIds = new Set<string>();

  for (const ocr of ocrObservations) {
    const nearby = new Map<string, Candidate>();
    const first = Math.floor(ocr.box[1] / bucketSize) - 1;
    const last = Math.floor(ocr.box[3] / bucketSize) + 1;
    for (let bucket = first; bucket <= last; bucket += 1) {
      for (const candidate of buckets.get(bucket) ?? []) nearby.set(candidate.id, candidate);
    }

    const scored = [...nearby.values()].map((native) => {
      const textual = textSimilarity(native.text, ocr.text);
      const geometric = geometryOverlap(native, ocr.box);
      return {
        native,
        textual,
        geometric,
        score: textual * ASSOCIATION_TEXT_WEIGHT + geometric * ASSOCIATION_GEOMETRY_WEIGHT
      };
    });
    const best = scored.sort((left, right) => right.score - left.score)[0];
    const criticalLocal = scored
      .filter((candidate) => candidate.geometric >= criticalGeometry && candidate.textual >= criticalText)
      .sort((left, right) => right.textual - left.textual || right.geometric - left.geometric)[0];

    if (criticalLocal) {
      const nativeCritical = criticalTokens(criticalLocal.native.text);
      const ocrCritical = criticalTokens(ocr.text);
      if ((nativeCritical.length || ocrCritical.length) && !criticalTokensAgree(nativeCritical, ocrCritical)) {
        conflicts.push({
          id: `conflict:${ocr.id}`,
          pageNumber: ocr.pageNumber,
          nativeIds: criticalLocal.native.sourceIds,
          ocrId: ocr.id,
          nativeText: criticalLocal.native.text,
          ocrText: ocr.text,
          nativeCriticalTokens: nativeCritical,
          ocrCriticalTokens: ocrCritical,
          geometryOverlap: criticalLocal.geometric,
          reason: nativeCritical.length && ocrCritical.length
            ? 'critical-token-disagreement'
            : 'critical-token-omission'
        });
        continue;
      }
    }

    if (best && best.textual >= minimumText && best.geometric >= minimumGeometry) {
      matchedOcrIds.add(ocr.id);
      sourceMatches.push({
        id: `match:${ocr.id}`,
        pageNumber: ocr.pageNumber,
        nativeIds: best.native.sourceIds,
        ocrId: ocr.id,
        nativeCandidateType: best.native.type,
        method: 'text-geometry-v1',
        textSimilarity: best.textual,
        geometryOverlap: best.geometric,
        confidence: Math.min(1, best.score)
      });
    }
  }

  return { nativeLines, sourceMatches, conflicts, matchedOcrIds };
}

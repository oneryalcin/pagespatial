import { overlapOverSmaller } from './geometry.js';
import { buildNativeLines } from './reading-order.js';
import { criticalTokens, sameTokenMultiset, textSimilarity } from './text.js';
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
  const bucketSize = options.bucketSize ?? 64;
  const minimumText = options.minimumTextSimilarity ?? 0.72;
  const minimumGeometry = options.minimumGeometryOverlap ?? 0.12;
  const criticalText = options.criticalCandidateTextSimilarity ?? 0.5;
  const criticalGeometry = options.criticalCandidateGeometryOverlap ?? 0.45;
  const nativeLines = buildNativeLines(nativeObservations);
  const candidates: Candidate[] = [
    ...nativeLines.map((line) => ({
      id: line.id,
      text: line.text,
      sourceIds: line.sourceIds,
      box: line.box,
      memberBoxes: line.sourceIds.map((id) => nativeObservations.find((item) => item.id === id)!.box),
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
      return { native, textual, geometric, score: textual * 0.78 + geometric * 0.22 };
    });
    const best = scored.sort((left, right) => right.score - left.score)[0];
    const criticalLocal = scored
      .filter((candidate) => candidate.geometric >= criticalGeometry && candidate.textual >= criticalText)
      .sort((left, right) => right.textual - left.textual || right.geometric - left.geometric)[0];

    if (criticalLocal) {
      const nativeCritical = criticalTokens(criticalLocal.native.text);
      const ocrCritical = criticalTokens(ocr.text);
      if ((nativeCritical.length || ocrCritical.length) && !sameTokenMultiset(nativeCritical, ocrCritical)) {
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


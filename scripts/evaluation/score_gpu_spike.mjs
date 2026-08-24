#!/usr/bin/env node
/**
 * Score one GPU-spike evidence directory without modifying the raw arms.
 *
 * Usage:
 *   node scripts/evaluation/score_gpu_spike.mjs \
 *     --run-dir .evaluation/gpu-spike/2026-08-24/<run> \
 *     --output .evaluation/gpu-spike/2026-08-24/<run>/score.json
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  criticalTokenDiff,
  rawLineDiff
} from './lib/modal-comparator.mjs';

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required argument ${name}`);
}

const runDir = arg('--run-dir');
const output = arg('--output', join(runDir, 'score.json'));
const pricingPath = arg('--pricing', 'evaluation/gpu-spike/pricing-2026-08-24.json');

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null;
};

const normalize = (text) => text.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();

function scoreProjection(repetition) {
  return {
    perPage: repetition.pages.map((page) => ({
      page: page.page,
      lines: page.lines.map((line) => ({ text: line.text, score: line.score ?? null }))
    }))
  };
}

function textDiff(left, right) {
  const leftProjection = scoreProjection(left);
  const rightProjection = scoreProjection(right);
  return {
    criticalTokens: criticalTokenDiff(leftProjection, rightProjection),
    rawLines: rawLineDiff(leftProjection, rightProjection)
  };
}

function boxIou(a, b) {
  const x0 = Math.max(a[0], b[0]);
  const y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[2], b[2]);
  const y1 = Math.min(a[3], b[3]);
  const intersection = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const leftArea = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
  const rightArea = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const union = leftArea + rightArea - intersection;
  return union > 0 ? intersection / union : 0;
}

function geometryDiff(left, right) {
  const rightPages = new Map(right.pages.map((page) => [page.page, page]));
  const ious = [];
  const confidenceDeltas = [];
  let leftLines = 0;
  let rightLines = 0;
  let exactTextMatches = 0;
  let unmatchedLeft = 0;
  let unmatchedRight = 0;
  const perPage = [];

  for (const leftPage of left.pages) {
    const rightPage = rightPages.get(leftPage.page) ?? { lines: [] };
    leftLines += leftPage.lines.length;
    rightLines += rightPage.lines.length;
    const candidates = new Map();
    rightPage.lines.forEach((line, index) => {
      const key = normalize(line.text);
      if (!candidates.has(key)) candidates.set(key, []);
      candidates.get(key).push({ line, index });
    });
    const used = new Set();
    let pageMatches = 0;
    for (const line of leftPage.lines) {
      const available = (candidates.get(normalize(line.text)) ?? []).filter((item) => !used.has(item.index));
      if (!available.length) {
        unmatchedLeft += 1;
        continue;
      }
      const best = available
        .map((item) => ({ ...item, iou: boxIou(line.box, item.line.box) }))
        .sort((a, b) => b.iou - a.iou)[0];
      used.add(best.index);
      exactTextMatches += 1;
      pageMatches += 1;
      ious.push(best.iou);
      if (Number.isFinite(line.score) && Number.isFinite(best.line.score)) {
        confidenceDeltas.push(best.line.score - line.score);
      }
    }
    const pageUnmatchedRight = rightPage.lines.length - used.size;
    unmatchedRight += pageUnmatchedRight;
    perPage.push({
      page: leftPage.page,
      leftLines: leftPage.lines.length,
      rightLines: rightPage.lines.length,
      exactTextMatches: pageMatches,
      unmatchedLeft: leftPage.lines.length - pageMatches,
      unmatchedRight: pageUnmatchedRight
    });
  }

  const absoluteConfidenceDeltas = confidenceDeltas.map(Math.abs);
  return {
    leftLines,
    rightLines,
    exactTextMatches,
    unmatchedLeft,
    unmatchedRight,
    iou: {
      min: ious.length ? Math.min(...ious) : null,
      p50: median(ious),
      p05: percentile(ious, 0.05)
    },
    confidenceDelta: {
      signedMean: confidenceDeltas.length
        ? confidenceDeltas.reduce((sum, value) => sum + value, 0) / confidenceDeltas.length
        : null,
      absoluteP50: median(absoluteConfidenceDeltas),
      absoluteP95: percentile(absoluteConfidenceDeltas, 0.95),
      absoluteMax: absoluteConfidenceDeltas.length ? Math.max(...absoluteConfidenceDeltas) : null
    },
    pagesWithUnmatchedLines: perPage.filter((page) => page.unmatchedLeft || page.unmatchedRight)
  };
}

function sameConfigNull(arm) {
  const comparisons = [];
  for (let left = 0; left < arm.repetitions.length; left += 1) {
    for (let right = left + 1; right < arm.repetitions.length; right += 1) {
      comparisons.push({
        leftRepeat: left + 1,
        rightRepeat: right + 1,
        ...textDiff(arm.repetitions[left], arm.repetitions[right])
      });
    }
  }
  return {
    criticalTokens: Math.max(0, ...comparisons.map((item) => item.criticalTokens.symmetricDifference)),
    rawLines: Math.max(0, ...comparisons.map((item) => item.rawLines.differingLines)),
    maxScoreDelta: Math.max(0, ...comparisons.map((item) => item.rawLines.maxScoreDelta)),
    comparisons
  };
}

function compareArms(left, right) {
  const pairs = [];
  const count = Math.min(left.repetitions.length, right.repetitions.length);
  for (let index = 0; index < count; index += 1) {
    pairs.push({
      repeat: index + 1,
      text: textDiff(left.repetitions[index], right.repetitions[index]),
      geometry: geometryDiff(left.repetitions[index], right.repetitions[index])
    });
  }
  const nullTolerance = {
    criticalTokens: Math.max(left.sameConfigNull.criticalTokens, right.sameConfigNull.criticalTokens),
    rawLines: Math.max(left.sameConfigNull.rawLines, right.sameConfigNull.rawLines)
  };
  const pass = pairs.every((pair) =>
    pair.text.criticalTokens.symmetricDifference <= nullTolerance.criticalTokens
    && pair.text.rawLines.differingLines <= nullTolerance.rawLines);
  return { left: left.arm.name, right: right.arm.name, nullTolerance, pass, pairs };
}

function estimatedCost(arm, pricing) {
  const rates = pricing.rates;
  const resources = arm.resources;
  const seconds = arm.attempt.remoteCallWallS;
  const ratePerSecond = resources.physicalCpuCores * rates.physicalCpuCore
    + resources.memoryMiB / 1024 * rates.memoryGiB
    + (resources.gpu ? rates.gpuL4 : 0);
  return { ratePerSecond, seconds, estimatedUsd: ratePerSecond * seconds };
}

const pricing = JSON.parse(readFileSync(pricingPath, 'utf8'));
const armFiles = readdirSync(runDir)
  .filter((name) => name.endsWith('.json') && name !== 'run.json' && name !== basename(output))
  .sort();
const arms = new Map();
for (const file of armFiles) {
  const arm = JSON.parse(readFileSync(join(runDir, file), 'utf8'));
  if (arm.attempt?.terminal !== 'success' || !arm.repetitions) continue;
  arm.sameConfigNull = sameConfigNull(arm);
  arm.estimatedCost = estimatedCost(arm, pricing);
  arms.set(arm.arm.name, arm);
}

const mutationSource = arms.values().next().value;
let mutationTest = { pass: false, reason: 'no successful arm' };
if (mutationSource?.repetitions?.[0]?.pages?.[0]?.lines?.[0]) {
  const original = structuredClone(mutationSource.repetitions[0]);
  const mutated = structuredClone(original);
  mutated.pages[0].lines[0].text += ' 999999';
  const mutation = textDiff(original, mutated);
  mutationTest = {
    pass: mutation.criticalTokens.symmetricDifference > 0 && mutation.rawLines.differingLines > 0,
    criticalTokenSymmetricDifference: mutation.criticalTokens.symmetricDifference,
    rawLinesDiffering: mutation.rawLines.differingLines
  };
}

const comparisons = [];
for (const [leftName, rightName] of [
  ['c-hpi-tiny', 'g-pd-tiny'],
  ['c-hpi-small', 'g-pd-small'],
  ['c-hpi-tiny', 'g-hpi-tiny'],
  ['c-hpi-small', 'g-hpi-small'],
  ['g-pd-tiny', 'g-hpi-tiny'],
  ['g-pd-small', 'g-hpi-small'],
  ['g-pd-tiny', 'g-ort-tiny'],
  ['g-pd-small', 'g-ort-small'],
  ['g-pd-tiny-b1c1', 'g-pd-tiny-b8c1'],
  ['g-pd-tiny-b1c1', 'g-pd-tiny-b1c8'],
  ['g-pd-tiny-b1c1', 'g-pd-tiny-b8c8'],
  ['g-pd-small-b1c1', 'g-pd-small-b8c1'],
  ['g-pd-small-b1c1', 'g-pd-small-b1c8'],
  ['g-pd-small-b1c1', 'g-pd-small-b8c8']
]) {
  if (arms.has(leftName) && arms.has(rightName)) comparisons.push(compareArms(arms.get(leftName), arms.get(rightName)));
}

const summary = [...arms.values()].map((arm) => ({
  arm: arm.arm.name,
  backendAttestationPass: arm.backendAttestation?.pass,
  modelVerificationPresent: Boolean(arm.modelVerification),
  requestedRecognitionBatch: arm.arm.recognitionBatchSize,
  requestedPageBatch: arm.arm.pageBatchSize,
  effectiveBatch: arm.effectiveBatchSummary,
  pagesPerS: arm.repetitions.map((repeat) => repeat.pagesPerS),
  pagesPerSMedian: median(arm.repetitions.map((repeat) => repeat.pagesPerS)),
  sameConfigNull: arm.sameConfigNull,
  telemetry: arm.gpuTelemetry,
  estimatedCost: arm.estimatedCost
}));

const result = {
  schemaVersion: 'pagespatial-gpu-spike-score-v1',
  run: basename(runDir),
  pricing: { source: pricing.source, capturedAt: pricing.capturedAt, interpretation: 'resource-time estimate, not isolated billed cost' },
  mutationTest,
  summary,
  comparisons
};
writeFileSync(output, `${JSON.stringify(result, null, 1)}\n`);
console.log(JSON.stringify({
  output,
  mutationTest,
  arms: summary.map((arm) => ({
    arm: arm.arm,
    pagesPerSMedian: arm.pagesPerSMedian,
    effectiveBatchMax: arm.effectiveBatch.max,
    sameConfigNull: {
      criticalTokens: arm.sameConfigNull.criticalTokens,
      rawLines: arm.sameConfigNull.rawLines,
      maxScoreDelta: arm.sameConfigNull.maxScoreDelta
    }
  })),
  comparisons: comparisons.map((comparison) => ({
    left: comparison.left,
    right: comparison.right,
    pass: comparison.pass,
    nullTolerance: comparison.nullTolerance,
    criticalTokenDeltas: comparison.pairs.map((pair) => pair.text.criticalTokens.symmetricDifference),
    rawLineDeltas: comparison.pairs.map((pair) => pair.text.rawLines.differingLines),
    unmatchedLines: comparison.pairs.map((pair) => pair.geometry.unmatchedLeft + pair.geometry.unmatchedRight)
  }))
}, null, 1));

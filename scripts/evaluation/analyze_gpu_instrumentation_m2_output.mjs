#!/usr/bin/env node
/** Existing stable-result comparator applied to the four-call M2 lifetime. */

import { readFileSync, writeFileSync } from 'node:fs';
import { comparePages, evaluateComparison } from './lib/modal-comparator.mjs';

const pages = (run) => run.pages.map((entry) => entry.pageSpatial);

export function compareM2Output(runs) {
  if (!Array.isArray(runs) || runs.length !== 4) {
    throw new Error('M2 output comparison requires four runs');
  }
  const nullComparison = comparePages(pages(runs[1]), pages(runs[3]));
  const nullTolerance = {
    criticalTokens: nullComparison.ocrScore.criticalTokens.symmetricDifference,
    rawLines: nullComparison.ocrScore.rawLines.differingLines,
  };
  const traceComparison = comparePages(pages(runs[1]), pages(runs[2]));
  return {
    schemaVersion: 'pagespatial-gpu-instrumentation-m2-output-v1',
    nullTolerance,
    nullComparison,
    traceComparison,
    verdict: evaluateComparison(traceComparison, nullTolerance),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const inputIndex = process.argv.indexOf('--input');
  const outputIndex = process.argv.indexOf('--output');
  if (inputIndex < 0 || outputIndex < 0) throw new Error('--input and --output are required');
  const result = compareM2Output(JSON.parse(readFileSync(process.argv[inputIndex + 1], 'utf8')));
  writeFileSync(process.argv[outputIndex + 1], `${JSON.stringify(result, null, 1)}\n`);
  if (!result.verdict.pass) process.exitCode = 1;
}

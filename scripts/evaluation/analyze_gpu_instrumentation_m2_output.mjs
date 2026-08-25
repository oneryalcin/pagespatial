#!/usr/bin/env node
/** Existing stable-result comparator applied to the four-call M2 lifetime. */

import { readFileSync, writeFileSync } from 'node:fs';
import { comparePages, evaluateComparison } from './lib/modal-comparator.mjs';
import { criticalTokenDifferences } from './score_gpu_merged_output.mjs';

const pages = (run) => run.pages.map((entry) => entry.pageSpatial);

export function evaluateTrustedOutput(controlPages, candidatePages, deterministicExact) {
  if (controlPages.length !== candidatePages.length) {
    throw new Error('trusted-output comparison requires equal page counts');
  }
  const differencesByPage = [];
  for (let index = 0; index < controlPages.length; index += 1) {
    const control = controlPages[index];
    const candidate = candidatePages[index];
    if (control.pageNumber !== candidate.pageNumber) {
      throw new Error('trusted-output comparison requires ordered matching pages');
    }
    const differences = criticalTokenDifferences(
      control.ocrObservations.map(({ text, box, confidence }) => ({ text, box, score: confidence ?? null })),
      candidate.ocrObservations.map(({ text, box, confidence }) => ({ text, box, score: confidence ?? null })),
    );
    if (differences.controlOnly.length || differences.candidateOnly.length) {
      differencesByPage.push({
        pageNumber: candidate.pageNumber,
        candidateTrusted: candidate.diagnostics.requiresEscalation === false,
        controlOnly: differences.controlOnly,
        candidateOnly: differences.candidateOnly,
      });
    }
  }
  const trustedDifferences = differencesByPage.filter((page) => page.candidateTrusted);
  return {
    pass: deterministicExact && trustedDifferences.length === 0,
    acceptanceRule: 'zero newly incorrect, missing, or unresolved critical values in trusted non-escalated output; raw OCR evidence differences are diagnostic',
    deterministicExact,
    trustedDifferencePages: trustedDifferences.map((page) => page.pageNumber),
    differences: differencesByPage,
  };
}

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
  const rawEquivalenceVerdict = evaluateComparison(traceComparison, nullTolerance);
  const productVerdict = evaluateTrustedOutput(
    pages(runs[1]), pages(runs[2]), traceComparison.deterministic.exact,
  );
  return {
    schemaVersion: 'pagespatial-gpu-instrumentation-m2-output-v2',
    nullTolerance,
    nullComparison,
    traceComparison,
    rawEquivalenceVerdict,
    productVerdict,
    verdict: productVerdict,
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

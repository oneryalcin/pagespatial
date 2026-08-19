import test from 'node:test';
import assert from 'node:assert/strict';
import { criticalTokens, sameTokenMultiset } from '../dist/index.js';

const NBSP = '\u00a0';
const THIN = '\u2009';
const NARROW = '\u202f';
const SOFT_HYPHEN = '\u00ad';
const MINUS = '\u2212';

function agrees(native, ocr) {
  return sameTokenMultiset(criticalTokens(native), criticalTokens(ocr));
}

// Critical tokens compare two transcriptions of the SAME ink, so only
// engine-introduced variance may be healed. Each row is one contract:
// notation differences conflict, presentation differences match.

const MATCHES = [
  ['identical value with unit word', '$3.5mm', '$3.5mm'],
  ['millimeters glued verbatim, never interpreted', 'a 3.5 mm bolt', 'a 3.5 mm bolt'],
  ['prose "in" glued symmetrically, not read as inches', '5 in the region', '5 in the region'],
  ['typographic thin-space grouping healed', `1${THIN}234${THIN}567`, '1234567'],
  ['accounting negative folds to leading minus', '(1,234)', '-1,234'],
  ['European format kept verbatim on both sides', '€1.234,56', '€1.234,56'],
  ['lakh grouping protected via \\p{Sc}', '₹5,00,000', '₹5,00,000'],
  ['engine spacing inside FY year healed', 'FY2024', 'FY 2024'],
  ['minus-sign codepoint variants healed', `${MINUS}42`, '-42'],
  ['multiplication prose splits symmetrically', '3 x 4', '3x4'],
  ['currency-code prefix with typographic spaces', `CHF${NBSP}1${NARROW}200`, 'CHF1200'],
  ['percent spacing healed', 'grew 5 %', 'grew 5%'],
  ['dates stay one verbatim token', '12/31/2024', '12/31/2024'],
  ['soft hyphen is invisible formatting', `soft${SOFT_HYPHEN}hyphen 42`, 'softhyphen 42'],
  ['accounting negative with non-Western currency', '(₹5,000)', '-₹5,000']
];

const CONFLICTS = [
  ['mm vs m is a visible-ink difference (old code matched)', '$3.5mm', '$3.5m'],
  ['plain-space grouping is ambiguous, escalate', '1 234', '1234'],
  ['comma vs period never unified (possible EU decimal)', '1,234', '1.234'],
  ['estimate vs forecast year suffix', 'FY2024E', 'FY2024F'],
  ['O/0 confusable is exactly what we detect', '10.5%', '1O.5%'],
  ['misread unit word escalates', '$5 million', '$5 rnillion'],
  ['misread currency code escalates', 'USD 450', 'USO 450']
];

for (const [name, native, ocr] of MATCHES) {
  test(`match: ${name}`, () => {
    assert.equal(agrees(native, ocr), true,
      `${JSON.stringify(criticalTokens(native))} vs ${JSON.stringify(criticalTokens(ocr))}`);
  });
}

for (const [name, native, ocr] of CONFLICTS) {
  test(`conflict: ${name}`, () => {
    assert.equal(agrees(native, ocr), false,
      `${JSON.stringify(criticalTokens(native))} vs ${JSON.stringify(criticalTokens(ocr))}`);
  });
}

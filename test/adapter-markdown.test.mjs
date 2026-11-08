import test from 'node:test';
import assert from 'node:assert/strict';
import { projectMarkdown } from '../dist/index.js';

// PA-SERS LLR VII manager presentation p3: LLR 5 is printed on two lines, and
// the extracted table collapsed them into one row, so "Net IRR 20.3 19.2%" reads
// as one fund's value.
const printed = [
  'LLR 4 2014 $50.0 26.5% 2.6x 2.1x',
  'LLR 5 2018 $ 75.0 20.3 2.1 x 0.6 x',
  '$205.0 19.2% 2.2x 1.5x'
];
const nativeLines = printed.map((text, index) => ({
  id: `n${index}:line:${index}`,
  pageNumber: 1,
  text,
  sourceIds: [`n${index}`],
  box: [95, 249 + 40 * index, 1013, 281 + 40 * index]
}));

function project(nativeMarkdown) {
  return projectMarkdown({
    pageNumber: 1,
    nativeObservations: nativeLines.map((line) => ({ id: line.sourceIds[0], text: line.text, box: line.box })),
    nativeLines,
    ocrObservations: [],
    sourceMatches: [],
    spatialRows: [],
    derivedRelations: [],
    nativeMarkdown,
    nativeMarkdownSource: 'pdf-inspector'
  });
}

const header = '||Vintage|Commit|Net IRR|Net TVPI|Net DPI|\n|---|---|---|---|---|---|';

test('a table row merging values printed on different lines is not projected', () => {
  const projection = project(`${header}\n|LLR 4|2014|$50.0|26.5%|2.6x|2.1x|\n|LLR 5|2018|$75.0 $205.0|20.3 19.2%|2.1x 2.2x|0.6x 1.5x|`);
  assert.equal(projection.markdownSource, 'pagespatial-native-lines');
});

test('a year in a wrapped row label does not count against the row', () => {
  // Asseco Poland FY2025 p71: the label's second line "1 stycznia 2025" sits on
  // its own native line, apart from the values.
  const lines = ['Wartość netto środków trwałych na dzień', '1 stycznia 2025', '401,2 361,3 94,6 46,2 17,6 920,9']
    .map((text, index) => ({ id: `a${index}:line:${index}`, pageNumber: 1, text, sourceIds: [`a${index}`], box: [95, 870 + 12 * index, 1013, 880 + 12 * index] }));
  const projection = projectMarkdown({
    pageNumber: 1,
    nativeObservations: lines.map((line) => ({ id: line.sourceIds[0], text: line.text, box: line.box })),
    nativeLines: lines,
    ocrObservations: [],
    sourceMatches: [],
    spatialRows: [],
    derivedRelations: [],
    nativeMarkdown: '|Wartość netto środków trwałych na dzień 1 stycznia 2025||401,2|361,3|94,6|46,2|17,6|920,9|',
    nativeMarkdownSource: 'pdf-inspector'
  });
  assert.equal(projection.markdownSource, 'pdf-inspector');
});

test('a table whose rows each match one printed line keeps its structure', () => {
  const projection = project(`${header}\n|LLR 4|2014|$50.0|26.5%|2.6x|2.1x|\n|LLR 5|2018|$75.0|20.3|2.1x|0.6x|\n||||$205.0|19.2%|2.2x|1.5x|`);
  assert.equal(projection.markdownSource, 'pdf-inspector');
});

function projectWith(nativeTexts, nativeMarkdown) {
  const lines = nativeTexts.map((text, index) => ({ id: `w${index}:line:${index}`, pageNumber: 1, text, sourceIds: [`w${index}`], box: [25, 100 + 10 * index, 1200, 108 + 10 * index] }));
  return projectMarkdown({
    pageNumber: 1,
    nativeObservations: lines.map((line) => ({ id: line.sourceIds[0], text: line.text, box: line.box })),
    nativeLines: lines,
    ocrObservations: [],
    sourceMatches: [],
    spatialRows: [],
    derivedRelations: [],
    nativeMarkdown,
    nativeMarkdownSource: 'pdf-inspector'
  });
}

// World Bank P178566 procurement plan p3: the PDF text is intact; pdf-inspector
// interleaves the letters of two tiny-font header lines.
const procurementHeader = [
  'Activity Reference No. / Loan / Credit No. Component Review Type Method Market Approach Procurement Process',
  'Description Prequalification High SEA/SH Risk Procurement Document Type Estimated Amount Actual Amount Status'
];

test('adapter markdown made of letters interleaved from neighbouring lines is not projected', () => {
  const projection = projectWith(procurementHeader,
    '|ActivitD|yeRsecfreipre tinocne No. /|Loan / Credit N o.|Component|Review Type|Method|Market Approac h|Procurement Pro cess|\n|---|---|---|---|---|---|---|---|\n|CDoW nsAtO ru/F ctSiR on|P/o NfCKBe/0 rs1a/2U0p2g3ra|IDA / 71560|Prequalification|High SEA/SH|Risk|Estimated|Amount|');
  assert.equal(projection.markdownSource, 'pagespatial-native-lines');
});

// Ares 2026 Q1 10-Q p48: a narrative page pdf-inspector turned into one table,
// paragraphs inside a cell.
const narrative = 'The following discussion and analysis should be read in conjunction with the unaudited condensed consolidated financial statements of Ares Management Corporation and the related notes included in this Quarterly Report on Form 10-Q and the audited financial statements and the related notes included in the 2025 Annual Report on Form 10-K of Ares Management Corporation.';

test('a table cell holding a paragraph is not projected', () => {
  const projection = projectWith([narrative, 'Trends Affecting Our Business'],
    `|Trends Affecting Our Business|${narrative}|\n|---|---|`);
  assert.equal(projection.markdownSource, 'pagespatial-native-lines');
});

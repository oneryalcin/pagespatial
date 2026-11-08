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

test('a table whose rows each match one printed line keeps its structure', () => {
  const projection = project(`${header}\n|LLR 4|2014|$50.0|26.5%|2.6x|2.1x|\n|LLR 5|2018|$75.0|20.3|2.1x|0.6x|\n||||$205.0|19.2%|2.2x|1.5x|`);
  assert.equal(projection.markdownSource, 'pdf-inspector');
});

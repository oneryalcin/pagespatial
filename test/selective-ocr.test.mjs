import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';

import { buildNativeLines, buildPageSpatial, pageSpatialSchema } from '../dist/index.js';
import { recognizeSelectively } from '../dist/selective-ocr.js';
import { createPdfInspectorNativeAdapter, openNodePdfSession } from '../dist/node/pdf-inspector.js';
import { createPpOcrSidecarAdapter } from '../service/adapters/ppocr-sidecar.mjs';

// One native observation per printed line, all in font F1. `visible` is what
// the page shows (and OCR reads); `native` is what the text layer claims.
const lineBox = (i) => [20, 20 + 40 * i, 700, 50 + 40 * i];
function natives(lines, nativeOf = (text) => text) {
  return lines.map((text, i) => ({ id: `n${i}`, pageNumber: 1, text: nativeOf(text), box: lineBox(i), font: 'F1' }));
}
async function plan(lines, options = {}) {
  const nativeObservations = options.natives ?? natives(lines, options.nativeOf);
  const requested = [];
  const result = await recognizeSelectively({
    boxes: options.boxes ?? lines.map((_, i) => lineBox(i)),
    nativeObservations,
    nativeLines: buildNativeLines(nativeObservations),
    readAll: options.readAll,
    recognize: async (indices) => { requested.push(...indices); return indices.map((index) => ({ index, text: lines[index] })); }
  });
  return { ...result, requested, read: new Set(requested), skippedIndices: result.skipped.map((skip) => skip.index) };
}

// Long enough to count as a usable text layer (200 native characters).
const PROSE = 'The committee reviewed the proposal before the meeting and approved the motion';
const PAGE = [PROSE, PROSE, PROSE, PROSE];

test('prose is skipped once OCR has confirmed its letters twice on the page; the audit lines are read', async () => {
  const result = await plan(PAGE);
  assert.equal(result.read.size, 2);
  assert.equal(result.skippedIndices.length, 2);
  assert.deepEqual(result.skipped.map((skip) => skip.nativeIds), result.skippedIndices.map((index) => [`n${index}`]));
});

test('a line with a letter OCR could not confirm elsewhere on the page is read', async () => {
  // Q and z occur only in the last line: nothing else on the page can vouch for those glyphs.
  const result = await plan([...PAGE, 'Quiz']);
  assert.ok(result.read.has(4));
  assert.ok(result.skippedIndices.length > 0);
});

test('a numeral anywhere on the native line forces the read, even outside the detected box', async () => {
  // The detector boxed only the label; the value sits further right on the same printed line.
  const nativeObservations = [
    ...natives(PAGE),
    { id: 'label', pageNumber: 1, text: 'the proposal before the meeting', box: [20, 180, 300, 210], font: 'F1' },
    { id: 'value', pageNumber: 1, text: '1,234', box: [600, 180, 700, 210], font: 'F1' }
  ];
  const lines = [...PAGE, 'the proposal before the meeting'];
  const result = await plan(lines, { natives: nativeObservations, boxes: [...PAGE.map((_, i) => lineBox(i)), [20, 180, 300, 210]] });
  assert.ok(result.read.has(4));
  assert.equal(result.reasons.get(4), 'native-has-numeral');
});

test('a text layer whose font maps letters wrong is read in full', async () => {
  // e and o swapped in the ToUnicode map: the page shows the right words, the text layer does not.
  const swapEO = (text) => text.replace(/[eo]/g, (ch) => (ch === 'e' ? 'o' : 'e'));
  const result = await plan(PAGE, { nativeOf: swapEO });
  assert.deepEqual(result.skipped, []);
  assert.equal(result.read.size, PAGE.length);
});

test('a page the native adapter distrusts is read in full', async () => {
  const result = await plan(PAGE, { readAll: 'page-image' });
  assert.deepEqual(result.skipped, []);
  assert.equal(result.read.size, PAGE.length);
});

test('text OCR finds outside the native layer (a chart label) is read', async () => {
  const result = await plan([...PAGE, 'chart label'], { natives: natives(PAGE) });
  assert.equal(result.reasons.get(4), 'not-native-covered');
});

// A record assembled the way the service assembles it: read lines become OCR
// observations, the rest are declared skipped.
const identity = { documentId: 'selective-doc', revisionId: 'r1', sha256: 'b'.repeat(64), pageCount: 1 };
async function record(lines, mutate = (input) => input) {
  const built = buildPageSpatial({
    document: identity,
    pageNumber: 1,
    geometry: { width: 800, height: 40 * lines.length + 400 },
    nativeObservations: lines.map((text, i) => ({ pageNumber: 1, text, box: lineBox(i), font: 'F1' })),
    ocrObservations: [],
    provenance: { parserName: 'fixture', parserVersion: '1', runId: 'selective-run', createdAt: new Date().toISOString() }
  });
  const result = await recognizeSelectively({
    boxes: lines.map((_, i) => lineBox(i)),
    nativeObservations: built.nativeObservations,
    nativeLines: built.nativeLines,
    recognize: async (indices) => indices.map((index) => ({ index, text: lines[index] }))
  });
  return () => buildPageSpatial(mutate({
    document: identity,
    pageNumber: 1,
    geometry: { width: 800, height: 40 * lines.length + 400 },
    nativeObservations: lines.map((text, i) => ({ pageNumber: 1, text, box: lineBox(i), font: 'F1' })),
    ocrObservations: result.readings.map((reading) => ({
      pageNumber: 1, text: reading.text, box: lineBox(reading.index), confidence: 0.99
    })),
    selectiveOcr: {
      rule: 'native-font-audited-v1',
      skipped: result.skipped.map((skip) => ({ box: lineBox(skip.index), nativeIds: skip.nativeIds }))
    },
    provenance: { parserName: 'fixture', parserVersion: '1', runId: 'selective-run', createdAt: new Date().toISOString() }
  }));
}

test('a record cannot declare a skip its own evidence does not excuse', async () => {
  const lines = [...PAGE, 'Total revenue 1,234'];
  const honest = (await record(lines))();
  assert.equal(honest.selectiveOcr.skipped.length, 2);
  assert.equal(pageSpatialSchema.safeParse(honest).success, true);

  // Declare the number line skipped instead of read.
  const numberLine = honest.nativeObservations.find((observation) => observation.text.includes('1,234'));
  const forged = await record(lines, (input) => ({
    ...input,
    ocrObservations: input.ocrObservations.filter((observation) => !observation.text.includes('1,234')),
    selectiveOcr: { ...input.selectiveOcr, skipped: [...input.selectiveOcr.skipped, { box: lineBox(4), nativeIds: [numberLine.id] }] }
  }));
  assert.throws(forged, /not excused by the page's evidence \(native-has-numeral\)/u);

  // Drop the audit readings that vouched for the skipped prose.
  const unaudited = await record(lines, (input) => ({
    ...input,
    ocrObservations: input.ocrObservations.filter((observation) => observation.text.includes('1,234'))
  }));
  assert.throws(unaudited, /not excused by the page's evidence \(letters-unconfirmed\)/u);
});

test('skipped prose does not make a page with chart labels look starved of corroboration', async () => {
  // 12 prose lines (2 read as audit lines, 10 skipped) and 8 chart labels with
  // no native text. Read in full, 12 of 20 confident boxes would be matched.
  const prose = Array.from({ length: 12 }, () => PROSE);
  const build = await record(prose, (input) => ({
    ...input,
    ocrObservations: [
      ...input.ocrObservations,
      ...Array.from({ length: 8 }, (_, i) => ({
        pageNumber: 1, text: `axis label ${String.fromCharCode(97 + i)}`, box: [20 + 90 * i, 520, 100 + 90 * i, 540], confidence: 0.99
      }))
    ]
  }));
  const page = build();
  assert.equal(page.selectiveOcr.skipped.length, 10);
  assert.equal(page.diagnostics.escalationReasons.some((reason) => reason.type === 'uncorroborated-ocr'), false);
});

// A mock sidecar child: four detected boxes, and a recognizer that answers
// only for the indices it is asked. It refuses a repeated or unknown index.
const TEXTS = ['Total revenue 2024', PROSE, PROSE, PROSE];
const MOCK_CHILD = `
const readline = require('node:readline');
const texts = ${JSON.stringify(TEXTS)};
const seen = new Set();
console.log(JSON.stringify({ kind: 'meta', versions: { paddleocr: 'mock-1' }, platform: 'MockOS', useHpip: false, hpiRequested: false, modelPins: {} }));
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.op === 'detect') {
    console.log(JSON.stringify({ id: request.id, polys: texts.map((_, i) => [[20, 20 + 40 * i], [700, 20 + 40 * i], [700, 50 + 40 * i], [20, 50 + 40 * i]]) }));
  } else if (request.op === 'recognize') {
    const bad = request.indices.find((index) => seen.has(index) || texts[index] === undefined);
    if (bad !== undefined) { console.log(JSON.stringify({ id: request.id, error: 'bad index ' + bad })); return; }
    request.indices.forEach((index) => seen.add(index));
    // Answered in reverse, so the adapter must attach readings by index, not by position.
    console.log(JSON.stringify({ id: request.id, lines: [...request.indices].reverse().map((index) => ({ index, text: texts[index], score: 0.98 })) }));
  } else {
    console.log(JSON.stringify({ id: request.id, error: 'full-page request in selective mode' }));
  }
});
`;

test('selective sidecar adapter: reads only the boxes the native text cannot stand in for, each reading on its own box', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'selective-sidecar-'));
  try {
    const modelDir = join(dir, 'models', 'PP-OCRv6_small_det');
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, 'inference.pdiparams'), 'weights');
    const pinsPath = join(dir, 'model-pins.json');
    writeFileSync(pinsPath, JSON.stringify({ repos: { 'PaddlePaddle/PP-OCRv6_small_det': {
      revision: 'rev', files: { 'inference.pdiparams': createHash('sha256').update('weights').digest('hex') }
    } } }));
    const mockPath = join(dir, 'mock-child.cjs');
    writeFileSync(mockPath, MOCK_CHILD);
    const adapter = createPpOcrSidecarAdapter({
      modelsDir: join(dir, 'models'), pinsPath, pythonCmd: [process.execPath, mockPath], metaTimeoutMs: 5000, selective: true
    });
    try {
      const observations = natives(TEXTS);
      const page = await adapter.recognize(
        { pageNumber: 1, geometry: { width: 800, height: 400 }, data: new Uint8Array([1]) },
        { observations, lines: buildNativeLines(observations) }
      );
      assert.match(adapter.descriptor, /;ocr=selective;rec_batch=same-width$/u);
      // The number line and two audit lines are read; one prose line is skipped.
      assert.equal(page.observations.length, 3);
      for (const observation of page.observations) {
        const index = Number(observation.id.split(':').pop());
        assert.equal(observation.text, TEXTS[index]);
        assert.deepEqual(observation.box, lineBox(index));
      }
      assert.ok(page.observations.some((observation) => observation.text === TEXTS[0]));
      assert.equal(page.selectiveOcr.skipped.length, 1);
      const skippedIndex = [1, 2, 3].find((index) => !page.observations.some((observation) => observation.id.endsWith(`:${index}`)));
      assert.deepEqual(page.selectiveOcr.skipped[0], {
        box: lineBox(skippedIndex),
        polygon: [[20, 20 + 40 * skippedIndex], [700, 20 + 40 * skippedIndex], [700, 50 + 40 * skippedIndex], [20, 50 + 40 * skippedIndex]],
        nativeIds: [`n${skippedIndex}`]
      });
    } finally {
      await adapter.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 80x40 white PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAFAAAAAoCAAAAABMCyLdAAAAJUlEQVR4nO3MMQEAAAwCIPuX1hDbCQFIn0UoFAqFQqFQKBQKbwaQyXQ1muFazgAAAABJRU5ErkJggg==',
  'base64'
);
async function pdfPage(draw) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  await draw(pdf, page, await pdf.embedFont(StandardFonts.Helvetica));
  const bytes = await pdf.save();
  const session = await openNodePdfSession(bytes, {});
  try {
    return await createPdfInspectorNativeAdapter().extractPage(session.source, 1);
  } finally {
    await session.dispose();
  }
}

test('native adapter: a page that is mostly one image is distrusted, so a scan with a hidden OCR layer is read in full', async () => {
  const text = (page, font) => ['An earlier OCR tool wrote this text layer.', 'It looks like native text but nothing verified it.']
    .forEach((line, i) => page.drawText(line, { x: 72, y: 700 - 20 * i, size: 11, font }));
  const scan = await pdfPage(async (pdf, page, font) => {
    page.drawImage(await pdf.embedPng(PNG), { x: 0, y: 0, width: 612, height: 792 });
    text(page, font);
  });
  assert.equal(scan.textLayerDistrust, 'page-image');
  const letterhead = await pdfPage(async (pdf, page, font) => {
    page.drawImage(await pdf.embedPng(PNG), { x: 72, y: 730, width: 80, height: 40 });
    text(page, font);
  });
  assert.equal(letterhead.textLayerDistrust, undefined);
});

test('native adapter: every item of one font carries one font label, including repeated text', async () => {
  // The repeated line cannot be matched to pdf-inspector by its text alone;
  // it must still pool its glyph evidence with the rest of the font.
  const native = await pdfPage(async (_pdf, page, font) => {
    ['Unique heading for this page', 'the same line', 'the same line', 'Another unique closing line']
      .forEach((line, i) => page.drawText(line, { x: 72, y: 700 - 20 * i, size: 11, font }));
  });
  assert.equal(native.observations.length, 4);
  assert.equal(new Set(native.observations.map((observation) => observation.font)).size, 1);
});

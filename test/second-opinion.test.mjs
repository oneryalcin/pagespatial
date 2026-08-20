import test from 'node:test';
import assert from 'node:assert/strict';
import { createParser, pageSpatialSchema } from '../dist/index.js';

// A scan-like page: no native text, 9 confident OCR observations — fires
// coverage starvation unless a second engine corroborates.
const identity = { documentId: 'scan-doc', revisionId: 'r', sha256: 'd'.repeat(64), pageCount: 1 };

const ocrTexts = ['Total 1,234', 'Fee 55%', 'Net 9,876', 'Cap 4,321', 'Sum 777',
  'Tax 88', 'Fund 6,543', 'Rate 12%', 'Gross 2,468'];

function parserWith(secondOpinion) {
  return createParser({
    native: {
      name: 'fixture-native', version: '1',
      async extractPage() {
        return { pageNumber: 1, geometry: { pointWidth: 250, pointHeight: 250 }, observations: [] };
      }
    },
    renderer: {
      name: 'fixture-renderer', version: '1',
      async render() {
        return {
          pageNumber: 1,
          geometry: { width: 400, height: 400, pointWidth: 250, pointHeight: 250, viewportTransform: [1.6, 0, 0, -1.6, 0, 400] },
          data: new Uint8Array([1])
        };
      }
    },
    ocr: {
      name: 'fixture-ocr', version: '1',
      async recognize() {
        return {
          pageNumber: 1,
          observations: ocrTexts.map((text, index) => ({
            pageNumber: 1, text, box: [10, 10 + index * 40, 200, 40 + index * 40], confidence: 0.95
          }))
        };
      }
    },
    ...(secondOpinion ? { secondOpinion } : {})
  }).parse({ identity, data: new Uint8Array([1]) }, { runId: 'so-run' });
}

test('a scan page without a second opinion escalates as coverage-starved', async () => {
  const page = (await parserWith(undefined)).pages[0];
  assert.equal(page.secondOpinion, undefined);
  assert.equal(page.diagnostics.escalationReasons.some((reason) => reason.type === 'uncorroborated-ocr'), true);
});

test('cross-family agreement clears starvation and lands on the record', async () => {
  let calls = 0;
  const page = (await parserWith({
    name: 'fixture-tesseract', version: 'eng/psm3',
    async recognize() {
      calls += 1;
      // The second engine reproduces every reading (its own segmentation).
      return {
        pageNumber: 1,
        observations: ocrTexts.map((text, index) => ({
          pageNumber: 1, text, box: [12, 12 + index * 40, 198, 38 + index * 40], confidence: 0.9
        }))
      };
    }
  })).pages[0];
  assert.equal(calls, 1);
  assert.equal(page.secondOpinion.adapter, 'fixture-tesseract@eng/psm3');
  assert.equal(page.secondOpinion.readings.length, 9);
  assert.equal(page.diagnostics.escalationReasons.some((reason) => reason.type === 'uncorroborated-ocr'), false);
  assert.equal(pageSpatialSchema.safeParse(page).success, true);

  // Forgery: dropping the second opinion while keeping the cleared alarm
  // must fail — the schema re-derives starvation from what remains.
  const forged = structuredClone(page);
  delete forged.secondOpinion;
  assert.equal(pageSpatialSchema.safeParse(forged).success, false);
});

test('a disagreeing second engine leaves the alarm standing', async () => {
  const page = (await parserWith({
    name: 'fixture-tesseract', version: 'eng/psm3',
    async recognize() {
      return {
        pageNumber: 1,
        // Different values everywhere: no critical token consumes.
        observations: [{ pageNumber: 1, text: 'unrelated 999,999', box: [10, 10, 200, 40], confidence: 0.9 }]
      };
    }
  })).pages[0];
  assert.ok(page.secondOpinion);
  assert.equal(page.diagnostics.escalationReasons.some((reason) => reason.type === 'uncorroborated-ocr'), true);
});

test('second-opinion failure degrades to the standing alarm, never loses the page', async () => {
  const page = (await parserWith({
    name: 'fixture-tesseract', version: 'eng/psm3',
    async recognize() { throw new Error('tesseract binary not found'); }
  })).pages[0];
  assert.equal(page.secondOpinion, undefined);
  assert.equal(page.diagnostics.escalationReasons.some((reason) => reason.type === 'uncorroborated-ocr'), true);
});

test('non-starving pages never spend the second read', async () => {
  let calls = 0;
  await createParser({
    native: {
      name: 'fixture-native', version: '1',
      async extractPage() {
        return {
          pageNumber: 1, geometry: { pointWidth: 250, pointHeight: 250 },
          observations: ocrTexts.map((text, index) => ({
            pageNumber: 1, text, pointBox: [6, 225 - index * 25, 125, 244 - index * 25]
          }))
        };
      }
    },
    renderer: {
      name: 'fixture-renderer', version: '1',
      async render() {
        return {
          pageNumber: 1,
          geometry: { width: 400, height: 400, pointWidth: 250, pointHeight: 250, viewportTransform: [1.6, 0, 0, -1.6, 0, 400] },
          data: new Uint8Array([1])
        };
      }
    },
    ocr: {
      name: 'fixture-ocr', version: '1',
      async recognize() {
        return {
          pageNumber: 1,
          observations: ocrTexts.map((text, index) => ({
            pageNumber: 1, text, box: [10, 10 + index * 40, 200, 39 + index * 40], confidence: 0.95
          }))
        };
      }
    },
    secondOpinion: {
      name: 'fixture-tesseract', version: 'eng/psm3',
      async recognize() { calls += 1; return { pageNumber: 1, observations: [] }; }
    }
  }).parse({ identity, data: new Uint8Array([1]) }, { runId: 'so-run2' });
  assert.equal(calls, 0);
});

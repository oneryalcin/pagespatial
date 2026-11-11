/**
 * Replay the selective-OCR rule on pages it was never tuned on.
 *
 * Trial: docs/trials/2026-11-11-selective-ocr-build.md
 *
 * selective-ocr-replay.mjs replays stored runs, and every stored run covers
 * the 162 dev pages the skip rule was tuned on. This replays a page sample
 * built by build_fresh_ocr_sample.py for which a full-OCR arm result exists
 * (ocr_arms_modal.py): other pages of the dev documents, read from the
 * corpus, and pages of other documents (DocLayNet test split) where their
 * single-page PDFs are present as <sample>/pdfs/<name>.pdf. Native text is
 * extracted now, with the current adapter. For every box the rule would
 * skip, it reports what full OCR would have added:
 *
 *   - conflicts: the box raises a critical-token conflict with the native text;
 *   - disagreements: the OCR reading is less than --min-similarity like the
 *     native text under the box. Printed with both texts, for inspection.
 *
 *   npm run build && node scripts/evaluation/selective-ocr-replay-fresh.mjs \
 *     --sample .evaluation/ocr-arms/fresh --results .evaluation/ocr-arms/fresh/results/results-small_small-r0.json \
 *     --data-root .evaluation [--min-similarity 0.9] [--out summary.json]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { intersectionArea, renderedPixelsPerPoint, roundBox } from '../../dist/geometry.js';
import { associateNativeAndOcr } from '../../dist/merge.js';
import { normalizeNative, validateNativePageGeometry } from '../../dist/page-parser.js';
import { buildNativeLines } from '../../dist/reading-order.js';
import { recognizeSelectively } from '../../dist/selective-ocr.js';
import { textSimilarity } from '../../dist/text.js';
import { nativeStage, openDocumentContext, renderStage } from '../../service/lib/stages.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const sample = option('--sample');
const dataRoot = option('--data-root');
const minSimilarity = Number(option('--min-similarity', '0.9'));
const results = JSON.parse(readFileSync(option('--results'), 'utf8'));
const corpus = JSON.parse(readFileSync(new URL('../../evaluation/corpus.v1.json', import.meta.url), 'utf8'));
const documents = new Map(corpus.documents.map((document) => [document.objectId, document]));
const linesByPage = new Map(results.perPage.map((page) => [page.page, page.lines]));
const width = (box) => Math.max(0, box[2] - box[0]);

const blank = () => ({ pages: 0, pagesReadInFull: 0, boxes: 0, width: 0, skippedBoxes: 0, skippedWidth: 0 });
const totals = { devDocuments: blank(), otherDocuments: blank() };
const conflicts = [];
const failed = [];
const disagreements = [];
const contexts = new Map();
for (const entry of JSON.parse(readFileSync(join(sample, 'manifest.json'), 'utf8'))) {
  const [objectId, pageText] = entry.page.split('#');
  const document = documents.get(objectId);
  const ownPdf = join(sample, 'pdfs', entry.png.replace(/\.png$/u, '.pdf'));
  if (!document && !existsSync(ownPdf)) continue;
  if (document && document.split !== 'development') throw new Error(`${objectId} is not a development document.`);
  const source = document ? 'devDocuments' : 'otherDocuments';
  const pageNumber = Number(pageText);
  if (!contexts.has(objectId)) {
    contexts.set(objectId, await openDocumentContext(document ? join(dataRoot, 'corpus', document.path) : ownPdf));
  }
  const context = contexts.get(objectId);
  const rendered = (await renderStage(context, pageNumber)).value.renderedPage;
  const native = (await nativeStage(context, pageNumber)).value;
  let geometry;
  try {
    geometry = validateNativePageGeometry(pageNumber, native, rendered);
  } catch (error) {
    // The service fails such a page closed; it is outside what selective OCR can affect.
    failed.push({ source, page: entry.page, error: String(error.message) });
    continue;
  }
  const natives = normalizeNative(context.identity, pageNumber, geometry, native.observations);
  const nativeLines = buildNativeLines(natives, renderedPixelsPerPoint(geometry));
  const ocr = linesByPage.get(entry.page)
    .filter((line) => line.text.trim() && line.box)
    .map((line, index) => ({
      id: `ocr:${index}`, pageNumber, text: line.text.trim(), confidence: line.score,
      box: roundBox(line.box.map((value, axis) => Math.min(Math.max(0, value), axis % 2 ? geometry.height : geometry.width)))
    }));
  const result = await recognizeSelectively({
    boxes: ocr.map((observation) => observation.box),
    nativeObservations: natives,
    nativeLines,
    readAll: native.textLayerDistrust,
    recognize: async (indices) => indices.map((index) => ({ index, text: ocr[index].text }))
  });
  const skipped = new Set(result.skipped.map((skip) => ocr[skip.index].id));
  const total = totals[source];
  total.pages += 1;
  if (native.textLayerDistrust) total.pagesReadInFull += 1;
  for (const observation of ocr) {
    total.boxes += 1; total.width += width(observation.box);
    if (skipped.has(observation.id)) { total.skippedBoxes += 1; total.skippedWidth += width(observation.box); }
  }
  const association = associateNativeAndOcr(natives, ocr, { pixelsPerPoint: renderedPixelsPerPoint(geometry) });
  for (const conflict of association.conflicts) {
    if (skipped.has(conflict.ocrId)) conflicts.push({ source, page: entry.page, reason: conflict.reason, native: conflict.nativeText, ocr: conflict.ocrText });
  }
  for (const skip of result.skipped) {
    const observation = ocr[skip.index];
    const under = natives
      .filter((item) => intersectionArea(observation.box, item.box) > 0)
      .sort((left, right) => left.box[0] - right.box[0]);
    // Best of the whole overlap and each single item: a box often clips a neighbouring line.
    const candidates = [under.map((item) => item.text).join(' '), ...under.map((item) => item.text)];
    const similarity = Math.max(...candidates.map((text) => textSimilarity(text, observation.text)));
    if (similarity < minSimilarity) {
      disagreements.push({ source, page: entry.page, similarity: Math.round(similarity * 100) / 100, native: candidates[0], ocr: observation.text, score: observation.confidence });
    }
  }
}
for (const context of contexts.values()) await context.dispose();

const share = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 1000 : 0);
const summary = {
  sample,
  ...Object.fromEntries(Object.entries(totals).map(([source, total]) => [source, {
    pages: total.pages, pagesReadInFull: total.pagesReadInFull, boxes: total.boxes, skippedBoxes: total.skippedBoxes,
    skippedShare: { boxes: share(total.skippedBoxes, total.boxes), width: share(total.skippedWidth, total.width) }
  }])),
  pagesTheParserRejects: failed,
  conflictsInSkippedBoxes: conflicts,
  minSimilarity,
  disagreementsInSkippedBoxes: disagreements.sort((left, right) => left.similarity - right.similarity)
};
const text = `${JSON.stringify(summary, null, 1)}\n`;
if (option('--out')) writeFileSync(option('--out'), text);
process.stdout.write(text);

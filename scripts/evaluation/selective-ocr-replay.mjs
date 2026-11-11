/**
 * Replay a full-OCR run under the live selective-OCR rule (src/selective-ocr.ts).
 *
 * Design: docs/design/2026-11-07-selective-ocr.md
 * Trial:  docs/trials/2026-11-11-selective-ocr-build.md
 *
 * Each first-pass OCR observation of a stored page record stands for one
 * detected box. recognizeSelectively() decides, exactly as the live mode does,
 * which boxes to read; "reading" returns the stored OCR text. Reports the
 * share of recognizer work skipped, why boxes were read, every recorded
 * conflict whose box would be skipped, and every wrong or edited gold token
 * that only skipped boxes contain.
 *
 * Unlike selective_ocr_replay.py this runs the per-page font audit, so its
 * skip share is net of audit lines. Page-level reasons to read everything
 * (a page image) are not in stored records and are not applied here.
 *
 * --renative <data-root> re-extracts the native observations from the corpus
 * PDFs with the current native adapter instead of using the stored ones, so a
 * native-adapter change can be replayed against stored OCR.
 *
 *   npm run build && node scripts/evaluation/selective-ocr-replay.mjs \
 *     --run-root .evaluation/runs/<run-id> [--gold-root .evaluation/gold] \
 *     [--renative .evaluation] [--out summary.json]
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { normalizeNative } from '../../dist/page-parser.js';
import { buildNativeLines } from '../../dist/reading-order.js';
import { renderedPixelsPerPoint } from '../../dist/geometry.js';
import { recognizeSelectively } from '../../dist/selective-ocr.js';
import { nativeStage, openDocumentContext } from '../../service/lib/stages.mjs';

const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const runRoot = option('--run-root');
if (!runRoot) throw new Error('--run-root is required');
const goldRoot = option('--gold-root');
const renativeRoot = option('--renative');

const squash = (text) => text.normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
const width = (box) => Math.max(0, box[2] - box[0]);

const total = { pages: 0, boxes: 0, width: 0, chars: 0, skippedBoxes: 0, skippedWidth: 0, skippedChars: 0 };
const reasons = {};
const perDocument = {};
const lostConflicts = [];
const pageSkips = new Map(); // `${objectId}|${pageNumber}` -> { skippedTexts, readTexts }

const documentsRoot = join(runRoot, 'documents');
for (const documentDir of readdirSync(documentsRoot).sort()) {
  const pagesDir = join(documentsRoot, documentDir, 'pages');
  if (!existsSync(pagesDir)) continue;
  const doc = perDocument[documentDir] = { pages: 0, width: 0, skippedWidth: 0 };
  let context;
  for (const file of readdirSync(pagesDir).sort()) {
    const record = JSON.parse(readFileSync(join(pagesDir, file), 'utf8'));
    const page = record.pageSpatial;
    if (renativeRoot) {
      context ??= await openDocumentContext(join(renativeRoot, 'corpus', record.path));
      const native = await nativeStage(context, page.pageNumber);
      page.nativeObservations = normalizeNative(context.identity, page.pageNumber, page.geometry, native.value.observations);
      page.nativeLines = buildNativeLines(page.nativeObservations, renderedPixelsPerPoint(page.geometry));
    }
    const firstPass = page.ocrObservations.filter((observation) => !observation.recoveryMethod);
    const result = await recognizeSelectively({
      boxes: firstPass.map((observation) => observation.box),
      nativeObservations: page.nativeObservations,
      nativeLines: page.nativeLines,
      recognize: async (indices) => indices.map((index) => ({ index, text: firstPass[index].text }))
    });
    const skipped = new Set(result.skipped.map((skip) => firstPass[skip.index].id));
    total.pages += 1;
    doc.pages += 1;
    firstPass.forEach((observation, index) => {
      const w = width(observation.box);
      total.boxes += 1; total.width += w; total.chars += observation.text.length; doc.width += w;
      if (skipped.has(observation.id)) {
        total.skippedBoxes += 1; total.skippedWidth += w; total.skippedChars += observation.text.length; doc.skippedWidth += w;
      } else {
        const reason = result.reasons.get(index);
        reasons[reason] = (reasons[reason] ?? 0) + w;
      }
    });
    for (const conflict of page.conflicts) {
      if (skipped.has(conflict.ocrId)) {
        lostConflicts.push({ page: `${documentDir}/${file}`, reason: conflict.reason, native: conflict.nativeText.slice(0, 60), ocr: conflict.ocrText.slice(0, 60) });
      }
    }
    pageSkips.set(`${record.objectId ?? page.documentId}|${page.pageNumber}`, {
      skipped: firstPass.filter((observation) => skipped.has(observation.id)).map((observation) => squash(observation.text)),
      read: firstPass.filter((observation) => !skipped.has(observation.id)).map((observation) => squash(observation.text))
    });
  }
  await context?.dispose();
}

// Gold: a wrong or edited token is at risk when only skipped boxes contain it.
const gold = { wrongOrEdited: 0, onReplayedPages: 0, onlyInSkippedBoxes: [] };
if (goldRoot) {
  for (const batch of readdirSync(goldRoot).sort()) {
    const path = join(goldRoot, batch, 'gold-verdicts.json');
    if (!existsSync(path)) continue;
    for (const page of JSON.parse(readFileSync(path, 'utf8')).pages) {
      for (const token of page.tokens) {
        if (token.verdict !== 'wrong' && token.verdict !== 'edited') continue;
        gold.wrongOrEdited += 1;
        const texts = pageSkips.get(`${page.objectId}|${page.pageNumber}`);
        if (!texts) continue;
        gold.onReplayedPages += 1;
        const needle = squash(token.text);
        if (!texts.read.some((text) => text.includes(needle)) && texts.skipped.some((text) => text.includes(needle))) {
          gold.onlyInSkippedBoxes.push({ batch, objectId: page.objectId, pageNumber: page.pageNumber, token: token.text, verdict: token.verdict });
        }
      }
    }
  }
}

const share = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 1000 : 0);
const summary = {
  run: runRoot.split('/').filter(Boolean).pop(),
  pages: total.pages,
  boxes: total.boxes,
  skippedShare: {
    boxes: share(total.skippedBoxes, total.boxes),
    width: share(total.skippedWidth, total.width),
    chars: share(total.skippedChars, total.chars)
  },
  readWidthShareByReason: Object.fromEntries(Object.entries(reasons)
    .sort((a, b) => b[1] - a[1]).map(([reason, w]) => [reason, share(w, total.width)])),
  conflictsInSkippedBoxes: lostConflicts,
  gold,
  perDocument: Object.fromEntries(Object.entries(perDocument)
    .map(([name, doc]) => [name, { pages: doc.pages, skippedWidthShare: share(doc.skippedWidth, doc.width) }]))
};
const text = `${JSON.stringify(summary, null, 1)}\n`;
if (option('--out')) writeFileSync(option('--out'), text);
process.stdout.write(text);

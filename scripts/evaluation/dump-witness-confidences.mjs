/**
 * Adoption-ceremony calibration input: run the server-native PP-OCR witness
 * (the PR #55 adapter) over an already-rendered page set and dump each
 * observation's confidence AND text — so the candidate can be compared
 * against the same-model witness (calibration quantiles + per-token gold
 * classification). The output contains corpus text and MUST stay under the
 * gitignored .evaluation/ tree; committed aggregates carry counts only.
 *
 * Usage:
 *   node scripts/evaluation/dump-witness-confidences.mjs \
 *     --pages-dir .evaluation/hpi-ceremony \
 *     --assets-dir .evaluation/ocr-assets-small \
 *     --output .evaluation/hpi-ceremony/server-witness-confidences.json \
 *     [--threads 4]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { createPpOcrV6NodeAdapter } from '../../dist/node/ppocr-ocr.js';

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required argument ${name}`);
}

const pagesDir = arg('--pages-dir');
const assetsDir = arg('--assets-dir');
const outputPath = arg('--output');
const threads = Number(arg('--threads', '4'));

const manifest = JSON.parse(readFileSync(join(pagesDir, 'manifest.json'), 'utf8'));
const adapter = createPpOcrV6NodeAdapter({ assetsDir, variant: 'small', numThreads: threads });
await adapter.warmup();

const perPage = [];
for (const entry of manifest) {
  const png = PNG.sync.read(readFileSync(join(pagesDir, entry.png)));
  const result = await adapter.recognize({
    pageNumber: 1,
    geometry: { width: entry.geometry.width, height: entry.geometry.height },
    data: { data: png.data, width: png.width, height: png.height }
  });
  const observations = result.observations.map((observation) => ({
    text: observation.text,
    confidence: Number(observation.confidence.toFixed(4))
  }));
  perPage.push({ page: entry.page, observations });
  console.log(`[${perPage.length}/${manifest.length}] ${entry.page}: ${observations.length} observations`);
}
await adapter.dispose();

writeFileSync(outputPath, JSON.stringify({
  method: 'witness-confidence-dump-v1',
  adapter: adapter.name,
  threads,
  pages: perPage.length,
  perPage
}, null, 1));
console.log(`Wrote ${perPage.length} pages of confidences to ${outputPath}`);

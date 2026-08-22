/**
 * HPI benchmark, step 1 (issue #2 speed-arm 2): render a stratified ~30-page
 * sample from the witness-equivalence gold∩record set, with the EXACT render
 * path the server witness used (rotation-aware dpi from the record's own
 * geometry; pdftoppm -r; dims must match geometry within 5% or fail closed).
 * The benchmark is reader-swap-camera-fixed by construction.
 *
 * Output: --output-dir gets page PNGs + manifest.json
 *   [{ page, png, geometry: {width, height}, pngWidth, pngHeight }]
 * PNGs contain corpus content — the output dir must live under .evaluation/
 * (gitignored). The manifest carries no page text.
 *
 * Usage:
 *   node scripts/evaluation/hpi-bench-render.mjs \
 *     --run-root .evaluation/runs/<run-id> \
 *     --corpus-root .evaluation/corpus \
 *     --equivalence evaluation/witness-equivalence-v2.json \
 *     --output-dir .evaluation/hpi-bench
 */
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PNG } from 'pngjs';

const execFileAsync = promisify(execFile);

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  throw new Error(`Missing required argument ${name}`);
}

const runRoot = arg('--run-root');
const corpusRoot = arg('--corpus-root');
const equivalencePath = arg('--equivalence');
const outputDir = arg('--output-dir');
mkdirSync(outputDir, { recursive: true });

// Stratified selection over the equivalence sample's families: rotated
// (blackstone), CJK (monotaro, p61 pinned), dense tables (world-bank),
// plus ordinary pages across the remaining families. Deterministic: pages
// sorted lexicographically within family, first-N taken.
const QUOTAS = [
  ['public-comps:blackstone', 5],
  ['public-comps:monotaro', 5],
  ['world-bank:', 6],
  ['osf:', 5],
  ['legistar:', 4],
  ['pa-sers:2024-09-24', 3],
  ['pa-sers:2026-06-09', 1],
  ['public-comps:ares', 2],
  ['public-comps:asseco-poland', 1]
];
const PINNED = ['public-comps:monotaro:2025-fy:003#61'];

const equivalence = JSON.parse(readFileSync(equivalencePath, 'utf8'));
const pages = equivalence.perPage.map((entry) => entry.page).sort();
const selected = new Set(PINNED.filter((key) => pages.includes(key)));
for (const [prefix, quota] of QUOTAS) {
  let taken = [...selected].filter((key) => key.startsWith(prefix)).length;
  for (const key of pages) {
    if (taken >= quota) break;
    if (key.startsWith(prefix) && !selected.has(key)) {
      selected.add(key);
      taken += 1;
    }
  }
}
console.log(`Selected ${selected.size} pages.`);

const recordIndex = new Map();
for (const doc of readdirSync(join(runRoot, 'documents'))) {
  let files;
  try { files = readdirSync(join(runRoot, 'documents', doc, 'pages')); } catch { continue; }
  for (const file of files) {
    const record = JSON.parse(readFileSync(join(runRoot, 'documents', doc, 'pages', file), 'utf8'));
    if (!record.pageSpatial) continue;
    recordIndex.set(`${record.objectId}#${record.pageNumber}`, record);
  }
}

const manifest = [];
for (const key of [...selected].sort()) {
  const record = recordIndex.get(key);
  if (!record) throw new Error(`No run record for ${key}`);
  const page = record.pageSpatial;
  const { width, height, pointWidth, pointHeight, rotation } = page.geometry;
  // Same rotation-aware dpi as witness-equivalence.mjs — -scale-to-x/y
  // applies pre-rotation and transposes 90° pages; render by dpi instead.
  const scale = (rotation % 180 !== 0) ? width / pointHeight : width / pointWidth;
  const prefix = join(outputDir, 'tmp-page');
  await execFileAsync('pdftoppm', [
    '-f', String(record.pageNumber), '-l', String(record.pageNumber),
    '-r', String(scale * 72),
    '-png', join(corpusRoot, record.path), prefix
  ]);
  const produced = readdirSync(outputDir).find((name) => name.startsWith('tmp-page'));
  if (!produced) throw new Error(`pdftoppm produced no image for ${key}`);
  const safeName = `${key.replaceAll(/[^a-zA-Z0-9]+/gu, '_')}.png`;
  renameSync(join(outputDir, produced), join(outputDir, safeName));
  const png = PNG.sync.read(readFileSync(join(outputDir, safeName)));
  if (Math.abs(png.width / width - 1) > 0.05 || Math.abs(png.height / height - 1) > 0.05) {
    throw new Error(`${key}: render dims ${png.width}x${png.height} disagree with geometry ${width}x${height} beyond rounding.`);
  }
  manifest.push({ page: key, png: safeName, geometry: { width, height }, pngWidth: png.width, pngHeight: png.height });
  console.log(`${key} -> ${safeName} (${png.width}x${png.height})`);
}
writeFileSync(join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
console.log(`Wrote ${manifest.length} PNGs + manifest to ${outputDir}`);

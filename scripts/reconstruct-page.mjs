/**
 * Reconstruct one page of a run as SVG, from its record alone.
 *
 * Usage:
 *   node scripts/reconstruct-page.mjs \
 *     --run-root .evaluation/runs/<run-id> \
 *     --page '<objectId>#<pageNumber>' \
 *     --output <file.svg> [--second-opinion]
 *
 * Corpus page text is private: for corpus pages the output path must stay
 * under .evaluation/ or a temp/scratch directory (warned otherwise).
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { reconstructSvg } from '../dist/reconstruct.js';

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  throw new Error(`Missing required argument ${name}`);
}

const runRoot = arg('--run-root');
const pageKey = arg('--page');
const output = arg('--output');
const includeSecondOpinion = process.argv.includes('--second-opinion');

const [objectId, pageNumberRaw] = pageKey.split('#');
const pageNumber = Number(pageNumberRaw);
if (!objectId || !Number.isInteger(pageNumber)) throw new Error(`--page must be '<objectId>#<pageNumber>', got ${pageKey}`);

let page = null;
const documentsRoot = join(runRoot, 'documents');
for (const doc of readdirSync(documentsRoot)) {
  let files;
  try { files = readdirSync(join(documentsRoot, doc, 'pages')); } catch { continue; }
  for (const file of files) {
    const record = JSON.parse(readFileSync(join(documentsRoot, doc, 'pages', file), 'utf8'));
    if (record.objectId === objectId && record.pageNumber === pageNumber) { page = record.pageSpatial; break; }
  }
  if (page) break;
}
if (!page) throw new Error(`No record for ${pageKey} under ${runRoot}`);

const resolved = resolve(output);
if (!/\.evaluation|\/tmp\/|\/T\/|scratch/u.test(resolved)) {
  console.warn(`WARNING: ${resolved} is outside .evaluation/tmp/scratch — corpus page text is private; do not commit this file.`);
}

writeFileSync(output, reconstructSvg(page, { includeSecondOpinion }));
console.log(`Wrote ${output} (${page.nativeObservations.length} native, ${page.ocrObservations.length} ocr, ${page.conflicts.length} conflicts, ${(page.unreadInkRegions ?? []).length} regions).`);

/**
 * Build the FIXED Modal qualification manifest (design doc §14.1): the
 * 23-document correctness set plus the deterministic 100-call scaling set,
 * with request ids, subset-PDF sha256/bytes, page counts, class labels,
 * expected disposition, and permission classification. Text-free — corpus
 * documents stay outside git; only hashes and counts are committed.
 *
 * The manifest must be fixed (committed) BEFORE the M3 run's results are
 * viewed.
 *
 * Usage:
 *   node scripts/evaluation/build-modal-qualification-manifest.mjs \
 *     --data-root /abs/path/.evaluation \
 *     [--subset-dir <data-root>/m1-subset-pdfs] [--check]
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildQualificationManifest } from './lib/modal-qualification.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function flag(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  return process.argv[index + 1];
}

const dataRoot = flag('--data-root');
if (!dataRoot) throw new Error('--data-root is required (the .evaluation directory).');
const subsetDir = flag('--subset-dir', join(dataRoot, 'm1-subset-pdfs'));
const checkOnly = process.argv.includes('--check');
const outputPath = join(root, 'evaluation', 'modal-qualification', 'manifest.v1.json');

const corpus = JSON.parse(readFileSync(join(root, 'evaluation', 'corpus.v1.json'), 'utf8'));
const subsetIndex = JSON.parse(readFileSync(join(subsetDir, 'index.json'), 'utf8'));

const subsetHashes = new Map();
for (const document of subsetIndex.documents) {
  const path = join(subsetDir, document.file);
  const bytes = statSync(path).size;
  const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
  subsetHashes.set(document.objectId, { sha256, bytes });
}

const manifest = buildQualificationManifest({ corpus, subsetIndex, subsetHashes });
const serialized = `${JSON.stringify(manifest, null, 1)}\n`;

if (checkOnly) {
  const committed = readFileSync(outputPath, 'utf8');
  if (committed !== serialized) {
    throw new Error('Committed manifest does not match a fresh rebuild from local subset PDFs.');
  }
  console.log('manifest check OK:', outputPath);
} else {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, serialized);
  console.log('wrote', outputPath);
  console.log(JSON.stringify(manifest.distributions, null, 1));
}

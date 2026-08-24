#!/usr/bin/env node

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';

function value(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const root = process.cwd();
const manifestPath = resolve(root, value('--manifest', 'evaluation/gpu-spike/english-diagnostic-v1.json'));
const sourceDir = resolve(root, value('--source-dir', '.evaluation/hpi-ceremony'));
const outputDir = resolve(root, value('--output-dir', '.evaluation/gpu-spike/english-diagnostic-v1'));
const checkOnly = process.argv.includes('--check');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

if (manifest.schemaVersion !== 'pagespatial-gpu-spike-english-diagnostic-v1') {
  throw new Error(`Unsupported manifest schema: ${manifest.schemaVersion}`);
}
if (manifest.languageScope !== 'en' || manifest.selection?.holdoutAccessed !== false) {
  throw new Error('GPU spike manifest must be English-only and must not access holdout data.');
}
if (manifest.pages.length !== 32 || new Set(manifest.pages.map(({ page }) => page)).size !== 32) {
  throw new Error('GPU spike diagnostic manifest must contain 32 unique pages.');
}

const runtime = [];
for (const entry of manifest.pages) {
  const source = join(sourceDir, basename(entry.sourcePng));
  const bytes = readFileSync(source);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== entry.sha256) {
    throw new Error(`${entry.page}: PNG SHA-256 ${actual} != frozen ${entry.sha256}`);
  }
  const outputName = `${String(runtime.length + 1).padStart(2, '0')}-${basename(entry.sourcePng)}`;
  if (!checkOnly) {
    mkdirSync(outputDir, { recursive: true });
    copyFileSync(source, join(outputDir, outputName));
  }
  runtime.push({
    page: entry.page,
    png: outputName,
    sha256: entry.sha256,
    pngWidth: entry.pngWidth,
    pngHeight: entry.pngHeight
  });
}

if (!checkOnly) {
  const out = join(outputDir, 'manifest.json');
  writeFileSync(out, `${JSON.stringify(runtime, null, 1)}\n`);
  console.log(`Wrote ${runtime.length} verified PNGs and ${out}`);
} else {
  console.log(`Verified ${runtime.length} frozen English diagnostic PNGs from ${dirname(sourceDir)}`);
}

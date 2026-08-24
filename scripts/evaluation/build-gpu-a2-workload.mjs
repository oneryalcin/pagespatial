#!/usr/bin/env node

/**
 * Materialize the frozen 50-page A2 workload. The output is derived evidence
 * and remains under gitignored .evaluation/; only its identity is committed.
 *
 * Usage:
 *   node scripts/evaluation/build-gpu-a2-workload.mjs
 *   node scripts/evaluation/build-gpu-a2-workload.mjs --check
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const defaultManifestPath = join(repoRoot, 'evaluation/gpu-spike/a2-50page-v1.json');

function flag(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function validateManifest(manifest) {
  if (manifest.schemaVersion !== 'pagespatial-gpu-a2-workload-v1') {
    throw new Error(`Unsupported manifest schema: ${manifest.schemaVersion}`);
  }
  if (manifest.workloadId !== 'a2-50page-v1' || manifest.languageScope !== 'en') {
    throw new Error('A2 workload must be the frozen English a2-50page-v1 workload.');
  }
  if (manifest.selection?.holdoutAccessed !== false) {
    throw new Error('A2 workload must not access holdout data.');
  }
  const pages = manifest.selection?.sourcePages;
  if (pages?.first !== 1 || pages?.last !== 50 || pages?.count !== 50) {
    throw new Error('A2 workload must select exactly source pages 1-50.');
  }
  for (const identity of [manifest.source, manifest.output]) {
    if (!identity || !/^[0-9a-f]{64}$/u.test(identity.sha256)) {
      throw new Error('A2 source and output require pinned SHA-256 identities.');
    }
    if (!Number.isSafeInteger(identity.bytes) || identity.bytes <= 0 ||
        !Number.isSafeInteger(identity.pageCount) || identity.pageCount <= 0) {
      throw new Error('A2 source and output require positive byte and page counts.');
    }
  }
  if (manifest.output.pageCount !== 50) {
    throw new Error('A2 derived PDF must contain exactly 50 pages.');
  }
  if (/holdout/iu.test(manifest.source.path) || /holdout/iu.test(manifest.output.path)) {
    throw new Error('A2 workload paths must not reference holdout data.');
  }
}

export function qpdfBuildArgs(sourcePath, outputPath) {
  return [
    '--warning-exit-0',
    '--decrypt',
    '--deterministic-id',
    '--object-streams=preserve',
    '--stream-data=preserve',
    '--pages', sourcePath, '1-50', '--', sourcePath, outputPath
  ];
}

function qpdfPageCount(path) {
  return Number.parseInt(execFileSync('qpdf', ['--show-npages', path], { encoding: 'utf8' }).trim(), 10);
}

export function verifyIdentity(label, path, expected, pageCount = qpdfPageCount) {
  const actual = {
    sha256: sha256File(path),
    bytes: statSync(path).size,
    pageCount: pageCount(path)
  };
  for (const field of ['sha256', 'bytes', 'pageCount']) {
    if (actual[field] !== expected[field]) {
      throw new Error(`${label} ${field} ${actual[field]} != frozen ${expected[field]}`);
    }
  }
  return actual;
}

export function run({ manifestPath = defaultManifestPath, outputPath, checkOnly = false } = {}) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  validateManifest(manifest);

  const sourcePath = resolve(repoRoot, manifest.source.path);
  const derivedPath = outputPath ? resolve(outputPath) : resolve(repoRoot, manifest.output.path);
  verifyIdentity('source', sourcePath, manifest.source);

  if (!checkOnly) {
    mkdirSync(dirname(derivedPath), { recursive: true });
    const temporaryDir = mkdtempSync(join(dirname(derivedPath), `.${basename(derivedPath)}.tmp-`));
    const temporaryPath = join(temporaryDir, basename(derivedPath));
    try {
      execFileSync('qpdf', qpdfBuildArgs(sourcePath, temporaryPath), {
        stdio: ['ignore', 'ignore', 'pipe']
      });
      verifyIdentity('generated output', temporaryPath, manifest.output);
      renameSync(temporaryPath, derivedPath);
    } finally {
      rmSync(temporaryDir, { recursive: true, force: true });
    }
  }

  verifyIdentity('output', derivedPath, manifest.output);
  console.log(`${checkOnly ? 'Verified' : 'Wrote and verified'} ${manifest.output.pageCount} pages at ${derivedPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifestPath = resolve(flag('--manifest', defaultManifestPath));
  const outputPath = flag('--out');
  run({ manifestPath, outputPath, checkOnly: process.argv.includes('--check') });
}

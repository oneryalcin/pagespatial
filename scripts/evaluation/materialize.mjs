#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  DEFAULT_CORPUS_MANIFEST_PATH,
  DEVELOPMENT_SPLIT,
  getDevelopmentDocuments,
  loadCorpusManifest
} from './lib/manifest.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_EVALUATION_DATA_ROOT = join(repositoryRoot, '.evaluation');

export async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function regularFileState(path) {
  const state = await lstat(path).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (state?.isSymbolicLink() || (state && !state.isFile())) throw new Error(`Materialization target exists but is not a regular non-symlink file: ${path}`);
  return state;
}

async function ensurePrivateDirectory(path) {
  const resolved = resolve(path);
  const existing = await lstat(resolved).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (existing?.isSymbolicLink() || (existing && !existing.isDirectory())) throw new Error(`Evaluation directory must not be a symlink: ${resolved}`);
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  await chmod(resolved, 0o700);
  return realpath(resolved);
}

async function ensureContainedParent(root, target) {
  const rootReal = await ensurePrivateDirectory(root);
  const parent = dirname(resolve(target));
  const rel = relative(resolve(root), parent);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Materialization target escapes the corpus root.');
  let current = resolve(root);
  for (const component of rel.split(sep)) {
    current = join(current, component);
    const state = await lstat(current).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (state?.isSymbolicLink() || (state && !state.isDirectory())) throw new Error(`Symlinked evaluation paths are not allowed: ${current}`);
    if (!state) await mkdir(current, { mode: 0o700 });
    await chmod(current, 0o700);
  }
  const parentReal = await realpath(parent);
  const physical = relative(rootReal, parentReal);
  if (physical === '..' || physical.startsWith(`..${sep}`) || isAbsolute(physical)) throw new Error('Materialization target resolves outside the corpus root.');
}

export function resolveMaterializedPath(dataRoot, document) {
  if (document.split !== DEVELOPMENT_SPLIT) throw new Error(`Refusing to resolve non-development object ${document.objectId}.`);
  return join(resolve(dataRoot), 'corpus', ...document.path.split('/'));
}

export function defaultCommandRunner(command, args, { cwd } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { if (stdout.length < 64_000) stdout += chunk; });
    child.stderr.on('data', (chunk) => { if (stderr.length < 64_000) stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
  });
}

async function runChecked(commandRunner, command, args, options, description) {
  let result;
  try {
    result = await commandRunner(command, args, options);
  } catch (error) {
    throw new Error(`${description} could not start: ${error.message}`, { cause: error });
  }
  if (!result || result.code !== 0) {
    const suffix = result?.signal ? ` (signal ${result.signal})` : '';
    throw new Error(`${description} failed${suffix}.`);
  }
  return result;
}

async function writeJsonAtomically(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * Materialize the full development split. There is deliberately no document or
 * split selector in this API: v1 cannot request a holdout object.
 */
export async function materializeDevelopmentCorpus({
  manifest,
  dataRoot = DEFAULT_EVALUATION_DATA_ROOT,
  dryRun = false,
  commandRunner = defaultCommandRunner,
  now = () => new Date()
} = {}) {
  const loadedManifest = manifest ?? (await loadCorpusManifest(DEFAULT_CORPUS_MANIFEST_PATH)).manifest;
  const documents = getDevelopmentDocuments(loadedManifest);
  if (documents.length !== 23 || documents.some(({ split }) => split !== DEVELOPMENT_SPLIT)) {
    throw new Error('Development materialization requires exactly the canonical 23 development documents.');
  }

  const paths = documents.map(({ path }) => path);
  const holdoutPaths = new Set(loadedManifest.documents.filter(({ split }) => split !== DEVELOPMENT_SPLIT).map(({ path }) => path));
  if (paths.some((path) => holdoutPaths.has(path))) throw new Error('Development path set intersects the holdout path set.');
  if (dryRun) return { dryRun: true, paths };

  const root = resolve(dataRoot);
  const corpusRoot = join(root, 'corpus');
  await ensurePrivateDirectory(root);
  await ensurePrivateDirectory(corpusRoot);
  const outcomes = [];
  const missing = [];
  for (const document of documents) {
    const target = resolveMaterializedPath(root, document);
    await ensureContainedParent(corpusRoot, target);
    const state = await regularFileState(target);
    if (!state) {
      missing.push({ document, target });
      continue;
    }
    const actual = await sha256File(target);
    if (actual !== document.sha256) {
      throw new Error(`Existing PDF has SHA-256 ${actual}; expected ${document.sha256}: ${target}`);
    }
    outcomes.push({ objectId: document.objectId, path: document.path, sha256: document.sha256, status: 'reused' });
  }

  if (missing.length > 0) {
    await runChecked(commandRunner, 'hf', ['auth', 'whoami'], {}, 'Hugging Face authentication check');
  }

  for (const { document, target } of missing) {
    const temporaryRoot = await mkdtemp(join(dirname(target), `.${basename(target)}.download-`));
    const downloadedPath = join(temporaryRoot, ...document.path.split('/'));
    try {
      await runChecked(commandRunner, 'hf', [
        'download',
        loadedManifest.dataset.repoId,
        document.path,
        '--repo-type', loadedManifest.dataset.repoType,
        '--revision', loadedManifest.dataset.revision,
        '--local-dir', temporaryRoot
      ], {}, `Hugging Face download for ${document.objectId}`);
      const downloadedState = await regularFileState(downloadedPath);
      if (!downloadedState) throw new Error(`Hugging Face did not materialize the requested path: ${document.path}`);
      const temporaryReal = await realpath(temporaryRoot);
      const downloadedReal = await realpath(downloadedPath);
      const downloadedRelative = relative(temporaryReal, downloadedReal);
      if (downloadedRelative === '..' || downloadedRelative.startsWith(`..${sep}`) || isAbsolute(downloadedRelative)) {
        throw new Error('Downloaded PDF resolves outside its private temporary directory.');
      }
      const actual = await sha256File(downloadedPath);
      if (actual !== document.sha256) {
        throw new Error(`Downloaded PDF has SHA-256 ${actual}; expected ${document.sha256}: ${document.path}`);
      }
      if (await regularFileState(target)) throw new Error(`Materialization target appeared during download: ${target}`);
      await rename(downloadedPath, target);
      await chmod(target, 0o600);
      outcomes.push({ objectId: document.objectId, path: document.path, sha256: document.sha256, status: 'downloaded' });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }

  const outcomeById = new Map(outcomes.map((outcome) => [outcome.objectId, outcome]));
  const report = {
    schemaVersion: 'pagespatial-materialization-v1',
    createdAt: now().toISOString(),
    dataset: { ...loadedManifest.dataset },
    dataRoot: root,
    documents: documents.map(({ objectId }) => outcomeById.get(objectId))
  };
  await writeJsonAtomically(join(root, 'materialization.json'), report);
  return report;
}

export function parseMaterializerArguments(argv) {
  let dataRoot = DEFAULT_EVALUATION_DATA_ROOT;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') {
      if (dryRun) throw new Error('--dry-run may be provided only once.');
      dryRun = true;
    } else if (argument === '--data-root') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--data-root requires a directory path.');
      dataRoot = resolve(value);
      index += 1;
    } else {
      throw new Error(`Unknown materializer argument: ${argument}`);
    }
  }
  return { dataRoot, dryRun };
}

async function main() {
  const options = parseMaterializerArguments(process.argv.slice(2));
  const result = await materializeDevelopmentCorpus(options);
  if (result.dryRun) {
    for (const path of result.paths) console.log(path);
    console.log(`Dry run: ${result.paths.length} development PDFs at the pinned revision.`);
    return;
  }
  const downloaded = result.documents.filter(({ status }) => status === 'downloaded').length;
  const reused = result.documents.length - downloaded;
  console.log(`Materialized ${result.documents.length} development PDFs: ${downloaded} downloaded, ${reused} reused.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

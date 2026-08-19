import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CORPUS_SCHEMA_VERSION = 'pagespatial-corpus-v1';
export const DEVELOPMENT_SPLIT = 'development';
export const HOLDOUT_SPLIT = 'holdout';

export const CORPUS_CLASS_LABELS = Object.freeze([
  'native-text',
  'image-only',
  'mixed-raster-native',
  'dense-table',
  'chart',
  'multi-column',
  'form',
  'multilingual',
  'slides',
  'long-document',
  'landscape',
  'sparse-overlay',
  'translation-sibling',
  'packet-sibling',
  'version-sibling'
]);

export const DEFAULT_CORPUS_MANIFEST_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..',
  'evaluation', 'corpus.v1.json'
);

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ALLOWED_LABELS = new Set(CORPUS_CLASS_LABELS);

function fail(message) {
  throw new TypeError(`Invalid PageSpatial corpus manifest: ${message}`);
}

function assertExactKeys(value, expected, location) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${location} must contain exactly: ${wanted.join(', ')}.`);
  }
}

function assertSafeDatasetPath(path, location) {
  if (typeof path !== 'string' || path.length === 0) fail(`${location}.path must be a non-empty string.`);
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) fail(`${location}.path is unsafe: ${path}`);
  const parts = path.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) fail(`${location}.path is unsafe: ${path}`);
  if (!path.toLowerCase().endsWith('.pdf')) fail(`${location}.path must end in .pdf.`);
}

/**
 * Validate the committed v1 corpus and return the same object for convenient use.
 * The exact counts are part of the v1 contract, rather than caller-supplied options.
 */
export function validateCorpusManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('root must be an object.');
  assertExactKeys(manifest, ['schemaVersion', 'dataset', 'documents'], 'root');
  if (manifest.schemaVersion !== CORPUS_SCHEMA_VERSION) fail(`schemaVersion must be ${CORPUS_SCHEMA_VERSION}.`);

  const dataset = manifest.dataset;
  if (!dataset || typeof dataset !== 'object' || Array.isArray(dataset)) fail('dataset must be an object.');
  assertExactKeys(dataset, ['repoType', 'repoId', 'revision'], 'dataset');
  if (dataset.repoType !== 'dataset') fail('dataset.repoType must be dataset.');
  if (typeof dataset.repoId !== 'string' || !/^[^/\s]+\/[^/\s]+$/u.test(dataset.repoId)) fail('dataset.repoId is invalid.');
  if (typeof dataset.revision !== 'string' || !/^[a-f0-9]{40}$/u.test(dataset.revision)) fail('dataset.revision must be a full Git commit hash.');

  if (!Array.isArray(manifest.documents) || manifest.documents.length !== 36) fail('documents must contain exactly 36 entries.');
  const objectIds = new Set();
  const paths = new Set();
  const hashes = new Set();
  const familySplits = new Map();
  const tupleIds = new Set();
  let developmentDocuments = 0;
  let holdoutDocuments = 0;
  let developmentPages = 0;
  let holdoutPages = 0;

  for (const [documentIndex, document] of manifest.documents.entries()) {
    const location = `documents[${documentIndex}]`;
    if (!document || typeof document !== 'object' || Array.isArray(document)) fail(`${location} must be an object.`);
    assertExactKeys(document, [
      'objectId', 'path', 'sha256', 'pageCount', 'split', 'familyId', 'selectionNotes', 'pages'
    ], location);
    if (typeof document.objectId !== 'string' || document.objectId.length === 0) fail(`${location}.objectId is invalid.`);
    if (objectIds.has(document.objectId)) fail(`duplicate objectId: ${document.objectId}`);
    objectIds.add(document.objectId);
    assertSafeDatasetPath(document.path, location);
    if (paths.has(document.path)) fail(`duplicate path: ${document.path}`);
    paths.add(document.path);
    if (typeof document.sha256 !== 'string' || !SHA256_PATTERN.test(document.sha256)) fail(`${location}.sha256 is invalid.`);
    if (hashes.has(document.sha256)) fail(`duplicate sha256: ${document.sha256}`);
    hashes.add(document.sha256);
    if (!Number.isSafeInteger(document.pageCount) || document.pageCount < 1) fail(`${location}.pageCount is invalid.`);
    if (document.split !== DEVELOPMENT_SPLIT && document.split !== HOLDOUT_SPLIT) fail(`${location}.split is invalid.`);
    if (document.split === DEVELOPMENT_SPLIT) developmentDocuments += 1;
    else holdoutDocuments += 1;
    if (typeof document.familyId !== 'string' || document.familyId.length === 0) fail(`${location}.familyId is invalid.`);
    const priorSplit = familySplits.get(document.familyId);
    if (priorSplit && priorSplit !== document.split) fail(`family ${document.familyId} crosses splits.`);
    familySplits.set(document.familyId, document.split);
    if (!Array.isArray(document.selectionNotes) || !document.selectionNotes.every((note) => typeof note === 'string' && note.length > 0)) {
      fail(`${location}.selectionNotes must contain strings.`);
    }
    if (!Array.isArray(document.pages) || document.pages.length === 0) fail(`${location}.pages must be non-empty.`);
    let priorPage = 0;
    for (const [pageIndex, page] of document.pages.entries()) {
      const pageLocation = `${location}.pages[${pageIndex}]`;
      if (!page || typeof page !== 'object' || Array.isArray(page)) fail(`${pageLocation} must be an object.`);
      assertExactKeys(page, ['pageNumber', 'labels'], pageLocation);
      if (!Number.isSafeInteger(page.pageNumber) || page.pageNumber < 1 || page.pageNumber > document.pageCount) {
        fail(`${pageLocation}.pageNumber is outside 1..${document.pageCount}.`);
      }
      if (page.pageNumber <= priorPage) fail(`${location}.pages must be strictly increasing and unique.`);
      priorPage = page.pageNumber;
      const tupleId = `${document.objectId}\0${page.pageNumber}`;
      if (tupleIds.has(tupleId)) fail(`duplicate object/page tuple: ${document.objectId} page ${page.pageNumber}.`);
      tupleIds.add(tupleId);
      if (!Array.isArray(page.labels) || page.labels.length === 0) fail(`${pageLocation}.labels must be non-empty.`);
      const labelSet = new Set(page.labels);
      if (labelSet.size !== page.labels.length || page.labels.some((label) => typeof label !== 'string' || !ALLOWED_LABELS.has(label))) {
        fail(`${pageLocation}.labels contains an unknown or duplicate label.`);
      }
      const ordered = CORPUS_CLASS_LABELS.filter((label) => labelSet.has(label));
      if (ordered.some((label, index) => label !== page.labels[index])) fail(`${pageLocation}.labels are not in canonical order.`);
      if (document.split === DEVELOPMENT_SPLIT) developmentPages += 1;
      else holdoutPages += 1;
    }
  }

  if (developmentDocuments !== 23 || holdoutDocuments !== 13) fail('split must contain 23 development and 13 holdout documents.');
  if (developmentPages !== 162 || holdoutPages !== 89) fail('split must contain 162 development and 89 holdout pages.');
  if (familySplits.size !== 31) fail('v1 must contain exactly 31 document families.');
  return manifest;
}

export async function loadCorpusManifest(path = DEFAULT_CORPUS_MANIFEST_PATH) {
  const raw = await readFile(path, 'utf8');
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    throw new TypeError(`Invalid PageSpatial corpus manifest JSON at ${path}: ${error.message}`, { cause: error });
  }
  validateCorpusManifest(manifest);
  return {
    manifest,
    raw,
    hash: createHash('sha256').update(raw).digest('hex')
  };
}

export function getDevelopmentDocuments(manifest) {
  validateCorpusManifest(manifest);
  return manifest.documents.filter(({ split }) => split === DEVELOPMENT_SPLIT);
}

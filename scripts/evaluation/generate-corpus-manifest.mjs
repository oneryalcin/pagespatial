import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORPUS_CLASS_LABELS, validateCorpusManifest } from './lib/manifest.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sourceDirectory = join(repositoryRoot, 'evaluation', 'corpus', 'manifests');
const outputPath = join(repositoryRoot, 'evaluation', 'corpus.v1.json');
const checkOnly = process.argv.includes('--check');
const unknownArguments = process.argv.slice(2).filter((argument) => argument !== '--check');
if (unknownArguments.length > 0) throw new Error(`Unknown argument: ${unknownArguments[0]}`);

const readJson = async (name) => JSON.parse(await readFile(join(sourceDirectory, name), 'utf8'));
const [selection, financial, government, osf] = await Promise.all([
  readJson('selection.json'), readJson('financial.json'), readJson('government.json'), readJson('osf.json')
]);

function expandPageSelection(selectionValue) {
  if (Array.isArray(selectionValue)) return [...selectionValue].sort((left, right) => left - right);
  const pages = new Set();
  for (const part of selectionValue.split(',')) {
    const [startText, endText = startText] = part.trim().split('-');
    const start = Number(startText);
    const end = Number(endText);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) throw new Error(`Invalid page selection: ${selectionValue}`);
    for (let page = start; page <= end; page += 1) pages.add(page);
  }
  return [...pages].sort((left, right) => left - right);
}

function proseFor(record) {
  return [
    record.layout_class,
    record.observed,
    record.reason,
    ...(record.verified_characteristics ?? []),
    record.measurements?.page_size,
    record.native_text?.density,
    record.raster_image_evidence?.notes
  ].filter(Boolean).map(String);
}

function sourceImageCount(record) {
  return record.raster_image_evidence?.pdfimages_records
    ?? record.measurements?.pdfimages_rows
    ?? record.measurements?.image_objects
    ?? 0;
}

const developmentIds = new Set(selection.development_object_ids);
const holdoutIds = new Set(selection.holdout_object_ids);
const imageOnlyIds = new Set(selection.confirmed_image_only_object_ids);
const families = new Map([
  ['public-comps:monotaro:2025-fy:003', ['family:monotaro-2025-integrated-report', 'translation-sibling']],
  ['public-comps:monotaro:2025-fy:004', ['family:monotaro-2025-integrated-report', 'translation-sibling']],
  ['pa-sers:2024-09-24:llr-vii:staff-memo', ['family:llr-vii-2024-09-24-packet', 'packet-sibling']],
  ['pa-sers:2024-09-24:llr-vii:consultant-memo', ['family:llr-vii-2024-09-24-packet', 'packet-sibling']],
  ['pa-sers:2024-09-24:llr-vii:manager-presentation', ['family:llr-vii-2024-09-24-packet', 'packet-sibling']],
  ['osf:file:6826158a05236079589c42c3:v1', ['family:nviq-preprint-27085689', 'version-sibling']],
  ['osf:file:6826162a05236079589c42d8:v1', ['family:nviq-preprint-27085689', 'version-sibling']],
  ['osf:file:67c9ea0bc0b41e91d8fd6c97:v1', ['family:real-e-preprint-27085689', 'version-sibling']],
  ['osf:file:652d65a187852d06ada59245:v1', ['family:real-e-preprint-27085689', 'version-sibling']]
]);

function labelsFor(record, pageNumber) {
  const objectId = record.object_id;
  const pageCount = record.page_count ?? record.total_pages;
  const prose = proseFor(record).join(' ').normalize('NFKC');
  const labels = new Set();
  if (pageCount >= 100) labels.add('long-document');
  if (imageOnlyIds.has(objectId)) labels.add('image-only');
  else labels.add('native-text');
  if (sourceImageCount(record) > 0 && !imageOnlyIds.has(objectId)) labels.add('mixed-raster-native');
  if (/\btables?\b|\bfinancial statements?\b|\bfinancial data\b|\bforms?\b|\bfields?\b/iu.test(prose)) labels.add('dense-table');
  if (/\bforms?\b|\bcheckbox(?:es)?\b|\bfields?\b/iu.test(prose)) labels.add('form');
  if (/\bcharts?\b|\bgraphs?\b|\bfigures?\b|\bkpi\b|\bvisuali[sz]ations?\b/iu.test(prose)) labels.add('chart');
  if (/\bmulti-column\b|\btwo-column\b|\bacademic paper\b|\bannual report\b|\bintegrated report\b/iu.test(prose)) labels.add('multi-column');
  if (objectId.startsWith('public-comps:monotaro:') || /\bbilingual\b|\bmultilingual\b|\bjapanese\b|\bpolish\b|\bindonesian\b/iu.test(prose)) labels.add('multilingual');
  if (/presentation|slide|deck/iu.test(`${record.path} ${prose}`)) labels.add('slides');
  if (/landscape/iu.test(prose)) labels.add('landscape');
  if (/sparse overlay|near-image-only|image-dominant/iu.test(prose)) labels.add('sparse-overlay');
  const family = families.get(objectId);
  if (family) labels.add(family[1]);
  if (objectId === 'osf:file:607883db0c818200885135da:v1' && pageNumber === 10) {
    labels.add('image-only');
    labels.delete('native-text');
  }
  return CORPUS_CLASS_LABELS.filter((label) => labels.has(label));
}

const records = [
  ...financial.candidates,
  ...government.candidates,
  ...osf.selected
];

const documents = records.map((record) => {
  const objectId = record.object_id;
  const split = developmentIds.has(objectId) ? 'development' : holdoutIds.has(objectId) ? 'holdout' : null;
  if (!split) throw new Error(`Object is absent from the authoritative split: ${objectId}`);
  const selectedPages = expandPageSelection(record.selected_pages);
  return {
    objectId,
    path: record.path,
    sha256: record.sha256,
    pageCount: record.page_count ?? record.total_pages,
    split,
    familyId: families.get(objectId)?.[0] ?? objectId,
    selectionNotes: proseFor(record),
    pages: selectedPages.map((pageNumber) => ({ pageNumber, labels: labelsFor(record, pageNumber) }))
  };
});

const manifest = {
  schemaVersion: 'pagespatial-corpus-v1',
  dataset: {
    repoType: selection.huggingface.repo_type,
    repoId: selection.huggingface.repo_id,
    revision: selection.huggingface.revision
  },
  documents
};

validateCorpusManifest(manifest);
const output = `${JSON.stringify(manifest, null, 2)}\n`;
if (checkOnly) {
  const existing = await readFile(outputPath, 'utf8');
  if (existing !== output) throw new Error(`Committed corpus manifest is stale. Run node ${process.argv[1]}.`);
  console.log(`Corpus manifest is current with ${documents.length} documents.`);
} else {
  await writeFile(outputPath, output, 'utf8');
  console.log(`Generated ${outputPath} with ${documents.length} documents.`);
}

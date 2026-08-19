import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  CORPUS_CLASS_LABELS,
  DEFAULT_CORPUS_MANIFEST_PATH,
  getDevelopmentDocuments,
  loadCorpusManifest,
  validateCorpusManifest
} from '../scripts/evaluation/lib/manifest.mjs';

test('canonical manifest has the fixed v1 identity and split totals', async () => {
  const { manifest, raw, hash } = await loadCorpusManifest();
  assert.equal(DEFAULT_CORPUS_MANIFEST_PATH.endsWith('/evaluation/corpus.v1.json'), true);
  assert.equal(hash, createHash('sha256').update(raw).digest('hex'));
  assert.deepEqual(manifest.dataset, {
    repoType: 'dataset',
    repoId: 'oneryalcin/enterprise-document-landfill',
    revision: 'e3ee38f067588644b11574ccc566843ca45f6d33'
  });
  assert.equal(manifest.documents.length, 36);
  assert.equal(getDevelopmentDocuments(manifest).length, 23);
  assert.equal(manifest.documents.filter(({ split }) => split === 'holdout').length, 13);
  assert.equal(manifest.documents.flatMap(({ pages }) => pages).length, 251);
  assert.equal(getDevelopmentDocuments(manifest).flatMap(({ pages }) => pages).length, 162);
});

test('canonical manifest snapshots all 251 object/page/label tuples', async () => {
  const { manifest } = await loadCorpusManifest();
  const tuples = manifest.documents.flatMap((document) => document.pages.map((page) => [
    document.objectId,
    page.pageNumber,
    page.labels
  ]));
  assert.equal(tuples.length, 251);
  assert.equal(
    createHash('sha256').update(JSON.stringify(tuples)).digest('hex'),
    'f4b15e38e13140698e74c2bbe4ed65797b1b9d58f1d4075f4d53796e3af111e1'
  );
  assert.deepEqual(
    manifest.documents.find(({ objectId }) => objectId === 'osf:file:607883db0c818200885135da:v1')
      .pages.find(({ pageNumber }) => pageNumber === 10).labels,
    ['image-only', 'mixed-raster-native', 'slides', 'landscape']
  );
});

test('v1 has only the four declared non-singleton families and no family leakage', async () => {
  const { manifest } = await loadCorpusManifest();
  const families = Map.groupBy(manifest.documents, ({ familyId }) => familyId);
  const nonSingleton = [...families].filter(([, documents]) => documents.length > 1);
  assert.deepEqual(nonSingleton.map(([familyId, documents]) => [
    familyId,
    documents.map(({ objectId }) => objectId),
    [...new Set(documents.map(({ split }) => split))]
  ]), [
    ['family:monotaro-2025-integrated-report', [
      'public-comps:monotaro:2025-fy:004',
      'public-comps:monotaro:2025-fy:003'
    ], ['development']],
    ['family:llr-vii-2024-09-24-packet', [
      'pa-sers:2024-09-24:llr-vii:staff-memo',
      'pa-sers:2024-09-24:llr-vii:consultant-memo',
      'pa-sers:2024-09-24:llr-vii:manager-presentation'
    ], ['development']],
    ['family:nviq-preprint-27085689', [
      'osf:file:6826158a05236079589c42c3:v1',
      'osf:file:6826162a05236079589c42d8:v1'
    ], ['development']],
    ['family:real-e-preprint-27085689', [
      'osf:file:67c9ea0bc0b41e91d8fd6c97:v1',
      'osf:file:652d65a187852d06ada59245:v1'
    ], ['holdout']]
  ]);
});

test('strict validator rejects unsafe paths, out-of-range pages, labels, and split leakage', async () => {
  const { manifest } = await loadCorpusManifest();
  const cases = [
    (copy) => { copy.documents[0].path = '../private.pdf'; },
    (copy) => { copy.documents[0].pages[0].pageNumber = copy.documents[0].pageCount + 1; },
    (copy) => { copy.documents[0].pages[0].labels = [...copy.documents[0].pages[0].labels, 'invented-label']; },
    (copy) => { copy.documents[1].split = 'holdout'; }
  ];
  for (const mutate of cases) {
    const copy = structuredClone(manifest);
    mutate(copy);
    assert.throws(() => validateCorpusManifest(copy), /Invalid PageSpatial corpus manifest/u);
  }
  assert.deepEqual(CORPUS_CLASS_LABELS, [
    'native-text', 'image-only', 'mixed-raster-native', 'dense-table', 'chart', 'multi-column', 'form',
    'multilingual', 'slides', 'long-document', 'landscape', 'sparse-overlay', 'translation-sibling',
    'packet-sibling', 'version-sibling'
  ]);
});

test('committed JSON Schema accepts the canonical manifest', async () => {
  const [{ default: Ajv2020 }, schema, manifest] = await Promise.all([
    import('ajv/dist/2020.js'),
    readFile(new URL('../evaluation/corpus.v1.schema.json', import.meta.url), 'utf8').then(JSON.parse),
    loadCorpusManifest().then(({ manifest }) => manifest)
  ]);
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  assert.equal(ajv.validate(schema, manifest), true, JSON.stringify(ajv.errors));
});

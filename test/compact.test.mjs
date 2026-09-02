import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  COMPACT_PAGE_SCHEMA_VERSION,
  compactPageSpatialSchema,
  projectCompactPage,
} from '../dist/index.js';
import { createValidDocument } from './fixture.mjs';

test('compact page is a deterministic projection without evidence arrays', async () => {
  const page = (await createValidDocument()).pages[0];
  const one = projectCompactPage(page);
  const two = projectCompactPage(structuredClone(page));

  assert.equal(JSON.stringify(one), JSON.stringify(two));
  assert.deepEqual(Object.keys(one), [
    'schemaVersion', 'documentId', 'revisionId', 'documentSha256',
    'pageId', 'pageNumber', 'projection', 'provenance',
  ]);
  assert.equal(one.schemaVersion, COMPACT_PAGE_SCHEMA_VERSION);
  assert.deepEqual(one.projection, page.projection);
  const { runId: _runId, createdAt: _createdAt, ...stableProvenance } = page.provenance;
  assert.deepEqual(one.provenance, stableProvenance);
  assert.equal(Object.hasOwn(one.provenance, 'runId'), false);
  assert.equal(Object.hasOwn(one.provenance, 'createdAt'), false);
  for (const field of [
    'geometry', 'nativeObservations', 'ocrObservations', 'nativeLines',
    'sourceMatches', 'conflicts', 'spatialRows', 'derivedRelations',
    'diagnostics', 'unreadInkRegions', 'secondOpinion',
  ]) {
    assert.equal(Object.hasOwn(one, field), false, `${field} must remain evidence-only`);
  }
  assert.equal(compactPageSpatialSchema.safeParse(one).success, true);
});

test('published compact JSON Schema is exact and rejects evidence fields', async () => {
  const schema = JSON.parse(await readFile(
    new URL('../schemas/pagespatial-compact.schema.json', import.meta.url), 'utf8',
  ));
  const validate = new Ajv2020({ allErrors: true }).compile(schema);
  const page = (await createValidDocument()).pages[0];
  const compact = projectCompactPage(page);
  assert.equal(validate(compact), true, JSON.stringify(validate.errors));

  const smuggled = { ...compact, nativeObservations: page.nativeObservations };
  assert.equal(validate(smuggled), false);
});

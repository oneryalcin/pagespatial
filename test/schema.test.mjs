import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import { buildPageSpatial, pageSpatialDocumentSchema, pageSpatialSchema } from '../dist/index.js';
import { createValidDocument } from './fixture.mjs';

function clone(value) {
  return structuredClone(value);
}

test('runtime schema enforces document and evidence invariants', async () => {
  const valid = await createValidDocument();
  assert.equal(pageSpatialDocumentSchema.safeParse(valid).success, true);

  const missingPage = clone(valid);
  missingPage.pages = [];
  missingPage.diagnostics.pagesParsed = 0;
  assert.equal(pageSpatialDocumentSchema.safeParse(missingPage).success, false);

  const badReference = clone(valid);
  badReference.pages[0].sourceMatches[0].ocrId = 'missing-ocr-id';
  assert.equal(pageSpatialDocumentSchema.safeParse(badReference).success, false);

  const wrongTotals = clone(valid);
  wrongTotals.pages[0].diagnostics.sourceMatchCount = 0;
  assert.equal(pageSpatialDocumentSchema.safeParse(wrongTotals).success, false);

  const wrongLowConfidence = clone(valid);
  wrongLowConfidence.pages[0].diagnostics.lowConfidenceOcrCount = 1;
  assert.equal(pageSpatialDocumentSchema.safeParse(wrongLowConfidence).success, false);

  const outOfBoundsPolygon = clone(valid);
  outOfBoundsPolygon.pages[0].ocrObservations[0].polygon = [[1, 1], [2, 2], [9999, 9999]];
  assert.equal(pageSpatialDocumentSchema.safeParse(outOfBoundsPolygon).success, false);

  const mismatchedPolygon = clone(valid);
  mismatchedPolygon.pages[0].ocrObservations[0].polygon = [[20, 20], [99, 20], [99, 40], [20, 40]];
  assert.equal(pageSpatialDocumentSchema.safeParse(mismatchedPolygon).success, false);

  const zeroAreaPolygon = clone(valid);
  zeroAreaPolygon.pages[0].ocrObservations[0].polygon = [[20, 20], [60, 30], [100, 40]];
  assert.equal(pageSpatialDocumentSchema.safeParse(zeroAreaPolygon).success, false);

  const invalidTransform = clone(valid);
  invalidTransform.pages[0].geometry = {
    width: 200,
    height: 200,
    pointBounds: [0, 0, 100, 100],
    pointWidth: 100,
    pointHeight: 100,
    viewportTransform: [1, 0, 0, 1, Number.NaN, 0]
  };
  assert.equal(pageSpatialDocumentSchema.safeParse(invalidTransform).success, false);

  const falseRenderedProvenance = clone(valid);
  delete falseRenderedProvenance.pages[0].nativeObservations[0].pointBox;
  assert.equal(pageSpatialDocumentSchema.safeParse(falseRenderedProvenance).success, false);

  const falsePointProvenance = clone(valid);
  falsePointProvenance.pages[0].nativeObservations[0].geometryMethod = 'rendered-input-v1';
  assert.equal(pageSpatialDocumentSchema.safeParse(falsePointProvenance).success, false);

  const falseFallbackProvenance = clone(valid);
  falseFallbackProvenance.pages[0].nativeObservations[0].geometryMethod = 'axis-aligned-fallback-v1';
  assert.equal(pageSpatialDocumentSchema.safeParse(falseFallbackProvenance).success, false);
});


// Version discriminator: prior-era records must be rejected by version, not
// mistaken for current ones and failed on incidental field differences.
test('runtime schema rejects records from a previous schemaVersion', () => {
  const page = buildPageSpatial({
    document: { documentId: 'v', revisionId: 'v', sha256: 'd'.repeat(64), pageCount: 1 },
    pageNumber: 1,
    geometry: { width: 200, height: 200 },
    nativeObservations: [{ pageNumber: 1, text: 'Revenue 647', box: [20, 20, 100, 40] }],
    ocrObservations: [{ pageNumber: 1, text: 'Revenue 647', box: [20, 20, 100, 40], confidence: 0.95 }],
    provenance: { parserName: 'fixture', parserVersion: '1', runId: 'v-run', createdAt: new Date().toISOString() }
  });
  const stale = clone(page);
  stale.schemaVersion = '0.2.0';
  const result = pageSpatialSchema.safeParse(stale);
  assert.equal(result.success, false);
  assert.ok(result.error.issues.some((item) => item.path[0] === 'schemaVersion'));
});

test('runtime schema cannot hide a critical conflict by clearing escalation', () => {
  const identity = {
    documentId: 'conflict-document',
    revisionId: 'conflict-revision',
    sha256: 'c'.repeat(64),
    pageCount: 1
  };
  const provenance = {
    parserName: 'fixture', parserVersion: '1', runId: 'conflict-run', createdAt: new Date().toISOString()
  };
  const page = buildPageSpatial({
    document: identity,
    pageNumber: 1,
    geometry: { width: 200, height: 200 },
    nativeObservations: [{ pageNumber: 1, text: 'Revenue 647', box: [20, 20, 100, 40] }],
    ocrObservations: [{ pageNumber: 1, text: 'Revenue 641', box: [20, 20, 100, 40], confidence: 0.99 }],
    provenance
  });
  assert.equal(page.conflicts.length, 1);
  const tampered = clone(page);
  tampered.diagnostics.requiresEscalation = false;
  tampered.diagnostics.escalationReasons = [];
  assert.equal(pageSpatialDocumentSchema.safeParse({
    schemaVersion: '0.6.0',
    document: identity,
    pages: [tampered],
    diagnostics: {
      pageCount: 1,
      pagesParsed: 1,
      pagesRequiringEscalation: [],
      ocrObservationCount: 1,
      nativeObservationCount: 1,
      sourceMatchCount: 0,
      nativeOcrAssociationCoverage: 0,
      criticalConflictCount: 1,
      criticalOmissionCount: 0
    },
    provenance
  }).success, false);
});

test('published JSON Schema independently enforces exact coordinate tuples', async () => {
  const schema = JSON.parse(await readFile(new URL('../schemas/pagespatial.schema.json', import.meta.url), 'utf8'));
  const validate = new Ajv2020({ allErrors: true }).compile(schema);
  const valid = await createValidDocument();
  assert.equal(validate(valid), true, JSON.stringify(validate.errors));

  const shortTransform = clone(valid);
  shortTransform.pages[0].geometry.viewportTransform = [1, 0];
  assert.equal(validate(shortTransform), false);

  const longBox = clone(valid);
  longBox.pages[0].ocrObservations[0].box = [20, 20, 100, 40, 50];
  assert.equal(validate(longBox), false);

  const shiftedBounds = clone(valid);
  shiftedBounds.pages[0].geometry.pointBounds = [10, 20, 110, 120];
  shiftedBounds.pages[0].geometry.pointWidth = 100;
  shiftedBounds.pages[0].geometry.pointHeight = 100;
  shiftedBounds.pages[0].geometry.viewportTransform = [2, 0, 0, -2, -20, 240];
  assert.equal(validate(shiftedBounds), true, JSON.stringify(validate.errors));
});

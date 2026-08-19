import test from 'node:test';
import assert from 'node:assert/strict';
import { associateNativeAndOcr, buildPageSpatial, pageSpatialSchema } from '../dist/index.js';

const document = { documentId: 'd', revisionId: 'r', sha256: 'a'.repeat(64), pageCount: 1 };
const provenance = { parserName: 'test', parserVersion: '1', runId: 'run', createdAt: new Date(0).toISOString() };

test('associates a split native line with one OCR observation', () => {
  const native = [
    { id: 'n1', pageNumber: 1, text: 'Revenue grew by', box: [10, 20, 120, 40], mcid: null, structureRole: null, geometryMethod: 'rendered-input-v1' },
    { id: 'n2', pageNumber: 1, text: '33.4% in 2022', box: [122, 20, 220, 40], mcid: null, structureRole: null, geometryMethod: 'rendered-input-v1' }
  ];
  const ocr = [{ id: 'o1', pageNumber: 1, text: 'Revenue grew by 33.4% in 2022', box: [9, 19, 221, 41], confidence: 0.99 }];
  const result = associateNativeAndOcr(native, ocr);
  assert.deepEqual(result.sourceMatches[0].nativeIds, ['n1', 'n2']);
  assert.equal(result.conflicts.length, 0);
});

test('critical numeric disagreement creates an escalation', () => {
  const page = buildPageSpatial({
    document: { documentId: 'd', revisionId: 'r', sha256: 'a'.repeat(64), pageCount: 1 },
    pageNumber: 1,
    geometry: { width: 200, height: 200 },
    nativeObservations: [{ pageNumber: 1, text: 'FY2022 revenue 647', box: [10, 20, 180, 40] }],
    ocrObservations: [{ pageNumber: 1, text: 'FY2022 revenue 641', box: [10, 20, 180, 40], confidence: 0.99 }],
    provenance: { parserName: 'test', parserVersion: '1', runId: 'run', createdAt: new Date(0).toISOString() }
  });
  assert.equal(page.conflicts[0].reason, 'critical-token-disagreement');
  assert.equal(page.diagnostics.requiresEscalation, true);
  assert.equal(page.diagnostics.escalationReasons[0].type, 'critical-token-conflict');
  pageSpatialSchema.parse(page);
});

// The false-confidence hole found by the gold pilot: a page of confident OCR
// with (almost) nothing in the native layer to corroborate or contradict it
// previously sailed through without escalating.
test('confident OCR with a starved native layer escalates as uncorroborated single-witness', () => {
  const ocr = Array.from({ length: 10 }, (_, index) => ({
    pageNumber: 1,
    text: `value ${100 + index}`,
    box: [10, 10 + index * 18, 90, 24 + index * 18],
    confidence: 0.92
  }));
  const page = buildPageSpatial({
    document,
    pageNumber: 1,
    geometry: { width: 400, height: 400 },
    nativeObservations: [],
    ocrObservations: ocr,
    provenance
  });
  const reason = page.diagnostics.escalationReasons.find((item) => item.type === 'uncorroborated-ocr');
  assert.equal(reason.severity, 'blocking');
  assert.equal(reason.count, 10);
  assert.equal(reason.sourceIds.length, 10);
  assert.equal(page.diagnostics.requiresEscalation, true);
  pageSpatialSchema.parse(page);
});

// The cutoff means strict MAJORITY single-witness: an exact half-engaged
// page must not fire, or the documented justification is false at its own
// boundary.
test('coverage starvation does not fire on an exact half-engaged tie', () => {
  const matchedHalf = Array.from({ length: 4 }, (_, index) => ({
    text: `alpha beta ${index}`,
    box: [10, 10 + index * 22, 150, 28 + index * 22]
  }));
  const page = buildPageSpatial({
    document,
    pageNumber: 1,
    geometry: { width: 400, height: 400 },
    nativeObservations: matchedHalf.map((item) => ({ pageNumber: 1, ...item })),
    ocrObservations: [
      ...matchedHalf.map((item) => ({ pageNumber: 1, ...item, confidence: 0.9 })),
      ...Array.from({ length: 4 }, (_, index) => ({
        pageNumber: 1,
        text: `orphan ${index}`,
        box: [200, 10 + index * 22, 350, 28 + index * 22],
        confidence: 0.9
      }))
    ],
    provenance
  });
  assert.equal(page.diagnostics.sourceMatchCount, 4);
  assert.equal(page.diagnostics.escalationReasons.some((item) => item.type === 'uncorroborated-ocr'), false);
});

test('coverage starvation does not fire on well-matched or sparse pages', () => {
  const matched = buildPageSpatial({
    document,
    pageNumber: 1,
    geometry: { width: 400, height: 200 },
    nativeObservations: Array.from({ length: 8 }, (_, index) => ({
      pageNumber: 1, text: `row ${index}`, box: [10, 10 + index * 20, 80, 26 + index * 20]
    })),
    ocrObservations: Array.from({ length: 8 }, (_, index) => ({
      pageNumber: 1, text: `row ${index}`, box: [10, 10 + index * 20, 80, 26 + index * 20], confidence: 0.9
    })),
    provenance
  });
  assert.equal(matched.diagnostics.escalationReasons.some((item) => item.type === 'uncorroborated-ocr'), false);

  const sparse = buildPageSpatial({
    document,
    pageNumber: 1,
    geometry: { width: 400, height: 200 },
    nativeObservations: [],
    ocrObservations: [
      { pageNumber: 1, text: 'lonely 7', box: [10, 10, 80, 26], confidence: 0.9 }
    ],
    provenance
  });
  assert.equal(sparse.diagnostics.escalationReasons.some((item) => item.type === 'uncorroborated-ocr'), false);
});

test('escalation reasons carry type-derived severity and a bounded share', () => {
  const page = buildPageSpatial({
    document,
    pageNumber: 1,
    geometry: { width: 200, height: 200 },
    nativeObservations: [{ pageNumber: 1, text: 'FY2022 revenue 647', box: [10, 20, 180, 40] }],
    ocrObservations: [
      { pageNumber: 1, text: 'FY2022 revenue 641', box: [10, 20, 180, 40], confidence: 0.99 },
      { pageNumber: 1, text: 'blur', box: [10, 60, 60, 80], confidence: 0.31 }
    ],
    provenance
  });
  const conflict = page.diagnostics.escalationReasons.find((item) => item.type === 'critical-token-conflict');
  const weak = page.diagnostics.escalationReasons.find((item) => item.type === 'low-ocr-confidence');
  assert.equal(conflict.severity, 'blocking');
  assert.equal(conflict.share, 1 / 2);
  assert.equal(weak.severity, 'advisory');
  assert.equal(weak.share, 1 / 2);
  pageSpatialSchema.parse(page);
});

test('multiple conflicts may share one native source without invalid diagnostics', () => {
  const page = buildPageSpatial({
    document,
    pageNumber: 1,
    geometry: { width: 400, height: 300 },
    nativeObservations: [{ pageNumber: 1, text: 'Revenue 647', box: [10, 10, 120, 30] }],
    ocrObservations: [
      { pageNumber: 1, text: 'Revenue 641', box: [10, 10, 120, 30], confidence: 0.99 },
      { pageNumber: 1, text: 'Revenue 642', box: [10, 10, 120, 30], confidence: 0.99 }
    ],
    provenance
  });

  assert.equal(page.conflicts.length, 2);
  const reason = page.diagnostics.escalationReasons.find((item) => item.type === 'critical-token-conflict');
  assert.equal(reason.count, 2);
  assert.equal(new Set(reason.sourceIds).size, reason.sourceIds.length);
});

test('single-series detector keeps category and value source evidence', () => {
  const page = buildPageSpatial({
    document: { documentId: 'd', revisionId: 'r', sha256: 'a'.repeat(64), pageCount: 1 },
    pageNumber: 1,
    geometry: { width: 400, height: 200 },
    nativeObservations: [],
    ocrObservations: [
      { pageNumber: 1, text: 'FY2020FY2021FY2022', box: [0, 150, 300, 170], confidence: 0.99 },
      { pageNumber: 1, text: '448', box: [35, 80, 65, 100], confidence: 0.99 },
      { pageNumber: 1, text: '527', box: [135, 70, 165, 90], confidence: 0.99 },
      { pageNumber: 1, text: '647', box: [235, 60, 265, 80], confidence: 0.99 }
    ],
    provenance: { parserName: 'test', parserVersion: '1', runId: 'run', createdAt: new Date(0).toISOString() }
  });
  assert.equal(page.derivedRelations.length, 3);
  assert.deepEqual(page.derivedRelations[1].attributes, { category: 'FY2021', value: '527' });
  assert.equal(page.derivedRelations[1].derived, true);
  assert.match(page.projection.markdown, /Unverified derived relationships/);
  assert.match(page.projection.markdown, /\| Category \| Value \| Source IDs \|\n\| --- \| ---: \| --- \|\n\| FY2020 \| 448 \|/);
});

test('ambiguous relations may share evidence without duplicate escalation references', () => {
  const page = buildPageSpatial({
    document,
    pageNumber: 1,
    geometry: { width: 400, height: 200 },
    nativeObservations: [],
    ocrObservations: [
      { pageNumber: 1, text: 'FY2020FY2021FY2022', box: [0, 150, 300, 170], confidence: 0.99 },
      { pageNumber: 1, text: '448', box: [35, 80, 65, 100], confidence: 0.99 },
      { pageNumber: 1, text: '527', box: [135, 70, 165, 90], confidence: 0.99 },
      { pageNumber: 1, text: '647', box: [235, 60, 265, 80], confidence: 0.99 }
    ],
    diagnostics: { minimumRelationConfidence: 0.9 },
    provenance
  });

  const reason = page.diagnostics.escalationReasons.find((item) => item.type === 'ambiguous-derived-relation');
  assert.equal(reason.count, 3);
  assert.equal(new Set(reason.sourceIds).size, reason.sourceIds.length);
  pageSpatialSchema.parse(page);
});

test('observation IDs are stable when distinct adapter records are reordered', () => {
  const common = {
    document: { documentId: 'd', revisionId: 'r', sha256: 'a'.repeat(64), pageCount: 1 },
    pageNumber: 1,
    geometry: { width: 200, height: 200 },
    nativeObservations: [],
    provenance: { parserName: 'test', parserVersion: '1', runId: 'run', createdAt: new Date(0).toISOString() }
  };
  const first = { pageNumber: 1, text: 'Alpha', box: [10, 10, 50, 30], confidence: 0.99 };
  const second = { pageNumber: 1, text: 'Beta', box: [10, 50, 50, 70], confidence: 0.99 };
  const forward = buildPageSpatial({ ...common, ocrObservations: [first, second] });
  const reverse = buildPageSpatial({ ...common, ocrObservations: [second, first] });
  const ids = (page) => Object.fromEntries(page.ocrObservations.map((item) => [item.text, item.id]));
  assert.deepEqual(ids(forward), ids(reverse));
});

test('association rejects unsafe bucket and threshold configuration', () => {
  for (const bucketSize of [0, Number.NaN, Number.POSITIVE_INFINITY, 4097]) {
    assert.throws(() => associateNativeAndOcr([], [], { bucketSize }), /bucketSize/);
  }
  for (const option of ['minimumTextSimilarity', 'minimumGeometryOverlap']) {
    assert.throws(() => associateNativeAndOcr([], [], { [option]: 1.1 }), new RegExp(option));
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEnrichmentRequestPlan, buildPageSpatial } from '../dist/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const RENDER_DPI = 150; // the runner's measured render resolution

// Synthetic page records (never real corpus text): geometry at 1 px/pt so
// point thresholds read directly in pixels.
const FAKE_SHA = '0'.repeat(64);
function syntheticPage({ pageId, reasons = [], conflicts = [], ocrObservations = [], unreadInkRegions, sha = FAKE_SHA }) {
  return {
    schemaVersion: '0.6.0',
    documentId: 'synthetic-doc',
    revisionId: `sha256:${sha}`,
    documentSha256: sha,
    pageId,
    pageNumber: 1,
    geometry: { width: 612, height: 792, pointWidth: 612, pointHeight: 792 },
    nativeObservations: [],
    ocrObservations,
    nativeLines: [],
    sourceMatches: [],
    conflicts,
    spatialRows: [],
    derivedRelations: [],
    ...(unreadInkRegions ? { unreadInkRegions } : {}),
    diagnostics: {
      escalationReasons: reasons.map((type) => ({ type, severity: 'blocking', message: 'synthetic' }))
    },
    projection: { markdown: '' },
    provenance: { parserName: 'synthetic', parserVersion: '1', runId: 'plan-test', createdAt: '2026-08-23T00:00:00.000Z' }
  };
}

const residueRegion = (box) => ({
  box, kind: 'structured', inkDensity: 0.5, midToneFraction: 0.05,
  recoveredObservationCount: 0, confirmations: []
});

test('multi-reason page gets multiple rungs with their inputs', () => {
  const page = syntheticPage({
    pageId: 'synthetic:multi:1',
    reasons: ['uncorroborated-ocr', 'critical-token-conflict'],
    ocrObservations: [{ id: 'o1', pageNumber: 1, text: '641', box: [20, 20, 200, 40], confidence: 0.99 }],
    conflicts: [{ id: 'c1', ocrId: 'o1', nativeText: '647', ocrText: '641' }]
  });
  const plan = buildEnrichmentRequestPlan({ pageSpatial: page }, { renderDpi: RENDER_DPI });
  assert.deepEqual(plan.fullTranscription, {});
  assert.equal(plan.residueCrops, undefined);
  assert.deepEqual(plan.adjudication.conflicts, [{
    conflictId: 'c1', nativeText: '647', ocrText: '641',
    // ymin/xmin/ymax/xmax in 0..1000 of the 612x792 page.
    normalizedBox: [Math.round((20 / 792) * 1000), Math.round((20 / 612) * 1000),
      Math.round((40 / 792) * 1000), Math.round((200 / 612) * 1000)]
  }]);
});

test('conflict reason without conflicts on the record gets no adjudication rung', () => {
  const page = syntheticPage({ pageId: 'synthetic:noconf:1', reasons: ['critical-token-conflict'] });
  assert.deepEqual(buildEnrichmentRequestPlan({ pageSpatial: page }, { renderDpi: RENDER_DPI }),
    { renderDpi: RENDER_DPI });
});

test('residue page below the minimum side gets no crops and is reported unanswered', () => {
  const page = syntheticPage({
    pageId: 'synthetic:thin:1',
    reasons: ['unread-ink-region'],
    unreadInkRegions: [residueRegion([100, 100, 105, 300])] // 5pt narrow side < INK_RESIDUE_MIN_SIDE_PT
  });
  assert.deepEqual(buildEnrichmentRequestPlan({ pageSpatial: page }, { renderDpi: RENDER_DPI }),
    { renderDpi: RENDER_DPI, residueUnanswered: true });
});

test('eligible residue region yields a margin-padded crop window at the render dpi', () => {
  const page = syntheticPage({
    pageId: 'synthetic:residue:1',
    reasons: ['unread-ink-region'],
    unreadInkRegions: [residueRegion([100, 100, 200, 160])]
  });
  const plan = buildEnrichmentRequestPlan({ pageSpatial: page }, { renderDpi: RENDER_DPI });
  // At 1 px/pt and 150 dpi: px -> round(px*150/72); margin 8pt -> 17px.
  assert.deepEqual(plan.residueCrops.crops, [{
    regionBox: [100, 100, 200, 160],
    crop: { x: 191, y: 191, w: 243, h: 159 }
  }]);
  assert.equal(plan.residueUnanswered, undefined);
});

test('full transcription subsumes residue crops on a page carrying both reasons', () => {
  const page = syntheticPage({
    pageId: 'synthetic:both:1',
    reasons: ['uncorroborated-ocr', 'unread-ink-region'],
    unreadInkRegions: [residueRegion([100, 100, 200, 160])]
  });
  const plan = buildEnrichmentRequestPlan({ pageSpatial: page }, { renderDpi: RENDER_DPI });
  assert.deepEqual(plan, { renderDpi: RENDER_DPI, fullTranscription: {} });
});

test('failed page (ok:false) is never routed to any rung', () => {
  // Design decision 7: a failed page has no evidence to enrich; routing it
  // to transcription would substitute model output for missing evidence.
  const page = syntheticPage({
    pageId: 'synthetic:failed:1',
    reasons: ['uncorroborated-ocr', 'critical-token-conflict', 'unread-ink-region'],
    ocrObservations: [{ id: 'o1', pageNumber: 1, text: '641', box: [20, 20, 200, 40], confidence: 0.99 }],
    conflicts: [{ id: 'c1', ocrId: 'o1', nativeText: '647', ocrText: '641' }],
    unreadInkRegions: [residueRegion([100, 100, 200, 160])]
  });
  assert.deepEqual(buildEnrichmentRequestPlan({ ok: false, pageSpatial: page }, { renderDpi: RENDER_DPI }),
    { renderDpi: RENDER_DPI });
  assert.deepEqual(buildEnrichmentRequestPlan({}, { renderDpi: RENDER_DPI }),
    { renderDpi: RENDER_DPI });
});

// ---------------------------------------------------------------------------
// Routing parity (design test 12): the same fixture records produce identical
// request plans from the library function directly and via the runner's path.
// The runner's submitted batch manifest keys are the runner-side plan.

const MINIMAL_PDF = Buffer.from(`%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj
xref
0 4
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
trailer << /Size 4 /Root 1 0 R >>
startxref
186
%%EOF
`);

const PRELOAD = `
const okJson = (body) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => '' });
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.includes(':batchGenerateContent')) {
    // Persist the submit body so the parity test can compare request
    // PAYLOADS (image part counts, conflict prompts), not just key sets.
    if (process.env.PLAN_TEST_CAPTURE) require('node:fs').writeFileSync(process.env.PLAN_TEST_CAPTURE, init?.body ?? '');
    return okJson({ name: 'batches/stub-op' });
  }
  if (u.includes('batches/stub-op')) return okJson({
    done: true,
    metadata: { state: 'BATCH_STATE_SUCCEEDED' },
    response: { inlinedResponses: { inlinedResponses: [] } }
  });
  throw new Error('unexpected fetch ' + u);
};
`;

test('parity: runner batch manifest matches library-built plans for a mixed fixture set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plan-parity-'));
  try {
    const corpusRoot = join(dir, 'corpus');
    mkdirSync(join(corpusRoot, 'docs'), { recursive: true });
    const pdfPath = join(corpusRoot, 'docs', 'fixture.pdf');
    writeFileSync(pdfPath, MINIMAL_PDF);
    const sha = createHash('sha256').update(MINIMAL_PDF).digest('hex');

    // One real conflict page (library-built diagnostics) + synthetic pages
    // covering every rung mix. All bound to the fixture PDF's sha so the
    // runner's fail-closed byte check passes.
    const conflictPage = buildPageSpatial({
      document: { documentId: 'fixture-doc', revisionId: `sha256:${sha}`, sha256: sha, pageCount: 1 },
      pageNumber: 1,
      geometry: { width: 612, height: 792, pointWidth: 612, pointHeight: 792 },
      nativeObservations: [{ pageNumber: 1, text: 'Revenue 647', box: [20, 20, 200, 40] }],
      ocrObservations: [{ pageNumber: 1, text: 'Revenue 641', box: [20, 20, 200, 40], confidence: 0.99 }],
      provenance: { parserName: 'fixture', parserVersion: '1', runId: 'fixture-run', createdAt: new Date().toISOString() }
    });
    const pages = [
      conflictPage,
      syntheticPage({
        pageId: 'synthetic:starved-conflict:1', sha,
        reasons: ['uncorroborated-ocr', 'critical-token-conflict'],
        ocrObservations: [{ id: 'o1', pageNumber: 1, text: '641', box: [20, 20, 200, 40], confidence: 0.99 }],
        // Two conflicts so payload parity below can detect a runner that
        // drifted the conflict inputs while emitting the right key set.
        conflicts: [
          { id: 'c1', ocrId: 'o1', nativeText: '647', ocrText: '641' },
          { id: 'c2', ocrId: 'o1', nativeText: '1,250', ocrText: '1,256' }
        ]
      }),
      syntheticPage({
        pageId: 'synthetic:residue:1', sha,
        reasons: ['unread-ink-region'],
        unreadInkRegions: [residueRegion([100, 100, 200, 160])]
      }),
      syntheticPage({
        pageId: 'synthetic:thin-residue:1', sha,
        reasons: ['unread-ink-region'],
        unreadInkRegions: [residueRegion([100, 100, 105, 300])]
      })
    ];

    const runRoot = join(dir, 'run');
    pages.forEach((page, index) => {
      const docDir = join(runRoot, 'documents', `doc-${index}`, 'pages');
      mkdirSync(docDir, { recursive: true });
      writeFileSync(join(docDir, '000001.json'), JSON.stringify({
        pageSpatial: page, objectId: page.documentId, pageNumber: 1, path: 'docs/fixture.pdf'
      }));
    });

    const preloadPath = join(dir, 'preload.cjs');
    writeFileSync(preloadPath, PRELOAD);
    const output = join(dir, 'out');
    const capturePath = join(dir, 'submit-body.json');
    const stdout = execFileSync(process.execPath, [
      '--require', preloadPath,
      join(root, 'scripts/evaluation/run-flash-enrichment.mjs'),
      '--run-root', runRoot, '--output', output, '--corpus-root', corpusRoot,
      '--concurrency', '1', '--batch'
    ], { env: { ...process.env, GEMINI_API_KEY: 'stub-key', PLAN_TEST_CAPTURE: capturePath }, encoding: 'utf8' });

    // Library side: identical records, identical plan builder call.
    const expectedKeys = [];
    let expectedUnanswered = 0;
    for (const page of pages) {
      const plan = buildEnrichmentRequestPlan({ pageSpatial: page }, { renderDpi: RENDER_DPI });
      const name = `${page.pageId.replaceAll(':', '_')}.json`;
      if (plan.fullTranscription) expectedKeys.push(`${name}|full`);
      else if (plan.residueCrops) expectedKeys.push(`${name}|crops`);
      if (plan.residueUnanswered) expectedUnanswered += 1;
      if (plan.adjudication) expectedKeys.push(`${name}|adj`);
    }

    const manifest = JSON.parse(readFileSync(join(output, 'batch-manifest.json'), 'utf8'));
    assert.deepEqual([...manifest.keys].sort(), expectedKeys.sort());
    assert.equal(expectedUnanswered, 1, 'thin-residue fixture must exercise the unanswered path');

    // Payload parity: the submitted request BODIES must match the library
    // plans, not just the key set — a runner that drifted conflict inputs
    // or crop counts while emitting the right keys must fail here.
    const submitted = JSON.parse(readFileSync(capturePath, 'utf8'));
    const byKey = new Map(submitted.batch.input_config.requests.requests
      .map((item) => [item.metadata.key, item.request]));
    assert.deepEqual([...byKey.keys()].sort(), expectedKeys.sort());
    const partsOf = (request) => request.contents[0].parts;
    const images = (request) => partsOf(request).filter((part) => part.inline_data).length;
    for (const page of pages) {
      const name = `${page.pageId.replaceAll(':', '_')}.json`;
      const plan = buildEnrichmentRequestPlan({ pageSpatial: page }, { renderDpi: RENDER_DPI });
      if (plan.residueCrops) {
        assert.equal(images(byKey.get(`${name}|crops`)), plan.residueCrops.crops.length,
          `${name}: one crop image per planned crop window`);
      }
      if (plan.adjudication) {
        const prompt = partsOf(byKey.get(`${name}|adj`)).find((part) => part.text).text;
        for (const conflict of plan.adjudication.conflicts) {
          assert.ok(prompt.includes(JSON.stringify(conflict.nativeText))
            && prompt.includes(JSON.stringify(conflict.ocrText))
            && prompt.includes(JSON.stringify(conflict.normalizedBox)),
            `${name}: adjudication prompt carries conflict ${conflict.conflictId}`);
        }
        assert.equal(images(byKey.get(`${name}|adj`)), 1);
      }
      if (plan.fullTranscription) assert.equal(images(byKey.get(`${name}|full`)), 1);
    }
    const aggregate = JSON.parse(readFileSync(join(output, 'aggregate.json'), 'utf8'));
    assert.equal(aggregate.residuePagesWithoutCropRequests, expectedUnanswered);
    assert.match(stdout, /Batch done/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a record the plan builder rejects fails that one page, never the run', () => {
  // Regression (PR #80 cold review, blocker): the plan build initially sat
  // OUTSIDE the runner's per-page try — a conflict with a dangling ocrId
  // crashed the whole run before any manifest or ledger was written,
  // instead of recording one page failure as the pre-extraction runner did.
  const dir = mkdtempSync(join(tmpdir(), 'plan-dangling-'));
  try {
    const corpusRoot = join(dir, 'corpus');
    mkdirSync(join(corpusRoot, 'docs'), { recursive: true });
    const pdfPath = join(corpusRoot, 'docs', 'fixture.pdf');
    writeFileSync(pdfPath, MINIMAL_PDF);
    const sha = createHash('sha256').update(MINIMAL_PDF).digest('hex');
    const pages = [
      syntheticPage({
        pageId: 'synthetic:dangling:1', sha,
        reasons: ['critical-token-conflict'],
        // No observation with id 'ghost' — the builder must throw for this
        // page and the runner must contain it.
        conflicts: [{ id: 'c1', ocrId: 'ghost', nativeText: '647', ocrText: '641' }]
      }),
      syntheticPage({ pageId: 'synthetic:healthy:1', sha, reasons: ['uncorroborated-ocr'] })
    ];
    const runRoot = join(dir, 'run');
    pages.forEach((page, index) => {
      const docDir = join(runRoot, 'documents', `doc-${index}`, 'pages');
      mkdirSync(docDir, { recursive: true });
      writeFileSync(join(docDir, '000001.json'), JSON.stringify({
        pageSpatial: page, objectId: page.documentId, pageNumber: 1, path: 'docs/fixture.pdf'
      }));
    });
    const preloadPath = join(dir, 'preload.cjs');
    writeFileSync(preloadPath, PRELOAD);
    const output = join(dir, 'out');
    // execFileSync throws on a non-zero exit: the run surviving IS the assertion.
    execFileSync(process.execPath, [
      '--require', preloadPath,
      join(root, 'scripts/evaluation/run-flash-enrichment.mjs'),
      '--run-root', runRoot, '--output', output, '--corpus-root', corpusRoot,
      '--concurrency', '1', '--batch'
    ], { env: { ...process.env, GEMINI_API_KEY: 'stub-key' }, encoding: 'utf8' });
    const manifest = JSON.parse(readFileSync(join(output, 'batch-manifest.json'), 'utf8'));
    assert.deepEqual(manifest.keys, ['synthetic_healthy_1.json|full'],
      'healthy page still submitted');
    const aggregate = JSON.parse(readFileSync(join(output, 'aggregate.json'), 'utf8'));
    const danglingFailure = aggregate.failures.find((failure) => failure.pageId === 'synthetic:dangling:1');
    assert.ok(danglingFailure, 'dangling-ocrId page recorded as a page failure');
    assert.match(danglingFailure.error, /unknown OCR observation/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

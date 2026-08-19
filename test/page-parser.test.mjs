import test from 'node:test';
import assert from 'node:assert/strict';
import * as publicApi from '../dist/index.js';
import { assemblePageSpatial, buildPageSpatial as internalBuildPageSpatial } from '../dist/page-parser.js';
import { resolveDiagnosticOptions } from '../dist/index.js';

const document = {
  documentId: 'page-helper-doc',
  revisionId: 'rev-1',
  sha256: 'b'.repeat(64),
  pageCount: 1
};

const nativePage = {
  pageNumber: 1,
  geometry: {
    width: 999,
    height: 999,
    pointWidth: 100,
    pointHeight: 100,
    rotation: 180
  },
  observations: [
    { id: 'native-adapter-id', pageNumber: 1, text: ' Revenue 2025 ', pointBox: [10, 70, 70, 90] }
  ],
  markdown: '# Revenue 2025'
};

const renderedPage = {
  pageNumber: 1,
  geometry: {
    width: 200,
    height: 200,
    pointWidth: 100,
    pointHeight: 100,
    rotation: 0,
    viewportTransform: [2, 0, 0, -2, 0, 200]
  }
};

const ocrPage = {
  pageNumber: 1,
  backend: 'fixture-backend',
  observations: [
    { id: 'ocr-adapter-id', pageNumber: 1, text: 'Revenue 2025', box: [20, 20, 140, 60], confidence: 1.2 }
  ]
};

const diagnosticOptions = {
  lowOcrConfidence: 0.9,
  minimumRelationConfidence: 0.65,
  maximumRelationAmbiguity: 0.45
};

function helperInput(overrides = {}) {
  return {
    document,
    pageNumber: 1,
    nativePage,
    renderedPage,
    ocrPage,
    runId: 'helper-run',
    createdAt: '2026-08-19T12:00:00.000Z',
    nativeAdapter: 'native-fixture@1',
    renderer: 'renderer-fixture@1',
    ocrAdapter: 'ocr-fixture@1',
    configuration: {
      renderScale: 2,
      concurrency: 1,
      diagnosticPolicy: resolveDiagnosticOptions(diagnosticOptions)
    },
    diagnostics: diagnosticOptions,
    ...overrides
  };
}

function withoutCreatedAt(page) {
  return {
    ...page,
    provenance: { ...page.provenance, createdAt: '<dynamic>' }
  };
}

test('single-page helper and full-document parser have semantic parity', async () => {
  const direct = assemblePageSpatial(helperInput());
  const source = { identity: document, data: new Uint8Array([1]), mimeType: 'application/pdf' };
  const parsed = await publicApi.createParser({
    native: {
      name: 'native-fixture',
      version: '1',
      async extractPage() { return structuredClone(nativePage); }
    },
    renderer: {
      name: 'renderer-fixture',
      version: '1',
      async render() { return { ...structuredClone(renderedPage), data: {} }; }
    },
    ocr: {
      name: 'ocr-fixture',
      version: '1',
      async recognize() { return structuredClone(ocrPage); }
    }
  }).parse(source, {
    renderScale: 2,
    concurrency: 1,
    runId: 'helper-run',
    diagnostics: diagnosticOptions
  });

  assert.deepEqual(withoutCreatedAt(parsed.pages[0]), withoutCreatedAt(direct));
  assert.equal(direct.geometry.width, 200, 'renderer width is canonical');
  assert.equal(direct.geometry.height, 200, 'renderer height is canonical');
  assert.equal(direct.geometry.rotation, 0, 'renderer metadata overrides conflicting native metadata');
  assert.deepEqual(direct.nativeObservations[0].box, [20, 20, 140, 60]);
  assert.equal(direct.ocrObservations[0].confidence, 1, 'normalization remains part of page assembly');
  assert.equal(direct.provenance.backend, 'fixture-backend');
});

test('single-page helper rejects every cross-page adapter boundary', () => {
  const cases = [
    [
      { nativePage: { ...nativePage, pageNumber: 2 } },
      /Native adapter returned page 2 while parsing page 1/
    ],
    [
      { nativePage: { ...nativePage, observations: [{ ...nativePage.observations[0], pageNumber: 2 }] } },
      /Native page 1 contains an observation for page 2/
    ],
    [
      { renderedPage: { ...renderedPage, pageNumber: 2 } },
      /Renderer returned page 2 while parsing page 1/
    ],
    [
      { ocrPage: { ...ocrPage, pageNumber: 2 } },
      /OCR adapter returned page 2 while parsing page 1/
    ],
    [
      { ocrPage: { ...ocrPage, observations: [{ ...ocrPage.observations[0], pageNumber: 2 }] } },
      /OCR page 1 contains an observation for page 2/
    ]
  ];

  for (const [override, expected] of cases) {
    assert.throws(() => assemblePageSpatial(helperInput(override)), expected);
  }
});

test('single-page helper rejects conflicting native and renderer point-space bounds', () => {
  const mismatchedNative = {
    ...nativePage,
    geometry: {
      pointBounds: [10, 20, 110, 120],
      pointWidth: 100,
      pointHeight: 100
    },
    observations: [{ ...nativePage.observations[0], pointBox: [20, 70, 70, 90] }]
  };
  const mismatchedRenderer = {
    ...renderedPage,
    geometry: {
      ...renderedPage.geometry,
      pointBounds: [0, 0, 100, 100]
    }
  };
  assert.throws(
    () => assemblePageSpatial(helperInput({ nativePage: mismatchedNative, renderedPage: mismatchedRenderer })),
    /do not describe the same coordinate basis/
  );
});

test('full-document parser still rejects invalid native evidence before invoking OCR', async () => {
  let ocrCalled = false;
  const source = { identity: document, data: new Uint8Array([1]), mimeType: 'application/pdf' };
  await assert.rejects(() => publicApi.createParser({
    native: {
      name: 'native-fixture', version: '1',
      async extractPage() { return { ...nativePage, pageNumber: 2 }; }
    },
    renderer: {
      name: 'renderer-fixture', version: '1',
      async render() { return { ...renderedPage, data: {} }; }
    },
    ocr: {
      name: 'ocr-fixture', version: '1',
      async recognize() {
        ocrCalled = true;
        return ocrPage;
      }
    }
  }).parse(source), /Native adapter returned page 2/);
  assert.equal(ocrCalled, false);
});

test('page assembly seam stays internal while public buildPageSpatial remains compatible', () => {
  assert.equal(publicApi.assemblePageSpatial, undefined);
  assert.equal(publicApi.buildPageSpatial, internalBuildPageSpatial);

  const publicPage = publicApi.buildPageSpatial({
    document,
    pageNumber: 1,
    geometry: renderedPage.geometry,
    nativeObservations: nativePage.observations,
    ocrObservations: ocrPage.observations,
    nativeMarkdown: nativePage.markdown,
    provenance: assemblePageSpatial(helperInput()).provenance
  });
  publicApi.pageSpatialSchema.parse(publicPage);
});

test('public Markdown projection remains source-compatible without nativeLines', () => {
  const projection = publicApi.projectMarkdown({
    pageNumber: 1,
    nativeObservations: [],
    ocrObservations: [],
    sourceMatches: [],
    spatialRows: [],
    derivedRelations: []
  });
  assert.match(projection.markdown, /No text observations/);
});

test('projection records which extractor produced the markdown', () => {
  const withAdapterMarkdown = publicApi.projectMarkdown({
    pageNumber: 1,
    nativeObservations: [],
    ocrObservations: [],
    sourceMatches: [],
    spatialRows: [],
    derivedRelations: [],
    nativeMarkdown: '# Heading',
    nativeMarkdownSource: 'pdf-inspector'
  });
  assert.equal(withAdapterMarkdown.markdownSource, 'pdf-inspector');
  const withoutAdapterMarkdown = publicApi.projectMarkdown({
    pageNumber: 1,
    nativeObservations: [],
    ocrObservations: [],
    sourceMatches: [],
    spatialRows: [],
    derivedRelations: []
  });
  assert.equal(withoutAdapterMarkdown.markdownSource, 'pagespatial-native-lines');
});

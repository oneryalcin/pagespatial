import { buildPageSpatial, pageSpatialSchema } from '../dist/index.js';

const document = {
  documentId: 'clinic-report',
  revisionId: 'sha256:example',
  sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  pageCount: 1
};

const page = buildPageSpatial({
  document,
  pageNumber: 1,
  geometry: {
    width: 700,
    height: 400,
    pointWidth: 350,
    pointHeight: 200,
    viewportTransform: [2, 0, 0, -2, 0, 400]
  },
  nativeObservations: [
    { pageNumber: 1, text: 'Development in number of clinics', pointBox: [10, 170, 180, 185] }
  ],
  ocrObservations: [
    { pageNumber: 1, text: 'Development in number of clinics', box: [20, 30, 360, 60], confidence: 0.99 },
    { pageNumber: 1, text: 'FY2020FY2021FY2022', box: [350, 330, 650, 350], confidence: 0.98 },
    { pageNumber: 1, text: '448', box: [390, 220, 430, 245], confidence: 0.97 },
    { pageNumber: 1, text: '527', box: [490, 190, 530, 215], confidence: 0.98 },
    { pageNumber: 1, text: '647', box: [590, 160, 630, 185], confidence: 0.98 }
  ],
  nativeMarkdown: '## Development in number of clinics',
  provenance: {
    parserName: 'pagespatial-example',
    parserVersion: '0.1.0',
    runId: 'example-run',
    createdAt: new Date().toISOString()
  }
});

pageSpatialSchema.parse(page);
console.log(page.projection.markdown);
console.log('\nDiagnostics:', page.diagnostics);

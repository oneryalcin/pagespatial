import { createParser } from '../dist/index.js';

export const fixtureIdentity = {
  documentId: 'fixture-document',
  revisionId: 'fixture-revision',
  sha256: 'f'.repeat(64),
  pageCount: 1
};

export async function createValidDocument() {
  return createParser({
    native: {
      name: 'fixture-native',
      version: '1',
      async extract() {
        return {
          pageCount: 1,
          pages: [{
            pageNumber: 1,
            geometry: { pointWidth: 100, pointHeight: 100 },
            observations: [{ pageNumber: 1, text: 'Revenue 100', pointBox: [10, 80, 50, 90] }]
          }]
        };
      }
    },
    renderer: {
      name: 'fixture-renderer',
      version: '1',
      async render() {
        return {
          pageNumber: 1,
          geometry: {
            width: 200,
            height: 200,
            pointWidth: 100,
            pointHeight: 100,
            viewportTransform: [2, 0, 0, -2, 0, 200]
          },
          data: new Uint8Array([1])
        };
      }
    },
    ocr: {
      name: 'fixture-ocr',
      version: '1',
      async recognize() {
        return {
          pageNumber: 1,
          observations: [{ pageNumber: 1, text: 'Revenue 100', box: [20, 20, 100, 40], confidence: 0.99 }]
        };
      }
    }
  }).parse({ identity: fixtureIdentity, data: new Uint8Array([1]) }, { runId: 'fixture-run' });
}

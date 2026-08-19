import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPdfInspectorNativeAdapter, openNodePdfSession } from '../../dist/node/pdf-inspector.js';

const inputPath = process.argv[2];
const outputPath = process.argv[3];
if (!inputPath || !outputPath) throw new Error('Usage: inspect-document-worker.mjs <input.json> <output.json>');
const request = JSON.parse(await readFile(resolve(inputPath), 'utf8'));
if (!Array.isArray(request.pages) || request.pages.some((page) => !Number.isSafeInteger(page) || page < 1)) {
  throw new Error('Inspector request pages must be positive integers.');
}
const bytes = await readFile(resolve(request.pdfPath));
const sessionStarted = performance.now();
const session = await openNodePdfSession(bytes, {
  documentId: request.objectId,
  revisionId: `sha256:${request.sha256}`,
  sourceUri: request.datasetPath,
  maxBytes: request.maxBytes,
  maxPages: request.maxPages
});
const sessionOpenMs = performance.now() - sessionStarted;
try {
  if (session.source.identity.sha256 !== request.sha256) throw new Error('Inspector PDF SHA-256 differs from the manifest.');
  if (session.source.identity.pageCount !== request.pageCount) throw new Error('Inspector PDF page count differs from the manifest.');
  const adapter = createPdfInspectorNativeAdapter();
  const pages = [];
  const started = performance.now();
  for (const pageNumber of request.pages) {
    const pageStarted = performance.now();
    try {
      const nativePage = await adapter.extractPage(session.source, pageNumber);
      pages.push({
        pageNumber,
        status: 'succeeded',
        nativePage,
        extractMs: performance.now() - pageStarted,
        rssBytes: process.memoryUsage().rss
      });
    } catch (error) {
      pages.push({
        pageNumber,
        status: 'failed',
        failure: {
          errorClass: error instanceof Error ? error.name : 'Error',
          message: error instanceof Error ? error.message : String(error)
        },
        extractMs: performance.now() - pageStarted,
        rssBytes: process.memoryUsage().rss
      });
    }
  }
  const result = {
    schemaVersion: 1,
    objectId: request.objectId,
    sha256: request.sha256,
    pageCount: request.pageCount,
    pages,
    timings: { sessionOpenMs, inspectorTotalMs: performance.now() - started },
    peakSampledRssBytes: Math.max(process.memoryUsage().rss, ...pages.map((page) => page.rssBytes))
  };
  await writeFile(resolve(outputPath), `${JSON.stringify(result)}\n`, { flag: 'wx', mode: 0o600 });
} finally {
  await session.dispose();
}

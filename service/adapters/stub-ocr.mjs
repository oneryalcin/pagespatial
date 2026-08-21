/**
 * Stub OCR adapter — load-testing and tests ONLY.
 *
 * canonical: false is the load-bearing bit. A stub witness must NEVER
 * produce a schema-valid PageSpatial record: the pipeline refuses to run
 * assembly for non-canonical adapters and emits stage timings only, so a
 * forged witness cannot masquerade as evidence. The real server OCR
 * adapter (issue #2) ships with canonical: true after the
 * witness-equivalence run against the browser witness.
 *
 * Test hooks (env, read per call so tests can vary per page):
 *   STUB_FAIL_PAGE=n        recognize() throws for page n (fail-closed path)
 *   STUB_CRASH_ONCE_FILE=f  hard-exit the worker process the first time any
 *                           page runs; the file records that the crash fired
 *                           so the retry attempt survives (crash-requeue path)
 */
import { existsSync, writeFileSync } from 'node:fs';

export function createStubOcrAdapter() {
  return {
    name: 'stub-ocr',
    version: '0',
    canonical: false,
    async recognize(page) {
      const crashFile = process.env.STUB_CRASH_ONCE_FILE;
      if (crashFile && !existsSync(crashFile)) {
        writeFileSync(crashFile, 'crashed');
        process.exit(17);
      }
      const failPage = Number(process.env.STUB_FAIL_PAGE ?? Number.NaN);
      if (page.pageNumber === failPage) throw new Error(`stub-ocr configured to fail page ${failPage}`);
      return { pageNumber: page.pageNumber, observations: [], backend: 'stub' };
    }
  };
}

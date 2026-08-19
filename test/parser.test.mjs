import test from 'node:test';
import assert from 'node:assert/strict';
import { createParser, pageSpatialDocumentSchema } from '../dist/index.js';

const document = { documentId: 'doc', revisionId: 'rev', sha256: 'a'.repeat(64), pageCount: 2 };
const source = { identity: document, data: new Uint8Array([1, 2, 3]), mimeType: 'application/pdf' };

function adapters(runtime) {
  const released = [];
  return {
    released,
    value: {
      native: {
        name: 'native-mock', version: '1',
        async extractPage(_source, pageNumber) {
          return {
            pageNumber,
            geometry: { pointWidth: 100, pointHeight: 100 },
            observations: [{ pageNumber, text: `Page ${pageNumber}`, pointBox: [10, 80, 50, 90] }]
          };
        }
      },
      renderer: {
        name: `${runtime}-renderer`, version: '1',
        async render(_document, pageNumber) {
          return {
            pageNumber,
            geometry: { width: 200, height: 200, pointWidth: 100, pointHeight: 100, viewportTransform: [2, 0, 0, -2, 0, 200] },
            data: { runtime, pageNumber },
            release() { released.push(pageNumber); }
          };
        }
      },
      ocr: {
        name: `${runtime}-ocr`, version: '1',
        async recognize(page) {
          return {
            pageNumber: page.pageNumber,
            backend: runtime,
            observations: [{ pageNumber: page.pageNumber, text: `Page ${page.pageNumber}`, box: [20, 20, 100, 40], confidence: 0.99 }]
          };
        }
      }
    }
  };
}

test('browser and server adapters produce equivalent evidence semantics', async () => {
  const browser = adapters('webgpu');
  const server = adapters('cuda');
  const completed = [];
  const browserResult = await createParser(browser.value).parse(source, {
    concurrency: 2,
    runId: 'browser-run',
    onPage(page) { completed.push(page.pageNumber); }
  });
  const serverResult = await createParser(server.value).parse(source, { concurrency: 2, runId: 'server-run' });

  pageSpatialDocumentSchema.parse(browserResult);
  pageSpatialDocumentSchema.parse(serverResult);
  assert.equal(browserResult.provenance.configuration.renderScale, 1.6);
  assert.ok(browserResult.pages.every((page) => page.provenance.configuration.renderScale === 1.6));
  assert.deepEqual([...completed].sort(), [1, 2]);
  assert.deepEqual([...browser.released].sort(), [1, 2]);
  assert.deepEqual([...server.released].sort(), [1, 2]);
  assert.deepEqual(
    browserResult.pages.map((page) => ({
      texts: page.ocrObservations.map((item) => item.text),
      boxes: page.ocrObservations.map((item) => item.box),
      matches: page.sourceMatches.map((item) => [item.nativeIds.length, item.ocrId.split(':').at(-1)])
    })),
    serverResult.pages.map((page) => ({
      texts: page.ocrObservations.map((item) => item.text),
      boxes: page.ocrObservations.map((item) => item.box),
      matches: page.sourceMatches.map((item) => [item.nativeIds.length, item.ocrId.split(':').at(-1)])
    }))
  );
});

test('parser rejects a cross-page native result', async () => {
  const invalid = adapters('webgpu').value;
  invalid.native.extractPage = async (_source, pageNumber) => ({ pageNumber: pageNumber + 1, geometry: {}, observations: [] });
  await assert.rejects(() => createParser(invalid).parse(source), /Native adapter returned page 2/);
});

test('parser validates source identity before calling adapters', async () => {
  const invalidSource = { ...source, identity: { ...document, sha256: 'not-a-sha256' } };
  const candidate = adapters('webgpu').value;
  let called = false;
  candidate.native.extractPage = async () => {
    called = true;
    return { pageNumber: 1, geometry: {}, observations: [] };
  };
  await assert.rejects(() => createParser(candidate).parse(invalidSource), /SHA-256/);
  assert.equal(called, false);
});

test('parser releases rendered resources when OCR fails', async () => {
  const candidate = adapters('webgpu');
  candidate.value.ocr.recognize = async () => {
    throw new Error('inference failed');
  };
  await assert.rejects(() => createParser(candidate.value).parse(source), /inference failed/);
  assert.deepEqual(candidate.released, [1]);
});

test('parser releases rendered resources when parallel native extraction fails', async () => {
  const candidate = adapters('webgpu');
  candidate.value.native.extractPage = async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    throw new Error('native extraction failed');
  };
  await assert.rejects(() => createParser(candidate.value).parse(source), /native extraction failed/);
  assert.deepEqual(candidate.released, [1]);
});

test('parser rejects cross-page renderer and observation evidence', async () => {
  const wrongRender = adapters('webgpu').value;
  wrongRender.renderer.render = async (_source, pageNumber) => ({
    pageNumber: pageNumber + 10,
    geometry: { width: 200, height: 200 },
    data: {}
  });
  await assert.rejects(() => createParser(wrongRender).parse(source), /Renderer returned page 11/);

  const wrongObservation = adapters('webgpu').value;
  wrongObservation.ocr.recognize = async (page) => ({
    pageNumber: page.pageNumber,
    observations: [{ pageNumber: page.pageNumber + 1, text: 'wrong page', box: [1, 1, 10, 10], confidence: 1 }]
  });
  await assert.rejects(() => createParser(wrongObservation).parse(source), /contains an observation for page 2/);
});

test('parser rejects duplicate adapter observation IDs before association', async () => {
  const candidate = adapters('webgpu').value;
  candidate.ocr.recognize = async (page) => ({
    pageNumber: page.pageNumber,
    observations: [
      { id: 'duplicate', pageNumber: page.pageNumber, text: 'first', box: [1, 1, 10, 10], confidence: 1 },
      { id: 'duplicate', pageNumber: page.pageNumber, text: 'second', box: [20, 20, 30, 30], confidence: 1 }
    ]
  });
  await assert.rejects(() => createParser(candidate).parse(source), /duplicate observation IDs/);
});

test('failed concurrent parse waits for workers and cannot emit late page callbacks', async () => {
  const candidate = adapters('webgpu');
  const callbacks = [];
  candidate.value.ocr.recognize = async (page) => {
    if (page.pageNumber === 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      throw new Error('page one failed');
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
    return {
      pageNumber: 2,
      observations: [{ pageNumber: 2, text: 'Page 2', box: [20, 20, 100, 40], confidence: 0.99 }]
    };
  };

  const started = performance.now();
  await assert.rejects(() => createParser(candidate.value).parse(source, {
    concurrency: 2,
    onPage(page) { callbacks.push(page.pageNumber); }
  }), /page one failed/);
  const elapsed = performance.now() - started;

  assert.ok(elapsed >= 30, `parse rejected before in-flight cleanup completed (${elapsed}ms)`);
  assert.deepEqual(callbacks, []);
  assert.deepEqual([...candidate.released].sort(), [1, 2]);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(callbacks, []);
});

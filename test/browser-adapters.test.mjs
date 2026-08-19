import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.DOMMatrix ??= class DOMMatrix {};
globalThis.ImageData ??= class ImageData {};
globalThis.Path2D ??= class Path2D {};

const {
  createPdfJsCanvasRenderer,
  createPpOcrV6BrowserAdapter,
  openPdfJsSession,
  pdfJsNativeAdapter
} = await import('../dist/browser/index.js');
const { createPdfInspectorNativeAdapter, openNodePdfSession } = await import('../dist/node/pdf-inspector.js');

function simplePdf() {
  const content = 'BT /F1 12 Tf 72 720 Td (Hello PageSpatial) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${new TextEncoder().encode(content).length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  let text = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(new TextEncoder().encode(text).length);
    text += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = new TextEncoder().encode(text).length;
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  text += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  text += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(text);
}

test('PDF.js session shares page proxies, extracts native text, and disposes once', async () => {
  const session = await openPdfJsSession(simplePdf(), { documentId: 'fixture', revisionId: 'r1', maxPages: 1 });
  const originalGetPage = session.document.getPage.bind(session.document);
  let loads = 0;
  session.document.getPage = async (...args) => {
    loads += 1;
    return originalGetPage(...args);
  };
  const [first, second] = await Promise.all([session.getPage(1), session.getPage(1)]);
  assert.equal(first, second);
  assert.equal(loads, 1);
  const native = await pdfJsNativeAdapter.extractPage(session.source, 1);
  assert.match(native.markdown, /Hello PageSpatial/);
  assert.equal(native.observations.length, 1);
  assert.ok(native.observations[0].pointBox.every(Number.isFinite));
  await session.dispose();
  await session.dispose();
  await assert.rejects(() => session.getPage(1), /disposed/);
});

test('PDF.js session rejects an oversized Blob before reading it', async () => {
  let reads = 0;
  const blob = new Blob([new Uint8Array(16)]);
  blob.arrayBuffer = async () => { reads += 1; return new ArrayBuffer(16); };
  await assert.rejects(() => openPdfJsSession(blob, { maxBytes: 8 }), /limit is 8/);
  assert.equal(reads, 0);
});

test('Firecrawl PDF Inspector returns page-aligned Markdown and native positions', async () => {
  const session = await openNodePdfSession(simplePdf(), { maxPages: 1 });
  try {
    const native = await createPdfInspectorNativeAdapter().extractPage(session.source, 1);
    assert.equal(native.pageNumber, 1);
    assert.equal(typeof native.markdown, 'string');
    assert.ok(native.observations.some((item) => item.text.includes('Hello PageSpatial')));
    assert.ok(native.observations.every((item) => item.pageNumber === 1 && item.pointBox.every(Number.isFinite)));
    const hello = native.observations.find((item) => item.text.includes('Hello PageSpatial'));
    assert.deepEqual(hello.pointBox.map(Math.round), [72, 720, 167, 732]);
  } finally {
    await session.dispose();
  }
});

test('Node PDF session checks known byte size before copying', async () => {
  const input = new Uint8Array(16);
  await assert.rejects(() => openNodePdfSession(input, { maxBytes: 8 }), /limit is 8/);
});

test('Node PDF session cannot return an in-flight page after disposal starts', async () => {
  const session = await openNodePdfSession(simplePdf(), { maxPages: 1 });
  let resolvePage;
  session.document.getPage = () => new Promise((resolve) => { resolvePage = resolve; });
  const pending = session.getPage(1);
  const disposal = session.dispose();
  resolvePage({ pageNumber: 1 });
  await assert.rejects(pending, /disposed/);
  await disposal;
});

test('Firecrawl PDF Inspector rejects unproven crop and rotation coordinate modes', async () => {
  for (const mode of ['crop', 'rotation']) {
    const session = await openNodePdfSession(simplePdf(), { maxPages: 1 });
    const original = session.getPage.bind(session);
    session.getPage = async (...args) => {
      const page = await original(...args);
      return new Proxy(page, {
        get(target, property) {
          if (property === 'view' && mode === 'crop') return [10, 20, 602, 772];
          if (property === 'getViewport' && mode === 'rotation') {
            return (options) => ({ ...target.getViewport(options), rotation: 90 });
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      });
    };
    try {
      await assert.rejects(
        () => createPdfInspectorNativeAdapter().extractPage(session.source, 1),
        mode === 'crop' ? /cropped or shifted page/ : /rotated page/
      );
    } finally {
      await session.dispose();
    }
  }
});

test('PDF.js renderer retains the viewport matrix and always releases its canvas', async () => {
  const canvas = {
    width: 0,
    height: 0,
    getContext() { return {}; }
  };
  const page = {
    view: [0, 0, 100, 200],
    getViewport({ scale }) {
      return { width: 100 * scale, height: 200 * scale, rotation: 0, transform: [scale, 0, 0, -scale, 0, 200 * scale] };
    },
    render() { return { promise: Promise.resolve() }; }
  };
  const session = { getPage: async () => page };
  const source = { identity: { documentId: 'd', revisionId: 'r', sha256: 'a'.repeat(64), pageCount: 1 }, data: session };
  const renderer = createPdfJsCanvasRenderer({ canvasFactory(width, height) { canvas.width = width; canvas.height = height; return canvas; } });
  const rendered = await renderer.render(source, 1, { scale: 2 });
  assert.deepEqual(rendered.geometry.viewportTransform, [2, 0, 0, -2, 0, 400]);
  assert.deepEqual([canvas.width, canvas.height], [200, 400]);
  await rendered.release();
  await rendered.release();
  assert.deepEqual([canvas.width, canvas.height], [0, 0]);
});

test('PDF.js renderer cancels an aborted render and releases its canvas', async () => {
  const canvas = { width: 0, height: 0, getContext() { return {}; } };
  let cancelled = 0;
  const page = {
    view: [0, 0, 100, 100],
    getViewport() { return { width: 100, height: 100, rotation: 0, transform: [1, 0, 0, -1, 0, 100] }; },
    render() { return { promise: new Promise(() => undefined), cancel() { cancelled += 1; } }; }
  };
  const source = {
    identity: { documentId: 'd', revisionId: 'r', sha256: 'a'.repeat(64), pageCount: 1 },
    data: { getPage: async () => page }
  };
  const renderer = createPdfJsCanvasRenderer({ canvasFactory(width, height) { canvas.width = width; canvas.height = height; return canvas; } });
  const controller = new AbortController();
  const pending = renderer.render(source, 1, { signal: controller.signal });
  controller.abort(new DOMException('stop', 'AbortError'));
  await assert.rejects(pending, /stop/);
  assert.equal(cancelled, 1);
  assert.deepEqual([canvas.width, canvas.height], [0, 0]);
});

test('PDF.js renderer rejects unsafe dimensions before allocating a canvas', async () => {
  let allocations = 0;
  const page = {
    view: [0, 0, 100, 100],
    getViewport() { return { width: 20_000, height: 20_000, rotation: 0, transform: [1, 0, 0, -1, 0, 100] }; }
  };
  const source = {
    identity: { documentId: 'd', revisionId: 'r', sha256: 'a'.repeat(64), pageCount: 1 },
    data: { getPage: async () => page }
  };
  const renderer = createPdfJsCanvasRenderer({ canvasFactory() { allocations += 1; return {}; } });
  await assert.rejects(() => renderer.render(source, 1), /canvas safety limit/);
  assert.equal(allocations, 0);
});

function mockResult(backend, text = 'FY2021 527') {
  return {
    image: { width: 100, height: 100 },
    items: [{ text, score: 0.98, poly: [[1, 2], [40, 2], [40, 12], [1, 12]] }],
    metrics: { detMs: 1, recMs: 1, totalMs: 2, detectedBoxes: 1, recognizedCount: 1 },
    runtime: { requestedBackend: backend, detProvider: backend, recProvider: backend, webgpuAvailable: backend === 'webgpu' }
  };
}

test('PP-OCR initializes once and serializes concurrent predictions', async () => {
  let creates = 0;
  let active = 0;
  let maximumActive = 0;
  const adapter = createPpOcrV6BrowserAdapter({
    detectionModelUrl: '/det.tar', recognitionModelUrl: '/rec.tar', wasmPaths: '/ort/', backend: 'wasm',
    async createEngine(config) {
      creates += 1;
      const backend = config.ortOptions.backend;
      return {
        async initialize() { return mockResult(backend).runtime; },
        async predict() {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise((resolve) => setTimeout(resolve, 8));
          active -= 1;
          return [mockResult(backend)];
        },
        async dispose() {}
      };
    }
  });
  const page = { pageNumber: 1, geometry: { width: 100, height: 100 }, data: {} };
  const results = await Promise.all([adapter.recognize(page), adapter.recognize(page), adapter.recognize(page)]);
  assert.equal(creates, 1);
  assert.equal(maximumActive, 1);
  assert.equal(results[0].observations[0].text, 'FY2021 527');
  assert.deepEqual(results[0].observations[0].box, [1, 2, 40, 12]);
  await adapter.dispose();
});

test('PP-OCR validates result providers on explicit WASM', async () => {
  const adapter = createPpOcrV6BrowserAdapter({
    detectionModelUrl: '/det.tar', recognitionModelUrl: '/rec.tar', wasmPaths: '/ort/', backend: 'wasm',
    async createEngine() {
      return {
        async initialize() { return mockResult('wasm').runtime; },
        async predict() {
          const result = mockResult('wasm');
          result.runtime.detProvider = 'webgpu';
          return [result];
        },
        async dispose() {}
      };
    }
  });
  const page = { pageNumber: 1, geometry: { width: 100, height: 100 }, data: {} };
  await assert.rejects(() => adapter.recognize(page), /requested wasm/);
  await adapter.dispose();
});

test('PP-OCR disposal is single-flight and observers cannot corrupt the engine', async () => {
  let finishPrediction;
  let disposals = 0;
  const adapter = createPpOcrV6BrowserAdapter({
    detectionModelUrl: '/det.tar', recognitionModelUrl: '/rec.tar', wasmPaths: '/ort/', backend: 'wasm',
    onBackend() { throw new Error('observer failed'); },
    async createEngine() {
      return {
        async initialize() { return mockResult('wasm').runtime; },
        async predict() {
          await new Promise((resolve) => { finishPrediction = resolve; });
          return [mockResult('wasm')];
        },
        async dispose() { disposals += 1; }
      };
    }
  });
  const page = { pageNumber: 1, geometry: { width: 100, height: 100 }, data: {} };
  const recognition = adapter.recognize(page);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(adapter.getBackend(), 'wasm');
  const first = adapter.dispose();
  const second = adapter.dispose();
  assert.equal(first, second);
  assert.equal(disposals, 0);
  finishPrediction();
  await Promise.all([recognition, first, second]);
  assert.equal(disposals, 1);
  assert.equal(adapter.getBackend(), null);
});

test('PP-OCR rejects silent provider mismatch and makes WASM fallback sticky', async () => {
  const created = [];
  const events = [];
  const adapter = createPpOcrV6BrowserAdapter({
    detectionModelUrl: '/det.tar', recognitionModelUrl: '/rec.tar', wasmPaths: '/ort/',
    onBackend(event) { events.push(event); },
    async createEngine(config) {
      const requested = config.ortOptions.backend;
      created.push(requested);
      return {
        async initialize() {
          const actual = requested === 'webgpu' ? 'wasm' : requested;
          return mockResult(actual).runtime;
        },
        async predict() { return [mockResult(requested)]; },
        async dispose() {}
      };
    }
  });
  const page = { pageNumber: 1, geometry: { width: 100, height: 100 }, data: {} };
  await adapter.recognize(page);
  await adapter.recognize(page);
  assert.deepEqual(created, ['webgpu', 'wasm']);
  assert.equal(adapter.getBackend(), 'wasm');
  assert.ok(events.some((event) => event.fallbackReason));
  await adapter.dispose();
});

test('PP-OCR retries one failed WebGPU prediction on WASM and never returns to WebGPU', async () => {
  const created = [];
  let webGpuPredictions = 0;
  const adapter = createPpOcrV6BrowserAdapter({
    detectionModelUrl: '/det.tar', recognitionModelUrl: '/rec.tar', wasmPaths: '/ort/',
    async createEngine(config) {
      const backend = config.ortOptions.backend;
      created.push(backend);
      return {
        async initialize() { return mockResult(backend).runtime; },
        async predict() {
          if (backend === 'webgpu' && webGpuPredictions++ === 0) throw new Error('device lost');
          return [mockResult(backend)];
        },
        async dispose() {}
      };
    }
  });
  const page = { pageNumber: 1, geometry: { width: 100, height: 100 }, data: {} };
  assert.equal((await adapter.recognize(page)).backend, 'wasm');
  assert.equal((await adapter.recognize(page)).backend, 'wasm');
  assert.deepEqual(created, ['webgpu', 'wasm']);
  assert.equal(webGpuPredictions, 1);
  await adapter.dispose();
});

test('PP-OCR fails closed on malformed geometry', async () => {
  const adapter = createPpOcrV6BrowserAdapter({
    detectionModelUrl: '/det.tar', recognitionModelUrl: '/rec.tar', wasmPaths: '/ort/', backend: 'wasm',
    async createEngine() {
      return {
        async initialize() { return mockResult('wasm').runtime; },
        async predict() {
          const result = mockResult('wasm');
          result.items[0].poly = [[1, 2], [Number.NaN, 2], [40, 12], [1, 12]];
          return [result];
        },
        async dispose() {}
      };
    }
  });
  const page = { pageNumber: 1, geometry: { width: 100, height: 100 }, data: {} };
  await assert.rejects(() => adapter.recognize(page), /non-finite polygon/);
  await adapter.dispose();
});

test('PP-OCR local-only mode rejects remote asset origins', () => {
  assert.throws(() => createPpOcrV6BrowserAdapter({
    detectionModelUrl: 'https://example.com/det.tar',
    recognitionModelUrl: '/rec.tar',
    wasmPaths: '/ort/'
  }), /same-origin path/);
});

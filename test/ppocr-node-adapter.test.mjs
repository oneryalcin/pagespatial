import test from 'node:test';
import assert from 'node:assert/strict';
import { createPpOcrV6NodeAdapter } from '../dist/node/ppocr-ocr.js';

// Contract tests with an injected fake engine: no network, no model assets,
// no wasm. What production bug each prevents is noted per test.

function fakeEngine(items, calls = []) {
  return {
    async initialize() {
      calls.push('initialize');
      return { backend: 'wasm', webgpuAvailable: false, detProvider: 'wasm', recProvider: 'wasm', assets: [], elapsedMs: 1, pipelineConfigWarnings: [] };
    },
    async predict(input, options) {
      calls.push(['predict', options]);
      return [{
        image: { width: 10, height: 10 },
        items,
        metrics: { detMs: 1, recMs: 1, totalMs: 2, detectedBoxes: items.length, recognizedCount: items.length },
        runtime: { requestedBackend: 'wasm', detProvider: 'wasm', recProvider: 'wasm', webgpuAvailable: false }
      }];
    },
    async dispose() { calls.push('dispose'); }
  };
}

const raster = (width = 2, height = 2) => ({ data: new Uint8ClampedArray(width * height * 4), width, height });
const page = (data) => ({ pageNumber: 7, geometry: { width: 2, height: 2, pointWidth: 2, pointHeight: 2 }, data });

test('maps engine items to observations with ids, boxes, model, confidence', async () => {
  const items = [
    { poly: [[10, 20], [110, 20], [110, 45], [10, 45]], text: 'Revenue 647', score: 0.93 },
    { poly: [[5, 60], [50, 60], [50, 80], [5, 80]], text: '   ', score: 0.9 } // whitespace-only: dropped
  ];
  const adapter = createPpOcrV6NodeAdapter({ assetsDir: '/nonexistent', createEngine: async () => fakeEngine(items) });
  const result = await adapter.recognize(page(raster()));
  assert.equal(result.observations.length, 1);
  const observation = result.observations[0];
  assert.equal(observation.id, 'ppocr:7:0');
  assert.equal(observation.text, 'Revenue 647');
  assert.deepEqual(observation.box, [10, 20, 110, 45]);
  assert.equal(observation.confidence, 0.93);
  assert.equal(observation.model, 'PP-OCRv6_small');
  assert.equal(result.backend, 'wasm-node');
  await adapter.dispose();
});

test('rejects invalid confidence instead of recording a fabricated witness', async () => {
  const items = [{ poly: [[0, 0], [1, 0], [1, 1], [0, 1]], text: 'x1', score: Number.NaN }];
  const adapter = createPpOcrV6NodeAdapter({ assetsDir: '/nonexistent', createEngine: async () => fakeEngine(items) });
  await assert.rejects(() => adapter.recognize(page(raster())), /invalid confidence/u);
  await adapter.dispose();
});

test('rejects non-finite polygon coordinates', async () => {
  const items = [{ poly: [[0, 0], [Infinity, 0], [1, 1], [0, 1]], text: 'x2', score: 0.5 }];
  const adapter = createPpOcrV6NodeAdapter({ assetsDir: '/nonexistent', createEngine: async () => fakeEngine(items) });
  await assert.rejects(() => adapter.recognize(page(raster())), /non-finite polygon/u);
  await adapter.dispose();
});

test('rejects rasters whose byte length disagrees with dimensions', async () => {
  const adapter = createPpOcrV6NodeAdapter({ assetsDir: '/nonexistent', createEngine: async () => fakeEngine([]) });
  // A stride/alpha mistake would silently shear every box on the page.
  await assert.rejects(
    () => adapter.recognize(page({ data: new Uint8ClampedArray(3), width: 2, height: 2 })),
    /expected 16 RGBA bytes/u
  );
  await assert.rejects(() => adapter.recognize(page({ data: new Uint8ClampedArray(0), width: 0, height: 2 })), /invalid raster dimensions/u);
  await adapter.dispose();
});

test('recognize is serialized: one engine call at a time in submission order', async () => {
  const order = [];
  let active = 0;
  const engine = {
    async initialize() { return { backend: 'wasm', detProvider: 'wasm', recProvider: 'wasm', assets: [], elapsedMs: 0, pipelineConfigWarnings: [], webgpuAvailable: false }; },
    async predict() {
      active += 1;
      assert.equal(active, 1, 'two predicts overlapped');
      order.push('start');
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      order.push('end');
      return [{ image: { width: 1, height: 1 }, items: [], metrics: { detMs: 0, recMs: 0, totalMs: 0, detectedBoxes: 0, recognizedCount: 0 }, runtime: { requestedBackend: 'wasm', detProvider: 'wasm', recProvider: 'wasm', webgpuAvailable: false } }];
    },
    async dispose() {}
  };
  const adapter = createPpOcrV6NodeAdapter({ assetsDir: '/nonexistent', createEngine: async () => engine });
  await Promise.all([adapter.recognize(page(raster())), adapter.recognize(page(raster()))]);
  assert.deepEqual(order, ['start', 'end', 'start', 'end']);
  await adapter.dispose();
});

test('a non-wasm execution provider fails closed', async () => {
  const engine = fakeEngine([]);
  engine.initialize = async () => ({ backend: 'webgpu', detProvider: 'webgpu', recProvider: 'wasm', assets: [], elapsedMs: 0, pipelineConfigWarnings: [], webgpuAvailable: true });
  const adapter = createPpOcrV6NodeAdapter({ assetsDir: '/nonexistent', createEngine: async () => engine });
  await assert.rejects(() => adapter.recognize(page(raster())), /expected the wasm provider/u);
  await adapter.dispose();
});

test('dispose after use rejects further work', async () => {
  const adapter = createPpOcrV6NodeAdapter({ assetsDir: '/nonexistent', createEngine: async () => fakeEngine([]) });
  await adapter.recognize(page(raster()));
  await adapter.dispose();
  await assert.rejects(() => adapter.recognize(page(raster())), /disposed/u);
});

test('option validation fails closed', () => {
  assert.throws(() => createPpOcrV6NodeAdapter({ assetsDir: '  ' }), /assetsDir is required/u);
  assert.throws(() => createPpOcrV6NodeAdapter({ assetsDir: '/x', variant: 'huge' }), /Unsupported PP-OCRv6 variant/u);
  assert.throws(() => createPpOcrV6NodeAdapter({ assetsDir: '/x', numThreads: 0 }), /numThreads/u);
  assert.throws(() => createPpOcrV6NodeAdapter({ assetsDir: '/x', recognitionThreshold: 2 }), /recognitionThreshold/u);
});

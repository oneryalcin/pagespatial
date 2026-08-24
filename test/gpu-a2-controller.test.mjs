import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { PDFDocument, StandardFonts } from 'pdf-lib';

import {
  MAX_OUTSTANDING_BYTES,
  MAX_OUTSTANDING_PAGES,
  OutstandingBudget,
  orderedTerminalPages,
  validateOcrLines
} from '../scripts/evaluation/gpu_a2_controller.mjs';
import { precomputeNativeEvidence } from '../scripts/evaluation/precompute_gpu_a2_native.mjs';

test('A2 queue budget is bounded by pages and bytes', () => {
  const budget = new OutstandingBudget(2, 10);
  budget.reserve(6);
  assert.equal(budget.canReserve(5), false);
  budget.reserve(4);
  assert.throws(() => budget.reserve(0), /bound exceeded/);
  budget.release(6);
  budget.release(4);
  assert.deepEqual({ pages: budget.pages, bytes: budget.bytes, peakPages: budget.peakPages, peakBytes: budget.peakBytes },
    { pages: 0, bytes: 0, peakPages: 2, peakBytes: 10 });
  assert.equal(MAX_OUTSTANDING_PAGES, 8);
  assert.equal(MAX_OUTSTANDING_BYTES, 128 * 1024 * 1024);
});

test('A2 OCR validation refuses bad confidence and polygons', () => {
  assert.throws(() => validateOcrLines([{ text: 'x', score: 2, poly: [[0, 0], [1, 0], [1, 1]] }], 1), /confidence/);
  assert.throws(() => validateOcrLines([{ text: 'x', score: 0.9, poly: [[0, 0], [1, 0]] }], 1), /polygon/);
  assert.deepEqual(validateOcrLines([{ text: '42', score: 0.9, poly: [[0, 0], [2, 0], [2, 1], [0, 1]] }], 3)[0], {
    id: 'ppocr-a2:3:0', pageNumber: 3, text: '42', box: [0, 0, 2, 1],
    polygon: [[0, 0], [2, 0], [2, 1], [0, 1]], confidence: 0.9,
    model: 'PP-OCRv6_small'
  });
});

test('A2 terminal publication is ordered and refuses missing/failed pages', () => {
  const good = (pageNumber) => ({ pageNumber, ok: true, pageSpatial: { pageNumber } });
  const results = new Map([[3, good(3)], [1, good(1)], [2, good(2)]]);
  assert.deepEqual(orderedTerminalPages(results, 3).map((page) => page.pageNumber), [1, 2, 3]);
  assert.throws(() => orderedTerminalPages(new Map([[1, good(1)]]), 2), /1\/2/);
  assert.throws(() => orderedTerminalPages(new Map([[1, { pageNumber: 1, ok: false }]]), 1), /not successful/);
});

const hasPdftoppm = spawnSync('pdftoppm', ['-v'], { stdio: 'ignore' }).status === 0;

test('A2 producer exits when its controller IPC owner disappears', { timeout: 10_000 }, async () => {
  const child = fork(
    new URL('../scripts/evaluation/gpu_a2_controller.mjs', import.meta.url).pathname,
    ['--producer'],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }
  );
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('producer never became ready')), 5_000);
    child.once('message', (message) => {
      clearTimeout(timer);
      assert.equal(message.kind, 'producer-ready');
      resolve();
    });
  });
  child.disconnect();
  const exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('producer survived IPC disconnect')), 5_000);
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  assert.deepEqual(exit, { code: 0, signal: null });
});

test('A2 controller tracks pending page numbers separately from request ids', () => {
  const source = readFileSync(new URL('../scripts/evaluation/gpu_a2_controller.mjs', import.meta.url), 'utf8');
  assert.match(source, /const pendingPages = new Set\(\)/u);
  assert.match(source, /pendingPages\.has\(message\.pageNumber\)/u);
  assert.match(source, /pendingPages\.delete\(entry\.pageNumber\)/u);
});

test('A2 controller runs the real terminal stages behind a stub owner', { skip: !hasPdftoppm, timeout: 120_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pagespatial-a2-controller-'));
  try {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    for (let pageNumber = 1; pageNumber <= 2; pageNumber += 1) {
      const page = document.addPage([612, 792]);
      page.drawText(`A2 controller page ${pageNumber}`, { x: 72, y: 700, size: 18, font });
    }
    const pdfPath = join(directory, 'input.pdf');
    const resultPath = join(directory, 'result.json');
    const nativeEvidencePath = join(directory, 'native-evidence.json');
    const scratch = join(directory, 'scratch');
    writeFileSync(pdfPath, await document.save());
    await precomputeNativeEvidence(pdfPath, nativeEvidencePath);
    const child = spawn(process.execPath, [
      new URL('../scripts/evaluation/gpu_a2_controller.mjs', import.meta.url).pathname,
      '--pdf', pdfPath,
      '--native-evidence', nativeEvidencePath,
      '--result', resultPath,
      '--scratch', scratch,
      '--run-id', 'test-a2-controller',
      '--expected-pages', '2'
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = createInterface({ input: child.stdout });
    let done = false;
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    for await (const line of lines) {
      const message = JSON.parse(line);
      if (message.kind === 'fatal') throw new Error(message.error);
      if (message.kind === 'ocr') {
        child.stdin.write(`${JSON.stringify({
          kind: 'ocr-result', id: message.id, lines: [], inferenceMs: 1, queueWaitMs: 0
        })}\n`);
      } else if (message.kind === 'done') {
        done = true;
        child.stdin.end();
      }
    }
    const exitCode = await new Promise((resolve) => child.once('exit', resolve));
    assert.equal(exitCode, 0, stderr);
    assert.equal(done, true);
    const result = JSON.parse(readFileSync(resultPath, 'utf8'));
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.pages.map(({ pageNumber }) => pageNumber), [1, 2]);
    assert.equal(result.provenance.deploymentProfile, 'en-gpu');
    assert.equal(result.provenance.nativeEvidenceMode, 'precomputed-cpu');
    assert.equal(result.timing.scope, 'render+queue+tensorrt-ocr+assembly');
    assert.equal(result.timing.nativePrecompute.includedInWall, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

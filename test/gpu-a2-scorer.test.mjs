import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { evaluateGpuA2 } from '../scripts/evaluation/score_gpu_a2.mjs';

const SHA = 'a'.repeat(64);
const MODEL_VERIFICATION = {
  detector: {
    repo: 'PaddlePaddle/PP-OCRv6_small_det', revision: 'det-rev',
    files: { 'inference.pdiparams': 'det-hash' }
  },
  recognizer: {
    repo: 'PaddlePaddle/PP-OCRv6_small_rec', revision: 'rec-rev',
    files: { 'inference.pdiparams': 'rec-hash' }
  }
};
const TINY_MODEL_VERIFICATION = {
  detector: {
    repo: 'PaddlePaddle/PP-OCRv6_tiny_det', revision: 'tiny-det-rev',
    files: { 'inference.pdiparams': 'tiny-det-hash' }
  },
  recognizer: {
    repo: 'PaddlePaddle/PP-OCRv6_tiny_rec', revision: 'tiny-rec-rev',
    files: { 'inference.pdiparams': 'tiny-rec-hash' }
  }
};

function page(pageNumber, text = `Page ${pageNumber}`, blocking = []) {
  return {
    documentId: 'a2-document',
    revisionId: `sha256:${SHA}`,
    documentSha256: SHA,
    pageNumber,
    geometry: { width: 612, height: 792 },
    nativeObservations: [{ id: `n-${pageNumber}`, pageNumber, text: `Native ${pageNumber}`, box: [0, 0, 100, 20] }],
    ocrObservations: [{ id: `o-${pageNumber}`, pageNumber, text, box: [0, 30, 200, 50], confidence: 0.99 }],
    conflicts: [],
    diagnostics: {
      requiresEscalation: blocking.length > 0,
      escalationReasons: blocking.map((type) => ({
        type, severity: 'blocking', sourceIds: [], count: 1, share: 1
      }))
    },
    provenance: {
      parserName: 'pagespatial', parserVersion: '0.6.0', runId: 'run', createdAt: '2026-08-24T00:00:00Z',
      nativeAdapter: 'pdfjs', renderer: 'pdftoppm', ocrAdapter: 'engine', configuration: { engine: 'arm' }
    }
  };
}

function run(kind, mutate = () => {}) {
  const pages = Array.from({ length: 50 }, (_, index) => ({
    pageNumber: index + 1,
    ok: true,
    pageSpatial: page(index + 1)
  }));
  mutate(pages);
  const identity = { documentId: 'a2-document', revisionId: `sha256:${SHA}`, sha256: SHA, pageCount: 50 };
  return kind === 'cpu'
    ? {
        status: 'completed', document_sha256: SHA, page_count: 50,
        pages_ok: 50, pages_failed: 0, pages, modelVerification: structuredClone(MODEL_VERIFICATION)
      }
    : {
        status: 'completed', document: identity, pageCount: 50, pages,
        modelVerification: structuredClone(MODEL_VERIFICATION)
      };
}

function adjudications(values) {
  return {
    schemaVersion: 'pagespatial-gpu-a2-adjudications-v1',
    documentSha256: SHA,
    values: values.map((value) => ({
      occurrence: 0,
      source: {
        documentSha256: SHA,
        pageNumber: value.pageNumber,
        observationBox: [0, 30, 200, 50],
        observation: 'Reviewed against source PDF.'
      },
      ...value
    }))
  };
}

test('allows raw OCR differences when trusted critical output is unchanged', () => {
  const cpu = run('cpu', (pages) => { pages[0].pageSpatial.ocrObservations[0].text = 'Alpha page'; });
  const gpu = run('gpu', (pages) => { pages[0].pageSpatial.ocrObservations[0].text = 'First page'; });
  const result = evaluateGpuA2({ cpu, gpu });
  assert.equal(result.summary.pass, true);
  assert.equal(result.summary.rawEvidenceDifferingPages, 1);
  assert.equal(result.summary.candidateOnlyCriticalValues, 0);
});

test('allows an explicitly identified Tiny candidate against the Small control', () => {
  const cpu = run('cpu', (pages) => { pages[0].pageSpatial.ocrObservations[0].text = 'Alpha page'; });
  const gpu = run('gpu', (pages) => { pages[0].pageSpatial.ocrObservations[0].text = 'First page'; });
  gpu.arm = { tier: 'tiny' };
  gpu.modelVerification = structuredClone(TINY_MODEL_VERIFICATION);
  const result = evaluateGpuA2({ cpu, gpu });
  assert.equal(result.modelTiers.control, 'small');
  assert.equal(result.modelTiers.candidate, 'tiny');
  assert.equal(result.candidateModels.detector.repo, 'PaddlePaddle/PP-OCRv6_tiny_det');
  assert.equal(result.summary.pass, true);
});

test('refuses candidate model verification that disagrees with its declared tier', () => {
  const cpu = run('cpu');
  const gpu = run('gpu');
  gpu.arm = { tier: 'tiny' };
  assert.throws(() => evaluateGpuA2({ cpu, gpu }), /GPU candidate is not PP-OCRv6 tiny/u);
});

test('reports missing source adjudications as visible pending failure', () => {
  const cpu = run('cpu', (pages) => { pages[0].pageSpatial.ocrObservations[0].text = 'Invoice date 2023-04-04'; });
  const gpu = run('gpu', (pages) => { pages[0].pageSpatial.ocrObservations[0].text = 'Invoice date 2022-04-04'; });
  const result = evaluateGpuA2({ cpu, gpu });
  assert.equal(result.summary.pass, false);
  assert.equal(result.summary.pendingSourceAdjudications, 2);
  assert.equal(result.summary.unresolvedTrustedValues, 2);
});

test('CLI writes a visible pending report and exits nonzero', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pagespatial-a2-score-'));
  try {
    const cpu = run('cpu', (pages) => { pages[0].pageSpatial.ocrObservations[0].text = 'Invoice 100'; });
    const gpu = run('gpu', (pages) => { pages[0].pageSpatial.ocrObservations[0].text = 'Invoice 900'; });
    const cpuPath = join(directory, 'cpu.json');
    const gpuPath = join(directory, 'gpu.json');
    const outputPath = join(directory, 'score.json');
    writeFileSync(cpuPath, JSON.stringify(cpu));
    writeFileSync(gpuPath, JSON.stringify(gpu));
    const result = spawnSync(process.execPath, [
      new URL('../scripts/evaluation/score_gpu_a2.mjs', import.meta.url).pathname,
      '--cpu', cpuPath, '--gpu', gpuPath, '--output', outputPath
    ], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /^PENDING:/u);
    assert.equal(JSON.parse(readFileSync(outputPath, 'utf8')).summary.pendingSourceAdjudications, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('passes source-adjudicated correct replacement and fails incorrect trusted value', () => {
  const cpu = run('cpu', (pages) => { pages[0].pageSpatial.ocrObservations[0].text = 'Invoice date 2023-04-04'; });
  const gpu = run('gpu', (pages) => { pages[0].pageSpatial.ocrObservations[0].text = 'Invoice date 2022-04-04'; });
  const accepted = evaluateGpuA2({
    cpu,
    gpu,
    adjudications: adjudications([
      { pageNumber: 1, side: 'candidate', token: '2022-04-04', verdict: 'correct' },
      {
        pageNumber: 1, side: 'control', token: '2023-04-04',
        verdict: 'removed-incorrect', correctToken: '2022-04-04'
      }
    ])
  });
  assert.equal(accepted.summary.pass, true);

  const rejected = evaluateGpuA2({
    cpu,
    gpu,
    adjudications: adjudications([
      {
        pageNumber: 1, side: 'candidate', token: '2022-04-04',
        verdict: 'incorrect', correctToken: '2023-04-04'
      },
      { pageNumber: 1, side: 'control', token: '2023-04-04', verdict: 'missing' }
    ])
  });
  assert.equal(rejected.summary.pass, false);
  assert.equal(rejected.summary.newlyIncorrectTrustedValues, 1);
  assert.equal(rejected.summary.missingTrustedValues, 1);
});

test('unrelated escalation cannot hide an unreviewed critical difference', () => {
  const cpu = run('cpu', (pages) => { pages[0].pageSpatial.ocrObservations[0].text = 'Invoice 100'; });
  const gpu = run('gpu', (pages) => {
    pages[0].pageSpatial.ocrObservations[0].text = 'Invoice 900';
    pages[0].pageSpatial.diagnostics = page(1, '', ['critical-conflict']).diagnostics;
  });
  const result = evaluateGpuA2({ cpu, gpu });
  assert.equal(result.summary.pass, false);
  assert.equal(result.summary.pendingSourceAdjudications, 2);
});

test('exact native critical conflict contains an escalated critical difference', () => {
  const cpu = run('cpu', (pages) => { pages[0].pageSpatial.ocrObservations[0].text = 'Invoice 100'; });
  const gpu = run('gpu', (pages) => {
    const page = pages[0].pageSpatial;
    page.ocrObservations[0].text = 'Invoice 900';
    page.conflicts = [{
      id: 'c-1', pageNumber: 1, nativeIds: ['n-1'], ocrId: 'o-1',
      nativeText: 'Invoice 100', ocrText: 'Invoice 900',
      nativeCriticalTokens: ['100'], ocrCriticalTokens: ['900'],
      geometryOverlap: 1, reason: 'critical-token-conflict'
    }];
    page.diagnostics = {
      requiresEscalation: true,
      escalationReasons: [{
        type: 'critical-token-conflict', severity: 'blocking',
        sourceIds: ['o-1', 'n-1'], count: 1, share: 1
      }]
    };
  });
  const result = evaluateGpuA2({ cpu, gpu });
  assert.equal(result.summary.pass, true);
  assert.equal(result.pages[0].candidateOnly[0].status, 'unreviewed-native-conflict');
});

test('fails when GPU clears a CPU blocking route', () => {
  const cpu = run('cpu', (pages) => {
    pages[0].pageSpatial.diagnostics = page(1, '', ['critical-conflict', 'uncorroborated-ocr']).diagnostics;
  });
  const gpu = run('gpu', (pages) => {
    pages[0].pageSpatial.diagnostics = page(1, '', ['uncorroborated-ocr']).diagnostics;
  });
  const result = evaluateGpuA2({ cpu, gpu });
  assert.equal(result.summary.pass, false);
  assert.deepEqual(result.summary.clearedControlBlockingRoutes, [
    { pageNumber: 1, types: ['critical-conflict'] }
  ]);
});

test('refuses non-identical documents and non-ordered terminal pages', () => {
  const wrongDocument = run('gpu');
  wrongDocument.document.sha256 = 'b'.repeat(64);
  assert.throws(() => evaluateGpuA2({ cpu: run('cpu'), gpu: wrongDocument }), /top-level document identity/u);

  const wrongOrder = run('gpu');
  [wrongOrder.pages[0], wrongOrder.pages[1]] = [wrongOrder.pages[1], wrongOrder.pages[0]];
  assert.throws(() => evaluateGpuA2({ cpu: run('cpu'), gpu: wrongOrder }), /out of order/u);
});

test('fails non-OCR deterministic evidence drift but ignores engine provenance', () => {
  const gpu = run('gpu', (pages) => {
    pages[0].pageSpatial.provenance.ocrAdapter = 'tensorrt';
    pages[0].pageSpatial.provenance.configuration = { deploymentProfile: 'en-gpu' };
    pages[1].pageSpatial.geometry.width = 700;
  });
  const result = evaluateGpuA2({ cpu: run('cpu'), gpu });
  assert.equal(result.summary.pass, false);
  assert.deepEqual(result.summary.deterministicDifferingPages, [2]);
});

test('refuses CPU/GPU model revision or file-hash drift', () => {
  const gpu = run('gpu');
  gpu.modelVerification.recognizer.files['inference.pdiparams'] = 'different';
  assert.throws(
    () => evaluateGpuA2({ cpu: run('cpu'), gpu }),
    /model revisions or file hashes differ/u
  );
});

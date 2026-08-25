import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { createValidDocument } from './fixture.mjs';
import { analyzeM1 } from '../scripts/evaluation/analyze_gpu_instrumentation_m1.mjs';

const modalSource = readFileSync(new URL('../scripts/evaluation/gpu_a2_modal.py', import.meta.url), 'utf8');
const workerSource = readFileSync(new URL('../scripts/evaluation/gpu_a2_trace_worker.py', import.meta.url), 'utf8');
const launcherSource = readFileSync(new URL('../scripts/evaluation/run_gpu_instrumentation.py', import.meta.url), 'utf8');
const controllerSource = readFileSync(new URL('../scripts/evaluation/gpu_a2_controller.mjs', import.meta.url), 'utf8');
const profilerSource = readFileSync(new URL('../scripts/evaluation/gpu_a3_stage_profile.py', import.meta.url), 'utf8');
const spikeSource = readFileSync(new URL('../scripts/evaluation/gpu_spike_modal.py', import.meta.url), 'utf8');
const processTreePath = new URL('../scripts/evaluation/gpu_process_tree.py', import.meta.url).pathname;
const modelPins = JSON.parse(readFileSync(
  new URL('../evaluation/gpu-spike/model-pins-v1.json', import.meta.url),
  'utf8',
));
const documentSha = '46ba5fc15613a260cf019ff6f9be0bb579279be4f5892694a76e02a536d8fcda';

function run(page, {
  pid = 10, childPid, sequenceIndex, rate = 2, cold = false,
  launchBoundary = childPid === undefined ? 'modal-method' : 'child-worker',
} = {}) {
  const pages = Array.from({ length: 50 }, (_, index) => ({
    pageNumber: index + 1,
    ok: true,
    pageSpatial: { ...structuredClone(page), pageNumber: index + 1 },
  }));
  return {
    status: 'completed',
    pages,
    arm: {
      tier: 'tiny', precision: 'fp32', recognitionBatchSize: 1,
      inferenceOwners: 2, stageProfile: false, nvtx: false,
    },
    resources: { physicalCpuCores: 4, memoryMiB: 24576, gpu: 'L4', inferenceOwners: 2 },
    document: {
      documentId: `sha256:${documentSha}`,
      revisionId: `sha256:${documentSha}`,
      sha256: documentSha,
      pageCount: 50,
    },
    modelVerification: {
      detector: { ...modelPins.models.tiny.detector, directory: '/models/tiny/detector' },
      recognizer: { ...modelPins.models.tiny.recognizer, directory: '/models/tiny/recognizer' },
    },
    deviceTruth: {
      paddleDevice: 'gpu:0', cudaCompiled: true, cudaVersion: '11.8',
      cudnnVersion: '8.9.7', paddleCudaDeviceName: 'NVIDIA L4',
      nvidiaSmiIdentity: ['NVIDIA L4, GPU-test, 580.95.05, 23034, 8.9'],
    },
    ultraInferPatch: {
      sourceRevision: 'ffb64904d23708863ff5b8da312a5cbd52a7f462',
      patchSha256: 'b03632bbfae1372f21a2e31babbf72f8936943a0848ff3db853a2f1cd5216bd6',
    },
    backendAttestations: [{ pass: true }, { pass: true }],
    versions: { nvtx: '0.2.16', tensorrt: '8.6.1' },
    instrumentation: {
      nvtx: {
        enabled: false,
        version: '0.2.16',
        wheelSha256: '23f30fcaf68f53d1895282315cb35aed5f605d59aeb33e75e276545ff95c4af6',
        domain: 'pagespatial.ocr',
      },
    },
    timing: { pagesPerS: rate },
    method: {
      ownerPid: pid, totalMethodMs: 50_000 / rate,
      containerCold: cold, processGroupClean: true,
    },
    client: { launchBoundary, containerId: 'ta-test', appId: 'ap-test' },
    ...(childPid === undefined ? {} : {
      launch: {
        workerPid: childPid, boundary: 'shared-core-child', sequenceIndex,
        processTreeClean: true, cleanupInterventions: 0,
      },
    }),
  };
}

test('M1 uses one execution core instead of copying the page loop', () => {
  assert.match(modalSource, /class A2ExecutionCore:/u);
  assert.match(modalSource, /return self\.core\.parse_document\(payload\)/u);
  assert.match(workerSource, /from gpu_a2_modal import A2ExecutionCore/u);
  assert.match(workerSource, /core\.parse_document\(_payload\(request\)\)/u);
  assert.doesNotMatch(workerSource, /ThreadPoolExecutor|gpu_a2_controller/u);
});

test('copied remote child imports cannot enter local image-build or budget code', () => {
  assert.match(modalSource, /Path\("\/app\/scripts\/evaluation\/gpu_a2_modal\.py"\)/u);
  assert.match(spikeSource, /Path\("\/app\/scripts\/evaluation\/gpu_spike_modal\.py"\)/u);
  assert.match(modalSource, /_LOCAL_BUILD_CONTEXT = modal\.is_local\(\) and not _COPIED_REMOTE_SOURCE/u);
  assert.match(spikeSource, /_LOCAL_BUILD_CONTEXT = modal\.is_local\(\) and not _COPIED_REMOTE_SOURCE/u);
  assert.match(spikeSource, /Remote hydration and plain child imports already run inside the assigned/u);
  assert.match(spikeSource, /else:\n    # Remote hydration[\s\S]*cpu_image = model_base[\s\S]*gpu_image = model_base/u);
  assert.equal((modalSource.match(/modal\.is_local\(\)/gu) ?? []).length, 1);
  assert.equal((spikeSource.match(/modal\.is_local\(\)/gu) ?? []).length, 1);
});

test('M1 paid launcher fixes the arm and closes the exact experiment app', () => {
  const reservation = launcherSource.indexOf('reserve(ledger, "M1-PARITY")');
  const paidRun = launcherSource.indexOf('M1_SCRIPT,');
  assert.ok(reservation >= 0 && paidRun > reservation);
  assert.match(launcherSource, /PAGESPATIAL_A2_MODEL_TIER": "tiny"/u);
  assert.match(launcherSource, /PAGESPATIAL_A2_RECOGNITION_BATCH_SIZE": "1"/u);
  assert.match(launcherSource, /PAGESPATIAL_A2_INFERENCE_OWNERS": "2"/u);
  assert.match(launcherSource, /PAGESPATIAL_A2_STAGE_PROFILE": "0"/u);
  assert.match(launcherSource, /PAGESPATIAL_A2_NVTX": "0"/u);
  assert.match(launcherSource, /app_id = stop_exact_app\(app_name\)/u);
});

test('NVTX provenance is hash-enforced and assembly proxies retain exact source timing', () => {
  assert.match(modalSource, /NVTX_CP310_X86_64_WHEEL_SHA256/u);
  assert.match(modalSource, /pip download --only-binary=:all:/u);
  assert.match(modalSource, /sha256sum -c/u);
  assert.match(modalSource, /"wheelSha256": NVTX_CP310_X86_64_WHEEL_SHA256/u);
  const assemblyStart = controllerSource.indexOf("phase: 'start', scope: 'page'");
  const assemblyCall = controllerSource.indexOf('assembled = await assemblyStage(');
  const assemblyEnd = controllerSource.indexOf("phase: 'end', scope: 'page'");
  assert.ok(assemblyStart >= 0 && assemblyStart < assemblyCall && assemblyCall < assemblyEnd);
  assert.match(controllerSource, /phase: 'start',[\s\S]*atNs: nowNs\(\)/u);
  assert.match(controllerSource, /phase: 'end',[\s\S]*atNs: nowNs\(\)/u);
  assert.match(modalSource, /message\.get\("stage"\) != "result\.assemble"/u);
  assert.match(modalSource, /"nvtxRangeKind": "protocol-proxy"/u);
  assert.match(modalSource, /"sourceWallMs"/u);
  assert.match(controllerSource, /terminal-result[\s\S]*scope: 'document'/u);
  assert.doesNotMatch(profilerSource, /"result\.decode": "recognizer\.decode"/u);
});

test('child timeout cleanup targets both worker and marked controller process groups', () => {
  assert.match(modalSource, /worker = subprocess\.Popen/u);
  assert.match(modalSource, /except subprocess\.TimeoutExpired/u);
  assert.match(modalSource, /_stop_process_group\(worker/u);
  assert.match(modalSource, /reap_marked_process_groups\(str\(scratch\)/u);
  assert.match(modalSource, /"processTreeClean"\] = True/u);
  assert.match(modalSource, /"cleanupInterventions"\] = cleanup_interventions/u);
});

test('Linux marker cleanup reaps multiple independent process groups', { skip: !existsSync('/proc') }, () => {
  const code = String.raw`
import importlib.util,json,subprocess,sys,time,uuid
spec=importlib.util.spec_from_file_location("tree",sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
marker="pagespatial-tree-test-"+uuid.uuid4().hex
children=[subprocess.Popen([sys.executable,"-c","import time; time.sleep(30)",marker],start_new_session=True) for _ in range(2)]
time.sleep(.1); before=len(m.marked_process_groups(marker)); reaped=m.reap_marked_process_groups(marker,.2); after=len(m.marked_process_groups(marker))
for child in children:
  try: child.wait(timeout=2)
  except subprocess.TimeoutExpired: child.kill(); child.wait()
print(json.dumps({"before":before,"reaped":reaped,"after":after}))
`;
  const result = JSON.parse(execFileSync('python3', ['-c', code, processTreePath], { encoding: 'utf8' }));
  assert.deepEqual(result, { before: 2, reaped: 2, after: 0 });
});

test('M1 analyzer passes exact same-core output within the 10% launch gate', async () => {
  const page = (await createValidDocument()).pages[0];
  const result = analyzeM1({
    cold: run(page, { cold: true }),
    before: run(page, { rate: 2 }),
    childCold: run(page, { childPid: 20, sequenceIndex: 1, rate: 1, cold: true }),
    childWarm: run(page, { childPid: 20, sequenceIndex: 2, rate: 2.05 }),
    after: run(page, { rate: 2.02 }),
  });
  assert.equal(result.pass, true, result.reasons.join('; '));
  assert.equal(result.output.verdict.pass, true);
});

test('M1 analyzer fails closed on terminal reconciliation or identity drift', async () => {
  const page = (await createValidDocument()).pages[0];
  const base = run(page, { cold: true });
  const missing = run(page, { childPid: 20, sequenceIndex: 1, cold: true });
  missing.pages.pop();
  const drifted = run(page, { childPid: 20, sequenceIndex: 2 });
  drifted.arm.recognitionBatchSize = 8;
  const result = analyzeM1({
    cold: base,
    before: run(page),
    childCold: missing,
    childWarm: drifted,
    after: run(page),
  });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join('; '), /not exactly 50|arm differs/u);
});

test('M1 analyzer rejects invalid timing and every required lifecycle proof', async () => {
  const page = (await createValidDocument()).pages[0];
  const valid = () => ({
    cold: run(page, { cold: true }),
    before: run(page),
    childCold: run(page, { childPid: 20, sequenceIndex: 1, cold: true }),
    childWarm: run(page, { childPid: 20, sequenceIndex: 2 }),
    after: run(page),
  });
  const mutations = [
    (runs) => { runs.before.method.totalMethodMs = 0; },
    (runs) => { runs.cold.method.containerCold = false; },
    (runs) => { runs.after.method.processGroupClean = false; },
    (runs) => { runs.childWarm.launch.sequenceIndex = 1; },
    (runs) => { runs.childWarm.launch.processTreeClean = false; },
    (runs) => { runs.childWarm.client.containerId = 'ta-other'; },
    (runs) => { runs.cold.instrumentation.nvtx.wheelSha256 = 'wrong'; },
    (runs) => { runs.childWarm.document.sha256 = 'different-document'; },
    ...['document', 'resources', 'modelVerification', 'deviceTruth', 'ultraInferPatch']
      .map((field) => (runs) => {
        for (const run of Object.values(runs)) delete run[field];
      }),
  ];
  for (const mutate of mutations) {
    const runs = valid();
    mutate(runs);
    assert.equal(analyzeM1(runs).pass, false);
  }
});

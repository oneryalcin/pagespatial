import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const capturePath = new URL('../scripts/evaluation/gpu_instrumentation_capture.py', import.meta.url).pathname;
const patchSource = readFileSync(new URL('../scripts/evaluation/ultra-infer-m3-native-nvtx.patch', import.meta.url), 'utf8');
const analyzerSource = readFileSync(new URL('../scripts/evaluation/analyze_gpu_instrumentation_m3.py', import.meta.url), 'utf8');
const dockerSource = readFileSync(new URL('../scripts/evaluation/Dockerfile.gpu-instrumentation-host-m2', import.meta.url), 'utf8');
const gcpSource = readFileSync(new URL('../scripts/evaluation/run_gpu_instrumentation_m2_gcp.py', import.meta.url), 'utf8');

test('M3 has exactly one fixed 10-page window', () => {
  const code = String.raw`
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("capture",sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps(m.plan_for_mode("m3-native")))
`;
  const plan = JSON.parse(execFileSync('python3', ['-c', code, capturePath], { encoding: 'utf8' }));
  assert.equal(plan.captureName, 'm3.native.capture');
  assert.deepEqual(plan.windows, [[11, 20]]);
});

test('native patch contains only the six bounded TensorRT phase names', () => {
  const observed = [...patchSource.matchAll(/PageSpatialM3Range \w+\("([^"]+)"\)/gu)].map((match) => match[1]);
  assert.deepEqual([...new Set(observed)].sort(), [
    'trt.device_to_host', 'trt.enqueue', 'trt.host_to_device',
    'trt.input_prepare', 'trt.output_materialize', 'trt.synchronize',
  ]);
  assert.match(patchSource, /nvtxDomainCreateA\("pagespatial\.native"\)/u);
  assert.doesNotMatch(patchSource, /batch|producer|model_tier|recognitionBatchSize/iu);
});

test('M3 analyzer prevents nested H2D double counting and enforces coverage', () => {
  assert.match(analyzerSource, /_subtract\(intervals, stages\["trt\.host_to_device"\]\)/u);
  assert.match(analyzerSource, /nativeCoveragePercent/u);
  assert.match(analyzerSource, /less than 80%/u);
  assert.match(analyzerSource, /insufficient-native-visibility/u);
  assert.match(analyzerSource, /activity statements apply only to the traced PageSpatial CUDA context/u);
});

test('M3 evolves the pinned M2 image and reuses only the exact VM owner', () => {
  assert.match(dockerSource, /ULTRA_INFER_M3_PATCH_SHA256=8ae31bf3/u);
  assert.match(dockerSource, /git -C \/opt\/paddlex-source apply \/root\/ultra-infer-m3-native-nvtx\.patch/u);
  assert.match(gcpSource, /elif args\.m3_native:\s*\n\s*reservations = \[reserve\(args\.ledger, "M3-NATIVE"\)\]/u);
  assert.match(gcpSource, /M3 does not authorize reuse of an M2 retry path/u);
  assert.match(gcpSource, /reopen_m3_capacity_retry\(args\.ledger, args\.m3_capacity_retry\)/u);
});

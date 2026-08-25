import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { evaluateTrustedOutput } from '../scripts/evaluation/analyze_gpu_instrumentation_m2_output.mjs';

const capturePath = new URL(
  '../scripts/evaluation/gpu_instrumentation_capture.py',
  import.meta.url,
).pathname;
const workerSource = readFileSync(
  new URL('../scripts/evaluation/gpu_a2_trace_worker.py', import.meta.url),
  'utf8',
);
const modalSource = readFileSync(
  new URL('../scripts/evaluation/gpu_a2_modal.py', import.meta.url),
  'utf8',
);
const designSource = readFileSync(
  new URL('../docs/design/2026-08-25-gpu-bottleneck-instrumentation.md', import.meta.url),
  'utf8',
);
const gcpSource = readFileSync(
  new URL('../scripts/evaluation/run_gpu_instrumentation_m2_gcp.py', import.meta.url),
  'utf8',
);
const hostSource = readFileSync(
  new URL('../scripts/evaluation/run_gpu_instrumentation_m2_host.py', import.meta.url),
  'utf8',
);
const containerSource = readFileSync(
  new URL('../scripts/evaluation/run_gpu_instrumentation_m2_container.py', import.meta.url),
  'utf8',
);
const analyzerPath = new URL(
  '../scripts/evaluation/analyze_gpu_instrumentation_m2.py', import.meta.url,
).pathname;
const analyzerSource = readFileSync(
  new URL('../scripts/evaluation/analyze_gpu_instrumentation_m2.py', import.meta.url),
  'utf8',
);
const containerPath = new URL(
  '../scripts/evaluation/run_gpu_instrumentation_m2_container.py', import.meta.url,
).pathname;
const gcpPath = new URL(
  '../scripts/evaluation/run_gpu_instrumentation_m2_gcp.py', import.meta.url,
).pathname;
const dockerfile = readFileSync(
  new URL('../scripts/evaluation/Dockerfile.gpu-instrumentation-host-m2', import.meta.url),
  'utf8',
);
const dockerIgnore = readFileSync(
  new URL('../scripts/evaluation/Dockerfile.gpu-instrumentation-host-m2.dockerignore', import.meta.url),
  'utf8',
);

function runCapture(code) {
  return JSON.parse(execFileSync('python3', ['-c', code, capturePath], { encoding: 'utf8' }));
}

test('M2 capture closes only after every target page completes assembly', () => {
  const code = String.raw`
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("capture",sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
events=[]; clock=iter(range(100,1000))
c=m.CaptureWindowController(run_id="r",capture_name="m2.capture",windows=((2,3),(6,7)),start_range=lambda name:events.append(["start",name]) or len(events),end_range=lambda handle:events.append(["end",handle]),now_ns=lambda:next(clock))
for page in (1,2,3,4): c.observe_ocr_enter(page,f"r:{page}")
c.observe_assembly_end(3,"r:3")
still_open=len(events)
c.observe_assembly_end(2,"r:2")
for page in (5,6,7,8): c.observe_ocr_enter(page,f"r:{page}")
c.observe_assembly_end(6,"r:6"); c.observe_assembly_end(7,"r:7")
result=c.finish()
print(json.dumps({"events":events,"stillOpenEvents":still_open,"windows":result["windows"]}))
`;
  const result = runCapture(code);
  assert.deepEqual(result.events.map((row) => row[0]), ['start', 'end', 'start', 'end']);
  assert.equal(result.stillOpenEvents, 1);
  assert.deepEqual(result.windows[0].submittedTargetPages, [2, 3]);
  assert.deepEqual(result.windows[0].assembledTargetPages, [3, 2]);
  assert.deepEqual(result.windows[0].overlappingOcrPages.map((row) => row.pageNumber), [2, 3, 4]);
});

test('M2 capture fails on overlap, incompleteness, and duplicate target evidence', () => {
  const code = String.raw`
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("capture",sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
def make(): return m.CaptureWindowController(run_id="r",capture_name="m2.capture",windows=((2,3),(5,6)),start_range=lambda name:1,end_range=lambda handle:None)
errors=[]
for action in (
 lambda c:(c.observe_ocr_enter(2,"a"),c.observe_ocr_enter(5,"b")),
 lambda c:(c.observe_ocr_enter(2,"a"),c.finish()),
 lambda c:(c.observe_ocr_enter(2,"a"),c.observe_ocr_enter(2,"b")),
):
 c=make()
 try: action(c)
 except Exception as e: errors.append(str(e))
print(json.dumps(errors))
`;
  const errors = runCapture(code);
  assert.match(errors[0], /overlap/u);
  assert.match(errors[1], /open window/u);
  assert.match(errors[2], /duplicate/u);
});

test('worker preserves M1 and confines M2 capture to the third request', () => {
  assert.match(workerSource, /"m1",[\s\S]*?"m2-systems",[\s\S]*?"m3-native",[\s\S]*?"batch-compare"/u);
  assert.match(workerSource, /request_capture = capture_plan if index == 3 else None/u);
  assert.match(workerSource, /"warmup", "control-before", "trace", "control-after"/u);
  assert.match(workerSource, /default="m1"/u);
});

test('shared core passes raw NVTX messages and records capture completion evidence', () => {
  assert.match(modalSource, /start_range\(message=message\)/u);
  assert.doesNotMatch(modalSource, /get_registered_string\(message\)/u);
  assert.match(modalSource, /capture_controller\.observe_ocr_enter/u);
  assert.match(modalSource, /capture_controller\.observe_assembly_end/u);
  assert.match(modalSource, /capture_controller\.finish\(\)/u);
});

test('design fixes capture semantics, retry windows, and ambiguity stop', () => {
  assert.match(designSource, /first page in its numeric target set enters the Python/u);
  assert.match(designSource, /11--15 and 31--35/u);
  assert.match(designSource, /`ambiguous-stop`/u);
});

test('GCP owner can mutate only the exact experiment VM and always stops it', () => {
  assert.match(gcpSource, /PROJECT = "red-studio-399209"/u);
  assert.match(gcpSource, /ZONE = "us-central1-a"/u);
  assert.match(gcpSource, /INSTANCE = "pagespatial-gpu-profiler-20260825"/u);
  assert.match(gcpSource, /ACCOUNT = "mehmet@desia\.ai"/u);
  assert.match(gcpSource, /"instances",\s*"start",\s*INSTANCE/u);
  assert.match(gcpSource, /"instances",\s*"stop",\s*INSTANCE/u);
  assert.match(gcpSource, /"instances",\s*"add-access-config",\s*INSTANCE/u);
  assert.match(gcpSource, /"instances",\s*"delete-access-config",\s*INSTANCE/u);
  assert.doesNotMatch(gcpSource, /instances",\s*"(create|delete(?!-access-config)|set-|add-(?!access-config)|remove-|update|move|attach|detach)/u);
  assert.doesNotMatch(gcpSource, /firewall|service-accounts|iam|networks",\s*"(create|delete|update)/u);
  assert.match(gcpSource, /serviceAccounts/u);
  assert.match(gcpSource, /shutdown -h \+360/u);
  assert.match(gcpSource, /automaticRestart/u);
  assert.match(gcpSource, /onHostMaintenance/u);
  assert.match(gcpSource, /accessConfigs/u);
  assert.match(gcpSource, /gcp-instance-before\.json/u);
  assert.match(gcpSource, /gcp-instance-after\.json/u);
  assert.match(gcpSource, /def _cleanup_exact_vm/u);
  assert.match(gcpSource, /time\.sleep\(5\)/u);
  assert.match(gcpSource, /os-login", "describe-profile/u);
  assert.match(gcpSource, /refusing to register or refresh it/u);
  assert.doesNotMatch(gcpSource, /"compute",\s*"(ssh|scp)"/u);
  assert.doesNotMatch(gcpSource, /start-iap-tunnel/u);
  assert.match(gcpSource, /HostKeyAlias=/u);
  assert.match(gcpSource, /StrictHostKeyChecking=yes/u);
  assert.match(gcpSource, /SSH_PORT = 443/u);
  assert.match(gcpSource, /Port 443/u);
  assert.match(gcpSource, /sudo -n python3 \{remote_root\}\/repo\/scripts\/evaluation\/run_gpu_instrumentation_m2_host\.py/u);
  assert.match(gcpSource, /--fixed-image-retry-bundle/u);
  assert.match(gcpSource, /327893a19271a4b71774dfa71192e1d4921da6edf7b44b5677ee9674abd741a9/u);
  assert.match(gcpSource, /fixed-image retry requires its integrity-pinned failure evidence/u);
});

test('GCP owner rejects drift in every retained M0 loss boundary', () => {
  const code = String.raw`
import copy,importlib.util,json,pathlib,sys
sys.path.insert(0,str(pathlib.Path(sys.argv[1]).parent))
spec=importlib.util.spec_from_file_location("gcp",sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
base={
 "id":"123456789", "name":m.INSTANCE, "status":"TERMINATED",
 "zone":f"projects/p/zones/{m.ZONE}", "machineType":f"projects/p/zones/{m.ZONE}/machineTypes/{m.MACHINE_TYPE}",
 "serviceAccounts":[], "scheduling":{"automaticRestart":False,"onHostMaintenance":"TERMINATE","preemptible":False,"provisioningModel":"STANDARD"},
 "metadata":{"items":[{"key":"block-project-ssh-keys","value":"TRUE"},{"key":"enable-oslogin","value":"TRUE"},{"key":"startup-script","value":m.STARTUP_SCRIPT}]},
 "labels":m.EXPECTED_LABELS,
 "disks":[{"deviceName":m.INSTANCE,"boot":True,"autoDelete":True,"mode":"READ_WRITE","diskSizeGb":"100"}],
 "networkInterfaces":[{"network":"projects/p/global/networks/default","subnetwork":"projects/p/regions/us-central1/subnetworks/default"}],
 "canIpForward":False}
m._assert_scope(base,"TERMINATED","absent"); errors=[]
for mutate in (
 lambda x:x["scheduling"].__setitem__("automaticRestart",True),
 lambda x:next(i for i in x["metadata"]["items"] if i["key"]=="startup-script").__setitem__("value","echo unsafe"),
 lambda x:x["networkInterfaces"][0].__setitem__("accessConfigs",[dict(m.EXPECTED_ACCESS_CONFIG)]),
 lambda x:x["disks"][0].__setitem__("autoDelete",False),
):
 value=copy.deepcopy(base); mutate(value)
 try:m._assert_scope(value,"TERMINATED","absent")
 except Exception as e:errors.append(str(e))
print(json.dumps(errors))
`;
  const errors = JSON.parse(execFileSync('python3', ['-c', code, gcpPath], { encoding: 'utf8' }));
  assert.equal(errors.length, 4);
});

test('temporary external access is exact, globally routable only while running, and restored absent', () => {
  const code = String.raw`
import copy,importlib.util,json,pathlib,sys
sys.path.insert(0,str(pathlib.Path(sys.argv[1]).parent))
spec=importlib.util.spec_from_file_location("gcp",sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
base={
 "id":"123456789", "name":m.INSTANCE, "status":"TERMINATED",
 "zone":f"projects/p/zones/{m.ZONE}", "machineType":f"projects/p/zones/{m.ZONE}/machineTypes/{m.MACHINE_TYPE}",
 "serviceAccounts":[], "scheduling":{"automaticRestart":False,"onHostMaintenance":"TERMINATE","preemptible":False,"provisioningModel":"STANDARD"},
 "metadata":{"items":[{"key":"block-project-ssh-keys","value":"TRUE"},{"key":"enable-oslogin","value":"TRUE"},{"key":"startup-script","value":m.STARTUP_SCRIPT}]},
 "labels":m.EXPECTED_LABELS,
 "disks":[{"deviceName":m.INSTANCE,"boot":True,"autoDelete":True,"mode":"READ_WRITE","diskSizeGb":"100"}],
 "networkInterfaces":[{"network":"projects/p/global/networks/default","subnetwork":"projects/p/regions/us-central1/subnetworks/default","accessConfigs":[dict(m.EXPECTED_ACCESS_CONFIG)]}],
 "canIpForward":False}
m._assert_scope(base,"TERMINATED","attached")
running=copy.deepcopy(base); running["status"]="RUNNING"; running["networkInterfaces"][0]["accessConfigs"][0]["natIP"]="34.1.2.3"
m._assert_scope(running,"RUNNING","attached")
bad=copy.deepcopy(running); bad["networkInterfaces"][0]["accessConfigs"][0]["natIP"]="10.0.0.1"
try:m._assert_scope(bad,"RUNNING","attached")
except Exception as e:print(json.dumps(str(e)))
`;
  const error = JSON.parse(execFileSync('python3', ['-c', code, gcpPath], { encoding: 'utf8' }));
  assert.match(error, /valid external IP/u);
  assert.match(gcpSource, /access_attach = _attach_external_access\(\)/u);
  assert.match(gcpSource, /cleanup = _cleanup_exact_vm\(\)/u);
  assert.match(gcpSource, /_assert_scope\(final, "TERMINATED", "absent"\)/u);
});

test('temporary access removal still runs when VM stop fails', () => {
  const code = String.raw`
import copy,importlib.util,json,pathlib,sys
sys.path.insert(0,str(pathlib.Path(sys.argv[1]).parent))
spec=importlib.util.spec_from_file_location("gcp",sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
base={
 "id":"123456789", "name":m.INSTANCE, "status":"RUNNING",
 "zone":f"projects/p/zones/{m.ZONE}", "machineType":f"projects/p/zones/{m.ZONE}/machineTypes/{m.MACHINE_TYPE}",
 "serviceAccounts":[], "scheduling":{"automaticRestart":False,"onHostMaintenance":"TERMINATE","preemptible":False,"provisioningModel":"STANDARD"},
 "metadata":{"items":[{"key":"block-project-ssh-keys","value":"TRUE"},{"key":"enable-oslogin","value":"TRUE"},{"key":"startup-script","value":m.STARTUP_SCRIPT}]},
 "labels":m.EXPECTED_LABELS,
 "disks":[{"deviceName":m.INSTANCE,"boot":True,"autoDelete":True,"mode":"READ_WRITE","diskSizeGb":"100"}],
 "networkInterfaces":[{"network":"projects/p/global/networks/default","subnetwork":"projects/p/regions/us-central1/subnetworks/default","accessConfigs":[dict(m.EXPECTED_ACCESS_CONFIG,natIP="34.1.2.3")]}],
 "canIpForward":False}
absent=copy.deepcopy(base); absent["networkInterfaces"][0].pop("accessConfigs")
states=iter([base,absent,absent,absent]); deletes=[]
m._describe=lambda:next(states)
m._gcloud=lambda *args,**kwargs:deletes.append(args) or {"returnCode":0}
m._stop_exact_vm=lambda access_state:(_ for _ in ()).throw(RuntimeError("stop boom"))
try:m._cleanup_exact_vm()
except Exception as e:error=str(e)
print(json.dumps({"deleteCalls":sum("delete-access-config" in row for row in deletes),"error":error}))
`;
  const result = JSON.parse(execFileSync('python3', ['-c', code, gcpPath], { encoding: 'utf8' }));
  assert.equal(result.deleteCalls, 1);
  assert.match(result.error, /stop boom/u);
  assert.match(result.error, /final boundary failed/u);
});

test('SSH readiness retries refusal but fails identity errors immediately', () => {
  const code = String.raw`
import importlib.util,json,pathlib,sys
sys.path.insert(0,str(pathlib.Path(sys.argv[1]).parent))
spec=importlib.util.spec_from_file_location("gcp",sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
responses=iter([{"returnCode":255,"stderr":"Connection refused"},{"returnCode":0,"stderr":""}]); m._ssh=lambda *args,**kwargs:next(responses); m.time.sleep=lambda _:None
ready=len(m._wait_for_ssh({},"34.1.2.3",180))
m._ssh=lambda *args,**kwargs:{"returnCode":255,"stderr":"Host key verification failed"}
try:m._wait_for_ssh({},"34.1.2.3",180)
except Exception as e:error=str(e)
print(json.dumps({"readyAttempts":ready,"identityError":error}))
`;
  const result = JSON.parse(execFileSync('python3', ['-c', code, gcpPath], { encoding: 'utf8' }));
  assert.equal(result.readyAttempts, 2);
  assert.match(result.identityError, /non-retryable SSH identity failure/u);
  assert.match(gcpSource, /-cleanup-\{attempt_id\}/u);
});

test('SSH retries only failures that occur before a remote command can start', () => {
  const code = String.raw`
import importlib.util,json,pathlib,sys
sys.path.insert(0,str(pathlib.Path(sys.argv[1]).parent))
spec=importlib.util.spec_from_file_location("gcp",sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
identity={"keyPath":"key","knownHostsPath":"hosts","hostAlias":"alias","username":"user"}; m.time.sleep=lambda _:None
rows=iter([{"returnCode":255,"stderr":"Operation timed out"},{"returnCode":0,"stderr":""}]); m._run=lambda *args,**kwargs:next(rows)
retried=m._ssh("true",1,identity,"34.1.2.3")
rows=iter([{"returnCode":255,"stderr":"Host key verification failed"},{"returnCode":0,"stderr":""}]); m._run=lambda *args,**kwargs:next(rows)
terminal=m._ssh("true",1,identity,"34.1.2.3",check=False)
print(json.dumps({"retried":len(retried["connectAttempts"]),"terminal":len(terminal["connectAttempts"]),"serializable":bool(json.dumps(retried))}))
`;
  const result = JSON.parse(execFileSync('python3', ['-c', code, gcpPath], { encoding: 'utf8' }));
  assert.equal(result.retried, 2);
  assert.equal(result.terminal, 1);
  assert.equal(result.serializable, true);
});

test('failed retained analysis fails the owner before its mandatory cleanup', () => {
  assert.match(gcpSource, /_require_analysis_success\(analysis, args\.out_dir \/ f"\{milestone\}-analysis\.json"\)/u);
  assert.match(gcpSource, /finally:\s*\n\s*try:\s*\n\s*cleanup = _cleanup_exact_vm\(\)/u);
  const code = String.raw`
import importlib.util,json,pathlib,sys,tempfile
sys.path.insert(0,str(pathlib.Path(sys.argv[1]).parent))
spec=importlib.util.spec_from_file_location("gcp",sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
p=pathlib.Path(tempfile.mkdtemp())/"analysis.json"; p.write_text(json.dumps({"pass":False}))
try: m._require_analysis_success({"returnCode":1},p)
except Exception as e: print(json.dumps(str(e)))
`;
  const error = JSON.parse(execFileSync('python3', ['-c', code, gcpPath], { encoding: 'utf8' }));
  assert.match(error, /returnCode=1, pass=False/u);
});

test('CPU-only output corruption fails the mandatory two-lifetime gate', () => {
  assert.match(analyzerSource, /systems_output = compare_output\(args\.systems_results\)/u);
  assert.match(analyzerSource, /cpu_output = compare_output\(args\.cpu_results\)/u);
  assert.match(analyzerSource, /"systemsOutput": systems_output/u);
  assert.match(analyzerSource, /"cpuOutput": cpu_output/u);
  const code = String.raw`
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("analyzer",sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
good={"verdict":{"pass":True}}; corrupt={"verdict":{"pass":False}}
print(json.dumps({"bothGood":m.output_pair_passes(good,good),"cpuCorrupt":m.output_pair_passes(good,corrupt)}))
`;
  const result = JSON.parse(execFileSync('python3', ['-c', code, analyzerPath], { encoding: 'utf8' }));
  assert.deepEqual(result, { bothGood: true, cpuCorrupt: false });
});

test('host run pins the four-core shape and restores its only host sysctl', () => {
  assert.match(hostSource, /--cpuset-cpus=0-7/u);
  assert.match(hostSource, /--memory=24g/u);
  assert.match(hostSource, /MIN_FREE_BYTES = 24 \* 1024\*\*3/u);
  assert.match(hostSource, /--privileged/u);
  assert.match(hostSource, /seccomp=unconfined/u);
  assert.match(hostSource, /kernel\.perf_event_paranoid=\{original_perf\}/u);
  assert.match(hostSource, /GPU processes remain after \{milestone\.upper\(\)\} container exit/u);
});

test('profiler commands use repeat/defer and separate CUDA from CPU sampling', () => {
  assert.match(containerSource, /--capture-range-end=repeat:\{repeat\}:defer/u);
  assert.match(containerSource, /capture_name="m2\.capture"[\s\S]*repeat=2[\s\S]*cpu_sampling=False/u);
  assert.match(containerSource, /capture_name="m2\.cpu\.capture"[\s\S]*repeat=1[\s\S]*cpu_sampling=True/u);
  assert.match(containerSource, /--sample=process-tree/u);
  assert.match(containerSource, /--backtrace=dwarf/u);
  assert.match(containerSource, /_captured_reports\(report_base, repeat\)/u);
  assert.match(containerSource, /f"\{name\}\.\{index\}\.sqlite"/u);
});

test('M2 image pins the measured runtime, models, profiler, and shared core', () => {
  assert.match(dockerfile, /paddle:3\.0\.0-gpu-cuda11\.8-cudnn8\.9-trt8\.6@sha256:2bd8830/u);
  assert.match(dockerfile, /NSYS_SHA256=506a8a3f/u);
  assert.match(dockerfile, /NVTX_SHA256=23f30fca/u);
  assert.match(dockerfile, /ULTRA_INFER_REV=ffb64904/u);
  assert.match(dockerfile, /PAGESPATIAL_A2_INFERENCE_OWNERS=2/u);
  assert.match(dockerfile, /PAGESPATIAL_A2_RECOGNITION_BATCH_SIZE=1/u);
  assert.match(
    dockerfile,
    /pip install --no-cache-dir --ignore-installed PyYAML==6\.0\.2[\s\S]*pip install --no-cache-dir[\s\S]*paddleocr==3\.7\.0/u,
  );
  assert.match(dockerfile, /gpu_a2_modal\.py/u);
  assert.match(dockerfile, /gpu_instrumentation_capture\.py/u);
  assert.match(dockerfile, /CUDACXX=\/usr\/local\/cuda\/bin\/nvcc/u);
  assert.match(dockerfile, /paddle2onnx==2\.0\.2rc3/u);
});

test('M2 Docker context is a clean archive with a private-data deny-by-default allowlist', () => {
  assert.match(hostSource, /shutil\.copyfile\(build_ignore, repo \/ "\.dockerignore"\)/u);
  assert.match(gcpSource, /"git",\s*"archive",\s*"--format=tar\.gz"/u);
  assert.equal(dockerIgnore.split('\n')[0], '**');
  assert.match(dockerIgnore, /!scripts\/evaluation\/gpu_a2_modal\.py/u);
  assert.match(dockerIgnore, /!evaluation\/gpu-spike\/model-pins-v1\.json/u);
  assert.doesNotMatch(dockerIgnore, /!\.evaluation/u);
  assert.doesNotMatch(dockerIgnore, /!service\/data/u);
});

test('analyzer interval algebra does not double count overlap and stops ambiguous ties', () => {
  const code = String.raw`
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("analyzer",sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps({
 "union":m._duration([(0,10),(5,15),(20,30)]),
 "intersection":m._duration(m._intersections([(0,20)],[(5,10),(15,25)])),
 "subtract":m._duration(m._subtract([(0,20)],[(5,10),(15,25)])),
 "clipped":m._clip((90,110),(100,200)),
 "ambiguous":m._decision({"a":25,"b":23},10)["row"],
 "clear":m._decision({"a":30,"b":20},10)["row"],
 "kernel60":m._decision({"a":0},60)["row"],
 "unattributed":m._decision({"a":0},0,{"unattributed":20})["row"],
 "cpuUnproven":m._decision({"cpu-preparation":30},0)["row"],
 "cpuProven":m._decision({"cpu-preparation":30},0,{},set(["cpu-preparation"]))["row"]}))
`;
  const result = JSON.parse(execFileSync('python3', ['-c', code, analyzerPath], { encoding: 'utf8' }));
  assert.deepEqual(result, {
    union: 25, intersection: 10, subtract: 10, clipped: [100, 110],
    ambiguous: 'ambiguous-stop', clear: 'a', kernel60: 'ambiguous-stop',
    unattributed: 'ambiguous-stop', cpuUnproven: 'ambiguous-stop', cpuProven: 'cpu-preparation',
  });
});

test('analyzer combines exactly two numbered Systems captures before deciding', () => {
  assert.match(analyzerSource, /def analyze_systems_reports/u);
  assert.match(analyzerSource, /len\(windows\) != 2/u);
  assert.match(analyzerSource, /action="append"/u);
  assert.match(gcpSource, /m2-systems\.1\.sqlite/u);
  assert.match(gcpSource, /m2-systems\.2\.sqlite/u);
  assert.match(gcpSource, /m2-cpu\.1\.sqlite/u);
});

test('M2 output keeps raw evidence drift visible but gates trusted output', () => {
  const source = readFileSync(
    new URL('../scripts/evaluation/analyze_gpu_instrumentation_m2_output.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /rawEquivalenceVerdict/u);
  assert.match(source, /productVerdict/u);
  assert.match(source, /candidate\.diagnostics\.requiresEscalation === false/u);
  assert.match(source, /zero newly incorrect, missing, or unresolved critical values/u);

  const page = (pageNumber, text, requiresEscalation) => ({
    pageNumber,
    ocrObservations: [{ text, box: [0, 0, 10, 10], confidence: 0.5 }],
    diagnostics: { requiresEscalation },
  });
  const untrusted = evaluateTrustedOutput(
    [page(1, 'value 5', true)], [page(1, 'value S', true)], true,
  );
  assert.equal(untrusted.pass, true);
  assert.equal(untrusted.differences[0].controlOnly[0].token, '5');
  assert.deepEqual(untrusted.trustedDifferencePages, []);

  const trusted = evaluateTrustedOutput(
    [page(1, 'value 5', false)], [page(1, 'value S', false)], true,
  );
  assert.equal(trusted.pass, false);
  assert.deepEqual(trusted.trustedDifferencePages, [1]);
});

test('CPU cause requires dominant resolved on-CPU stage evidence', () => {
  const code = String.raw`
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("analyzer",sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
def systems(): return {"windows":[{"wallMs":100,"candidateSharesPercent":{"cpu-preparation":30},"materialRemaindersPercent":{},"cuda":{"kernelOccupiedUnionMs":0}},{"wallMs":100,"candidateSharesPercent":{"cpu-preparation":31},"materialRemaindersPercent":{},"cuda":{"kernelOccupiedUnionMs":0}}]}
base={"samples":100,"dominantNamedStage":"crop.generate","onCpuSamplesByNamedStage":{"crop.generate":30},"unresolvedLeafSamplePercentByNamedStage":{"crop.generate":0}}
passed=m.corroborate_cpu_decisions(systems(),base)
bad=dict(base,unresolvedLeafSamplePercentByNamedStage={"crop.generate":50})
failed=m.corroborate_cpu_decisions(systems(),bad)
print(json.dumps({"pass":passed["selectedDecisionRow"],"fail":failed["selectedDecisionRow"]}))
`;
  const result = JSON.parse(execFileSync('python3', ['-c', code, analyzerPath], { encoding: 'utf8' }));
  assert.deepEqual(result, { pass: 'cpu-preparation', fail: 'ambiguous-stop' });
});

test('profiler refuses nonzero nsys exit even when a harness could leave artifacts', () => {
  const code = String.raw`
import importlib.util,json,pathlib,sys,tempfile
spec=importlib.util.spec_from_file_location("runner",sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m._run=lambda *args,**kwargs:{"returnCode":9,"command":[],"stdout":"","stderr":"boom"}
try: m._profile(output_dir=pathlib.Path(tempfile.mkdtemp()),name="x",capture_name="m2.capture",repeat=2,mode="m2-systems",requests=pathlib.Path("r"),cpu_sampling=False)
except Exception as e: print(json.dumps(str(e)))
`;
  const error = JSON.parse(execFileSync('python3', ['-c', code, containerPath], { encoding: 'utf8' }));
  assert.match(error, /exited nonzero/u);
});

test('analyzer requires every target recognition batch to reconcile', () => {
  const code = String.raw`
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("analyzer",sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
base={stage:[] for stage in m.FIXED_STAGES}
for stage in ("page.decode","predict.total","detector.prepare","detector.backend","detector.postprocess","crop.generate","result.assemble"):
 base[stage]=[{"page":"1"}]
for stage in ("recognizer.prepare","recognizer.wait_backend","recognizer.backend","recognizer.decode"):
 base[stage]=[{"page":"1","batch":"1","crops":"1"}]
m._reconcile_target_stages(base,[1]); errors=[]
for mutate in (
 lambda x:x.__setitem__("recognizer.backend",[]),
 lambda x:x.__setitem__("recognizer.decode",[{"page":"1","batch":"2","crops":"1"}]),
 lambda x:x.__setitem__("recognizer.backend",[{"page":"1","batch":"1","crops":"2"}]),
):
 value={key:[dict(row) for row in rows] for key,rows in base.items()}; mutate(value)
 try:m._reconcile_target_stages(value,[1])
 except Exception as e:errors.append(str(e))
print(json.dumps(errors))
`;
  const errors = JSON.parse(execFileSync('python3', ['-c', code, analyzerPath], { encoding: 'utf8' }));
  assert.equal(errors.length, 3);
  assert.match(errors[0], /backend batches do not reconcile/u);
  assert.match(errors[1], /differ from backend batches/u);
  assert.match(errors[2], /expected B1/u);
});

test('analyzer fails rather than zero-filling missing Nsight tables', () => {
  const code = String.raw`
import importlib.util,json,sqlite3,sys,tempfile
spec=importlib.util.spec_from_file_location("analyzer",sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
p=tempfile.mktemp(suffix=".sqlite"); c=sqlite3.connect(p); c.execute("create table NVTX_EVENTS(start integer)"); c.close()
try: m.analyze_systems(__import__("pathlib").Path(p))
except Exception as e: print(json.dumps(str(e)))
`;
  const error = JSON.parse(execFileSync('python3', ['-c', code, analyzerPath], { encoding: 'utf8' }));
  assert.match(error, /lacks required tables/u);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const moduleUrl = new URL('../scripts/evaluation/gpu_instrumentation_budget.py', import.meta.url);
const modulePath = moduleUrl.pathname;
const source = readFileSync(moduleUrl, 'utf8');
const authorization = JSON.parse(readFileSync(
  new URL('../evaluation/gpu-instrumentation/authorization-2026-08-25.json', import.meta.url),
  'utf8',
));
const modalSource = readFileSync(
  new URL('../scripts/evaluation/gpu_instrumentation_modal.py', import.meta.url),
  'utf8',
);
const hostDockerfile = readFileSync(
  new URL('../scripts/evaluation/Dockerfile.gpu-instrumentation-host-probe', import.meta.url),
  'utf8',
);
const hostResult = JSON.parse(readFileSync(
  new URL('../evaluation/gpu-instrumentation/m0-gcp-host-capability-result-v1.json', import.meta.url),
  'utf8',
));

function runPython(code, ledger) {
  return JSON.parse(execFileSync('python3', ['-c', code, modulePath, ledger], { encoding: 'utf8' }));
}

test('instrumentation budget records the owner-approved USD 130 continuation', () => {
  assert.match(source, /AUTHORIZATION_END_UTC = datetime\(2026, 8, 25, 23, 0/u);
  assert.match(source, /OWNER_CEILING_USD = 130\.0/u);
  assert.match(source, /OPERATIONAL_STOP_USD = 130\.0/u);
  assert.match(source, /pagespatial-gpu-instrumentation-/u);
  assert.doesNotMatch(source, /a2-budget-v1/u);
  assert.equal(authorization.ownerCeilingUsd, 100);
  assert.equal(authorization.operationalStopUsd, 100);
  assert.deepEqual(authorization.amendments.at(-1), {
    authorizedAtUtc: '2026-08-25T09:33:09Z',
    scope: 'one fresh M2 Systems plus CPU bundle after three pre-build GCP host-access failures',
    reason: 'owner approved a USD 30 continuation after reviewing the USD 20 Systems and USD 10 CPU stage bounds',
    previousOwnerCeilingUsd: 100,
    newOwnerCeilingUsd: 130,
    previousOperationalStopUsd: 100,
    newOperationalStopUsd: 130,
    reservationWorstCaseUsd: 30,
    noFurtherBundles: true,
    oldBundleReopeningDisabled: true,
  });
});

test('instrumentation reservations are fixed and total less than the ceiling', () => {
  const code = String.raw`
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("budget",sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(json.dumps({"total":sum(v["worstCaseUsd"] for v in m.STAGE_BOUNDS.values()),"stages":sorted(m.STAGE_BOUNDS)}))
`;
  const result = runPython(code, join(mkdtempSync(join(tmpdir(), 'gpu-inst-bounds-')), 'ledger.json'));
  assert.deepEqual(result.stages, ['M0-CAPABILITY', 'M1-PARITY', 'M2-CPU', 'M2-SYSTEMS']);
  assert.equal(result.total, 45);
});

test('instrumentation reservation is single-use and retains completed exposure', () => {
  const ledger = join(mkdtempSync(join(tmpdir(), 'gpu-inst-budget-')), 'ledger.json');
  const code = String.raw`
import importlib.util,json,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location("budget",sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.current_profile=lambda:"desia"; m.active_experiment_apps=lambda:[]; m.billing_rows=lambda:[]
m.now_utc=lambda:m.datetime(2026,8,25,12,0,tzinfo=m.timezone.utc)
m.FRESH_M2_CONTINUATION_ACTIVE=False
p=Path(sys.argv[2]); r=m.reserve(p,"M0-CAPABILITY"); m.validate_reservation(p,r["id"],"M0-CAPABILITY"); errors=[]
try: m.validate_reservation(p,r["id"],"M0-CAPABILITY")
except Exception as e: errors.append(str(e))
m.complete(p,r["id"],"ap-test","stopped")
state=m.load_ledger(p)
print(json.dumps({"errors":errors,"status":state["reservations"][0]["status"],"exposure":m.reserved_exposure(state)}))
`;
  const result = runPython(code, ledger);
  assert.match(result.errors[0], /live budget reservation/u);
  assert.equal(result.status, 'completed-unposted');
  assert.equal(result.exposure, 5);
});

test('M2 host stages reserve atomically before one VM lifetime', () => {
  const ledger = join(mkdtempSync(join(tmpdir(), 'gpu-inst-bundle-')), 'ledger.json');
  const code = String.raw`
import importlib.util,json,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location("budget",sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.current_profile=lambda:"desia"; m.active_experiment_apps=lambda:[]; m.billing_rows=lambda:[]
m.now_utc=lambda:m.datetime(2026,8,25,12,0,tzinfo=m.timezone.utc)
p=Path(sys.argv[2]); rows=m.reserve_bundle(p,["M2-SYSTEMS","M2-CPU"]); state=m.load_ledger(p)
print(json.dumps({"stages":[r["stage"] for r in rows],"bundleIds":list({r["bundleId"] for r in rows}),"exposure":m.reserved_exposure(state)}))
`;
  const result = runPython(code, ledger);
  assert.deepEqual(result.stages, ['M2-SYSTEMS', 'M2-CPU']);
  assert.equal(result.bundleIds.length, 1);
  assert.equal(result.exposure, 30);
});

test('USD 130 amendment permits one fresh M2 bundle and permanently rejects all continuations', () => {
  const ledger = join(mkdtempSync(join(tmpdir(), 'gpu-inst-continuation-')), 'ledger.json');
  const code = String.raw`
import importlib.util,json,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location("budget",sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.current_profile=lambda:"desia"; m.active_experiment_apps=lambda:[]; m.billing_rows=lambda:[{"description":"pagespatial-gpu-instrumentation-posted","cost":0.54140977}]
m.now_utc=lambda:m.datetime(2026,8,25,12,0,tzinfo=m.timezone.utc)
p=Path(sys.argv[2]); state=m._new_ledger(); now=1787640000
old_bundle="bundle-1787644975-72c9dbee"
for stage,bound in (("M2-SYSTEMS",20.0),("M2-CPU",10.0)):
 state["reservations"].append({"id":f"old-{stage}","bundleId":old_bundle,"stage":stage,"worstCaseUsd":bound,"status":"completed-unposted","createdAt":now,"completedAt":now+1,"appId":"gcp:pagespatial-gpu-profiler-20260825","completionNote":"IAP tunnel failed before build"})
state["reservations"].append({"id":"prior-exposure","stage":"prior-work","worstCaseUsd":65.0,"status":"completed-unposted","createdAt":now})
m.save_ledger(p,state)
rows=m.reserve_bundle(p,["M2-SYSTEMS","M2-CPU"]); fresh_bundle=rows[0]["bundleId"]
for row in rows:m.validate_reservation(p,row["id"],row["stage"]); m.complete(p,row["id"],"gcp:test","complete")
errors=[]
for action in (
 lambda:m.reserve_bundle(p,["M2-SYSTEMS","M2-CPU"]),
 lambda:m.reopen_preflight_bundle(p,old_bundle),
 lambda:m.reserve_bundle(p,["M2-SYSTEMS"]),
 lambda:m.reserve(p,"M2-CPU"),
):
 try:action()
 except Exception as e:errors.append(str(e))
final=m.load_ledger(p); token=final[m.FRESH_M2_CONTINUATION_LEDGER_KEY]
print(json.dumps({"freshBundle":fresh_bundle,"token":token,"exposure":m.reserved_exposure(final),"errors":errors}))
`;
  const result = runPython(code, ledger);
  assert.equal(result.token.bundleId, result.freshBundle);
  assert.deepEqual(result.token.stages, ['M2-SYSTEMS', 'M2-CPU']);
  assert.equal(result.exposure, 125);
  assert.match(result.errors[0], /already been reserved/u);
  assert.match(result.errors[1], /old M2 bundle reopening is disabled/u);
  assert.match(result.errors[2], /only one exact fresh M2 stage bundle/u);
  assert.match(result.errors[3], /only one exact fresh M2 stage bundle/u);
});

test('instrumentation authorization expires at the stated boundary', () => {
  const ledger = join(mkdtempSync(join(tmpdir(), 'gpu-inst-expired-')), 'ledger.json');
  const code = String.raw`
import importlib.util,json,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location("budget",sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.current_profile=lambda:"desia"; m.active_experiment_apps=lambda:[]; m.billing_rows=lambda:[]
m.now_utc=lambda:m.datetime(2026,8,25,23,0,tzinfo=m.timezone.utc)
try: m.reserve_bundle(Path(sys.argv[2]),["M2-SYSTEMS","M2-CPU"])
except Exception as e: print(json.dumps({"error":str(e)}))
`;
  const result = runPython(code, ledger);
  assert.match(result.error, /authorization has expired/u);
});

test('M0 separates unavailable perf sampling from the CUDA capability trace', () => {
  assert.match(modalSource, /"--trace=cuda,nvtx,osrt"[\s\S]*?"--sample=none"/u);
  assert.match(modalSource, /CPU Profiling Environment \(process-tree\): Fail/u);
  assert.match(modalSource, /native CPU sampling is unsupported/u);
  assert.doesNotMatch(modalSource, /"--cuda-event-trace=true"/u);
});

test('M0 validates generated artifacts instead of treating exit status as evidence', () => {
  assert.match(modalSource, /if not report_path\.is_file\(\):/u);
  assert.match(modalSource, /if profile\["returnCode"\] != 0:/u);
  assert.match(modalSource, /if not sqlite_path\.is_file\(\):/u);
  assert.match(modalSource, /requiredEventCountsPass/u);
  assert.doesNotMatch(
    modalSource,
    /if profile\["returnCode"\] != 0 or not report_path\.is_file\(\):/u,
  );
});

test('M0 event counts exclude schema enumeration rows', () => {
  assert.match(modalSource, /not name\.upper\(\)\.startswith\("ENUM_"\)/u);
});

test('M0 host reproduction recipe enforces the recorded profiler and CUDA identities', () => {
  assert.match(hostDockerfile, /paddle:3\.0\.0-gpu-cuda11\.8-cudnn8\.9-trt8\.6@sha256:2bd8830dafd258501e7313b320fa1bcc946c70318b3081647b90bc70182e7360/u);
  assert.match(hostDockerfile, /NsightSystems-linux-cli-public-2025\.5\.1\.121-3638078\.deb/u);
  assert.match(hostDockerfile, /506a8a3fdd94cec84c4c216d159ce3a6496170e8cf22b95b603b4bef4e0fb6e2/u);
  assert.match(hostDockerfile, /nvtx==0\.2\.16/u);
  assert.match(hostDockerfile, /23f30fcaf68f53d1895282315cb35aed5f605d59aeb33e75e276545ff95c4af6/u);
  assert.match(hostDockerfile, /--require-hashes/u);
  const digest = createHash('sha256').update(hostDockerfile).digest('hex');
  assert.equal(hostResult.probeImage.reproductionDockerfileSha256, digest);
  assert.notEqual(
    hostResult.probeImage.sourceDockerfileSha256AtRun,
    hostResult.probeImage.reproductionDockerfileSha256,
  );
});

test('M0 host result requires real CUDA, NVTX, CPU, and scheduler events', () => {
  assert.equal(hostResult.verdict.hostSupportsRequiredM2Trace, true);
  for (const capability of [
    'reportGeneration', 'sqliteExport', 'osRuntimeTrace', 'cpuSampling',
    'cpuContextSwitchTrace', 'nvtxTrace', 'cudaApiTrace', 'cudaKernelTrace',
    'cudaMemoryTrace',
  ]) {
    assert.equal(hostResult.capabilities[capability], true, capability);
  }
  assert.ok(hostResult.cudaTrace.nvtxEvents > 0);
  assert.ok(hostResult.cudaTrace.cudaApiEvents > 0);
  assert.ok(hostResult.cudaTrace.cudaKernelEvents > 0);
  assert.ok(hostResult.cudaTrace.cudaMemoryEvents > 0);
  assert.equal(hostResult.cpuTrace.sampleEvents, 1668);
  assert.equal(hostResult.cpuTrace.sampledCallchains, 1668);
  assert.equal(hostResult.cpuTrace.sampledCallchainFrames, 10712);
  assert.ok(hostResult.cpuTrace.schedulerEvents > 0);
});

test('M0 host result integrity-pins every private supporting artifact', () => {
  assert.deepEqual(hostResult.supportingEvidence.hostIdentity, {
    sha256: '544d524d5429aad700332ab77a9736341d825c2d6f19040bfcc178d46a7c0937',
    bytes: 3882,
  });
  assert.deepEqual(hostResult.supportingEvidence.nsysStatus, {
    sha256: 'dce6f055aeff7200eb787287e6d717d93ec454b710190fff3d2fd89b815ae625',
    bytes: 1159,
  });
  assert.equal(
    hostResult.supportingEvidence.gcpInstanceDescribe.sha256,
    '07ebca3b1b764a4a399691664474ee66074b7be1c0c59de0cfe2c2c05f8e53d4',
  );
  assert.equal(hostResult.supportingEvidence.gcpInstanceDescribe.bytes, 1939);
});

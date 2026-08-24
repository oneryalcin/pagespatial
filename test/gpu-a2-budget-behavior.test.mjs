import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const modulePath = new URL('../scripts/evaluation/gpu_a2_budget.py', import.meta.url).pathname;

function runPython(code, ledger) {
  return JSON.parse(execFileSync('python3', ['-c', code, modulePath, ledger], { encoding: 'utf8' }));
}

test('concurrent callers cannot create two live paid reservations', () => {
  const ledger = join(mkdtempSync(join(tmpdir(), 'gpu-a2-budget-')), 'ledger.json');
  const code = String.raw`
import importlib.util,json,multiprocessing,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location("budget",sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.current_profile=lambda:"desia"; m.active_experiment_apps=lambda:[]; m.billing_rows=lambda:[]
def worker(q):
  try: q.put(["ok",m.reserve(Path(sys.argv[2]),"E1-CPU")["id"]])
  except Exception as e: q.put(["error",str(e)])
ctx=multiprocessing.get_context("fork"); q=ctx.Queue(); ps=[ctx.Process(target=worker,args=(q,)) for _ in range(2)]
[p.start() for p in ps]; results=[q.get(timeout=10) for _ in ps]; [p.join(10) for p in ps]
print(json.dumps({"results":results,"ledger":m.load_ledger(Path(sys.argv[2]))}))
`;
  const result = runPython(code, ledger);
  assert.equal(result.results.filter(([kind]) => kind === 'ok').length, 1);
  assert.equal(result.results.filter(([kind]) => kind === 'error').length, 1);
  assert.equal(result.ledger.reservations.length, 1);
});

test('reservation stage is exact and token can be claimed only once', () => {
  const ledger = join(mkdtempSync(join(tmpdir(), 'gpu-a2-claim-')), 'ledger.json');
  const code = String.raw`
import importlib.util,json,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location("budget",sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.current_profile=lambda:"desia"; m.active_experiment_apps=lambda:[]; m.billing_rows=lambda:[]
p=Path(sys.argv[2]); r=m.reserve(p,"E1-GPU"); errors=[]
try: m.validate_reservation(p,r["id"],"E1-CPU")
except Exception as e: errors.append(str(e))
m.validate_reservation(p,r["id"],"E1-GPU")
try: m.validate_reservation(p,r["id"],"E1-GPU")
except Exception as e: errors.append(str(e))
print(json.dumps({"errors":errors,"status":m.load_ledger(p)["reservations"][0]["status"]}))
`;
  const result = runPython(code, ledger);
  assert.match(result.errors[0], /stage mismatch/u);
  assert.match(result.errors[1], /live budget reservation/u);
  assert.equal(result.status, 'active');
});

test('a no-app launch closes the live lock but retains full exposure', () => {
  const ledger = join(mkdtempSync(join(tmpdir(), 'gpu-a2-no-app-')), 'ledger.json');
  const code = String.raw`
import importlib.util,json,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location("budget",sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.current_profile=lambda:"desia"; m.active_experiment_apps=lambda:[]; m.billing_rows=lambda:[]
p=Path(sys.argv[2]); r=m.reserve(p,"E1-GPU"); m.validate_reservation(p,r["id"],"E1-GPU")
closed=m.complete_without_app(p,r["id"],"CLI rejected arguments before app creation")
next_reservation=m.reserve(p,"E1-CPU")
state=m.load_ledger(p)
print(json.dumps({"closed":closed,"next":next_reservation,"exposure":m.reserved_exposure(state)}))
`;
  const result = runPython(code, ledger);
  assert.equal(result.closed.status, 'completed-unposted');
  assert.equal(result.closed.appId, null);
  assert.match(result.closed.noAppReason, /before app creation/u);
  assert.equal(result.next.status, 'reserved');
  assert.equal(result.exposure, 6);
});

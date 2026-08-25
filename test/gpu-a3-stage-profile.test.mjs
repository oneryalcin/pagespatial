import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const profilerPath = new URL('../scripts/evaluation/gpu_a3_stage_profile.py', import.meta.url).pathname;
const modalSource = readFileSync(new URL('../scripts/evaluation/gpu_a2_modal.py', import.meta.url), 'utf8');
const runnerSource = readFileSync(new URL('../scripts/evaluation/run_gpu_a2_experiment.py', import.meta.url), 'utf8');

function runPython(code) {
  return JSON.parse(execFileSync('python3', ['-c', code, profilerPath], { encoding: 'utf8' }));
}

test('stage profiler preserves generator output and records nested real boundaries', () => {
  const code = String.raw`
import importlib.util,json,sys,time,types
spec=importlib.util.spec_from_file_location("profile",sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
class Batch:
  def __init__(self, values): self.instances=values; self.input_paths=[]; self.page_indexes=[]
class Sampler:
  batch_size=1
  def __call__(self, values):
    for value in values: yield Batch([value])
class Op:
  def __call__(self, **kwargs): time.sleep(0.0002); return kwargs.get("imgs", kwargs.get("x", [1]))
class Runner:
  def __call__(self, **kwargs): time.sleep(0.0003); return kwargs
class Model:
  def __init__(self, kind):
    self.kind=kind; self.batch_sampler=Sampler(); self.pre_tfs={"Read":Op(),"ToBatch":Op()}; self.runner=Runner(); self.post_op=Op()
  def __call__(self, values, **kwargs):
    for batch in self.batch_sampler(values):
      imgs=self.pre_tfs["Read"](imgs=batch.instances); x=self.pre_tfs["ToBatch"](imgs=imgs); pred=self.runner(x=x); self.post_op(x=pred)
      if self.kind=="detector": yield {"dt_polys":[[[0,0],[1,0],[1,1],[0,1]]]}
      else: yield {"rec_text":"ok","rec_score":1.0,"vis_font":"x"}
class Pipeline:
  def __init__(self): self.img_reader=Op(); self.text_det_model=Model("detector"); self.text_rec_model=Model("recognizer")
  def _sort_boxes(self, value): return value
  def _crop_by_polys(self, image, polys):
    for _ in polys: yield image
  def __call__(self, image):
    images=self.img_reader(imgs=[image]); det=list(self.text_det_model(images)); polys=self._sort_boxes(det[0]["dt_polys"]); crops=list(self._crop_by_polys(image,polys)); yield from self.text_rec_model(crops)
class OCR:
  def __init__(self): self.paddlex_pipeline=types.SimpleNamespace(_pipeline=Pipeline())
  def predict(self,image): return self.paddlex_pipeline._pipeline(image)
ocr=OCR(); profiler,identity=m.install_ocr_stage_profiler(ocr,0); profiler.begin_method(); profiler.begin_page(1,"p1")
with profiler.span("predict.total"): output=list(ocr.predict("pixels"))
page=profiler.finish_page(); summary=m.summarize_method_profile([page],[identity],page["wallMs"])
print(json.dumps({"output":output,"stages":sorted(summary["stageSummary"]),"recCalls":summary["stageSummary"]["recognizer.backend"]["calls"],"missing":identity["missingPaths"],"limitations":summary["limitations"]}))
`;
  const result = runPython(code);
  assert.deepEqual(result.output, [{ rec_text: 'ok', rec_score: 1, vis_font: 'x' }]);
  assert.equal(result.recCalls, 1);
  for (const stage of ['detector.total', 'detector.backend', 'crop.total', 'recognizer.total', 'recognizer.backend', 'predict.total']) {
    assert.ok(result.stages.includes(stage), `missing ${stage}`);
  }
  assert.match(result.limitations.join(' '), /not pure GPU kernel time/u);
});

test('stage profiler records generator errors once and does not hide them', () => {
  const code = String.raw`
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("profile",sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
p=m.StageProfiler(0); p.begin_method(); p.begin_page(7,"boom")
def fail():
  yield 1
  raise ValueError("expected")
error=""
try: list(p.wrap("recognizer.backend",fail)())
except Exception as exc: error=type(exc).__name__
page=p.finish_page(); print(json.dumps({"error":error,"events":page["events"]}))
`;
  const result = runPython(code);
  assert.equal(result.error, 'ValueError');
  assert.equal(result.events.filter((event) => event.status === 'error').length, 1);
  assert.equal(result.events.at(-1).status, 'error');
  assert.equal(result.events.at(-1).errorType, 'ValueError');
});

test('NVTX ranges use the fixed domain and expose recognizer wait without a new lock', () => {
  const code = String.raw`
import importlib.util,json,os,sys,types
events=[]
class Domain:
 def __init__(self,name): self.name=name
 def start_range(self,**kwargs): events.append(["start",self.name,kwargs["message"]]); return len(events)
 def end_range(self,handle): events.append(["end",handle])
fake=types.SimpleNamespace(Domain=Domain)
sys.modules["nvtx"]=fake; os.environ["PAGESPATIAL_A2_NVTX"]="1"
spec=importlib.util.spec_from_file_location("profile",sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
p=m.StageProfiler(1); p.recognizer_last_prepare_stage="recognizer.preprocess.to_batch"; p.begin_method(); p.begin_page(3,"req-3","run-1")
p.observe_recognition_batch(types.SimpleNamespace(instances=[1,2,3]))
with p.span("recognizer.preprocess.to_batch"): pass
with p.span("recognizer.backend"): pass
p.finish_page(); print(json.dumps(events))
`;
  const result = runPython(code);
  assert.equal(result[0][1], 'pagespatial.ocr');
  assert.match(result[0][2], /^recognizer\.prepare;run=run-1;page=3;owner=1;request=req-3;crops=3;batch=1$/u);
  assert.equal(result[1][0], 'end');
  assert.match(result[2][2], /^recognizer\.wait_backend;.*;crops=3;batch=1$/u);
  assert.equal(result[3][0], 'end');
  assert.match(result[4][2], /^recognizer\.backend;.*;crops=3;batch=1$/u);
});

test('stage profiler merges overlapping owner backend intervals without calling them GPU kernels', () => {
  const code = String.raw`
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("profile",sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
pages=[{"events":[
 {"stage":"recognizer.backend","startMs":0,"endMs":20,"wallMs":20,"threadCpuMs":1,"status":"success"},
 {"stage":"recognizer.backend","startMs":5,"endMs":10,"wallMs":5,"threadCpuMs":1,"status":"success"},
 {"stage":"recognizer.backend","startMs":25,"endMs":30,"wallMs":5,"threadCpuMs":1,"status":"success"}
]}]
s=m.summarize_method_profile(pages,[],35); print(json.dumps(s["backendOccupancy"]["recognizer.backend"]))
`;
  const result = runPython(code);
  assert.equal(result.occupiedUnionMs, 25);
  assert.equal(result.windowMs, 30);
  assert.equal(result.gapMs, 5);
  assert.equal(result.mergedIntervals.length, 2);
});

test('A3 profiling is evaluation-only, arm-bounded, persisted, and opt-in from the guarded runner', () => {
  assert.match(modalSource, /PAGESPATIAL_A2_STAGE_PROFILE/u);
  assert.match(modalSource, /stage profiling is bounded to Tiny B1 with two owners/u);
  assert.match(modalSource, /install_ocr_stage_profiler/u);
  assert.match(modalSource, /summarize_method_profile/u);
  assert.match(modalSource, /stage profile did not reconcile exactly 50 pages/u);
  assert.match(runnerSource, /--stage-profile/u);
  assert.match(runnerSource, /--stage-profile requires --model-tier tiny/u);
  assert.ok(runnerSource.indexOf('reserve(ledger, "E1-GPU")') < runnerSource.indexOf('"modal", "run"'));
});

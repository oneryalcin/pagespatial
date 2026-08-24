import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const splitPath = new URL('../scripts/evaluation/gpu_a3_split_recognition.py', import.meta.url).pathname;
const modalSource = readFileSync(new URL('../scripts/evaluation/gpu_a2_modal.py', import.meta.url), 'utf8');
const runnerSource = readFileSync(new URL('../scripts/evaluation/run_gpu_a2_experiment.py', import.meta.url), 'utf8');

function runPython(code) {
  return JSON.parse(execFileSync('python3', ['-c', code, splitPath], { encoding: 'utf8' }));
}

test('bounded split recognition preserves output order and overlaps CPU work with backend work', () => {
  const code = String.raw`
import importlib.util,json,sys,time,types,threading
spec=importlib.util.spec_from_file_location("split",sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
events=[]; lock=threading.Lock()
def mark(name,phase,index):
  with lock: events.append({"name":name,"phase":phase,"index":index,"at":time.monotonic()})
class Image:
  def __init__(self,index): self.index=index; self.shape=(10,20,3)
class Batch:
  def __init__(self,index): self.instances=[Image(index)]; self.input_paths=[f"p{index}"]; self.page_indexes=[index]
class Sampler:
  batch_size=1
  def __call__(self,values):
    for value in values: yield Batch(value)
class Read:
  def __call__(self,imgs): return imgs
class Prep:
  def __call__(self,imgs):
    index=imgs[0].index; mark("prep","start",index); time.sleep(.025); mark("prep","end",index); return imgs
class ToBatch:
  def __call__(self,imgs): return imgs[0].index
class Runner:
  def __call__(self,x): mark("backend","start",x); time.sleep(.025); mark("backend","end",x); return x
class Post:
  def __call__(self,predictions,**kwargs): mark("post","start",predictions); time.sleep(.025); mark("post","end",predictions); return [f"text-{predictions}"],[1.0]
class Result(dict): pass
class Model:
  def __init__(self):
    self.batch_sampler=Sampler(); self.pre_tfs={"Read":Read(),"ReisizeNorm":Prep(),"ToBatch":ToBatch()}; self.runner=Runner(); self.post_op=Post(); self.return_word_box=False; self.vis_font="font"; self.result_class=Result(); self.result_class=Result
    self.config={"PreProcess":{"transform_ops":[{"RecResizeImg":{"image_shape":[3,48,320]}}]}}
  def process(self): pass
model=Model(); split=m.SplitRecognitionModel(model)
started=time.monotonic(); output=list(split([0,1,2,3])); elapsed=time.monotonic()-started
def event(name,phase,index): return next(item["at"] for item in events if item["name"]==name and item["phase"]==phase and item["index"]==index)
print(json.dumps({"texts":[item["rec_text"] for item in output],"elapsed":elapsed,"prepOverlap":event("prep","start",1)<event("backend","end",0),"postOverlap":event("post","start",0)<event("backend","end",1),"metrics":split.metrics()}))
`;
  const result = runPython(code);
  assert.deepEqual(result.texts, ['text-0', 'text-1', 'text-2', 'text-3']);
  assert.equal(result.prepOverlap, true);
  assert.equal(result.postOverlap, true);
  assert.ok(result.elapsed < 0.25, `pipeline did not overlap: ${result.elapsed}`);
  assert.equal(result.metrics.maxPreparedInFlight, 2);
  assert.equal(result.metrics.maxPostprocessInFlight, 2);
});

test('split recognition is fixed to a two-batch bound', () => {
  const code = String.raw`
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location("split",sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
try: m.SplitRecognitionModel(object(),queue_depth=3); error=""
except Exception as exc: error=str(exc)
print(json.dumps({"error":error}))
`;
  assert.match(runPython(code).error, /fixed at 2/u);
});

test('treatment is evaluation-only, arm-bounded, opt-in, and records its metrics', () => {
  assert.match(modalSource, /PAGESPATIAL_A2_SPLIT_RECOGNITION/u);
  assert.match(modalSource, /split recognition is bounded to Tiny B1 with two owners/u);
  assert.match(modalSource, /install_split_recognition\(ocr, queue_depth=2\)/u);
  assert.match(modalSource, /result\["splitRecognition"\]/u);
  assert.match(runnerSource, /--split-recognition/u);
  assert.match(runnerSource, /--stage-profile and --split-recognition are separate A3 arms/u);
});

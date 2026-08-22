# Server-native PP-OCR witness: same engine, same bytes, no browser

**Date:** 2026-08-22 · **Branch:** `server-ocr-adapter` · **Issue:** #2 (now-half; #22 dependency)

## What shipped

`src/node/ppocr-ocr.ts` — `createPpOcrV6NodeAdapter`: the OCR witness
running under plain Node. Not a port: the **exact same
`@paddleocr/paddleocr-js` pipeline** the browser witness uses (identical
preprocessing, DB postprocess, CTC decode) and the **byte-identical
sha256-pinned ONNX models** (`scripts/prepare-ppocr-assets.mjs`
materializes them), executed on ONNX Runtime's WASM provider in-process.
No Chromium, no WebGPU, no DOM.

Three narrow environment accommodations, each documented in the source:

1. The engine's serving guard reads `location.protocol`; an inert frozen
   `location` is installed only if the global is undefined.
2. The engine's default image path needs DOM canvas; its first-class
   escape hatch — passing a `cv.Mat` — is used instead
   (`matFromImageData`, pure WASM).
3. opencv.js is an emscripten module whose object is a legacy *thenable*:
   it must never be a promise's resolution value or the awaiting caller
   hangs forever once the runtime is already initialized. The loader
   returns a `{ cv }` wrapper destructured at the call site. (This
   cost an afternoon; it is the one genuine trap in running this engine
   under Node.)

Model asset loading goes through a `local-asset://` fetch that refuses
non-local URLs and path traversal — a server worker must not be able to
fetch models from the network at inference time.

## What can differ from the browser witness (and is measured, not assumed)

- **Execution provider**: browser production path is WebGPU; this is
  WASM (the browser's own fallback EP).
- **Renderer**: pdf.js canvas vs `pdftoppm` — the measurement renders at
  the exact pixel dimensions of the browser run's geometry, so what
  remains is rasterizer character (antialiasing, hinting), which is part
  of the witness swap being measured.
- **Threads**: WASM thread count changes throughput only.

## Witness-equivalence measurement

`scripts/evaluation/witness-equivalence.mjs` — sample: **every
gold-labelled page with a dev-v12 run record** (deterministic, no
seed needed). Per page: render via pdftoppm to the record's exact
geometry; run the node adapter; compare against the record's
**first-pass** `ocrObservations` (zoom-retry recovery observations are
excluded — recovery is a pipeline layer above the witness and absent
from a single-pass run; the first measurement attempt compared against
recovery-inclusive observations and overstated divergence, visibly
corrected here). Matching uses the library's own tokenizer and
consume-once pool corroboration — never a re-implementation. Gold recall
uses human-verified (`correct`/`edited`) tokens under each witness's
pool.

### Results (dev-v12, N pages)

| | value |
|---|---|
| pages (all gold pages with dev-v12 records) | 90 |
| first-pass observations, browser / node | 7,908 / 7,938 |
| critical tokens matched, browser→node | **4,277/4,662 (91.7%)** |
| critical tokens matched, node→browser | **4,277/4,681 (91.4%)** |
| box IoU (median of page medians, 6,669 exact-text matches) | 0.922 |
| gold recall (63 pages, 1,223 human-verified tokens) | browser **972** · node **982** |
| per-page gold | node better 9 · browser better 7 · tied 47 |

Japanese pages (18, both monotaro docs): equivalent — p61 gold 105/106
(node) vs 103/106 (browser); token agreement ≥95% on every JA page but
one 9-token page. The residual one-sided differences (~8% each way)
concentrate on a handful of dense World-Bank table pages (48–62%
agreement) and are symmetric — renderer antialiasing and EP numerics
change WHICH faint tokens each pipeline admits, with no directional
winner and almost no gold impact.

### Verdict

**Near-equivalent with documented deltas.** Not byte-identical — 8% of
either witness's tokens are unmatched by the other, symmetrically — but
evidentiary strength is equal: aggregate gold recall is a wash (982 vs
972 of 1,223; per-page ties dominate) and CJK, the historical failure
mode, is fully preserved. Per the era rules the witness swap is a run-
configuration change: service runs must carry their own configuration id
and comparisons across the swap happen at the gold level, not raw
conflict counts. Whether that is "same era" is the owner's call, made on
these numbers; nothing here is silently blessed.

One methodological correction, kept visible: the first measurement run
compared against recovery-inclusive observations AND transposed rotated
pages via pdftoppm's pre-rotation `-scale-to-x/y` semantics (Blackstone
p12–17 zeroed, the crop-bug lesson relearned in render form). Both fixed;
every number above is from the corrected run.

## Throughput and footprint (CPU)

| | value |
|---|---|
| OCR ms/page, p50 / p95 (4 WASM threads) | 3,742 / 13,341 |
| render (pdftoppm) mean | 370 ms/page |
| RSS peak, single worker incl. models | 2.3 GB (start 640 MB) |
| cold init (models + wasm) | ~0.6 s |

~0.24 pages/sec/worker at 4 threads on this laptop — the honest baseline
the #22 service instruments against on server hardware. **This is the
WASM-EP cost, not "the CPU cost"**: the native onnxruntime-node EP was
deliberately not used because `@paddleocr/paddleocr-js` hard-depends on
onnxruntime-web — swapping the EP means a different pipeline and weaker
equivalence, so engine parity was bought at throughput's expense. Native
EP over the same ONNX files is plausibly several-fold faster and is a
named #22 measurement arm, alongside thread count and GPU. The browser's
WebGPU path is several times faster per page today.

Box IoU is diagnostic-only: it conditions on exact-text matches, so it
characterizes geometric agreement of shared readings and says nothing
about tokens only one witness read.

Hardware: Apple Silicon (darwin arm64, this development machine);
single adapter instance, 4 WASM threads. The #22 service decides GPU
purchases from these numbers re-measured on target server hardware —
per the issue #2 gate, not from intuition.

## Incidental finding — RETRACTED (2026-08-22, see the p144 differential)

The claim originally made here — that the server witness "reads both
16s" on `osf … p144`, suggesting an input-sensitive miss mechanism —
was **false**, contradicted by this trial's own committed data
(`witness-equivalence-v2.json`: p144 `goldRecall {browser: 0, node: 0}`)
and by direct reproduction at both 150 dpi and the equivalence dpi. The
raw OCR text does contain `16` — but so does the browser run's; visible
text was equated with scorer corroboration. The real mechanism is a
tokenizer artifact (`"trials + 16 filler"` → `+16|filler`, sign-glued
across a space, rejecting gold's bare `16`), and no witness ever missed
the ink. Full analysis:
`docs/trials/2026-08-22-p144-differential.md`.

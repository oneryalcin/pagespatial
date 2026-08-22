# Sidecar integration: the adopted witness enters the service

**Date:** 2026-08-22 · **Branch:** `sidecar-integration` · **Issues:** #2 (owner
adoption decision), #22 · **Builds on:** the adoption ceremony
(`2026-08-22-sidecar-adoption-ceremony.md`, PR #67)

## What shipped

1. **Subprocess-per-worker sidecar.** Each Node page-worker owns one Python
   child (`service/sidecar/ppocr_sidecar.py`) running the official
   PaddleOCR pipeline — JSONL over stdin/stdout, pages travel as tmpfiles
   (no base64, no HTTP, no ports). A child crash rejects the in-flight page
   (fails closed, queue requeues) and the next page respawns the child; the
   child never outlives its worker. Adapter:
   `service/adapters/ppocr-sidecar.mjs`.
2. **Model pinning — the ceremony's open precondition, closed.**
   `service/sidecar/fetch_models.py --record` resolved and froze exact HF
   revisions + per-file sha256 into the committed
   `service/sidecar/model-pins.json`:
   - `PP-OCRv6_small_det@106c9759…` — **matches the revision the ceremony
     observed**, closing that lineage gap exactly;
   - `PP-OCRv6_small_rec@bd619643…` — the ceremony had NO rec evidence;
     this pin is validated behaviorally by the parity check below.
   Verification is two-sided (Node at boot, Python before loading); any
   hash mismatch refuses to serve. Models load from LOCAL dirs — nothing
   downloads at serve time.
3. **Truthful per-host provenance.** The descriptor's `ep=` derives from
   the child's own meta (`enable_hpi` requested on Linux only; `useHpip`
   introspected in-band): `#ep=hpi` where engaged, `#ep=paddle-default`
   elsewhere — never a claim the process cannot verify.
   `configuration.ocrBackend` carries versions, platform, threads,
   `modelPins`, and `engineEvidence` — the C++ backend-selection line
   captured from child stderr, **labeled log-derived** (the C++ layer
   bypasses Python logging; in-band capture remains impossible, stated
   rather than papered over).
4. **Boot fails closed** (no silent fallback): configured-sidecar boot runs
   Node-side pin verification plus a real child `--check`; misconfigured
   hosts refuse jobs. Thread misparse refuses at boot. The canonical gate
   (two-sided, worker + assembly) is untouched; the WASM adapter stays
   registered as the validated fallback; the stub stays tests-only.

## Integrated-path witness sanity check (10 ceremony pages, 613 gold tokens)

`service/sidecar/sanity-check.mjs` drives the REAL sidecar through the
service adapter over the 10 most gold-bearing ceremony pages and scores
with the SAME `score-candidate-witness.mjs` — integrated path vs
ceremonial path, scorer and gold held constant:

| | gold hits |
|---|---|
| ceremony (Modal, 1 vCPU, HPI/OpenVINO) | 438 |
| integrated sidecar (this Mac, paddle-default) | **438** |

**Delta 0 of a ±4 allowance — parity.** The tmpfile protocol, adapter
mapping, and pinned local models reproduce the ceremonial readings
exactly on these pages (line counts match page-for-page). This also
validates the rec-model pin behaviorally.

## Measured: boot cost and full-pipeline throughput (this host)

Same 3 corpus PDFs / 176 pages / 4 workers as every prior service table
(M-series laptop). **This host runs paddle-default (macOS — no HPI); the
OpenVINO numbers remain the Modal/Linux ceremony figures, and
target-hardware re-measurement is a deploy-time task.**

| | WASM witness (PR #62) | **sidecar (this PR)** |
|---|---|---|
| ocr p50 / p95 ms | 6,504 / 10,869 | **6,779 / 12,123** |
| render p50 ms | 361 | 209 |
| native p50 ms | 20 | 7.2 |
| ocrColdInit (once/worker) | 665 ms | **3,427 ms** (python + model load + warm engine) |
| pages/sec (4 workers) | 0.54 | **0.53** |
| end-to-end wall (176 pages) | 327.6 s | 336.9 s |
| memory / worker | ~2.3 GB OS-max (one process) | **343 MB Node + 1.4–1.8 GB Python child ≈ ~2 GB combined** |

Reading this honestly: **on macOS the sidecar ≈ the WASM witness** —
paddle-default has no OpenVINO, so parity here is expected, and the point
of this table is that the integration adds no overhead of its own (the
tmpfile protocol + subprocess hop cost ~nothing; render/native got
FASTER because four Python processes contend differently than four WASM
engines). The adoption's speed case lives on Linux/OpenVINO: 989–1,448
ms/page measured in the ceremony/scaling runs — **~6× better core
economics** — to be re-confirmed through this integrated path on target
hardware at deploy time. Worker RSS in `/v1/metrics` now measures the
NODE side only; the Python child is a separate process (capacity: budget
~2 GB combined per worker, measured via OS `ps`, not the metric).

**Lifecycle fix shipped alongside (found live during this measurement's
teardown):** an unhandled SIGTERM terminated the server without draining
the pool, leaking workers — each now holding a ~1.5 GB Python engine.
`server.mjs` handles SIGTERM like SIGINT, and workers exit through
`process.exit` so adapter exit-hooks kill their children. Verified
empirically: SIGTERM → 0 workers, 0 sidecar processes within seconds.

Cross-machine caveats apply as ever (PR #64 lesson): compare trends, not
milliseconds, across hosts.

## Provenance field names (per record)

`provenance.ocrAdapter` = `ppocrv6-small-sidecar@<paddleocr>#ep=<hpi|paddle-default>;threads=N`;
`provenance.configuration.ocrBackend` = `{adapter, version, variant,
executionProvider, numThreads, platform, hpiRequested, useHpip,
modelPins, engineEvidence{source, line}}`.

## Era note

dev-v12 remains the browser-era reference. **dev-v13 is cut at the first
post-adoption corpus run** (not in this PR); cross-era comparisons at gold
level only, per the era rules. Output stability across containers is
~±4 gold tokens (ceremony finding) — not bit-stable; single-token deltas
between hosts are expected noise.

## Honest-but-open

- In-band C++ backend capture: still impossible from Python; evidence is
  stderr-derived and labeled. Revisit only if paddle exposes it.
- OpenVINO-on-Linux throughput through THIS integrated path is unmeasured
  (ceremony measured the pipeline on Modal directly); the deploy-time
  re-measure covers it.
- `os.cpu_count()` in meta reports host cores, not cgroup quotas
  (ceremony finding, unchanged).

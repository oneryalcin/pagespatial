"""M1 Linux verification (design doc 2026-08-23, workstream 1).

The measurement environment IS the deployment unit: the Modal image is
built FROM THE COMMITTED Dockerfile (modal.Image.from_dockerfile, linux
x86 builder), so a passing run verifies both that the Dockerfile builds
and that its runtime behaves — same pins, same baked models, same env
vars. Corpus pages travel as function arguments (nothing persists
remotely; precedent: the HPI benchmark trial, owner-authorized).

Tasks (run from the repo root):

  modal run scripts/evaluation/m1_linux_verification_modal.py::probe
      # image smoke: versions, pins on disk, node present, sidecar --check

  modal run scripts/evaluation/m1_linux_verification_modal.py::ep_control_local \
      --pages-dir /abs/.evaluation/hpi-bench --out /abs/.evaluation/m1-linux/ep-control.json
      # criterion 2: SAME container — hpi twice (null tolerance), then
      # paddle-default once (SIDECAR_DISABLE_HPI=1), via the real sidecar
      # script. Score each run with score-candidate-witness.mjs and the
      # pairwise diffs with score-ep-control.mjs.

  modal run scripts/evaluation/m1_linux_verification_modal.py::throughput_local \
      --pdfs-dir /abs/.evaluation/m1-subset-pdfs --workers 4 --threads 1 \
      --out /abs/.evaluation/m1-linux/throughput-4x1.json
      # criterion 3: full 162-page corpus through the real service in the
      # real image; OS-max RSS from /proc VmHWM + cgroup peak. Run once
      # per packing (4x1 and 1x4). Doubles as criterion 1 (the returned
      # provenance block is lifted from a result record) and exercises
      # the SIGTERM drain + PID probe at the end (criterion 4 partial).

  modal run scripts/evaluation/m1_linux_verification_modal.py::failure_local \
      --pdfs-dir /abs/.evaluation/m1-subset-pdfs --out /abs/.evaluation/m1-linux/failure.json
      # criterion 4: worker SIGKILL mid-job -> requeue; sidecar SIGKILL
      # mid-job -> fail-closed + respawn; SIGTERM mid-job -> drain with
      # zero surviving processes (PID probe) + restart resume; stub-hook
      # corrupt page -> fails closed, siblings unaffected.

Outputs are count-level only — no corpus text leaves the function.
"""

import json
import os
import time
from pathlib import Path

import modal

app = modal.App("pagespatial-m1-linux-verification")

# This module is re-imported INSIDE the container (at /root/<file>.py,
# parentless); the Dockerfile path only matters client-side, where the
# lazy image build actually reads it.
REPO_ROOT = Path(__file__).resolve().parents[2] if modal.is_local() else Path("/app")

image = modal.Image.from_dockerfile(
    REPO_ROOT / "Dockerfile",
    context_dir=REPO_ROOT,
    add_python="3.11",
)

SIDECAR_ENV = {
    "SIDECAR_MODELS_DIR": "/opt/models",
    "SIDECAR_THREADS": "1",
}


def _spawn_sidecar(extra_env: dict) -> "subprocess.Popen":
    import subprocess

    env = {**os.environ, **SIDECAR_ENV, **extra_env}
    return subprocess.Popen(
        ["/opt/paddle/bin/python", "/app/service/sidecar/ppocr_sidecar.py"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        text=True,
    )


def _sidecar_run(name: str, pages: list, extra_env: dict) -> dict:
    """One full pass of `pages` through the REAL sidecar script (fresh
    process = fresh engine), returning scorer-compatible perPage plus the
    child's own meta (in-band useHpip)."""
    import tempfile
    import threading

    child = _spawn_sidecar(extra_env)
    # Drain stderr on a thread: the C++ layer logs heavily and an undrained
    # PIPE buffer would deadlock the child mid-predict. Keep the engine-
    # selection lines as LOG-DERIVED evidence (labeled; meta.useHpip is the
    # in-band channel).
    engine_lines = []

    def _drain():
        for line in child.stderr:
            if "Backend::" in line or "backend config" in line:
                if len(engine_lines) < 20:
                    engine_lines.append(line.strip())

    threading.Thread(target=_drain, daemon=True).start()

    def read_json(expect_kind=None):
        # The C++ layer writes [INFO] lines to the RAW stdout fd, interleaved
        # with the protocol JSONL — skip unparseable lines, exactly as the
        # Node adapter does.
        while True:
            line = child.stdout.readline()
            if not line:
                raise RuntimeError(f"{name}: sidecar stdout closed unexpectedly")
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(message, dict):
                continue
            if message.get("kind") == "fatal":
                raise RuntimeError(f"{name}: sidecar fatal: {message.get('error')}")
            if expect_kind is not None and message.get("kind") != expect_kind:
                continue
            return message

    t0 = time.monotonic()
    meta = read_json(expect_kind="meta")
    init_s = time.monotonic() - t0
    per_page = []
    with tempfile.TemporaryDirectory() as tmp:
        for index, (page_name, png_bytes) in enumerate(pages):
            path = Path(tmp) / f"{index}.png"
            path.write_bytes(png_bytes)
            child.stdin.write(json.dumps({"id": index, "path": str(path)}) + "\n")
            child.stdin.flush()
            response = read_json()
            if response.get("error"):
                raise RuntimeError(f"{name} page {page_name}: {response['error']}")
            lines = []
            for line in response["lines"]:
                poly = line.get("poly")
                if poly:
                    xs = [p[0] for p in poly]
                    ys = [p[1] for p in poly]
                    box = [min(xs), min(ys), max(xs), max(ys)]
                else:
                    box = None
                lines.append({"text": line["text"], "box": box, "score": line["score"]})
            per_page.append({"page": page_name, "ms": response["ms"], "lines": lines})
        # Warm re-run of page 0 so every quoted ms is warm (bench discipline).
        if pages:
            path = Path(tmp) / "warm0.png"
            path.write_bytes(pages[0][1])
            child.stdin.write(json.dumps({"id": len(pages), "path": str(path)}) + "\n")
            child.stdin.flush()
            response = read_json()
            lines = per_page[0]["lines"]
            per_page[0] = {"page": pages[0][0], "ms": response["ms"], "lines": lines}
    child.stdin.close()
    child.wait(timeout=60)
    return {"name": name, "meta": meta, "initS": round(init_s, 2), "perPage": per_page,
            "engineEvidenceLogDerived": engine_lines}


@app.function(image=image, cpu=1.0, memory=8192, timeout=1800)
def probe() -> dict:
    """Image smoke: the deployment unit's own fail-closed boot pieces."""
    import platform
    import shutil
    import subprocess

    node = shutil.which("node")
    node_version = subprocess.run([node, "--version"], capture_output=True, text=True).stdout.strip() if node else None
    versions = subprocess.run(
        ["/opt/paddle/bin/python", "-c",
         "import importlib.metadata as m, json; print(json.dumps({p: m.version(p) for p in ('paddleocr','paddlepaddle')}))"],
        capture_output=True, text=True,
    )
    pip_list = subprocess.run(["/opt/paddle/bin/pip", "list"], capture_output=True, text=True).stdout
    check = subprocess.run(
        ["/opt/paddle/bin/python", "/app/service/sidecar/ppocr_sidecar.py", "--check"],
        capture_output=True, text=True, env={**os.environ, **SIDECAR_ENV}, timeout=1200,
    )
    meta = None
    for line in check.stdout.splitlines():
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            continue
        if parsed.get("kind") == "meta":
            meta = parsed
    return {
        "platform": platform.platform(),
        "machine": platform.machine(),
        "node": node_version,
        "venvVersions": json.loads(versions.stdout) if versions.returncode == 0 else versions.stderr[-400:],
        "modelsDirPresent": Path("/opt/models").is_dir(),
        "modelRepos": sorted(p.name for p in Path("/opt/models").iterdir()) if Path("/opt/models").is_dir() else [],
        "sidecarCheckExit": check.returncode,
        "sidecarMeta": meta,
        "sidecarCheckStdoutTail": check.stdout[-1500:],
        "sidecarCheckStderrTail": check.stderr[-1500:],
        "pipUltraInfer": [line for line in pip_list.splitlines() if "ultra" in line.lower() or "paddlex" in line.lower() or "paddle2onnx" in line.lower() or "openvino" in line.lower()],
        "env": {k: os.environ.get(k) for k in ("SERVICE_OCR_ADAPTER", "SERVICE_SIDECAR_PYTHON", "SERVICE_SIDECAR_MODELS_DIR", "SERVICE_SIDECAR_THREADS")},
    }


@app.function(image=image, cpu=1.0, memory=8192, timeout=7200)
def ep_control(pages: list) -> dict:
    """Criterion 2: hpi twice then paddle-default once, ONE container (same
    host, same models, same interpreter — only the EP toggles)."""
    results = {}
    for name, extra in (("hpi_a", {}), ("hpi_b", {}), ("default", {"SIDECAR_DISABLE_HPI": "1"})):
        results[name] = _sidecar_run(name, pages, extra)
    return {
        "container": {"cpu": 1, "osCpuCount": os.cpu_count()},
        "runs": results,
    }


# ---------------------------------------------------------------------------
# Service harness (throughput + failure): drives the REAL server.
# ---------------------------------------------------------------------------

def _http(method: str, port: int, path: str, body: bytes = None, content_type: str = None):
    import urllib.request

    request = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=body, method=method)
    if content_type:
        request.add_header("content-type", content_type)
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.status, json.loads(response.read())


def _wait_health(port: int, deadline_s: float) -> dict:
    """Poll /health until 200; record that 503-before-ready was observed."""
    import urllib.error
    import urllib.request

    saw_503 = False
    start = time.monotonic()
    while time.monotonic() - start < deadline_s:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=10) as response:
                body = json.loads(response.read())
                return {"readyAfterS": round(time.monotonic() - start, 1), "saw503BeforeReady": saw_503, "body": body}
        except urllib.error.HTTPError as error:
            if error.code == 503:
                saw_503 = True
        except Exception:
            pass
        time.sleep(2)
    raise RuntimeError(f"/health not ready within {deadline_s}s")


def _start_server(port: int, env_overrides: dict):
    import subprocess

    env = {**os.environ, "PORT": str(port), "SERVICE_DATA_DIR": "/tmp/psvc-data", **env_overrides}
    return subprocess.Popen(["node", "service/server.mjs"], cwd="/app", env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)


def _proc_scan(needles: tuple) -> list:
    """PID probe: every live process whose cmdline mentions a needle."""
    found = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            cmdline = (entry / "cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")
        except OSError:
            continue
        for needle in needles:
            if needle in cmdline:
                found.append({"pid": int(entry.name), "match": needle})
                break
    return found


def _proc_mem(pid: int):
    """All Vm* fields (kB) from /proc/<pid>/status — gVisor's procfs omits
    some (VmHWM was observed absent), so return whatever the kernel offers
    and let the caller say which field it is quoting."""
    fields = {}
    try:
        for line in (Path("/proc") / str(pid) / "status").read_text().splitlines():
            if line.startswith("Vm") or line.startswith("Rss"):
                parts = line.split()
                if len(parts) >= 2 and parts[1].isdigit():
                    fields[parts[0].rstrip(":")] = int(parts[1])
    except OSError as error:
        fields["error"] = str(error)
    return fields


class _PeakSampler:
    """OS-derived peak RSS by 2 s /proc sampling — used where the kernel
    surfaces no VmHWM/cgroup peak (gVisor). A sampled max LOWER-BOUNDS the
    true high-water mark; labeled as such in the results."""

    def __init__(self, needles):
        import threading

        self.needles = needles
        self.peaks = {}  # pid -> {"match", "maxVmRssKb", "lastVmRssKb", "vmHwmKb"}
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def _loop(self):
        while not self._stop.is_set():
            for proc in _proc_scan(self.needles):
                mem = _proc_mem(proc["pid"])
                rss = mem.get("VmRSS")
                if rss is None:
                    continue
                entry = self.peaks.setdefault(proc["pid"], {"match": proc["match"], "maxVmRssKb": 0, "vmHwmKb": None})
                entry["maxVmRssKb"] = max(entry["maxVmRssKb"], rss)
                entry["lastVmRssKb"] = rss
                if mem.get("VmHWM") is not None:
                    entry["vmHwmKb"] = mem["VmHWM"]
            self._stop.wait(2)

    def stop(self):
        self._stop.set()
        self._thread.join(timeout=5)
        return [{"pid": pid, **entry} for pid, entry in sorted(self.peaks.items())]


def _cgroup_probe():
    out = {}
    for path in ("/sys/fs/cgroup/memory.peak", "/sys/fs/cgroup/memory.current",
                 "/sys/fs/cgroup/memory/memory.max_usage_in_bytes",
                 "/sys/fs/cgroup/memory/memory.usage_in_bytes"):
        try:
            out[path] = int(Path(path).read_text().strip())
        except (OSError, ValueError):
            continue
    return out


def _submit_and_drain(port: int, pdfs: list) -> dict:
    """Submit every PDF, poll all jobs to completion, return timings and
    count-level aggregates (never page text)."""
    jobs = []
    t_first_submit = time.monotonic()
    for name, pdf_bytes in pdfs:
        status, body = _http("POST", port, "/v1/jobs", pdf_bytes, "application/pdf")
        assert status == 202, (status, body)
        jobs.append({"name": name, "jobId": body["jobId"], "pageCount": body["pageCount"]})
    # Poll only jobs still pending: GET /v1/jobs returns the FULL pages
    # array every time (known quadratic), and re-fetching completed jobs
    # each sweep would steal measurable CPU from the workers under test.
    while True:
        pending = 0
        for job in jobs:
            if job.get("status") == "completed":
                continue
            status, body = _http("GET", port, f"/v1/jobs/{job['jobId']}")
            job["status"] = body["status"]
            job["pages"] = body["pages"]
            if body["status"] != "completed":
                pending += 1
        if pending == 0:
            break
        time.sleep(10)
    wall_s = time.monotonic() - t_first_submit
    pages = [page for job in jobs for page in job["pages"]]
    ok = [p for p in pages if p.get("ok")]
    failed = [p for p in pages if not p.get("ok")]
    def _pct(values, rank):
        if not values:
            return None
        ordered = sorted(values)
        return ordered[min(len(ordered) - 1, max(0, -(-len(ordered) * rank // 100) - 1))]
    stage_stats = {}
    for stage in ("render", "native", "ocr", "assembly", "secondOpinion", "ocrColdInit"):
        values = [p["stageTimingsMs"][stage] for p in pages if stage in p.get("stageTimingsMs", {})]
        if values:
            stage_stats[stage] = {"n": len(values), "p50": _pct(values, 50), "p95": _pct(values, 95)}
    return {
        "wallS": round(wall_s, 1),
        "pagesTotal": len(pages),
        "pagesOk": len(ok),
        "pagesFailed": len(failed),
        "failedClasses": sorted({p["failure"].get("errorClass", "?") for p in failed}) if failed else [],
        "attemptsHistogram": {str(a): sum(1 for p in pages if p.get("attempts") == a) for a in sorted({p.get("attempts") for p in pages})},
        "stageTimingsMs": stage_stats,
        "wallMsP50": _pct([p["wallMs"] for p in pages if "wallMs" in p], 50),
        "wallMsP95": _pct([p["wallMs"] for p in pages if "wallMs" in p], 95),
        "jobs": [{k: job[k] for k in ("name", "jobId", "pageCount", "status")} for job in jobs],
        "_pagesRaw": pages,  # stripped before return by callers that expose results
    }


def _provenance_from(pages: list):
    """Criterion 1 evidence: the record's own provenance/config — no text."""
    for page in pages:
        record = page.get("pageSpatial")
        if not record:
            continue
        return {
            "ocrAdapter": record.get("provenance", {}).get("ocrAdapter") or record.get("ocrAdapter"),
            "configurationOcrBackend": (record.get("provenance", {}).get("configuration") or record.get("configuration", {})).get("ocrBackend"),
            "keys": sorted(record.keys()),
        }
    return None


def _shutdown_and_probe(server, timeout_s: float = 60.0) -> dict:
    """SIGTERM the server, await exit, PID-probe for survivors."""
    import signal as signals

    t0 = time.monotonic()
    server.send_signal(signals.SIGTERM)
    try:
        server.wait(timeout=timeout_s)
        exited = True
    except Exception:
        exited = False
    # Give reparented stragglers a beat to die, then probe.
    time.sleep(3)
    survivors = _proc_scan(("ppocr_sidecar", "worker.mjs", "server.mjs"))
    return {
        "serverExited": exited,
        "exitCode": server.returncode,
        "drainS": round(time.monotonic() - t0, 1),
        "survivingProcesses": survivors,
    }


@app.function(image=image, cpu=4.0, memory=24576, timeout=7200)
def throughput(pdfs: list, workers: int, threads: int) -> dict:
    """Criterion 3 (one packing) + criterion 1 evidence + drain probe."""
    port = 8571
    sampler = _PeakSampler(("worker.mjs", "ppocr_sidecar", "server.mjs"))
    server = _start_server(port, {"SERVICE_WORKERS": str(workers), "SERVICE_SIDECAR_THREADS": str(threads)})
    health = _wait_health(port, 1500)
    run = _submit_and_drain(port, pdfs)
    pages_raw = run.pop("_pagesRaw")
    provenance = _provenance_from(pages_raw)
    # OS-max RSS BEFORE shutdown, from /proc (never process.memoryUsage):
    # VmHWM where the kernel offers it; otherwise the 2 s-sampled VmRSS max
    # (a lower bound on the true peak, labeled).
    rss = {
        "method": "/proc/<pid>/status VmHWM where present; else max of 2s-sampled VmRSS (lower bound)",
        "processes": sampler.stop(),
        "statusFieldsExample": _proc_mem(server.pid),
        "cgroup": _cgroup_probe(),
    }
    status, metrics = _http("GET", port, "/v1/metrics")
    drain = _shutdown_and_probe(server)
    return {
        # Field name kept for artifact comparability; unit correction
        # 2026-08-23: the value is Modal cpu=4.0 = 4 PHYSICAL cores.
        "packing": {"containerVCpu": 4, "workers": workers, "threadsPerSidecar": threads, "osCpuCount": os.cpu_count()},
        "health": {k: health[k] for k in ("readyAfterS", "saw503BeforeReady")},
        "healthBody": health["body"],
        "run": run,
        "pagesPerSec": round(run["pagesTotal"] / run["wallS"], 3),
        "pagesPerSecPerCore": round(run["pagesTotal"] / run["wallS"] / 4, 4),
        "inBandProvenance": provenance,
        "rss": rss,
        "metrics": metrics,
        "drain": drain,
    }


@app.function(image=image, cpu=2.0, memory=16384, timeout=7200)
def failure(pdfs: list, corrupt_pdf: bytes) -> dict:
    """Criterion 4: crash containment + drain, inside the container."""
    import signal as signals

    port = 8571
    out = {}
    server = _start_server(port, {"SERVICE_WORKERS": "2", "SERVICE_SIDECAR_THREADS": "1"})
    health = _wait_health(port, 1500)
    out["health"] = {k: health[k] for k in ("readyAfterS", "saw503BeforeReady")}

    def submit(pdf_bytes):
        status, body = _http("POST", port, "/v1/jobs", pdf_bytes, "application/pdf")
        assert status == 202, (status, body)
        return body["jobId"]

    def wait_done(job_id, deadline_s=1800):
        start = time.monotonic()
        while time.monotonic() - start < deadline_s:
            status, body = _http("GET", port, f"/v1/jobs/{job_id}")
            if body["status"] == "completed":
                return body
            time.sleep(2)
        raise RuntimeError(f"job {job_id} did not complete")

    def wait_partial(job_id, at_least=1, deadline_s=900):
        start = time.monotonic()
        while time.monotonic() - start < deadline_s:
            status, body = _http("GET", port, f"/v1/jobs/{job_id}")
            if body["completedPages"] >= at_least and body["status"] != "completed":
                return body
            if body["status"] == "completed":
                return body
            time.sleep(1)
        raise RuntimeError("no partial progress observed")

    # --- A: SIGKILL one WORKER mid-job -> page requeues, job completes.
    job_a = submit(pdfs[0][1])
    wait_partial(job_a)
    worker_pids = [p["pid"] for p in _proc_scan(("worker.mjs",))]
    os.kill(worker_pids[0], signals.SIGKILL)
    body = wait_done(job_a)
    out["workerCrash"] = {
        "killedWorkerPid": worker_pids[0],
        "pagesOk": sum(1 for p in body["pages"] if p.get("ok")),
        "pagesFailed": sum(1 for p in body["pages"] if not p.get("ok")),
        "maxAttempts": max(p.get("attempts", 1) for p in body["pages"]),
        "failedClasses": sorted({p["failure"].get("errorClass") for p in body["pages"] if not p.get("ok")}),
    }

    # --- B: SIGKILL one PYTHON SIDECAR mid-job -> page fails closed,
    #        adapter respawns, job completes.
    sidecars_before = {p["pid"] for p in _proc_scan(("ppocr_sidecar",))}
    job_b = submit(pdfs[1][1])
    wait_partial(job_b)
    victim = sorted(sidecars_before)[0] if sidecars_before else _proc_scan(("ppocr_sidecar",))[0]["pid"]
    try:
        os.kill(victim, signals.SIGKILL)
    except ProcessLookupError:
        victim = _proc_scan(("ppocr_sidecar",))[0]["pid"]
        os.kill(victim, signals.SIGKILL)
    body = wait_done(job_b)
    sidecars_after = {p["pid"] for p in _proc_scan(("ppocr_sidecar",))}
    out["sidecarCrash"] = {
        "killedSidecarPid": victim,
        "respawned": bool(sidecars_after - sidecars_before),
        "pagesOk": sum(1 for p in body["pages"] if p.get("ok")),
        "pagesFailed": sum(1 for p in body["pages"] if not p.get("ok")),
        "maxAttempts": max(p.get("attempts", 1) for p in body["pages"]),
    }

    # --- C: SIGTERM MID-JOB -> bounded drain, ZERO surviving processes,
    #        then a fresh boot RESUMES the interrupted job to completion.
    job_c = submit(pdfs[2][1])
    wait_partial(job_c)
    out["sigtermDrain"] = _shutdown_and_probe(server)
    server2 = _start_server(port, {"SERVICE_WORKERS": "2", "SERVICE_SIDECAR_THREADS": "1"})
    _wait_health(port, 1500)
    body = wait_done(job_c)
    out["resumeAfterSigterm"] = {
        "status": body["status"],
        "completedPages": body["completedPages"],
        "pageCount": body["pageCount"],
    }
    out["sigtermDrain2"] = _shutdown_and_probe(server2)

    # --- D: corrupt page fails closed, siblings unaffected. The queue's
    #        fail-closed machinery is adapter-independent; exercised here
    #        via the stub adapter's per-page failure hook (STUB_FAIL_PAGE)
    #        because a crafted "corrupt" page is repaired by the viewer
    #        stack (pdf.js/poppler render it) — honest label, see trial doc.
    server3 = _start_server(port, {"SERVICE_WORKERS": "2", "SERVICE_OCR_ADAPTER": "stub-ocr", "STUB_FAIL_PAGE": "2"})
    _wait_health(port, 300)
    job_d = submit(corrupt_pdf)
    body = wait_done(job_d, 300)
    out["corruptPage"] = {
        "adapter": "stub-ocr (queue fail-closed machinery; see trial doc)",
        "pages": [{"pageNumber": p["pageNumber"], "ok": p.get("ok", False), "attempts": p.get("attempts")} for p in body["pages"]],
    }
    out["finalDrain"] = _shutdown_and_probe(server3)
    return out


# ---------------------------------------------------------------------------
# Local entrypoints
# ---------------------------------------------------------------------------

def _load_bench_pages(pages_dir: str) -> list:
    manifest = json.loads((Path(pages_dir) / "manifest.json").read_text())
    return [(entry["page"], (Path(pages_dir) / entry["png"]).read_bytes()) for entry in manifest]


def _load_pdfs(pdfs_dir: str) -> list:
    index = json.loads((Path(pdfs_dir) / "index.json").read_text())
    return [(doc["objectId"], (Path(pdfs_dir) / doc["file"]).read_bytes()) for doc in index["documents"]]


def _write(out: str, payload: dict) -> None:
    path = Path(out)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=1))
    print(f"wrote {path}")


@app.local_entrypoint()
def probe_local():
    print(json.dumps(probe.remote(), indent=1))


@app.local_entrypoint()
def ep_control_local(pages_dir: str, out: str):
    pages = _load_bench_pages(pages_dir)
    print(f"{len(pages)} pages")
    result = ep_control.remote(pages)
    _write(out, result)
    for name, run in result["runs"].items():
        warm = sorted(p["ms"] for p in run["perPage"])
        print(f"{name}: useHpip={run['meta']['useHpip']} init={run['initS']}s p50={warm[len(warm)//2]:.0f}ms")


@app.local_entrypoint()
def throughput_local(pdfs_dir: str, workers: int, threads: int, out: str):
    pdfs = _load_pdfs(pdfs_dir)
    total = sum(1 for _ in pdfs)
    print(f"{total} documents")
    result = throughput.remote(pdfs, workers, threads)
    _write(out, result)
    print(json.dumps({k: result[k] for k in ("packing", "health", "pagesPerSec", "pagesPerSecPerCore", "drain")}, indent=1))


@app.local_entrypoint()
def failure_local(pdfs_dir: str, out: str):
    pdfs = _load_pdfs(pdfs_dir)
    # Three mid-sized documents for the crash probes.
    chosen = sorted(pdfs, key=lambda item: -len(item[1]))[:3]
    corrupt = _minimal_pdf(3)
    result = failure.remote(chosen, corrupt)
    _write(out, result)
    print(json.dumps(result, indent=1)[:2000])


def _minimal_pdf(page_count: int) -> bytes:
    objects = ["<< /Type /Catalog /Pages 2 0 R >>"]
    kids = " ".join(f"{i + 3} 0 R" for i in range(page_count))
    objects.append(f"<< /Type /Pages /Kids [{kids}] /Count {page_count} >>")
    for _ in range(page_count):
        objects.append("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>")
    body = "%PDF-1.4\n"
    offsets = []
    for index, content in enumerate(objects):
        offsets.append(len(body))
        body += f"{index + 1} 0 obj {content} endobj\n"
    xref = len(body)
    body += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n"
    for offset in offsets:
        body += f"{offset:010d} 00000 n \n"
    body += f"trailer << /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n"
    return body.encode()

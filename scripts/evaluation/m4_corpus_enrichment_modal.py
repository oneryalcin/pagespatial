"""M4 real-corpus enrichment run (design doc 2026-08-23, workstream 2).

Same measurement discipline as M1 (`m1_linux_verification_modal.py`): the
Modal image is built FROM THE COMMITTED Dockerfile on Modal's linux/amd64
builder, so the environment under measurement IS the deployment unit.
Corpus pages travel as function arguments; the Gemini key arrives as a
Modal secret (`gemini-api-key`) — never in code, never in logs.

Privacy: the service transmits rendered page images of the private corpus
to the Gemini API (enrichment=batch). Run only with the corpus owner's
explicit authorization.

Task (run from the repo root):

  modal run scripts/evaluation/m4_corpus_enrichment_modal.py::corpus_local \
      --pdfs-dir /abs/.evaluation/m1-subset-pdfs \
      --out /abs/.evaluation/m4/corpus-enrichment.json

Measures, for the trial doc's workstream-2 criteria:
- default-off assertion: a control job submitted WITHOUT the enrichment
  param completes with enrichmentStatus 'disabled' and no enrichment dir;
- cost per enriched page (criterion 2) from the on-disk job manifests;
- /v1/metrics vs manifests reconciliation inputs (criterion 4);
- parse-vs-enrichment wall and CPU split (criterion 5): wall from the
  submit/parse-complete/enrichment-terminal timeline; CPU from
  /proc/<pid>/stat utime+stime (+cutime/cstime for reaped children —
  the server's short-lived pdftoppm 150 dpi render children land there)
  snapshotted at the phase boundaries, plus cgroup cpu.stat where exposed.

The returned payload includes the enrichment records themselves (corpus-
derived) — the caller writes them to gitignored `.evaluation/`; committed
docs carry counts only.
"""

import json
import os
import time
from pathlib import Path

import modal

app = modal.App("pagespatial-m4-corpus-enrichment")

REPO_ROOT = Path(__file__).resolve().parents[2] if modal.is_local() else Path("/app")

image = modal.Image.from_dockerfile(
    REPO_ROOT / "Dockerfile",
    context_dir=REPO_ROOT,
    add_python="3.11",
)

DATA_DIR = "/tmp/psvc-data"


def _http(method: str, port: int, path: str, body: bytes = None, content_type: str = None):
    import urllib.request

    request = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=body, method=method)
    if content_type:
        request.add_header("content-type", content_type)
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.status, json.loads(response.read())


def _wait_health(port: int, deadline_s: float) -> dict:
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


def _proc_cpu_snapshot() -> dict:
    """Cumulative CPU seconds per process class from /proc/<pid>/stat.

    selfS = utime+stime of live processes; childrenS = cutime+cstime
    (REAPED children only — the server's pdftoppm renders land here
    promptly; its long-lived workers do not until they exit)."""
    tick = os.sysconf("SC_CLK_TCK")
    classes = {"server.mjs": "server", "worker.mjs": "worker", "ppocr_sidecar": "sidecar"}
    out = {name: {"selfS": 0.0, "childrenS": 0.0, "n": 0} for name in classes.values()}
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            cmdline = (entry / "cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")
            stat = (entry / "stat").read_text()
        except OSError:
            continue
        for needle, name in classes.items():
            if needle not in cmdline:
                continue
            rest = stat.rsplit(")", 1)[1].split()
            utime, stime, cutime, cstime = (int(rest[i]) for i in (11, 12, 13, 14))
            out[name]["selfS"] += (utime + stime) / tick
            out[name]["childrenS"] += (cutime + cstime) / tick
            out[name]["n"] += 1
            break
    for path in ("/sys/fs/cgroup/cpu.stat",):
        try:
            for line in Path(path).read_text().splitlines():
                key, _, value = line.partition(" ")
                if key == "usage_usec":
                    out["cgroupUsageS"] = int(value) / 1e6
        except OSError:
            pass
    for name in list(out):
        if isinstance(out[name], dict):
            out[name] = {k: (round(v, 2) if isinstance(v, float) else v) for k, v in out[name].items()}
    return out


def _job_state(port: int, job_id: str) -> dict:
    _, body = _http("GET", port, f"/v1/jobs/{job_id}")
    return body


def _manifests() -> dict:
    out = {}
    for job_dir in Path(DATA_DIR).iterdir():
        manifest = job_dir / "enrichment" / "manifest.json"
        if manifest.is_file():
            out[job_dir.name] = json.loads(manifest.read_text())
    return out


@app.function(image=image, cpu=4.0, memory=24576, timeout=4 * 3600,
              secrets=[modal.Secret.from_name("gemini-api-key")])
def corpus_enrichment(pdfs: list, workers: int, threads: int, deadline_s: int) -> dict:
    import subprocess

    assert os.environ.get("GEMINI_API_KEY"), "gemini-api-key secret did not inject GEMINI_API_KEY"
    port = 8571
    env = {**os.environ, "PORT": str(port), "SERVICE_DATA_DIR": DATA_DIR,
           "SERVICE_WORKERS": str(workers), "SERVICE_SIDECAR_THREADS": str(threads)}
    server = subprocess.Popen(["node", "service/server.mjs"], cwd="/app", env=env,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    # containerVCpu: name kept for artifact comparability; the value is
    # Modal cpu=4.0 = 4 PHYSICAL cores (unit correction 2026-08-23).
    result = {"packing": {"containerVCpu": 4, "workers": workers, "threadsPerSidecar": threads,
                          "osCpuCount": os.cpu_count()}}
    result["health"] = {k: _wait_health(port, 1500)[k] for k in ("readyAfterS", "saw503BeforeReady")}

    # --- Default-off control: NO enrichment param on the submission.
    name0, pdf0 = pdfs[0]
    status, body = _http("POST", port, "/v1/jobs", pdf0, "application/pdf")
    assert status == 202, (status, body)
    control_id = body["jobId"]
    while _job_state(port, control_id)["status"] != "completed":
        time.sleep(5)
    control = _job_state(port, control_id)
    result["controlDefaultOff"] = {
        "doc": name0,
        "enrichmentStatus": control.get("enrichmentStatus"),
        "pagesCarryEnrichmentState": any("enrichmentState" in p for p in control["pages"]),
        "enrichmentDirExists": (Path(DATA_DIR) / control_id / "enrichment").exists(),
        "pagesOk": sum(1 for p in control["pages"] if p.get("ok")),
    }

    # --- The corpus run: every document with enrichment=batch.
    timeline = {"t0": time.time()}
    cpu = {"t0": _proc_cpu_snapshot()}
    jobs = []
    t0 = time.monotonic()
    for name, pdf_bytes in pdfs:
        status, body = _http("POST", port, "/v1/jobs?enrichment=batch", pdf_bytes, "application/pdf")
        assert status == 202, (status, body)
        jobs.append({"name": name, "jobId": body["jobId"], "pageCount": body["pageCount"],
                     "sha256": body["sha256"]})
    terminal = {"complete", "partial", "unavailable", "disabled"}
    parse_done_at = {}
    enrich_done_at = {}
    parse_all_marked = False
    while time.monotonic() - t0 < deadline_s:
        for job in jobs:
            if job["jobId"] in enrich_done_at:
                continue
            state = _job_state(port, job["jobId"])
            job["status"] = state["status"]
            job["enrichmentStatus"] = state.get("enrichmentStatus")
            if state["status"] == "completed" and job["jobId"] not in parse_done_at:
                parse_done_at[job["jobId"]] = round(time.monotonic() - t0, 1)
            if state["status"] == "completed" and state.get("enrichmentStatus") in terminal:
                enrich_done_at[job["jobId"]] = round(time.monotonic() - t0, 1)
        if not parse_all_marked and len(parse_done_at) == len(jobs):
            parse_all_marked = True
            timeline["parseAllCompletedS"] = round(time.monotonic() - t0, 1)
            cpu["parseAllCompleted"] = _proc_cpu_snapshot()
        if len(enrich_done_at) == len(jobs):
            break
        time.sleep(10)
    timeline["enrichAllTerminalS"] = round(time.monotonic() - t0, 1) if len(enrich_done_at) == len(jobs) else None
    timeline["parseDoneAtS"] = parse_done_at
    timeline["enrichDoneAtS"] = enrich_done_at
    cpu["enrichAllTerminal"] = _proc_cpu_snapshot()

    # --- Evidence for reconciliation: metrics, manifests, records.
    _, metrics = _http("GET", port, "/v1/metrics")
    manifests = _manifests()
    records = {}
    for job in jobs:
        job_records = {}
        enrichment_dir = Path(DATA_DIR) / job["jobId"] / "enrichment"
        if enrichment_dir.is_dir():
            for record_file in sorted(enrichment_dir.glob("*.json")):
                if record_file.name == "manifest.json":
                    continue
                job_records[record_file.stem] = json.loads(record_file.read_text())
        records[job["name"]] = job_records
    # Final job states (page-level enrichment states, count-level).
    final_states = {}
    for job in jobs:
        state = _job_state(port, job["jobId"])
        counts = {}
        for page in state["pages"]:
            key = page.get("enrichmentState", "absent")
            counts[key] = counts.get(key, 0) + 1
        final_states[job["name"]] = {
            "status": state["status"],
            "enrichmentStatus": state.get("enrichmentStatus"),
            "enrichmentReason": state.get("enrichmentReason"),
            "pagesOk": sum(1 for p in state["pages"] if p.get("ok")),
            "pageEnrichmentStates": counts,
        }

    # --- Drain (same contract M1 verified; keep the probe).
    import signal as signals

    server.send_signal(signals.SIGTERM)
    try:
        server.wait(timeout=60)
        drained = {"exited": True, "exitCode": server.returncode}
    except Exception:
        drained = {"exited": False}

    result.update({
        "timeline": timeline,
        "cpu": cpu,
        "jobs": [{k: job.get(k) for k in ("name", "jobId", "pageCount", "sha256", "status", "enrichmentStatus")} for job in jobs],
        "finalStates": final_states,
        "metrics": metrics,
        "manifestsByJobDir": manifests,
        "recordsByDoc": records,
        "drain": drained,
    })
    return result


@app.local_entrypoint()
def corpus_local(pdfs_dir: str, out: str, workers: int = 4, threads: int = 1, deadline_s: int = 10800):
    index = json.loads((Path(pdfs_dir) / "index.json").read_text())
    pdfs = [(doc["objectId"], (Path(pdfs_dir) / doc["file"]).read_bytes()) for doc in index["documents"]]
    # Smallest document first: it doubles as the default-off control job.
    pdfs.sort(key=lambda item: len(item[1]))
    print(f"{len(pdfs)} documents, control={pdfs[0][0]}")
    result = corpus_enrichment.remote(pdfs, workers, threads, deadline_s)
    path = Path(out)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(result, indent=1))
    print(f"wrote {path}")
    spend = {"promptTokens": 0, "outputTokens": 0, "estimatedCostUsd": 0.0, "complete": 0}
    for manifest in result["manifestsByJobDir"].values():
        spend["promptTokens"] += manifest["spend"]["promptTokens"]
        spend["outputTokens"] += manifest["spend"]["outputTokens"]
        spend["estimatedCostUsd"] = round(spend["estimatedCostUsd"] + manifest["spend"]["estimatedCostUsd"], 6)
        spend["complete"] += sum(1 for e in manifest["pages"].values() if e["state"] == "complete")
    print(json.dumps({"control": result["controlDefaultOff"], "timeline": result["timeline"],
                      "spend": spend,
                      "costPerEnrichedPage": round(spend["estimatedCostUsd"] / spend["complete"], 6) if spend["complete"] else None},
                     indent=1))

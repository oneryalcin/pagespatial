"""M3 qualification harness (design doc §14.2/§12): spawn manifest calls
against a deployed arm app, capture per-call results with the MANDATORY
spawn/receipt wall clocks, snapshot `modal container list` during the run,
and dump per-container logs afterwards — everything the reconciler
(scripts/evaluation/reconcile-modal-run.mjs) and comparator
(scripts/evaluation/compare-modal-runs.mjs) need.

Corpus PDFs come from the LOCAL subset directory and never enter git; all
outputs land under the gitignored .evaluation/ tree.

Usage (repo root):

  python3 scripts/evaluation/m3_qualification_modal.py submit \
    --app pagespatial-parse-arm3-dev \
    --set scaling \
    --pdf-root /abs/.evaluation/m1-subset-pdfs \
    --out-dir /abs/.evaluation/modal-qualification/<run>/arm3 \
    [--ids id1,id2,...] [--duplicate] [--inject mode=request_id ...] \
    [--no-logs]

  python3 scripts/evaluation/m3_qualification_modal.py probe \
    --app pagespatial-parse-arm8-dev --which scratch --out probe.json

Capture wrapper schema (per deploy/modal/README.md): one JSONL line per
awaited FunctionCall: {"request_id", "kind": "result"|"exception",
"result"?|"error"?, "spawned_at_ms", "result_at_ms", "function_call_id"}.
"""

import argparse
import hashlib
import json
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import modal

SCHEMA_VERSION = "0.6.0"
CONTAINER_POLL_S = 20


def now_ms() -> int:
    return int(time.time() * 1000)


def load_manifest(repo_root: Path, which: str) -> list:
    manifest = json.loads(
        (repo_root / "evaluation" / "modal-qualification" / "manifest.v1.json").read_text())
    if which == "correctness":
        return manifest["correctness"]
    if which == "scaling":
        return manifest["scaling"]
    raise SystemExit(f"unknown manifest set {which!r}")


def load_pdfs(pdf_root: Path, entries: list) -> dict:
    """object_id -> bytes, sha-verified against the manifest."""
    index = json.loads((pdf_root / "index.json").read_text())
    file_by_object = {d["objectId"]: d["file"] for d in index["documents"]}
    blobs = {}
    for entry in entries:
        object_id = entry["object_id"]
        if object_id in blobs:
            continue
        data = (pdf_root / file_by_object[object_id]).read_bytes()
        sha = hashlib.sha256(data).hexdigest()
        if sha != entry["sha256"]:
            raise SystemExit(f"LOCAL PDF HASH MISMATCH for {object_id}: manifest {entry['sha256']} vs local {sha}")
        blobs[object_id] = data
    return blobs


class ContainerWatcher(threading.Thread):
    """Snapshot `modal container list --json` during the run; accumulate the
    container ids seen for this app so logs can be dumped afterwards."""

    def __init__(self, app_name: str, out_path: Path):
        super().__init__(daemon=True)
        self.app_name = app_name
        self.out_path = out_path
        self.stop_event = threading.Event()
        self.container_ids: set[str] = set()

    def snapshot(self):
        try:
            raw = subprocess.run(["modal", "container", "list", "--json"],
                                 capture_output=True, text=True, timeout=60).stdout
            rows = json.loads(raw) if raw.strip() else []
        except Exception as error:
            rows = [{"error": str(error)}]
        mine = [row for row in rows if row.get("app_name") == self.app_name]
        for row in mine:
            cid = row.get("container_id")
            if cid:
                self.container_ids.add(cid)
        with self.out_path.open("a") as handle:
            handle.write(json.dumps({"ts": now_ms(), "containers": mine}) + "\n")

    def run(self):
        while not self.stop_event.is_set():
            self.snapshot()
            self.stop_event.wait(CONTAINER_POLL_S)
        self.snapshot()


def dump_container_logs(container_ids, logs_dir: Path):
    logs_dir.mkdir(parents=True, exist_ok=True)
    for cid in sorted(container_ids):
        try:
            # --all: the default fetches only the LAST 100 entries, which
            # loses service_started (cold readiness lives ONLY in logs).
            out = subprocess.run(["modal", "container", "logs", "--all", "--timestamps", cid],
                                 capture_output=True, text=True, timeout=300)
            (logs_dir / f"{cid}.log").write_text(out.stdout + (out.stderr or ""))
        except Exception as error:
            (logs_dir / f"{cid}.log.error").write_text(str(error))


def cmd_submit(args):
    repo_root = Path(__file__).resolve().parents[2]
    entries = load_manifest(repo_root, args.set)
    if args.ids:
        wanted = args.ids.split(",")
        by_id = {e["request_id"]: e for e in entries}
        missing = [w for w in wanted if w not in by_id]
        if missing:
            raise SystemExit(f"ids not in manifest set: {missing}")
        entries = [by_id[w] for w in wanted]
    injections = {}
    for spec in args.inject or []:
        mode, _, request_id = spec.partition("=")
        injections[request_id] = mode

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    captures_path = out_dir / "captures.jsonl"
    blobs = load_pdfs(Path(args.pdf_root), entries)

    parser = modal.Cls.from_name(args.app, "ParseContainer")()
    watcher = ContainerWatcher(args.app, out_dir / "container-list.jsonl")
    watcher.start()

    calls = []  # (request_id, entry, spawned_at_ms, handle_or_error)
    submissions = entries if not args.duplicate else [e for e in entries for _ in (0, 1)]
    for entry in submissions:
        payload = {
            "request_id": entry["request_id"],
            "pdf_bytes": blobs[entry["object_id"]],
            "source_uri": f"m3-qualification/{entry['object_id']}",
            "expected_sha256": entry["sha256"],
            "schema_version": SCHEMA_VERSION,
            "enrichment": "off",
        }
        if entry["request_id"] in injections:
            payload["test_failure"] = injections[entry["request_id"]]
        spawned_at = now_ms()
        handle = parser.parse_document.spawn(payload)
        calls.append((entry["request_id"], spawned_at, handle))
        print(f"spawned {entry['request_id']} -> {handle.object_id}", flush=True)

    lock = threading.Lock()

    def await_one(call):
        request_id, spawned_at, handle = call
        try:
            result = handle.get()
            wrapper = {"request_id": request_id, "kind": "result", "result": result}
        except Exception as error:
            wrapper = {"request_id": request_id, "kind": "exception",
                       "error": f"{type(error).__name__}: {error}"}
        wrapper["spawned_at_ms"] = spawned_at
        wrapper["result_at_ms"] = now_ms()
        wrapper["function_call_id"] = handle.object_id
        with lock:
            with captures_path.open("a") as out:
                out.write(json.dumps(wrapper) + "\n")
        status = wrapper.get("result", {}).get("status") if wrapper["kind"] == "result" else "exception"
        print(f"terminal {request_id}: {status} "
              f"({(wrapper['result_at_ms'] - spawned_at) / 1000:.1f}s)", flush=True)
        return wrapper

    with ThreadPoolExecutor(max_workers=max(8, len(calls))) as pool:
        outcomes = list(pool.map(await_one, calls))

    watcher.stop_event.set()
    watcher.join(timeout=90)
    if not args.no_logs:
        dump_container_logs(watcher.container_ids, out_dir / "logs")
    summary = {
        "app": args.app,
        "set": args.set,
        "calls": len(calls),
        "results": sum(1 for o in outcomes if o["kind"] == "result"),
        "exceptions": sum(1 for o in outcomes if o["kind"] == "exception"),
        "containers_seen": sorted(watcher.container_ids),
        "window_ms": {
            "first_spawn": min(c[1] for c in calls),
            "last_result": max(o["result_at_ms"] for o in outcomes),
        },
    }
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=1))
    print(json.dumps(summary, indent=1))


def cmd_probe(args):
    parser = modal.Cls.from_name(args.app, "ParseContainer")()
    method = parser.probe_scratch if args.which == "scratch" else parser.probe_exit_drain
    report = method.remote()
    payload = {"app": args.app, "which": args.which, "ts": now_ms(), "report": report}
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(json.dumps(payload, indent=1))
    print(json.dumps(payload, indent=1))


def main():
    top = argparse.ArgumentParser(description=__doc__)
    sub = top.add_subparsers(dest="command", required=True)

    submit = sub.add_parser("submit")
    submit.add_argument("--app", required=True)
    submit.add_argument("--set", required=True, choices=["correctness", "scaling"])
    submit.add_argument("--pdf-root", required=True)
    submit.add_argument("--out-dir", required=True)
    submit.add_argument("--ids", help="comma-separated request ids (subset of the set)")
    submit.add_argument("--duplicate", action="store_true",
                        help="spawn every selected input twice (arm 6)")
    submit.add_argument("--inject", action="append",
                        help="mode=request_id (dev-gated; e.g. kill-node=m3-scale-004-…)")
    submit.add_argument("--no-logs", action="store_true")
    submit.set_defaults(func=cmd_submit)

    probe = sub.add_parser("probe")
    probe.add_argument("--app", required=True)
    probe.add_argument("--which", required=True, choices=["scratch", "exit_drain"])
    probe.add_argument("--out")
    probe.set_defaults(func=cmd_probe)

    args = top.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""The only approved paid launcher for the bounded A2 E1 experiment.

It reserves fixed worst-case exposure before deploy/image construction,
serializes CPU and GPU arms, gives each arm a unique app identity, and stops
that exact app in every terminal path. E2/E3 are intentionally absent until
E1 correctness and speed gates pass.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import statistics
import subprocess
import sys
import time
import uuid
from pathlib import Path

from gpu_a2_budget import DEFAULT_LEDGER, complete, complete_without_app, reserve


REPO_ROOT = Path(__file__).resolve().parents[2]
WORKLOAD = REPO_ROOT / ".evaluation/gpu-spike/a2-50page-v1.pdf"


def run(command: list[str], *, env: dict[str, str] | None = None) -> None:
    subprocess.run(command, cwd=REPO_ROOT, env=env, check=True)


def app_rows() -> list[dict]:
    result = subprocess.run(
        ["modal", "app", "list", "--json"], cwd=REPO_ROOT,
        check=True, capture_output=True, text=True, timeout=120,
    )
    return json.loads(result.stdout)


def exact_app(name: str) -> dict | None:
    matches = [row for row in app_rows() if row.get("description") == name]
    if len(matches) > 1:
        raise RuntimeError(f"ambiguous Modal app identity for {name!r}: {matches}")
    return matches[0] if matches else None


def stop_exact_app(name: str) -> str:
    row = exact_app(name)
    if row is None:
        raise RuntimeError(f"paid arm created no discoverable app named {name!r}")
    app_id = row["app_id"]
    subprocess.run(
        ["modal", "app", "stop", "--yes", app_id], cwd=REPO_ROOT,
        check=False, capture_output=True, text=True, timeout=180,
    )
    remaining = exact_app(name)
    if remaining is None or (
        remaining.get("state") != "stopped" or str(remaining.get("tasks", "0")) != "0"
    ):
        raise RuntimeError(f"A2 app did not stop cleanly: {remaining}")
    return app_id


def modal_python() -> str:
    modal_bin = Path(shutil.which("modal") or "").resolve()
    candidate = modal_bin.parent / "python"
    if not candidate.exists():
        raise RuntimeError("cannot locate the Python interpreter for the Modal CLI")
    return str(candidate)


def source_revision() -> str:
    dirty = subprocess.run(
        ["git", "status", "--porcelain"], cwd=REPO_ROOT,
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    if dirty:
        raise RuntimeError("paid A2 runs require a clean committed worktree")
    return subprocess.run(
        ["git", "rev-parse", "--short=12", "HEAD"], cwd=REPO_ROOT,
        check=True, capture_output=True, text=True,
    ).stdout.strip()


def image_pin_revision() -> str:
    digest = hashlib.sha256()
    for name in (
        "Dockerfile", "package-lock.json", "service/sidecar/model-pins.json",
        "service/sidecar/fetch_models.py",
    ):
        digest.update(name.encode())
        digest.update((REPO_ROOT / name).read_bytes())
    return digest.hexdigest()[:12]


def new_run_dir(root: Path, before: set[Path]) -> Path:
    created = {path for path in root.glob("*") if path.is_dir()} - before
    if len(created) != 1:
        raise RuntimeError(f"expected one new evidence directory under {root}, found {created}")
    return created.pop()


def run_cpu(ledger: Path, out_dir: Path, revision: str) -> tuple[str, str, Path]:
    reservation = reserve(ledger, "E1-CPU")
    suffix = f"{time.strftime('%Y%m%d%H%M%S', time.gmtime())}-{uuid.uuid4().hex[:6]}"
    app_name = f"pagespatial-gpu-a2-e1-cpu-{suffix}"
    app_id = ""
    evidence_root = out_dir / "cpu"
    before = {path for path in evidence_root.glob("*") if path.is_dir()}
    try:
        env = {
            **os.environ,
            "PAGESPATIAL_MODAL_APP_NAME": app_name,
            "PAGESPATIAL_MAX_CONTAINERS": "1",
        }
        run(["modal", "deploy", "deploy/modal/modal_app.py"], env=env)
        row = exact_app(app_name)
        if row is None or row.get("state") != "deployed":
            raise RuntimeError(f"CPU control deployment identity missing: {row}")
        app_id = row["app_id"]
        run(
            [
                modal_python(), "scripts/evaluation/run_gpu_a2_cpu_control.py",
                "--app", app_name,
                "--expected-app-id", app_id,
                "--expected-adapter-revision", revision,
                "--expected-image-pin-revision", image_pin_revision(),
                "--reservation", reservation["id"],
                "--ledger", str(ledger),
                "--pdf-path", str(WORKLOAD),
                "--out-dir", str(out_dir / "cpu"),
                "--repeats", "4",
            ]
        )
        return reservation["id"], app_id, new_run_dir(evidence_root, before)
    finally:
        row = exact_app(app_name)
        if row is not None:
            app_id = stop_exact_app(app_name)
        if app_id:
            complete(ledger, reservation["id"], app_id)


def run_gpu(ledger: Path, out_dir: Path) -> tuple[str, str, Path]:
    reservation = reserve(ledger, "E1-GPU")
    suffix = f"{time.strftime('%Y%m%d%H%M%S', time.gmtime())}-{uuid.uuid4().hex[:6]}"
    app_name = f"pagespatial-gpu-a2-e1-gpu-{suffix}"
    app_id = ""
    evidence_root = out_dir / "gpu"
    before = {path for path in evidence_root.glob("*") if path.is_dir()}
    try:
        env = {
            **os.environ,
            "PAGESPATIAL_A2_RESERVATION": reservation["id"],
            "PAGESPATIAL_A2_LEDGER": str(ledger),
            "PAGESPATIAL_A2_APP_NAME": app_name,
        }
        run(
            [
                "modal", "run", "scripts/evaluation/gpu_a2_modal.py",
                "--pdf-path", str(WORKLOAD),
                "--out-dir", str(out_dir / "gpu"),
                "--repeats", "4",
            ],
            env=env,
        )
        row = exact_app(app_name)
        if row is None:
            raise RuntimeError("GPU arm app identity was not recorded")
        app_id = row["app_id"]
        return reservation["id"], app_id, new_run_dir(evidence_root, before)
    finally:
        row = exact_app(app_name)
        if row is not None:
            app_id = stop_exact_app(app_name)
        if app_id:
            complete(ledger, reservation["id"], app_id)
        else:
            complete_without_app(
                ledger,
                reservation["id"],
                "Modal launcher failed before a discoverable app was created",
            )


def validate_cpu_evidence(path: Path, revision: str) -> Path:
    run_path = path / "run.json"
    if not run_path.is_file():
        raise RuntimeError(f"reused CPU evidence has no run.json: {path}")
    metadata = json.loads(run_path.read_text())
    if metadata.get("repeats") != 4 or not metadata.get("completedAt"):
        raise RuntimeError("reused CPU evidence is not a completed four-call run")
    warm = metadata.get("summary", {}).get("warmReuse", {})
    if warm.get("coldPattern") != [True, False, False, False]:
        raise RuntimeError("reused CPU evidence has no exact cold/warm proof")
    if len(set(warm.get("containerIds", []))) != 1:
        raise RuntimeError("reused CPU evidence did not use one warm container")
    for repeat in range(1, 5):
        result_path = path / f"cpu-repeat-{repeat}.json"
        result = json.loads(result_path.read_text())
        if (
            result.get("status") != "completed"
            or result.get("page_count") != EXPECTED_PAGES
            or result.get("pages_failed") != 0
            or len(result.get("pages", [])) != EXPECTED_PAGES
            or result.get("adapter_revision") != revision
            or result.get("image_pin_revision") != image_pin_revision()
            or result.get("client", {}).get("repeat") != repeat
        ):
            raise RuntimeError(f"reused CPU evidence failed validation: {result_path}")
    return path


def score_e1(cpu_dir: Path, gpu_dir: Path, out_dir: Path, adjudications: Path | None) -> dict:
    reports = []
    correctness_pass = True
    for repeat in range(1, 5):
        report_path = out_dir / f"correctness-repeat-{repeat}.json"
        command = [
            "node", "scripts/evaluation/score_gpu_a2.mjs",
            "--cpu", str(cpu_dir / f"cpu-repeat-{repeat}.json"),
            "--gpu", str(gpu_dir / f"gpu-repeat-{repeat}.json"),
            "--output", str(report_path),
        ]
        if adjudications is not None:
            command.extend(["--adjudications", str(adjudications)])
        outcome = subprocess.run(command, cwd=REPO_ROOT, check=False)
        report = json.loads(report_path.read_text())
        reports.append(report_path)
        correctness_pass = correctness_pass and outcome.returncode == 0 and report["summary"]["pass"]

    cpu_rates = [
        json.loads((cpu_dir / f"cpu-repeat-{repeat}.json").read_text())["client"]["inclusivePagesPerS"]
        for repeat in range(2, 5)
    ]
    gpu_rates = [
        EXPECTED_PAGES / json.loads(
            (gpu_dir / f"gpu-repeat-{repeat}.json").read_text()
        )["client"]["spawnToResultS"]
        for repeat in range(2, 5)
    ]
    cpu_median = statistics.median(cpu_rates)
    gpu_median = statistics.median(gpu_rates)
    speedup = gpu_median / cpu_median
    decision = {
        "schemaVersion": "pagespatial-gpu-a2-e1-decision-v1",
        "cpuEvidence": str(cpu_dir),
        "gpuEvidence": str(gpu_dir),
        "correctnessReports": [str(path) for path in reports],
        "correctnessPass": correctness_pass,
        "warmCpuMedianPagesPerS": cpu_median,
        "warmGpuMedianPagesPerS": gpu_median,
        "warmSpeedup": speedup,
        "speedGate": {"minimum": 2.0, "pass": speedup >= 2.0},
        "technicalGatePass": correctness_pass and speedup >= 2.0,
        "billingGate": {
            "status": "pending-closed-interval-reconciliation",
            "pass": False,
        },
        "advanceToE2": False,
    }
    (out_dir / "e1-decision.json").write_text(json.dumps(decision, indent=1) + "\n")
    return decision


EXPECTED_PAGES = 50


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ledger", type=Path, default=DEFAULT_LEDGER)
    parser.add_argument(
        "--out-dir", type=Path,
        default=Path(".evaluation/gpu-spike/2026-08-24/a2-e1"),
    )
    parser.add_argument("--adjudications", type=Path)
    parser.add_argument(
        "--cpu-evidence", type=Path,
        help="reuse one completed, current-revision four-call CPU control",
    )
    args = parser.parse_args()
    revision = source_revision()
    if not WORKLOAD.exists():
        raise SystemExit(f"frozen workload missing: {WORKLOAD}")
    args.out_dir.mkdir(parents=True, exist_ok=True)
    if args.cpu_evidence is not None:
        cpu_dir = validate_cpu_evidence(args.cpu_evidence, revision)
        cpu = ("reused", json.loads((cpu_dir / "run.json").read_text())["expectedAppId"], cpu_dir)
    else:
        cpu = run_cpu(args.ledger, args.out_dir, revision)
    gpu = run_gpu(args.ledger, args.out_dir)
    decision = score_e1(cpu[2], gpu[2], args.out_dir, args.adjudications)
    print(json.dumps({
        "cpu": [cpu[0], cpu[1], str(cpu[2])],
        "gpu": [gpu[0], gpu[1], str(gpu[2])],
        "outDir": str(args.out_dir),
        "decision": decision,
    }, indent=1))
    raise SystemExit(
        "E2 remains locked pending correctness, 2x speed, and closed-interval billing gates"
    )


if __name__ == "__main__":
    main()

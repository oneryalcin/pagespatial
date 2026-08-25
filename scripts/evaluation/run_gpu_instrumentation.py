#!/usr/bin/env python3
"""Only approved paid launcher for the GPU instrumentation milestones."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import time
import uuid
from pathlib import Path

from gpu_instrumentation_budget import DEFAULT_LEDGER, complete, reserve


REPO_ROOT = Path(__file__).resolve().parents[2]
M0_SCRIPT = "scripts/evaluation/gpu_instrumentation_modal.py"
M1_SCRIPT = "scripts/evaluation/gpu_a2_modal.py"
M1_WORKLOAD = REPO_ROOT / ".evaluation/gpu-spike/a2-50page-v1.pdf"
M1_NATIVE_EVIDENCE = (
    REPO_ROOT / ".evaluation/gpu-spike/2026-08-24/a3-profile/native-evidence-v1.json"
)


def app_rows() -> list[dict]:
    result = subprocess.run(
        ["modal", "app", "list", "--json"],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
        text=True,
        timeout=120,
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
        raise RuntimeError(f"paid stage created no discoverable app named {name!r}")
    app_id = row["app_id"]
    if row.get("state") != "stopped" or str(row.get("tasks", "0")) != "0":
        subprocess.run(
            ["modal", "app", "stop", "--yes", app_id],
            cwd=REPO_ROOT,
            check=False,
            capture_output=True,
            text=True,
            timeout=180,
        )
    deadline = time.monotonic() + 120
    remaining = exact_app(name)
    while remaining is not None and time.monotonic() < deadline:
        if remaining.get("state") == "stopped" and str(remaining.get("tasks", "0")) == "0":
            break
        time.sleep(2)
        remaining = exact_app(name)
    if remaining is None or remaining.get("state") != "stopped" or str(
        remaining.get("tasks", "0")
    ) != "0":
        raise RuntimeError(f"instrumentation app did not stop cleanly: {remaining}")
    return app_id


def require_clean_revision() -> str:
    dirty = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    if dirty:
        raise RuntimeError("paid instrumentation runs require a clean committed worktree")
    return subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def _new_evidence_dir(root: Path, before: set[Path]) -> Path:
    created = {path for path in root.glob("*") if path.is_dir()} - before
    if len(created) != 1:
        raise RuntimeError(f"expected one new evidence directory, found {created}")
    return created.pop()


def run_m0(ledger: Path, out_dir: Path) -> dict:
    revision = require_clean_revision()
    reservation = reserve(ledger, "M0-CAPABILITY")
    suffix = f"{time.strftime('%Y%m%d%H%M%S', time.gmtime())}-{uuid.uuid4().hex[:6]}"
    app_name = f"pagespatial-gpu-instrumentation-m0-{suffix}"
    app_id: str | None = None
    before = {path for path in out_dir.glob("*") if path.is_dir()}
    error: BaseException | None = None
    try:
        env = {
            **os.environ,
            "PAGESPATIAL_GPU_INSTRUMENTATION_RESERVATION": reservation["id"],
            "PAGESPATIAL_GPU_INSTRUMENTATION_LEDGER": str(ledger),
            "PAGESPATIAL_GPU_INSTRUMENTATION_APP_NAME": app_name,
        }
        subprocess.run(
            [
                "modal",
                "run",
                "--detach",
                M0_SCRIPT,
                "--out-dir",
                str(out_dir),
            ],
            cwd=REPO_ROOT,
            env=env,
            check=True,
        )
        row = exact_app(app_name)
        if row is None:
            raise RuntimeError("M0 app identity was not recorded")
        app_id = row["app_id"]
        evidence_dir = _new_evidence_dir(out_dir, before)
        result_path = evidence_dir / "m0-result.json"
        result = json.loads(result_path.read_text())
        result["launcher"] = {
            "appName": app_name,
            "appId": app_id,
            "reservationId": reservation["id"],
            "gitRevision": revision,
        }
        result_path.write_text(json.dumps(result, indent=1) + "\n")
        return result
    except BaseException as caught:
        error = caught
        raise
    finally:
        row = exact_app(app_name)
        if row is not None:
            app_id = stop_exact_app(app_name)
        complete(
            ledger,
            reservation["id"],
            app_id,
            str(error) if error is not None else "stage completed and exact app stopped",
        )


def run_m1(
    ledger: Path, out_dir: Path, pdf_path: Path, native_evidence_path: Path
) -> dict:
    revision = require_clean_revision()
    if not pdf_path.is_file() or not native_evidence_path.is_file():
        raise RuntimeError("M1 fixed PDF and native-evidence inputs must exist")
    reservation = reserve(ledger, "M1-PARITY")
    suffix = f"{time.strftime('%Y%m%d%H%M%S', time.gmtime())}-{uuid.uuid4().hex[:6]}"
    app_name = f"pagespatial-gpu-instrumentation-m1-{suffix}"
    app_id: str | None = None
    before = {path for path in out_dir.glob("*") if path.is_dir()}
    error: BaseException | None = None
    try:
        env = {
            **os.environ,
            "PAGESPATIAL_GPU_INSTRUMENTATION_RESERVATION": reservation["id"],
            "PAGESPATIAL_GPU_INSTRUMENTATION_LEDGER": str(ledger),
            "PAGESPATIAL_A2_APP_NAME": app_name,
            "PAGESPATIAL_A2_MODEL_TIER": "tiny",
            "PAGESPATIAL_A2_RECOGNITION_BATCH_SIZE": "1",
            "PAGESPATIAL_A2_INFERENCE_OWNERS": "2",
            "PAGESPATIAL_A2_STAGE_PROFILE": "0",
            "PAGESPATIAL_A2_NVTX": "0",
        }
        subprocess.run(
            [
                "modal",
                "run",
                "--detach",
                M1_SCRIPT,
                "--pdf-path",
                str(pdf_path),
                "--native-evidence-path",
                str(native_evidence_path),
                "--out-dir",
                str(out_dir),
                "--repeats",
                "4",
                "--mode",
                "m1-parity",
            ],
            cwd=REPO_ROOT,
            env=env,
            check=True,
        )
        row = exact_app(app_name)
        if row is None:
            raise RuntimeError("M1 app identity was not recorded")
        app_id = row["app_id"]
        evidence_dir = _new_evidence_dir(out_dir, before)
        result_path = evidence_dir / "m1-parity.json"
        result = json.loads(result_path.read_text())
        if result.get("pass") is not True:
            raise RuntimeError(f"M1 parity failed: {result.get('reasons')}")
        result["launcher"] = {
            "appName": app_name,
            "appId": app_id,
            "reservationId": reservation["id"],
            "gitRevision": revision,
        }
        result_path.write_text(json.dumps(result, indent=1) + "\n")
        return result
    except BaseException as caught:
        error = caught
        raise
    finally:
        row = exact_app(app_name)
        if row is not None:
            app_id = stop_exact_app(app_name)
        complete(
            ledger,
            reservation["id"],
            app_id,
            str(error) if error is not None else "stage completed and exact app stopped",
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ledger", type=Path, default=DEFAULT_LEDGER)
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=None,
    )
    parser.add_argument("--pdf-path", type=Path, default=M1_WORKLOAD)
    parser.add_argument(
        "--native-evidence-path", type=Path, default=M1_NATIVE_EVIDENCE
    )
    parser.add_argument("stage", choices=("m0", "m1"))
    args = parser.parse_args()
    if args.out_dir is None:
        args.out_dir = Path(
            f".evaluation/gpu-instrumentation/2026-08-25/{args.stage}"
        )
    args.out_dir.mkdir(parents=True, exist_ok=True)
    if args.stage == "m0":
        result = run_m0(args.ledger, args.out_dir)
        print(json.dumps({"classification": result["classification"]}, indent=1))
        if result["classification"] != "supported":
            raise SystemExit(2)
    else:
        result = run_m1(
            args.ledger, args.out_dir, args.pdf_path, args.native_evidence_path
        )
        print(json.dumps({"pass": result["pass"], "throughput": result["throughput"]}, indent=1))


if __name__ == "__main__":
    main()

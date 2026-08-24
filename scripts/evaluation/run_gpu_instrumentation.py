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


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ledger", type=Path, default=DEFAULT_LEDGER)
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=Path(".evaluation/gpu-instrumentation/2026-08-25/m0"),
    )
    parser.add_argument("stage", choices=("m0",))
    args = parser.parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)
    result = run_m0(args.ledger, args.out_dir)
    print(json.dumps({"classification": result["classification"]}, indent=1))
    if result["classification"] != "supported":
        raise SystemExit(2)


if __name__ == "__main__":
    main()

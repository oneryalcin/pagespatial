#!/usr/bin/env python3
"""Run the bounded M2 Nsight captures inside the pinned profiler image."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


APP = Path("/app")
WORKER = APP / "scripts/evaluation/gpu_a2_trace_worker.py"
PREFLIGHT = APP / "scripts/evaluation/gpu_instrumentation_m2_preflight.py"


def _utc() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _run(command: list[str], timeout: int, cwd: Path = APP) -> dict[str, Any]:
    started = time.monotonic()
    result = subprocess.run(
        command,
        cwd=cwd,
        capture_output=True,
        text=True,
        check=False,
        timeout=timeout,
    )
    return {
        "command": command,
        "returnCode": result.returncode,
        "wallS": time.monotonic() - started,
        "stdout": result.stdout,
        "stderr": result.stderr,
    }


def _sha(path: Path) -> dict[str, Any]:
    data = path.read_bytes()
    return {
        "path": path.name,
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
    }


def _export(report: Path, output: Path) -> dict[str, Any]:
    result = _run(
        [
            "nsys",
            "export",
            "--type=sqlite",
            "--force-overwrite=true",
            f"--output={output}",
            str(report),
        ],
        600,
    )
    if result["returnCode"] != 0 or not output.is_file():
        raise RuntimeError(f"Nsight SQLite export failed: {result}")
    return result


def _stats(report: Path, output: Path, *, cpu_sampling: bool) -> dict[str, Any]:
    reports = (
        "nvtx_sum,osrt_sum"
        if cpu_sampling
        else "nvtx_sum,cuda_api_sum,cuda_gpu_kern_sum,cuda_gpu_mem_time_sum"
    )
    result = _run(
        [
            "nsys",
            "stats",
            f"--report={reports}",
            "--format=csv",
            str(report),
        ],
        600,
    )
    output.write_text(result["stdout"] + "\nSTDERR\n" + result["stderr"])
    if result["returnCode"] != 0:
        raise RuntimeError(f"required Nsight reports failed: {result}")
    return result


def _profile(
    *,
    output_dir: Path,
    name: str,
    capture_name: str,
    repeat: int,
    mode: str,
    requests: Path,
    cpu_sampling: bool,
) -> dict[str, Any]:
    report_base = output_dir / name
    report = report_base.with_suffix(".nsys-rep")
    sqlite_path = report_base.with_suffix(".sqlite")
    result_path = output_dir / f"{name}-results.json"
    command = [
        "nsys",
        "profile",
        "--trace=nvtx,osrt" if cpu_sampling else "--trace=cuda,nvtx,osrt",
        "--sample=process-tree" if cpu_sampling else "--sample=none",
        "--cpuctxsw=process-tree" if cpu_sampling else "--cpuctxsw=none",
    ]
    if cpu_sampling:
        command.append("--backtrace=dwarf")
    else:
        command.append("--cuda-event-trace=false")
    command.extend(
        [
            "--capture-range=nvtx",
            f"--nvtx-capture={capture_name}@pagespatial.ocr",
            f"--capture-range-end=repeat:{repeat}:defer",
            "--force-overwrite=true",
            f"--output={report_base}",
            "python",
            str(WORKER),
            "--mode",
            mode,
            "--requests",
            str(requests),
            "--output",
            str(result_path),
        ]
    )
    profile = _run(command, 3600)
    if profile["returnCode"] != 0:
        raise RuntimeError(f"Nsight profile exited nonzero: {profile}")
    if not report.is_file():
        raise RuntimeError(f"Nsight profile produced no report: {profile}")
    if not result_path.is_file():
        raise RuntimeError(f"trace worker produced no result: {profile}")
    export = _export(report, sqlite_path)
    stats_path = output_dir / f"{name}-stats.csv"
    stats = _stats(report, stats_path, cpu_sampling=cpu_sampling)
    return {
        "profile": profile,
        "export": export,
        "stats": stats,
        "artifacts": [
            _sha(report),
            _sha(sqlite_path),
            _sha(result_path),
            _sha(stats_path),
        ],
    }


def _registered_range_count(sqlite_path: Path, name: str) -> int:
    with sqlite3.connect(sqlite_path) as connection:
        tables = {
            row[0]
            for row in connection.execute(
                "select name from sqlite_master where type='table'"
            )
        }
        if not {"NVTX_EVENTS", "StringIds"}.issubset(tables):
            raise RuntimeError("preflight SQLite lacks NVTX identity tables")
        return int(
            connection.execute(
                """
                select count(*)
                from NVTX_EVENTS n
                left join StringIds s on s.id = n.textId
                where coalesce(n.text, s.value) = ? and n.end is not null
                """,
                (name,),
            ).fetchone()[0]
        )


def _preflight(output_dir: Path) -> dict[str, Any]:
    report_base = output_dir / "m2-preflight"
    report = report_base.with_suffix(".nsys-rep")
    sqlite_path = report_base.with_suffix(".sqlite")
    profile = _run(
        [
            "nsys",
            "profile",
            "--trace=cuda,nvtx,osrt",
            "--sample=none",
            "--cpuctxsw=none",
            "--capture-range=nvtx",
            "--nvtx-capture=m2.preflight@pagespatial.ocr",
            "--capture-range-end=repeat:2:defer",
            "--force-overwrite=true",
            f"--output={report_base}",
            "python",
            str(PREFLIGHT),
        ],
        600,
    )
    if profile["returnCode"] != 0:
        raise RuntimeError(f"two-range preflight exited nonzero: {profile}")
    if not report.is_file():
        raise RuntimeError(f"two-range preflight produced no report: {profile}")
    export = _export(report, sqlite_path)
    count = _registered_range_count(sqlite_path, "m2.preflight")
    if count != 2:
        raise RuntimeError(f"two-range preflight retained {count} ranges, expected 2")
    return {
        "profile": profile,
        "export": export,
        "retainedRanges": count,
        "artifacts": [_sha(report), _sha(sqlite_path)],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--requests", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    started = _utc()
    identity = {
        "startedAtUtc": started,
        "pid": os.getpid(),
        "nsysVersion": _run(["nsys", "--version"], 30),
        "nsysStatus": _run(["nsys", "status", "-e"], 60),
        "nvidiaSmi": _run(
            [
                "nvidia-smi",
                "--query-gpu=uuid,name,driver_version,memory.total",
                "--format=csv,noheader",
            ],
            30,
        ),
        "environment": {
            key: os.environ.get(key)
            for key in (
                "PAGESPATIAL_A2_MODEL_TIER",
                "PAGESPATIAL_A2_RECOGNITION_BATCH_SIZE",
                "PAGESPATIAL_A2_INFERENCE_OWNERS",
                "PAGESPATIAL_A2_STAGE_PROFILE",
                "PAGESPATIAL_A2_NVTX",
            )
        },
    }
    result: dict[str, Any] = {
        "schemaVersion": "pagespatial-gpu-instrumentation-m2-container-run-v1",
        "identity": identity,
        "preflight": None,
        "systems": None,
        "cpu": None,
        "status": "running",
    }
    run_record = args.output_dir / "m2-container-run.json"
    try:
        result["preflight"] = _preflight(args.output_dir)
        result["systems"] = _profile(
            output_dir=args.output_dir,
            name="m2-systems",
            capture_name="m2.capture",
            repeat=2,
            mode="m2-systems",
            requests=args.requests,
            cpu_sampling=False,
        )
        result["cpu"] = _profile(
            output_dir=args.output_dir,
            name="m2-cpu",
            capture_name="m2.cpu.capture",
            repeat=1,
            mode="m2-cpu",
            requests=args.requests,
            cpu_sampling=True,
        )
        result["status"] = "completed"
    except BaseException as error:
        result["status"] = "failed"
        result["error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        result["endedAtUtc"] = _utc()
        run_record.write_text(json.dumps(result, indent=1) + "\n")


if __name__ == "__main__":
    main()

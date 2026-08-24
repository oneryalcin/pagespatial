#!/usr/bin/env python3
"""M0 Modal capability probe for PageSpatial GPU instrumentation."""

from __future__ import annotations

import hashlib
import json
import os
import platform
import sqlite3
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any

import modal


if modal.is_local():
    from gpu_instrumentation_budget import DEFAULT_LEDGER, validate_reservation

    _reservation_id = os.environ.get("PAGESPATIAL_GPU_INSTRUMENTATION_RESERVATION", "")
    _ledger_path = Path(
        os.environ.get(
            "PAGESPATIAL_GPU_INSTRUMENTATION_LEDGER", str(DEFAULT_LEDGER)
        )
    )
    if not _reservation_id:
        raise RuntimeError(
            "PAGESPATIAL_GPU_INSTRUMENTATION_RESERVATION is required before image construction"
        )
    validate_reservation(_ledger_path, _reservation_id, "M0-CAPABILITY")

from gpu_spike_trt_modal import trt_image


APP_NAME = os.environ.get(
    "PAGESPATIAL_GPU_INSTRUMENTATION_APP_NAME",
    "pagespatial-gpu-instrumentation-m0",
)
if modal.is_local() and not APP_NAME.startswith("pagespatial-gpu-instrumentation-"):
    raise RuntimeError("instrumentation app name has the wrong prefix")

REPO_ROOT = Path(__file__).resolve().parents[2] if modal.is_local() else Path("/app")
PROBE_CHILD = REPO_ROOT / "scripts/evaluation/gpu_instrumentation_probe_child.py"
NSYS_VERSION = "2025.5.1.121-255136380782v0"
NSYS_DEB = "NsightSystems-linux-cli-public-2025.5.1.121-3638078.deb"
NSYS_DEB_SHA256 = "506a8a3fdd94cec84c4c216d159ce3a6496170e8cf22b95b603b4bef4e0fb6e2"
NSYS_URL = f"https://developer.download.nvidia.com/devtools/repos/ubuntu2004/amd64/{NSYS_DEB}"
NVTX_VERSION = "0.2.16"
NVTX_CP310_X86_64_WHEEL_SHA256 = (
    "23f30fcaf68f53d1895282315cb35aed5f605d59aeb33e75e276545ff95c4af6"
)


def _install_nsys_command() -> str:
    return (
        "set -eu; "
        f"curl -fsSLo /tmp/{NSYS_DEB} {NSYS_URL}; "
        f"echo '{NSYS_DEB_SHA256}  /tmp/{NSYS_DEB}' | sha256sum -c -; "
        f"dpkg -i /tmp/{NSYS_DEB}; "
        f"rm /tmp/{NSYS_DEB}; "
        "nsys --version"
    )


if modal.is_local():
    instrumentation_image = (
        trt_image
        .apt_install("curl")
        .uv_pip_install(f"nvtx=={NVTX_VERSION}")
        .run_commands(_install_nsys_command())
        .add_local_file(str(PROBE_CHILD), "/app/gpu_instrumentation_probe_child.py", copy=True)
    )
else:
    instrumentation_image = modal.Image.debian_slim(python_version="3.10")


app = modal.App(APP_NAME)


def _run(command: list[str], timeout: int = 120) -> dict[str, Any]:
    started = time.monotonic()
    result = subprocess.run(
        command,
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


def _file_record(path: Path) -> dict[str, Any]:
    data = path.read_bytes()
    return {
        "name": path.name,
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "data": data,
    }


def _sqlite_counts(path: Path) -> dict[str, int]:
    with sqlite3.connect(path) as connection:
        table_names = [
            row[0]
            for row in connection.execute(
                "select name from sqlite_master where type='table' order by name"
            )
        ]
        counts = {}
        for name in table_names:
            quoted = '"' + name.replace('"', '""') + '"'
            counts[name] = int(
                connection.execute(f"select count(*) from {quoted}").fetchone()[0]
            )
        return counts


def _sum_matching(counts: dict[str, int], *tokens: str) -> int:
    return sum(
        count
        for name, count in counts.items()
        if not name.upper().startswith("ENUM_")
        and all(token in name.upper() for token in tokens)
    )


def _platform_denial(text: str) -> bool:
    lowered = text.lower()
    markers = (
        "profiling is not supported",
        "permission denied",
        "cupti initialization failed",
        "failed to initialize cupti",
        "perf_event_open failed",
        "operation not permitted",
    )
    return any(marker in lowered for marker in markers)


@app.function(
    image=instrumentation_image,
    gpu="L4",
    cpu=4.0,
    memory=24576,
    timeout=600,
    startup_timeout=1800,
    retries=0,
)
def probe_capabilities(run_id: str) -> dict[str, Any]:
    scratch = Path("/tmp") / f"pagespatial-instrumentation-{run_id}"
    scratch.mkdir(parents=True, exist_ok=False)
    report_base = scratch / "m0-capability"
    report_path = report_base.with_suffix(".nsys-rep")
    sqlite_path = report_base.with_suffix(".sqlite")

    identity = {
        "platform": platform.platform(),
        "python": platform.python_version(),
        "pid": os.getpid(),
        "nsysPackageVersion": NSYS_VERSION,
        "nsysDebSha256": NSYS_DEB_SHA256,
        "nvtxVersion": NVTX_VERSION,
        "nvtxWheelSha256": NVTX_CP310_X86_64_WHEEL_SHA256,
        "nsysVersion": _run(["nsys", "--version"], timeout=30),
        "nvidiaSmi": _run(
            [
                "nvidia-smi",
                "--query-gpu=uuid,name,driver_version,memory.total",
                "--format=csv,noheader",
            ],
            timeout=30,
        ),
        "paddle": _run(
            [
                "python",
                "-c",
                (
                    "import json,paddle; print(json.dumps({"
                    "'version':paddle.__version__,'cuda':paddle.version.cuda(),"
                    "'cudnn':paddle.version.cudnn()}))"
                ),
            ],
            timeout=30,
        ),
        "nsysStatus": _run(["nsys", "status", "-e"], timeout=60),
    }

    profile = _run(
        [
            "nsys",
            "profile",
            "--trace=cuda,nvtx,osrt",
            # `nsys status -e` is the capability truth for host sampling. Do
            # not request perf sampling after that probe reports that gVisor
            # rejects perf_event_open; doing so crashed nsys 2025.5 with 139
            # before CUPTI could produce the independent CUDA trace.
            "--sample=none",
            "--cpuctxsw=none",
            "--cuda-event-trace=false",
            "--force-overwrite=true",
            f"--output={report_base}",
            "python",
            "/app/gpu_instrumentation_probe_child.py",
        ],
        timeout=240,
    )
    combined_output = profile["stdout"] + "\n" + profile["stderr"]
    result: dict[str, Any] = {
        "schemaVersion": "pagespatial-gpu-instrumentation-m0-v1",
        "runId": run_id,
        "identity": identity,
        "profile": profile,
        "classification": "harness-error",
        "capabilities": {
            "nvtx": False,
            "cudaApi": False,
            "cudaKernel": False,
            "cudaMemory": False,
            "cpuSampling": False,
            "cpuContextSwitch": False,
            "reportExport": False,
        },
        "tableCounts": {},
        "artifacts": {},
        "limitations": [],
    }

    if not report_path.is_file():
        if _platform_denial(combined_output):
            result["classification"] = "platform-denied"
        result["limitations"].append("Nsight Systems profile did not produce a report")
        return result
    if profile["returnCode"] != 0:
        result["limitations"].append(
            f"nsys profile exited {profile['returnCode']} after generating the retained report"
        )

    export = _run(
        [
            "nsys",
            "export",
            "--type=sqlite",
            "--force-overwrite=true",
            f"--output={sqlite_path}",
            str(report_path),
        ],
        timeout=240,
    )
    result["export"] = export
    if not sqlite_path.is_file():
        if _platform_denial(export["stdout"] + "\n" + export["stderr"]):
            result["classification"] = "platform-denied"
        result["limitations"].append("Nsight Systems SQLite export failed")
        result["artifacts"][report_path.name] = _file_record(report_path)
        return result
    if export["returnCode"] != 0:
        result["limitations"].append(
            f"nsys export exited {export['returnCode']} after generating the retained SQLite file"
        )

    counts = _sqlite_counts(sqlite_path)
    nvtx_count = _sum_matching(counts, "NVTX")
    cuda_api_count = _sum_matching(counts, "CUPTI", "RUNTIME")
    kernel_count = _sum_matching(counts, "CUPTI", "KERNEL")
    memory_count = _sum_matching(counts, "CUPTI", "MEM")
    sampling_count = _sum_matching(counts, "SAMPL")
    schedule_count = _sum_matching(counts, "SCHED")
    capabilities = {
        "nvtx": nvtx_count > 0,
        "cudaApi": cuda_api_count > 0,
        "cudaKernel": kernel_count > 0,
        "cudaMemory": memory_count > 0,
        "cpuSampling": sampling_count > 0,
        "cpuContextSwitch": schedule_count > 0,
        "reportExport": True,
    }
    required = (
        capabilities["nvtx"]
        and capabilities["cudaApi"]
        and capabilities["cudaKernel"]
        and capabilities["cudaMemory"]
        and capabilities["reportExport"]
    )
    result.update(
        {
            "classification": "supported" if required else "unsupported-events",
            "capabilities": capabilities,
            "tableCounts": counts,
            "artifacts": {
                report_path.name: _file_record(report_path),
                sqlite_path.name: _file_record(sqlite_path),
            },
            "artifactValidation": {
                "profileExitCode": profile["returnCode"],
                "exportExitCode": export["returnCode"],
                "reportExists": True,
                "sqliteExists": True,
                "requiredEventCountsPass": required,
            },
        }
    )
    status_text = identity["nsysStatus"]["stdout"] + identity["nsysStatus"]["stderr"]
    if "CPU Profiling Environment (process-tree): Fail" in status_text:
        result["limitations"].append(
            "Modal gVisor denies perf_event_open; native CPU sampling is unsupported"
        )
    elif not capabilities["cpuSampling"]:
        result["limitations"].append("CPU samples were not observed in the M0 trace")
    if not capabilities["cpuContextSwitch"]:
        result["limitations"].append(
            "CPU scheduling events were not requested after the CPU environment probe failed"
        )
    return result


@app.local_entrypoint()
def main(out_dir: str) -> None:
    repo_root = Path(__file__).resolve().parents[2]
    dirty = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=repo_root,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    if dirty:
        raise RuntimeError("paid instrumentation runs require a clean committed worktree")
    revision = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=repo_root,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    run_id = f"{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}-{uuid.uuid4().hex[:8]}"
    target = Path(out_dir) / run_id
    target.mkdir(parents=True, exist_ok=False)
    result = probe_capabilities.remote(run_id)
    result["source"] = {"gitRevision": revision, "dirty": False}
    result["reservationId"] = _reservation_id
    artifacts = result.pop("artifacts", {})
    manifest = {}
    for name, record in artifacts.items():
        data = record.pop("data")
        path = target / name
        path.write_bytes(data)
        manifest[name] = {**record, "path": str(path)}
    result["artifacts"] = manifest
    result["completedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    output = target / "m0-result.json"
    output.write_text(json.dumps(result, indent=1) + "\n")
    print(json.dumps({"result": str(output), "classification": result["classification"]}))

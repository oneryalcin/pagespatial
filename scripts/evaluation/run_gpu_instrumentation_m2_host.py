#!/usr/bin/env python3
"""Build and run M2 on the dedicated experiment-owned GCP L4 VM."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import socket
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


EXPECTED_INSTANCE = "pagespatial-gpu-profiler-20260825"
IMAGE_REPOSITORY = "pagespatial-gpu-instrumentation-m2"
CONTAINER_NAME = "pagespatial-gpu-instrumentation-m2"
MIN_FREE_BYTES = 28 * 1024**3
MAX_EVIDENCE_BYTES = 12 * 1024**3


def _utc() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _run(command: list[str], timeout: int, check: bool = True) -> dict[str, Any]:
    started = time.monotonic()
    result = subprocess.run(
        command,
        capture_output=True,
        text=True,
        check=False,
        timeout=timeout,
    )
    record = {
        "command": command,
        "returnCode": result.returncode,
        "wallS": time.monotonic() - started,
        "stdout": result.stdout,
        "stderr": result.stderr,
    }
    if check and result.returncode != 0:
        raise RuntimeError(f"command failed: {record}")
    return record


def _sha(path: Path, root: Path) -> dict[str, Any]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            size += len(chunk)
            digest.update(chunk)
    return {"path": str(path.relative_to(root)), "bytes": size, "sha256": digest.hexdigest()}


def _write_requests(input_dir: Path, output: Path) -> None:
    pdf = input_dir / "a2-50page-v1.pdf"
    native = input_dir / "native-evidence-v1.json"
    expected = {
        "a2-50page-v1.pdf": "46ba5fc15613a260cf019ff6f9be0bb579279be4f5892694a76e02a536d8fcda",
    }
    if not pdf.is_file() or not native.is_file():
        raise RuntimeError("M2 private PDF or native evidence is missing")
    pdf_sha = hashlib.sha256(pdf.read_bytes()).hexdigest()
    if pdf_sha != expected[pdf.name]:
        raise RuntimeError("M2 PDF identity mismatch")
    native_sha = hashlib.sha256(native.read_bytes()).hexdigest()
    run_prefix = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    labels = ("warmup", "control-before", "trace", "control-after")
    rows = [
        {
            "label": label,
            "run_id": f"{run_prefix}-m2-{index}-{label}",
            "pdf_path": "/inputs/a2-50page-v1.pdf",
            "native_evidence_path": "/inputs/native-evidence-v1.json",
            "native_evidence_sha256": native_sha,
            "expected_sha256": pdf_sha,
            "expected_pages": 50,
        }
        for index, label in enumerate(labels, start=1)
    ]
    output.write_text(json.dumps(rows, indent=1) + "\n")


def _assert_host() -> dict[str, Any]:
    hostname = socket.gethostname()
    if hostname != EXPECTED_INSTANCE:
        raise RuntimeError(f"refusing non-experiment host: {hostname!r}")
    disk = shutil.disk_usage("/")
    if disk.free < MIN_FREE_BYTES:
        raise RuntimeError(
            f"host has {disk.free} free bytes; profiling requires {MIN_FREE_BYTES}"
        )
    return {
        "hostname": hostname,
        "disk": {"total": disk.total, "used": disk.used, "free": disk.free},
        "cpuCountLogical": os.cpu_count(),
        "uname": _run(["uname", "-a"], 30),
        "docker": _run(["docker", "version"], 60),
        "nvidiaSmi": _run(
            [
                "nvidia-smi",
                "--query-gpu=uuid,name,driver_version,memory.total",
                "--format=csv,noheader",
            ],
            30,
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--input-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--m3-native", action="store_true")
    args = parser.parse_args()
    milestone = "m3" if args.m3_native else "m2"
    repo = args.repo_root.resolve()
    inputs = args.input_dir.resolve()
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=False)
    manifest: dict[str, Any] = {
        "schemaVersion": f"pagespatial-gpu-instrumentation-{milestone}-host-run-v1",
        "startedAtUtc": _utc(),
        "revision": args.revision,
        "status": "running",
        "host": _assert_host(),
        "commands": [],
    }
    manifest_path = output / f"{milestone}-host-run.json"
    image_tag = f"pagespatial-gpu-instrumentation-{milestone}:{args.revision[:12]}"
    requests = inputs / "requests.json"
    original_perf = None
    try:
        _write_requests(inputs, requests)
        source_revision = (inputs / "source-revision.txt").read_text().strip()
        if source_revision != args.revision:
            raise RuntimeError("host source revision marker mismatch")
        build = _run(
            [
                "docker",
                "build",
                "--file",
                str(repo / "scripts/evaluation/Dockerfile.gpu-instrumentation-host-m2"),
                "--tag",
                image_tag,
                str(repo),
            ],
            7200,
        )
        manifest["commands"].append(build)
        manifest["imageInspect"] = json.loads(
            _run(["docker", "image", "inspect", image_tag], 60)["stdout"]
        )[0]
        original_perf = _run(["sysctl", "-n", "kernel.perf_event_paranoid"], 30)[
            "stdout"
        ].strip()
        manifest["perfEventParanoidBefore"] = original_perf
        manifest["commands"].append(
            _run(["sudo", "sysctl", "-w", "kernel.perf_event_paranoid=-1"], 30)
        )
        profile = _run(
            [
                "docker",
                "run",
                "--name",
                f"pagespatial-gpu-instrumentation-{milestone}",
                "--rm",
                "--privileged",
                "--security-opt",
                "seccomp=unconfined",
                "--gpus",
                "all",
                "--cpuset-cpus=0-7",
                "--memory=24g",
                "--volume",
                f"{inputs}:/inputs:ro",
                "--volume",
                f"{output}:/output",
                image_tag,
                "python",
                f"/app/scripts/evaluation/run_gpu_instrumentation_{milestone}_container.py",
                "--requests",
                "/inputs/requests.json",
                "--output-dir",
                "/output",
            ],
            9000,
            check=False,
        )
        manifest["commands"].append(profile)
        if profile["returnCode"] != 0:
            raise RuntimeError(f"{milestone.upper()} profiler container failed")
        gpu_processes = _run(
            [
                "nvidia-smi",
                "--query-compute-apps=pid,process_name,used_memory",
                "--format=csv,noheader",
            ],
            30,
            check=False,
        )
        manifest["gpuProcessesAfter"] = gpu_processes
        if gpu_processes["stdout"].strip():
            raise RuntimeError(f"GPU processes remain after {milestone.upper()} container exit")
        evidence = [
            _sha(path, output)
            for path in sorted(output.rglob("*"))
            if path.is_file() and path != manifest_path
        ]
        evidence_bytes = sum(item["bytes"] for item in evidence)
        if evidence_bytes > MAX_EVIDENCE_BYTES:
            raise RuntimeError(
                f"{milestone.upper()} evidence is {evidence_bytes} bytes; cap is {MAX_EVIDENCE_BYTES}"
            )
        manifest["artifacts"] = evidence
        manifest["evidenceBytes"] = evidence_bytes
        manifest["status"] = "completed"
    except BaseException as error:
        manifest["status"] = "failed"
        manifest["error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        _run(["docker", "rm", "--force", f"pagespatial-gpu-instrumentation-{milestone}"], 60, check=False)
        if original_perf is not None:
            manifest["perfEventRestore"] = _run(
                [
                    "sudo",
                    "sysctl",
                    "-w",
                    f"kernel.perf_event_paranoid={original_perf}",
                ],
                30,
                check=False,
            )
        manifest["endedAtUtc"] = _utc()
        manifest_path.write_text(json.dumps(manifest, indent=1) + "\n")


if __name__ == "__main__":
    main()

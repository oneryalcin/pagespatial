#!/usr/bin/env python3
"""Own the exact GCP experiment VM for one bounded M2 profiler run.

Only the named PageSpatial VM is mutated. All account, project, and instance
checks are read-only. The VM is stopped in ``finally`` and is never recreated,
resized, relabelled, re-networked, or given credentials.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import shutil
import socket
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

from gpu_instrumentation_budget import (
    DEFAULT_LEDGER,
    complete,
    reserve_bundle,
    validate_reservation,
)


PROJECT = "red-studio-399209"
ZONE = "us-central1-a"
INSTANCE = "pagespatial-gpu-profiler-20260825"
ACCOUNT = "mehmet@desia.ai"
MACHINE_TYPE = "g2-standard-8"
M2_STAGES = ("M2-SYSTEMS", "M2-CPU")
STARTUP_SCRIPT = """#!/bin/bash
set -eu

# Bound accidental GPU runtime. A deliberate restart schedules a fresh window.
/sbin/shutdown -h +360
"""
EXPECTED_LABELS = {
    "expires": "20260825",
    "owner": "mehmet",
    "purpose": "pagespatial-gpu-instrumentation",
    "repo": "pagespatial",
}
SSH_KEY = Path.home() / ".ssh/google_compute_engine"
KNOWN_HOSTS = Path.home() / ".ssh/google_compute_known_hosts"


def _run(
    command: list[str], timeout: int, *, check: bool = True
) -> dict[str, Any]:
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


def _gcloud(*args: str, timeout: int = 300, check: bool = True) -> dict[str, Any]:
    return _run(
        ["gcloud", *args, "--project", PROJECT], timeout, check=check
    )


def _describe() -> dict[str, Any]:
    result = _gcloud(
        "compute",
        "instances",
        "describe",
        INSTANCE,
        "--zone",
        ZONE,
        "--format=json",
        timeout=120,
    )
    return json.loads(result["stdout"])


def _assert_scope(instance: dict[str, Any], required_status: str) -> None:
    if instance.get("name") != INSTANCE or instance.get("status") != required_status:
        raise RuntimeError("experiment VM identity or state mismatch")
    if not str(instance.get("zone", "")).endswith(f"/zones/{ZONE}"):
        raise RuntimeError("experiment VM zone mismatch")
    if not str(instance.get("machineType", "")).endswith(
        f"/machineTypes/{MACHINE_TYPE}"
    ):
        raise RuntimeError("experiment VM machine type changed")
    if instance.get("serviceAccounts") not in (None, []):
        raise RuntimeError("experiment VM unexpectedly has a service account")
    scheduling = instance.get("scheduling") or {}
    if (
        scheduling.get("automaticRestart") is not False
        or scheduling.get("onHostMaintenance") != "TERMINATE"
        or scheduling.get("preemptible") is not False
        or scheduling.get("provisioningModel") != "STANDARD"
    ):
        raise RuntimeError("experiment VM bounded scheduling policy changed")
    metadata_items = {
        item.get("key"): item.get("value")
        for item in (instance.get("metadata") or {}).get("items", [])
    }
    if metadata_items != {
        "block-project-ssh-keys": "TRUE",
        "enable-oslogin": "TRUE",
        "startup-script": STARTUP_SCRIPT,
    }:
        raise RuntimeError("experiment VM safety metadata changed")
    if instance.get("labels") != EXPECTED_LABELS:
        raise RuntimeError("experiment VM ownership labels changed")
    disks = instance.get("disks") or []
    if (
        len(disks) != 1
        or disks[0].get("deviceName") != INSTANCE
        or disks[0].get("boot") is not True
        or disks[0].get("autoDelete") is not True
        or disks[0].get("mode") != "READ_WRITE"
        or disks[0].get("diskSizeGb") != "100"
    ):
        raise RuntimeError("experiment VM disk boundary changed")
    interfaces = instance.get("networkInterfaces") or []
    if (
        len(interfaces) != 1
        or interfaces[0].get("accessConfigs") not in (None, [])
        or not str(interfaces[0].get("network", "")).endswith(
            "/global/networks/default"
        )
        or not str(interfaces[0].get("subnetwork", "")).endswith(
            "/regions/us-central1/subnetworks/default"
        )
    ):
        raise RuntimeError("experiment VM network boundary changed")
    if instance.get("canIpForward") not in (None, False):
        raise RuntimeError("experiment VM unexpectedly permits IP forwarding")


def _narrow_snapshot(instance: dict[str, Any]) -> dict[str, Any]:
    return {
        key: instance.get(key)
        for key in (
            "id",
            "name",
            "status",
            "zone",
            "machineType",
            "serviceAccounts",
            "scheduling",
            "metadata",
            "labels",
            "disks",
            "networkInterfaces",
            "canIpForward",
        )
    }


def _stop_exact_vm() -> dict[str, Any]:
    def issue_stop() -> dict[str, Any]:
        try:
            return _gcloud(
                "compute",
                "instances",
                "stop",
                INSTANCE,
                "--zone",
                ZONE,
                timeout=180,
                check=False,
            )
        except BaseException as error:
            return {
                "command": ["gcloud", "compute", "instances", "stop", INSTANCE],
                "error": f"{type(error).__name__}: {error}",
            }

    attempts = []
    deadline = time.monotonic() + 600
    next_retry = time.monotonic() + 60
    attempts.append(issue_stop())
    retried = False
    last = _describe()
    while last.get("status") != "TERMINATED" and time.monotonic() < deadline:
        if not retried and time.monotonic() >= next_retry:
            attempts.append(issue_stop())
            retried = True
        time.sleep(5)
        last = _describe()
    if last.get("status") != "TERMINATED":
        raise RuntimeError(
            f"exact experiment VM failed to stop after {len(attempts)} attempts: "
            f"{last.get('status')}"
        )
    _assert_scope(last, "TERMINATED")
    return {"attempts": attempts, "final": _narrow_snapshot(last)}


def _assert_gcloud_identity() -> None:
    account = _run(
        ["gcloud", "config", "get-value", "account"], 30
    )["stdout"].strip()
    project = _run(
        ["gcloud", "config", "get-value", "project"], 30
    )["stdout"].strip()
    if account != ACCOUNT or project != PROJECT:
        raise RuntimeError(
            f"gcloud identity mismatch: account={account!r}, project={project!r}"
        )


def _existing_ssh_identity(instance: dict[str, Any]) -> dict[str, str]:
    instance_id = str(instance.get("id", ""))
    if not instance_id.isdigit():
        raise RuntimeError("experiment VM describe lacks its numeric instance ID")
    if not SSH_KEY.is_file() or not SSH_KEY.with_suffix(".pub").is_file():
        raise RuntimeError("existing Google Compute SSH keypair is unavailable")
    if not KNOWN_HOSTS.is_file():
        raise RuntimeError("existing Google Compute known-hosts file is unavailable")
    host_alias = f"compute.{instance_id}"
    if not any(
        line.startswith(host_alias + " ")
        for line in KNOWN_HOSTS.read_text().splitlines()
    ):
        raise RuntimeError("experiment VM host key is not already pinned locally")
    profile_result = _gcloud(
        "compute", "os-login", "describe-profile", "--format=json", timeout=120
    )
    profile = json.loads(profile_result["stdout"])
    local_key = SSH_KEY.with_suffix(".pub").read_text().split()
    if len(local_key) < 2:
        raise RuntimeError("existing Google Compute public key is malformed")
    matching_keys = []
    for value in (profile.get("sshPublicKeys") or {}).values():
        remote_key = str(value.get("key", "")).split()
        if remote_key[:2] == local_key[:2]:
            matching_keys.append(value)
    now_usec = int(time.time() * 1_000_000)
    usable = [
        value
        for value in matching_keys
        if not value.get("expirationTimeUsec")
        or int(value["expirationTimeUsec"]) > now_usec + 7 * 3600 * 1_000_000
    ]
    if not usable:
        raise RuntimeError(
            "existing SSH key is absent or expires before the bounded VM window; "
            "refusing to register or refresh it"
        )
    accounts = profile.get("posixAccounts") or []
    account = next(
        (
            value
            for value in accounts
            if value.get("primary") is True or value.get("projectId") == PROJECT
        ),
        None,
    )
    username = str((account or {}).get("username", ""))
    if not username:
        raise RuntimeError("OS Login profile lacks an existing POSIX username")
    return {
        "username": username,
        "hostAlias": host_alias,
        "keyPath": str(SSH_KEY),
        "knownHostsPath": str(KNOWN_HOSTS),
    }


@contextlib.contextmanager
def _iap_tunnel():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = int(probe.getsockname()[1])
    command = [
        "gcloud",
        "compute",
        "start-iap-tunnel",
        INSTANCE,
        "22",
        f"--local-host-port=127.0.0.1:{port}",
        "--zone",
        ZONE,
        "--project",
        PROJECT,
    ]
    process = subprocess.Popen(
        command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
    )
    try:
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if process.poll() is not None:
                stdout, stderr = process.communicate(timeout=5)
                raise RuntimeError(
                    f"read-only IAP tunnel failed: rc={process.returncode}, "
                    f"stdout={stdout!r}, stderr={stderr!r}"
                )
            with socket.socket() as connection:
                connection.settimeout(0.25)
                if connection.connect_ex(("127.0.0.1", port)) == 0:
                    yield port
                    return
            time.sleep(0.25)
        raise RuntimeError("read-only IAP tunnel did not become ready")
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


def _sha(path: Path) -> dict[str, Any]:
    data = path.read_bytes()
    return {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def _require_analysis_success(process: dict[str, Any], result_path: Path) -> None:
    """Retain failed analysis evidence, but never report it as a successful run."""
    if not result_path.is_file():
        raise RuntimeError("M2 local analyzer produced no retained result")
    result = json.loads(result_path.read_text())
    if process.get("returnCode") != 0 or result.get("pass") is not True:
        raise RuntimeError(
            "M2 local analysis failed: "
            f"returnCode={process.get('returnCode')}, pass={result.get('pass')}"
        )


def _ssh(
    remote_command: str,
    timeout: int,
    identity: dict[str, str],
    check: bool = True,
) -> dict[str, Any]:
    with _iap_tunnel() as port:
        return _run(
            [
                "ssh",
                "-i",
                identity["keyPath"],
                "-p",
                str(port),
                "-o",
                "BatchMode=yes",
                "-o",
                "IdentitiesOnly=yes",
                "-o",
                "StrictHostKeyChecking=yes",
                "-o",
                f"UserKnownHostsFile={identity['knownHostsPath']}",
                "-o",
                f"HostKeyAlias={identity['hostAlias']}",
                "-o",
                "ConnectTimeout=30",
                f"{identity['username']}@127.0.0.1",
                remote_command,
            ],
            timeout,
            check=check,
        )


def _scp(
    sources: list[str],
    destination: str,
    timeout: int,
    identity: dict[str, str],
    check: bool = True,
) -> dict[str, Any]:
    def endpoint(value: str) -> str:
        prefix = f"{INSTANCE}:"
        return (
            f"{identity['username']}@127.0.0.1:{value[len(prefix):]}"
            if value.startswith(prefix)
            else value
        )

    with _iap_tunnel() as port:
        return _run(
            [
                "scp",
                "-r",
                "-i",
                identity["keyPath"],
                "-P",
                str(port),
                "-o",
                "BatchMode=yes",
                "-o",
                "IdentitiesOnly=yes",
                "-o",
                "StrictHostKeyChecking=yes",
                "-o",
                f"UserKnownHostsFile={identity['knownHostsPath']}",
                "-o",
                f"HostKeyAlias={identity['hostAlias']}",
                *[endpoint(value) for value in sources],
                endpoint(destination),
            ],
            timeout,
            check=check,
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ledger", type=Path, default=DEFAULT_LEDGER)
    parser.add_argument(
        "--pdf",
        type=Path,
        default=Path(".evaluation/gpu-spike/a2-50page-v1.pdf"),
    )
    parser.add_argument(
        "--native-evidence",
        type=Path,
        default=Path(
            ".evaluation/gpu-spike/2026-08-24/a3-profile/native-evidence-v1.json"
        ),
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=Path(".evaluation/gpu-instrumentation/2026-08-25/m2-gcp"),
    )
    args = parser.parse_args()
    _assert_gcloud_identity()
    source = _run(["git", "status", "--porcelain"], 30)["stdout"]
    if source:
        raise RuntimeError("M2 GCP execution requires a clean committed revision")
    revision = _run(["git", "rev-parse", "HEAD"], 30)["stdout"].strip()
    if args.out_dir.exists():
        raise RuntimeError(f"refusing existing M2 output directory: {args.out_dir}")
    if not args.pdf.is_file() or not args.native_evidence.is_file():
        raise RuntimeError("M2 private inputs are unavailable")
    before = _describe()
    _assert_scope(before, "TERMINATED")
    ssh_identity = _existing_ssh_identity(before)
    reservations = reserve_bundle(args.ledger, list(M2_STAGES))
    for reservation in reservations:
        validate_reservation(args.ledger, reservation["id"], reservation["stage"])

    remote_root = f"/tmp/pagespatial-m2-{revision[:12]}"
    app_id = f"gcp:{PROJECT}:{ZONE}:{INSTANCE}"
    failure: str | None = None
    copied = False
    cleanup: dict[str, Any] | None = None
    with tempfile.TemporaryDirectory(prefix="pagespatial-m2-transfer-") as temp:
        temp_root = Path(temp)
        archive = temp_root / "source.tar.gz"
        revision_file = temp_root / "source-revision.txt"
        transfer_manifest = temp_root / "transfer-manifest.json"
        _run(
            [
                "git",
                "archive",
                "--format=tar.gz",
                f"--output={archive}",
                revision,
            ],
            120,
        )
        revision_file.write_text(revision + "\n")
        transfer_manifest.write_text(
            json.dumps(
                {
                    "revision": revision,
                    "sourceArchive": _sha(archive),
                    "pdf": _sha(args.pdf),
                    "nativeEvidence": _sha(args.native_evidence),
                },
                indent=1,
            )
            + "\n"
        )
        try:
            _gcloud(
                "compute",
                "instances",
                "start",
                INSTANCE,
                "--zone",
                ZONE,
                timeout=600,
            )
            _assert_scope(_describe(), "RUNNING")
            _ssh(
                f"mkdir -p {remote_root}/repo {remote_root}/inputs",
                120,
                ssh_identity,
            )
            _scp(
                [
                    str(archive),
                    str(revision_file),
                    str(transfer_manifest),
                    str(args.pdf),
                    str(args.native_evidence),
                ],
                f"{INSTANCE}:{remote_root}/inputs/",
                1800,
                ssh_identity,
            )
            remote = (
                f"tar -xzf {remote_root}/inputs/source.tar.gz -C {remote_root}/repo && "
                f"python3 {remote_root}/repo/scripts/evaluation/run_gpu_instrumentation_m2_host.py "
                f"--repo-root {remote_root}/repo --input-dir {remote_root}/inputs "
                f"--output-dir {remote_root}/output --revision {revision}"
            )
            _ssh(remote, 10800, ssh_identity)
            args.out_dir.parent.mkdir(parents=True, exist_ok=True)
            local_transfer = temp_root / "evidence"
            local_transfer.mkdir()
            _scp(
                [f"{INSTANCE}:{remote_root}/output"],
                str(local_transfer),
                7200,
                ssh_identity,
            )
            copied_output = local_transfer / "output"
            if not copied_output.is_dir():
                raise RuntimeError("GCP evidence copy did not produce the output directory")
            shutil.move(str(copied_output), str(args.out_dir))
            copied = True
            analysis = _run(
                [
                    "python3",
                    "scripts/evaluation/analyze_gpu_instrumentation_m2.py",
                    "--systems-sqlite",
                    str(args.out_dir / "m2-systems.sqlite"),
                    "--cpu-sqlite",
                    str(args.out_dir / "m2-cpu.sqlite"),
                    "--systems-results",
                    str(args.out_dir / "m2-systems-results.json"),
                    "--cpu-results",
                    str(args.out_dir / "m2-cpu-results.json"),
                    "--output",
                    str(args.out_dir / "m2-analysis.json"),
                ],
                600,
                check=False,
            )
            (args.out_dir / "m2-local-analysis-process.json").write_text(
                json.dumps(analysis, indent=1) + "\n"
            )
            _require_analysis_success(analysis, args.out_dir / "m2-analysis.json")
        except BaseException as error:
            failure = f"{type(error).__name__}: {error}"
            if not copied:
                args.out_dir.parent.mkdir(parents=True, exist_ok=True)
                _scp(
                    [f"{INSTANCE}:{remote_root}/output"],
                    str(args.out_dir),
                    7200,
                    ssh_identity,
                    check=False,
                )
            raise
        finally:
            try:
                cleanup = _stop_exact_vm()
            except BaseException as stop_error:
                failure = (
                    f"{failure}; cleanup: {type(stop_error).__name__}: {stop_error}"
                    if failure
                    else f"cleanup: {type(stop_error).__name__}: {stop_error}"
                )
                current = _describe()
                cleanup = {
                    "status": "failed",
                    "reason": failure,
                    "final": _narrow_snapshot(current),
                }
            evidence_dir = (
                args.out_dir
                if args.out_dir.is_dir()
                else args.out_dir.parent / f"{args.out_dir.name}-cleanup"
            )
            evidence_dir.mkdir(parents=True, exist_ok=True)
            (evidence_dir / "gcp-instance-before.json").write_text(
                json.dumps(_narrow_snapshot(before), indent=1) + "\n"
            )
            (evidence_dir / "gcp-cleanup.json").write_text(
                json.dumps(cleanup or {"status": "failed", "reason": failure}, indent=1)
                + "\n"
            )
            (evidence_dir / "gcp-instance-after.json").write_text(
                json.dumps((cleanup or {}).get("final"), indent=1) + "\n"
            )
            for reservation in reservations:
                complete(
                    args.ledger,
                    reservation["id"],
                    app_id,
                    failure or "M2 host lifetime completed; exact VM stopped",
                )
            if failure is not None:
                raise RuntimeError(failure)


if __name__ == "__main__":
    main()

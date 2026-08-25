#!/usr/bin/env python3
"""Own the exact GCP experiment VM for one bounded M2 profiler run.

Only the named PageSpatial VM is mutated. All account, project, and instance
checks are read-only. The VM is stopped in ``finally`` and is never recreated,
resized, relabelled, re-networked, or given credentials.
"""

from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

from gpu_instrumentation_budget import (
    CAPACITY_FAILURE_MARKER,
    DEFAULT_LEDGER,
    complete,
    reopen_capacity_retry,
    reopen_fixed_image_retry,
    reopen_m3_capacity_retry,
    reserve,
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
EXPECTED_ACCESS_CONFIG = {
    "name": "external-nat",
    "networkTier": "PREMIUM",
    "type": "ONE_TO_ONE_NAT",
}
SSH_KEY = Path.home() / ".ssh/google_compute_engine"
KNOWN_HOSTS = Path.home() / ".ssh/google_compute_known_hosts"
FIXED_IMAGE_FAILURE_EVIDENCE = Path(
    ".evaluation/gpu-instrumentation/2026-08-25/"
    "m2-gcp-retry-16e6599/m2-host-run.json"
)
FIXED_IMAGE_FAILURE_EVIDENCE_SHA256 = (
    "327893a19271a4b71774dfa71192e1d4921da6edf7b44b5677ee9674abd741a9"
)


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


def _assert_scope(
    instance: dict[str, Any], required_status: str, access_state: str = "absent"
) -> None:
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
    access_configs = (
        interfaces[0].get("accessConfigs") or [] if len(interfaces) == 1 else []
    )
    if (
        len(interfaces) != 1
        or not str(interfaces[0].get("network", "")).endswith(
            "/global/networks/default"
        )
        or not str(interfaces[0].get("subnetwork", "")).endswith(
            "/regions/us-central1/subnetworks/default"
        )
    ):
        raise RuntimeError("experiment VM network boundary changed")
    if access_state == "absent":
        if access_configs:
            raise RuntimeError("experiment VM external access boundary changed")
    elif access_state == "attached":
        if len(access_configs) != 1 or any(
            access_configs[0].get(key) != value
            for key, value in EXPECTED_ACCESS_CONFIG.items()
        ):
            raise RuntimeError("experiment VM external access boundary changed")
    else:
        raise RuntimeError(f"unknown experiment VM access state: {access_state}")
    nat_ip = access_configs[0].get("natIP") if access_configs else None
    if access_state == "attached" and required_status == "RUNNING":
        try:
            if not nat_ip or not ipaddress.ip_address(str(nat_ip)).is_global:
                raise ValueError("not a global address")
        except ValueError as error:
            raise RuntimeError("running experiment VM lacks a valid external IP") from error
    elif access_state == "attached" and required_status == "TERMINATED" and nat_ip is not None:
        raise RuntimeError("stopped experiment VM unexpectedly retains an external IP")
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


def _stop_exact_vm(access_state: str) -> dict[str, Any]:
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
    _assert_scope(last, "TERMINATED", access_state)
    return {"attempts": attempts, "final": _narrow_snapshot(last)}


def _attach_external_access() -> dict[str, Any]:
    command = _gcloud(
        "compute",
        "instances",
        "add-access-config",
        INSTANCE,
        "--zone",
        ZONE,
        "--access-config-name",
        EXPECTED_ACCESS_CONFIG["name"],
        "--network-tier",
        EXPECTED_ACCESS_CONFIG["networkTier"],
        timeout=180,
    )
    _assert_scope(_describe(), "TERMINATED", "attached")
    return command


def _cleanup_exact_vm() -> dict[str, Any]:
    def delete_access() -> list[dict[str, Any]]:
        attempts = []
        for attempt in range(2):
            attempts.append(
                _gcloud(
                    "compute",
                    "instances",
                    "delete-access-config",
                    INSTANCE,
                    "--zone",
                    ZONE,
                    "--access-config-name",
                    EXPECTED_ACCESS_CONFIG["name"],
                    timeout=180,
                    check=False,
                )
            )
            if attempts[-1].get("returnCode") == 0:
                break
            if attempt == 0:
                time.sleep(5)
        return attempts

    errors: list[str] = []
    current = _describe()
    access_configs = (current.get("networkInterfaces") or [{}])[0].get(
        "accessConfigs"
    ) or []
    access_state = "attached" if access_configs else "absent"
    _assert_scope(current, str(current.get("status")), access_state)
    detached: list[dict[str, Any]] = []
    if access_state == "attached":
        detached.extend(delete_access())
        if detached[-1].get("returnCode") != 0:
            errors.append(f"pre-stop external access removal failed: {detached}")
    after_detach = _describe()
    remaining_access = (after_detach.get("networkInterfaces") or [{}])[0].get(
        "accessConfigs"
    ) or []
    stop_access_state = "attached" if remaining_access else "absent"
    stopped: dict[str, Any] | None = None
    try:
        stopped = _stop_exact_vm(stop_access_state)
    except BaseException as error:
        errors.append(f"stop failed: {type(error).__name__}: {error}")
    after_stop = _describe()
    still_attached = (after_stop.get("networkInterfaces") or [{}])[0].get(
        "accessConfigs"
    ) or []
    if still_attached:
        detached.extend(delete_access())
        if detached[-1].get("returnCode") != 0:
            errors.append(f"post-stop external access removal failed: {detached}")
    final = _describe()
    try:
        _assert_scope(final, "TERMINATED", "absent")
    except BaseException as error:
        errors.append(f"final boundary failed: {type(error).__name__}: {error}")
    result = {
        "stop": stopped,
        "accessDetachAttempts": detached,
        "final": _narrow_snapshot(final),
    }
    if errors:
        raise RuntimeError(f"exact VM cleanup failed: {errors}; record={result}")
    return result


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
    host: str,
    check: bool = True,
) -> dict[str, Any]:
    return _run(
        [
            "ssh",
            "-i",
            identity["keyPath"],
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
            f"{identity['username']}@{host}",
            remote_command,
        ],
        timeout,
        check=check,
    )


def _wait_for_ssh(
    identity: dict[str, str], host: str, timeout_seconds: int = 180
) -> list[dict[str, Any]]:
    """Wait only for sshd readiness; never alter keys or remote state."""
    deadline = time.monotonic() + timeout_seconds
    attempts = []
    while True:
        attempt = _ssh("true", 45, identity, host, check=False)
        attempts.append(attempt)
        if attempt.get("returnCode") == 0:
            return attempts
        error = str(attempt.get("stderr", ""))
        if any(
            marker in error
            for marker in (
                "Permission denied",
                "REMOTE HOST IDENTIFICATION HAS CHANGED",
                "Host key verification failed",
            )
        ):
            raise RuntimeError(f"non-retryable SSH identity failure: {attempt}")
        if time.monotonic() >= deadline:
            raise RuntimeError(f"SSH did not become ready: {attempts}")
        time.sleep(5)


def _scp(
    sources: list[str],
    destination: str,
    timeout: int,
    identity: dict[str, str],
    host: str,
    check: bool = True,
) -> dict[str, Any]:
    def endpoint(value: str) -> str:
        prefix = f"{INSTANCE}:"
        return (
            f"{identity['username']}@{host}:{value[len(prefix):]}"
            if value.startswith(prefix)
            else value
        )

    return _run(
        [
            "scp",
            "-r",
            "-i",
            identity["keyPath"],
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
    parser.add_argument("--capacity-retry-bundle")
    parser.add_argument("--fixed-image-retry-bundle")
    parser.add_argument("--m3-native", action="store_true")
    parser.add_argument("--m3-capacity-retry")
    parser.add_argument("--capacity-wait-seconds", type=int, default=0)
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
    if not 0 <= args.capacity_wait_seconds <= 600:
        raise RuntimeError("capacity wait must be between 0 and 600 seconds")
    milestone = "m3" if args.m3_native else "m2"
    fixed_image_failure_sha256: str | None = None
    _assert_gcloud_identity()
    source = _run(["git", "status", "--porcelain"], 30)["stdout"]
    if source:
        raise RuntimeError(f"{milestone.upper()} GCP execution requires a clean committed revision")
    revision = _run(["git", "rev-parse", "HEAD"], 30)["stdout"].strip()
    if args.out_dir.exists():
        raise RuntimeError(f"refusing existing {milestone.upper()} output directory: {args.out_dir}")
    if not args.pdf.is_file() or not args.native_evidence.is_file():
        raise RuntimeError(f"{milestone.upper()} private inputs are unavailable")
    retry_modes = [args.capacity_retry_bundle, args.fixed_image_retry_bundle, args.m3_capacity_retry]
    if args.m3_capacity_retry and not args.m3_native:
        raise RuntimeError("M3 capacity retry requires --m3-native")
    if args.m3_native and any((args.capacity_retry_bundle, args.fixed_image_retry_bundle)):
        raise RuntimeError("M3 does not authorize reuse of an M2 retry path")
    if sum(value is not None for value in retry_modes) > 1:
        raise RuntimeError("only one M2 retry mode may be selected")
    if args.fixed_image_retry_bundle:
        if not FIXED_IMAGE_FAILURE_EVIDENCE.is_file():
            raise RuntimeError("fixed-image retry requires its integrity-pinned failure evidence")
        fixed_image_failure_sha256 = str(
            _sha(FIXED_IMAGE_FAILURE_EVIDENCE)["sha256"]
        )
        if fixed_image_failure_sha256 != FIXED_IMAGE_FAILURE_EVIDENCE_SHA256:
            raise RuntimeError("fixed-image retry requires its integrity-pinned failure evidence")
    before = _describe()
    _assert_scope(before, "TERMINATED", "absent")
    ssh_identity = _existing_ssh_identity(before)
    if args.m3_capacity_retry:
        reservations = [reopen_m3_capacity_retry(args.ledger, args.m3_capacity_retry)]
    elif args.fixed_image_retry_bundle:
        reservations = reopen_fixed_image_retry(
            args.ledger,
            args.fixed_image_retry_bundle,
            fixed_image_failure_sha256 or "",
        )
    elif args.capacity_retry_bundle:
        reservations = reopen_capacity_retry(args.ledger, args.capacity_retry_bundle)
    elif args.m3_native:
        reservations = [reserve(args.ledger, "M3-NATIVE")]
    else:
        reservations = reserve_bundle(args.ledger, list(M2_STAGES))
    for reservation in reservations:
        validate_reservation(args.ledger, reservation["id"], reservation["stage"])

    remote_root = f"/tmp/pagespatial-{milestone}-{revision[:12]}"
    app_id = f"gcp:{PROJECT}:{ZONE}:{INSTANCE}"
    failure: str | None = None
    copied = False
    ssh_host: str | None = None
    access_attach: dict[str, Any] | None = None
    cleanup: dict[str, Any] | None = None
    ssh_readiness: list[dict[str, Any]] = []
    start_attempts: list[dict[str, Any]] = []
    attempt_id = f"{time.time_ns()}-{revision[:12]}"
    with tempfile.TemporaryDirectory(prefix=f"pagespatial-{milestone}-transfer-") as temp:
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
            access_attach = _attach_external_access()
            start_deadline = time.monotonic() + args.capacity_wait_seconds
            while True:
                start_attempt = _gcloud(
                    "compute", "instances", "start", INSTANCE, "--zone", ZONE,
                    timeout=600, check=False,
                )
                start_attempts.append(start_attempt)
                if start_attempt["returnCode"] == 0:
                    break
                if (
                    CAPACITY_FAILURE_MARKER not in start_attempt["stderr"]
                    or time.monotonic() >= start_deadline
                ):
                    raise RuntimeError(f"VM start failed: {start_attempt}")
                time.sleep(min(30, max(0, start_deadline - time.monotonic())))
            running = _describe()
            _assert_scope(running, "RUNNING", "attached")
            ssh_host = str(running["networkInterfaces"][0]["accessConfigs"][0]["natIP"])
            ssh_readiness = _wait_for_ssh(ssh_identity, ssh_host)
            _ssh(
                f"mkdir -p {remote_root}/repo {remote_root}/inputs",
                120,
                ssh_identity,
                ssh_host,
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
                ssh_host,
            )
            remote = (
                f"tar -xzf {remote_root}/inputs/source.tar.gz -C {remote_root}/repo && "
                f"sudo -n python3 {remote_root}/repo/scripts/evaluation/run_gpu_instrumentation_m2_host.py "
                f"--repo-root {remote_root}/repo --input-dir {remote_root}/inputs "
                f"--output-dir {remote_root}/output --revision {revision}"
                + (" --m3-native" if args.m3_native else "")
            )
            _ssh(remote, 10800, ssh_identity, ssh_host)
            args.out_dir.parent.mkdir(parents=True, exist_ok=True)
            local_transfer = temp_root / "evidence"
            local_transfer.mkdir()
            _scp(
                [f"{INSTANCE}:{remote_root}/output"],
                str(local_transfer),
                7200,
                ssh_identity,
                ssh_host,
            )
            copied_output = local_transfer / "output"
            if not copied_output.is_dir():
                raise RuntimeError("GCP evidence copy did not produce the output directory")
            shutil.move(str(copied_output), str(args.out_dir))
            copied = True
            analysis_command = (
                [
                    "python3", "scripts/evaluation/analyze_gpu_instrumentation_m3.py",
                    "--sqlite", str(args.out_dir / "m3-native.1.sqlite"),
                    "--results", str(args.out_dir / "m3-native-results.json"),
                    "--output", str(args.out_dir / "m3-analysis.json"),
                ]
                if args.m3_native else [
                    "python3", "scripts/evaluation/analyze_gpu_instrumentation_m2.py",
                    "--systems-sqlite", str(args.out_dir / "m2-systems.1.sqlite"),
                    "--systems-sqlite", str(args.out_dir / "m2-systems.2.sqlite"),
                    "--cpu-sqlite", str(args.out_dir / "m2-cpu.1.sqlite"),
                    "--systems-results", str(args.out_dir / "m2-systems-results.json"),
                    "--cpu-results", str(args.out_dir / "m2-cpu-results.json"),
                    "--output", str(args.out_dir / "m2-analysis.json"),
                ]
            )
            analysis = _run(
                analysis_command,
                600,
                check=False,
            )
            (args.out_dir / f"{milestone}-local-analysis-process.json").write_text(
                json.dumps(analysis, indent=1) + "\n"
            )
            _require_analysis_success(analysis, args.out_dir / f"{milestone}-analysis.json")
        except BaseException as error:
            failure = f"{type(error).__name__}: {error}"
            if not copied and ssh_host is not None:
                args.out_dir.parent.mkdir(parents=True, exist_ok=True)
                _scp(
                    [f"{INSTANCE}:{remote_root}/output"],
                    str(args.out_dir),
                    7200,
                    ssh_identity,
                    ssh_host,
                    check=False,
                )
            raise
        finally:
            try:
                cleanup = _cleanup_exact_vm()
                cleanup["accessAttach"] = access_attach
                cleanup["sshReadiness"] = ssh_readiness
                cleanup["startAttempts"] = start_attempts
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
                else args.out_dir.parent / f"{args.out_dir.name}-cleanup-{attempt_id}"
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
                    failure or f"{milestone.upper()} host lifetime completed; exact VM stopped",
                )
            if failure is not None:
                raise RuntimeError(failure)


if __name__ == "__main__":
    main()

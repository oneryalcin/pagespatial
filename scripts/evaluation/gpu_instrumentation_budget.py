#!/usr/bin/env python3
"""Bounded spend ledger for the 2026-08-25 GPU instrumentation work."""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import subprocess
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


BILLING_START = "2026-08-24"
BILLING_END = "2026-08-26"
AUTHORIZATION_END_UTC = datetime(2026, 8, 25, 23, 0, tzinfo=timezone.utc)
REQUIRED_PROFILE = "desia"
OWNER_CEILING_USD = 100.0
OPERATIONAL_STOP_USD = 100.0
EXPERIMENT_PREFIX = "pagespatial-gpu-instrumentation-"
DEFAULT_LEDGER = Path(".evaluation/gpu-instrumentation/budget-2026-08-25.json")

STAGE_BOUNDS: dict[str, dict[str, Any]] = {
    "M0-CAPABILITY": {
        "worstCaseUsd": 5.0,
        "calls": 1,
        "containers": 1,
        "gpu": "L4",
        "physicalCpuCores": 4.0,
        "timeoutSecondsPerCall": 600,
        "buildAndIdleAllowanceUsd": 4.0,
    },
    "M1-PARITY": {
        "worstCaseUsd": 10.0,
        "calls": 4,
        "containers": 1,
        "gpu": "L4",
        "physicalCpuCores": 4.0,
        "timeoutSecondsPerCall": 1200,
        "buildAndIdleAllowanceUsd": 4.0,
    },
    "M2-SYSTEMS": {
        "worstCaseUsd": 20.0,
        "calls": 4,
        "containers": 1,
        "gpu": "L4",
        "physicalCpuCores": 4.0,
        "timeoutSecondsPerCall": 1200,
        "buildAndIdleAllowanceUsd": 8.0,
    },
    "M2-CPU": {
        "worstCaseUsd": 10.0,
        "calls": 1,
        "containers": 1,
        "gpu": "L4",
        "physicalCpuCores": 4.0,
        "timeoutSecondsPerCall": 1200,
        "buildAndIdleAllowanceUsd": 4.0,
    },
}


def _run_json(command: list[str]) -> Any:
    result = subprocess.run(
        command, check=True, capture_output=True, text=True, timeout=120
    )
    return json.loads(result.stdout)


def current_profile() -> str:
    result = subprocess.run(
        ["modal", "profile", "current"],
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )
    return result.stdout.strip()


def billing_rows() -> list[dict[str, Any]]:
    rows = _run_json(
        [
            "modal",
            "billing",
            "report",
            "--start",
            BILLING_START,
            "--end",
            BILLING_END,
            "--show-resources",
            "--json",
        ]
    )
    return [
        row
        for row in rows
        if str(row.get("description", "")).startswith(EXPERIMENT_PREFIX)
    ]


def active_experiment_apps() -> list[dict[str, Any]]:
    rows = _run_json(["modal", "app", "list", "--json"])
    return [
        row
        for row in rows
        if str(row.get("description", "")).startswith(EXPERIMENT_PREFIX)
        and (row.get("state") != "stopped" or str(row.get("tasks", "0")) != "0")
    ]


def posted_spend(rows: list[dict[str, Any]]) -> float:
    return sum(float(row["cost"]) for row in rows)


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _new_ledger() -> dict[str, Any]:
    return {
        "schemaVersion": "pagespatial-gpu-instrumentation-budget-v1",
        "localDate": "2026-08-25",
        "timezone": "Europe/London",
        "billingWindowUtc": "[2026-08-24T00:00:00Z,2026-08-26T00:00:00Z)",
        "authorizationEndsAtUtc": "2026-08-25T23:00:00Z",
        "profile": REQUIRED_PROFILE,
        "ownerCeilingUsd": OWNER_CEILING_USD,
        "operationalStopUsd": OPERATIONAL_STOP_USD,
        "reservations": [],
    }


def load_ledger(path: Path) -> dict[str, Any]:
    ledger = json.loads(path.read_text()) if path.exists() else _new_ledger()
    if ledger.get("schemaVersion") != "pagespatial-gpu-instrumentation-budget-v1":
        raise RuntimeError("unsupported GPU instrumentation budget ledger")
    if ledger.get("localDate") != "2026-08-25":
        raise RuntimeError("GPU instrumentation ledger date mismatch")
    if ledger.get("profile") != REQUIRED_PROFILE:
        raise RuntimeError("GPU instrumentation ledger profile mismatch")
    ledger["ownerCeilingUsd"] = OWNER_CEILING_USD
    ledger["operationalStopUsd"] = OPERATIONAL_STOP_USD
    ledger.setdefault("reservations", [])
    return ledger


def save_ledger(path: Path, ledger: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + f".{uuid.uuid4().hex}.tmp")
    temporary.write_text(json.dumps(ledger, indent=1) + "\n")
    temporary.replace(path)


@contextmanager
def ledger_lock(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_suffix(path.suffix + ".lock")
    with lock_path.open("a+") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def reserved_exposure(ledger: dict[str, Any]) -> float:
    return sum(
        float(item["worstCaseUsd"])
        for item in ledger["reservations"]
        if item.get("status") in {"reserved", "active", "completed-unposted"}
    )


def _assert_authorized() -> None:
    if current_profile() != REQUIRED_PROFILE:
        raise RuntimeError(f"Modal profile must be {REQUIRED_PROFILE!r}")
    if now_utc() >= AUTHORIZATION_END_UTC:
        raise RuntimeError("2026-08-25 Europe/London instrumentation authorization has expired")


def reserve(path: Path, stage: str) -> dict[str, Any]:
    if stage not in STAGE_BOUNDS:
        raise RuntimeError(f"unknown paid stage: {stage!r}")
    _assert_authorized()
    active = active_experiment_apps()
    if active:
        raise RuntimeError(f"paid launch serialization refused: active apps: {active}")
    rows = billing_rows()
    with ledger_lock(path):
        ledger = load_ledger(path)
        live = [
            item
            for item in ledger["reservations"]
            if item.get("status") in {"reserved", "active"}
        ]
        if live:
            raise RuntimeError(f"paid launch serialization refused: live reservation: {live}")
        bound = STAGE_BOUNDS[stage]
        worst_case_usd = float(bound["worstCaseUsd"])
        posted = posted_spend(rows)
        exposure = posted + reserved_exposure(ledger) + worst_case_usd
        if exposure > OPERATIONAL_STOP_USD:
            raise RuntimeError(
                f"spend guard refused: posted ${posted:.4f} + reserved "
                f"${reserved_exposure(ledger):.4f} + next ${worst_case_usd:.4f} "
                f"> ${OPERATIONAL_STOP_USD:.2f}"
            )
        reservation = {
            "id": f"{int(time.time())}-{uuid.uuid4().hex[:8]}",
            "stage": stage,
            "bound": bound,
            "worstCaseUsd": worst_case_usd,
            "status": "reserved",
            "createdAt": int(time.time()),
            "postedSpendAtReserveUsd": posted,
            "exposureAfterReserveUsd": exposure,
        }
        ledger["reservations"].append(reservation)
        ledger["lastBillingRows"] = rows
        save_ledger(path, ledger)
        return reservation


def reserve_bundle(path: Path, stages: list[str]) -> list[dict[str, Any]]:
    """Atomically reserve sequential stages run in one bounded host lifetime."""
    if not stages or len(stages) != len(set(stages)):
        raise RuntimeError("paid stage bundle must be non-empty and unique")
    unknown = [stage for stage in stages if stage not in STAGE_BOUNDS]
    if unknown:
        raise RuntimeError(f"unknown paid stages: {unknown}")
    _assert_authorized()
    active = active_experiment_apps()
    if active:
        raise RuntimeError(f"paid launch serialization refused: active apps: {active}")
    rows = billing_rows()
    with ledger_lock(path):
        ledger = load_ledger(path)
        live = [
            item
            for item in ledger["reservations"]
            if item.get("status") in {"reserved", "active"}
        ]
        if live:
            raise RuntimeError(f"paid launch serialization refused: live reservation: {live}")
        posted = posted_spend(rows)
        bundle_worst_case = sum(
            float(STAGE_BOUNDS[stage]["worstCaseUsd"]) for stage in stages
        )
        exposure = posted + reserved_exposure(ledger) + bundle_worst_case
        if exposure > OPERATIONAL_STOP_USD:
            raise RuntimeError(
                f"spend guard refused: exposure ${exposure:.4f} > "
                f"${OPERATIONAL_STOP_USD:.2f}"
            )
        bundle_id = f"bundle-{int(time.time())}-{uuid.uuid4().hex[:8]}"
        reservations = []
        for stage in stages:
            bound = STAGE_BOUNDS[stage]
            reservation = {
                "id": f"{int(time.time())}-{uuid.uuid4().hex[:8]}",
                "bundleId": bundle_id,
                "stage": stage,
                "bound": bound,
                "worstCaseUsd": float(bound["worstCaseUsd"]),
                "status": "reserved",
                "createdAt": int(time.time()),
                "postedSpendAtReserveUsd": posted,
                "bundleExposureAfterReserveUsd": exposure,
            }
            ledger["reservations"].append(reservation)
            reservations.append(reservation)
        ledger["lastBillingRows"] = rows
        save_ledger(path, ledger)
        return reservations


def reopen_preflight_bundle(path: Path, bundle_id: str) -> list[dict[str, Any]]:
    """Reuse one already-counted M2 bundle after a proven access-only failure."""
    _assert_authorized()
    active = active_experiment_apps()
    if active:
        raise RuntimeError(f"paid launch serialization refused: active apps: {active}")
    rows = billing_rows()
    with ledger_lock(path):
        ledger = load_ledger(path)
        live = [
            item
            for item in ledger["reservations"]
            if item.get("status") in {"reserved", "active"}
        ]
        if live:
            raise RuntimeError(f"paid launch serialization refused: live reservation: {live}")
        matches = [
            item for item in ledger["reservations"] if item.get("bundleId") == bundle_id
        ]
        if sorted(item.get("stage") for item in matches) != sorted(
            ["M2-SYSTEMS", "M2-CPU"]
        ):
            raise RuntimeError("retry requires one exact M2 stage bundle")
        if any(item.get("status") != "completed-unposted" for item in matches):
            raise RuntimeError("retry bundle is not completed-unposted")
        if any(item.get("retryHistory") for item in matches):
            raise RuntimeError("M2 preflight bundle may be reopened only once")
        if any(
            not str(item.get("appId", "")).startswith("gcp:")
            or not any(
                marker in str(item.get("completionNote", ""))
                for marker in ("IAP tunnel failed", "Connection refused")
            )
            for item in matches
        ):
            raise RuntimeError("retry requires a retained GCP access-only failure")
        exposure = posted_spend(rows) + reserved_exposure(ledger)
        if exposure > OPERATIONAL_STOP_USD:
            raise RuntimeError(
                f"spend guard refused reused exposure ${exposure:.4f} > "
                f"${OPERATIONAL_STOP_USD:.2f}"
            )
        reopened_at = int(time.time())
        for item in matches:
            item["retryHistory"] = [
                {
                    "status": item["status"],
                    "completedAt": item.get("completedAt"),
                    "completionNote": item.get("completionNote"),
                    "appId": item.get("appId"),
                }
            ]
            item["status"] = "reserved"
            item["reopenedAt"] = reopened_at
            for key in (
                "claimedAt",
                "claimedByPid",
                "completedAt",
                "completionNote",
                "appId",
            ):
                item.pop(key, None)
        ledger["lastBillingRows"] = rows
        ledger["lastReusedExposureUsd"] = exposure
        save_ledger(path, ledger)
        return matches


def validate_reservation(path: Path, reservation_id: str, stage: str) -> dict[str, Any]:
    _assert_authorized()
    with ledger_lock(path):
        ledger = load_ledger(path)
        match = next(
            (item for item in ledger["reservations"] if item["id"] == reservation_id),
            None,
        )
        if match is None or match.get("status") != "reserved":
            raise RuntimeError("paid entry point requires a live budget reservation")
        if match.get("stage") != stage:
            raise RuntimeError(
                f"reservation stage mismatch: {match.get('stage')!r} != {stage!r}"
            )
        match.update(
            {"status": "active", "claimedAt": int(time.time()), "claimedByPid": os.getpid()}
        )
        save_ledger(path, ledger)
        return match


def complete(
    path: Path, reservation_id: str, app_id: str | None, reason: str | None = None
) -> dict[str, Any]:
    with ledger_lock(path):
        ledger = load_ledger(path)
        match = next(
            (item for item in ledger["reservations"] if item["id"] == reservation_id),
            None,
        )
        if match is None or match.get("status") not in {"reserved", "active"}:
            raise RuntimeError("reservation is not completable")
        match.update(
            {
                "status": "completed-unposted",
                "appId": app_id,
                "completedAt": int(time.time()),
            }
        )
        if reason:
            match["completionNote"] = reason[:500]
        save_ledger(path, ledger)
        return match


def status(path: Path) -> dict[str, Any]:
    if current_profile() != REQUIRED_PROFILE:
        raise RuntimeError(f"Modal profile must be {REQUIRED_PROFILE!r}")
    rows = billing_rows()
    active = active_experiment_apps()
    with ledger_lock(path):
        ledger = load_ledger(path)
        ledger["lastBillingRows"] = rows
        ledger["status"] = {
            "postedSpendUsd": posted_spend(rows),
            "reservedExposureUsd": reserved_exposure(ledger),
            "activeApps": active,
        }
        save_ledger(path, ledger)
        return ledger


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ledger", type=Path, default=DEFAULT_LEDGER)
    sub = parser.add_subparsers(dest="command", required=True)
    add = sub.add_parser("reserve")
    add.add_argument("--stage", required=True)
    bundle = sub.add_parser("reserve-bundle")
    bundle.add_argument("--stages", required=True)
    claim = sub.add_parser("claim")
    claim.add_argument("--reservation", required=True)
    claim.add_argument("--stage", required=True)
    done = sub.add_parser("complete")
    done.add_argument("--reservation", required=True)
    done.add_argument("--app-id")
    done.add_argument("--reason")
    sub.add_parser("status")
    args = parser.parse_args()
    if args.command == "reserve":
        result = reserve(args.ledger, args.stage)
    elif args.command == "reserve-bundle":
        result = reserve_bundle(args.ledger, args.stages.split(","))
    elif args.command == "claim":
        result = validate_reservation(args.ledger, args.reservation, args.stage)
    elif args.command == "complete":
        result = complete(args.ledger, args.reservation, args.app_id, args.reason)
    else:
        result = status(args.ledger)
    print(json.dumps(result, indent=1))


if __name__ == "__main__":
    main()

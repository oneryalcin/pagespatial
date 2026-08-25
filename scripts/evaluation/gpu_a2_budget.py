#!/usr/bin/env python3
"""Executable spend ledger for the 2026-08-25 PageSpatial A2 experiment.

Paid commands are serialized by operator policy. `reserve` refuses a launch
unless the active profile is `desia`, no A2 app is active, and posted spend plus
unreconciled reservations plus the next worst case stays at or below USD 100.
Reservations remain charged at their worst case until the exact app is stopped
and an operator attests a final total from a closed billing interval.
"""

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


DATE_START = "2026-08-25"  # Modal billing-report UTC day
DATE_END = "2026-08-26"
AUTHORIZATION_END_UTC = datetime(2026, 8, 25, 23, 0, tzinfo=timezone.utc)
REQUIRED_PROFILE = "desia"
OWNER_CEILING_USD = 100.0
OPERATIONAL_STOP_USD = 100.0
EXPERIMENT_PREFIX = "pagespatial-gpu-a2-"
DEFAULT_LEDGER = Path(".evaluation/gpu-spike/a2-budget-2026-08-25.json")

# Fixed reservations are part of the experiment contract. Callers cannot
# lower them. Values include the stated call count, the configured resource
# timeout, container count, and a deliberately generous image-build/idle
# allowance. They are exposure guards, not predicted bills.
STAGE_BOUNDS: dict[str, dict[str, Any]] = {
    "E1-CPU": {
        "worstCaseUsd": 3.0, "calls": 4, "containers": 1,
        "physicalCpuCores": 4.0, "timeoutSecondsPerCall": 1800,
        "buildAndIdleAllowanceUsd": 1.0,
    },
    "E1-GPU": {
        "worstCaseUsd": 3.0, "calls": 4, "containers": 1,
        "gpu": "L4", "physicalCpuCores": 4.0,
        "timeoutSecondsPerCall": 1200, "buildAndIdleAllowanceUsd": 1.0,
    },
    "E2-GPU": {
        "worstCaseUsd": 12.0, "calls": 8, "containers": 1,
        "gpu": "L4", "physicalCpuCores": 4.0,
        "timeoutSecondsPerCall": 1200, "buildAndIdleAllowanceUsd": 4.0,
    },
    "E3-GPU": {
        "worstCaseUsd": 14.0, "calls": 12, "containers": 1,
        "gpu": "L4", "physicalCpuCores": 4.0,
        "timeoutSecondsPerCall": 1200, "buildAndIdleAllowanceUsd": 4.0,
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
            "modal", "billing", "report",
            "--start", DATE_START,
            "--end", DATE_END,
            "--show-resources", "--json",
        ]
    )
    return [
        row for row in rows
        if str(row.get("description", "")).startswith("pagespatial")
    ]


def active_experiment_apps() -> list[dict[str, Any]]:
    rows = _run_json(["modal", "app", "list", "--json"])
    return [
        row for row in rows
        if str(row.get("description", "")).startswith(EXPERIMENT_PREFIX)
        and (row.get("state") != "stopped" or str(row.get("tasks", "0")) != "0")
    ]


def posted_spend(rows: list[dict[str, Any]]) -> float:
    return sum(float(row["cost"]) for row in rows)


def now_utc() -> datetime:
    """Clock seam for deterministic tests; production uses the real UTC clock."""
    return datetime.now(timezone.utc)


def load_ledger(path: Path) -> dict[str, Any]:
    if path.exists():
        ledger = json.loads(path.read_text())
    else:
        ledger = {
            "schemaVersion": "pagespatial-gpu-a2-budget-v1",
            "date": DATE_START,
            "billingWindowUtc": "[2026-08-25T00:00:00Z,2026-08-26T00:00:00Z)",
            "authorizationEndsAtUtc": "2026-08-25T23:00:00Z",
            "profile": REQUIRED_PROFILE,
            "ownerCeilingUsd": OWNER_CEILING_USD,
            "operationalStopUsd": OPERATIONAL_STOP_USD,
            "reservations": [],
        }
    if ledger.get("schemaVersion") != "pagespatial-gpu-a2-budget-v1":
        raise RuntimeError("unsupported A2 budget ledger")
    if ledger.get("date") != DATE_START or ledger.get("profile") != REQUIRED_PROFILE:
        raise RuntimeError("A2 budget ledger date/profile mismatch")
    ledger.setdefault(
        "billingWindowUtc", "[2026-08-25T00:00:00Z,2026-08-26T00:00:00Z)"
    )
    ledger.setdefault("authorizationEndsAtUtc", "2026-08-25T23:00:00Z")
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
    """Serialize read-check-write across independent launch processes."""
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


def reserve(path: Path, stage: str) -> dict[str, Any]:
    if stage not in STAGE_BOUNDS:
        raise RuntimeError(f"unknown paid stage: {stage!r}")
    bound = STAGE_BOUNDS[stage]
    worst_case_usd = float(bound["worstCaseUsd"])
    if current_profile() != REQUIRED_PROFILE:
        raise RuntimeError(f"Modal profile must be {REQUIRED_PROFILE!r}")
    if now_utc() >= AUTHORIZATION_END_UTC:
        raise RuntimeError("2026-08-25 Europe/London experiment authorization has expired")
    active = active_experiment_apps()
    if active:
        raise RuntimeError(f"paid launch serialization refused: active A2 apps: {active}")
    rows = billing_rows()
    with ledger_lock(path):
        ledger = load_ledger(path)
        live = [
            item for item in ledger["reservations"]
            if item.get("status") in {"reserved", "active"}
        ]
        if live:
            raise RuntimeError(f"paid launch serialization refused: live reservation: {live}")
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


def complete(path: Path, reservation_id: str, app_id: str) -> dict[str, Any]:
    with ledger_lock(path):
        ledger = load_ledger(path)
        match = next((item for item in ledger["reservations"] if item["id"] == reservation_id), None)
        if match is None:
            raise RuntimeError(f"unknown reservation: {reservation_id}")
        if match.get("status") not in {"reserved", "active"}:
            raise RuntimeError(f"reservation is not completable: {match.get('status')}")
        match.update({"status": "completed-unposted", "appId": app_id, "completedAt": int(time.time())})
        save_ledger(path, ledger)
        return match


def complete_without_app(path: Path, reservation_id: str, reason: str) -> dict[str, Any]:
    """Close a claimed launch that failed before Modal created an app.

    The full worst-case reservation remains `completed-unposted` exposure.
    This only removes the live serialization lock; it never releases money.
    """
    if active_experiment_apps():
        raise RuntimeError("cannot close a no-app reservation while an A2 app is active")
    with ledger_lock(path):
        ledger = load_ledger(path)
        match = next((item for item in ledger["reservations"] if item["id"] == reservation_id), None)
        if match is None:
            raise RuntimeError(f"unknown reservation: {reservation_id}")
        if match.get("status") not in {"reserved", "active"}:
            raise RuntimeError(f"reservation is not completable: {match.get('status')}")
        match.update(
            {
                "status": "completed-unposted",
                "appId": None,
                "noAppReason": reason[:500],
                "completedAt": int(time.time()),
            }
        )
        save_ledger(path, ledger)
        return match


def validate_reservation(path: Path, reservation_id: str, stage: str) -> dict[str, Any]:
    if current_profile() != REQUIRED_PROFILE:
        raise RuntimeError(f"Modal profile must be {REQUIRED_PROFILE!r}")
    if now_utc() >= AUTHORIZATION_END_UTC:
        raise RuntimeError("2026-08-25 Europe/London experiment authorization has expired")
    with ledger_lock(path):
        ledger = load_ledger(path)
        match = next((item for item in ledger["reservations"] if item["id"] == reservation_id), None)
        if match is None or match.get("status") != "reserved":
            raise RuntimeError("paid entry point requires a live budget reservation")
        if match.get("stage") != stage:
            raise RuntimeError(f"reservation stage mismatch: {match.get('stage')!r} != {stage!r}")
        match.update({"status": "active", "claimedAt": int(time.time()), "claimedByPid": os.getpid()})
        save_ledger(path, ledger)
        return match


def reconcile_final(
    path: Path, reservation_id: str, final_app_total_usd: float
) -> dict[str, Any]:
    """Release worst-case exposure only after an operator supplies a FINAL
    stopped-app total from a closed billing interval. Never infer finality from
    a partial positive billing row."""
    rows = _run_json(["modal", "app", "list", "--json"])
    with ledger_lock(path):
        ledger = load_ledger(path)
        match = next((item for item in ledger["reservations"] if item["id"] == reservation_id), None)
        if match is None or match.get("status") != "completed-unposted":
            raise RuntimeError("reservation is not awaiting final reconciliation")
        app_id = match.get("appId")
        app_rows = [row for row in rows if row.get("app_id") == app_id]
        if not app_rows or any(
            row.get("state") != "stopped" or str(row.get("tasks", "0")) != "0"
            for row in app_rows
        ):
            raise RuntimeError("final reconciliation requires a stopped app with zero tasks")
        if final_app_total_usd < 0:
            raise RuntimeError("final app total must be non-negative")
        match.update(
            {
                "status": "reconciled",
                "finalAppTotalUsd": final_app_total_usd,
                "finality": "operator-attested closed billing interval",
                "reconciledAt": int(time.time()),
            }
        )
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
    done = sub.add_parser("complete")
    done.add_argument("--reservation", required=True)
    done.add_argument("--app-id", required=True)
    no_app = sub.add_parser("complete-no-app")
    no_app.add_argument("--reservation", required=True)
    no_app.add_argument("--reason", required=True)
    final = sub.add_parser("reconcile-final")
    final.add_argument("--reservation", required=True)
    final.add_argument("--final-app-total-usd", required=True, type=float)
    sub.add_parser("status")
    args = parser.parse_args()
    if args.command == "reserve":
        result = reserve(args.ledger, args.stage)
    elif args.command == "complete":
        result = complete(args.ledger, args.reservation, args.app_id)
    elif args.command == "complete-no-app":
        result = complete_without_app(args.ledger, args.reservation, args.reason)
    elif args.command == "reconcile-final":
        result = reconcile_final(
            args.ledger, args.reservation, args.final_app_total_usd
        )
    else:
        result = status(args.ledger)
    print(json.dumps(result, indent=1))


if __name__ == "__main__":
    main()

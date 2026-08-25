#!/usr/bin/env python3
"""Linux-only exact-marker cleanup for bounded GPU evaluation children."""

from __future__ import annotations

import os
import signal
import time
from pathlib import Path


def marked_process_groups(marker: str) -> set[int]:
    groups: set[int] = set()
    marker_bytes = marker.encode()
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            command = (entry / "cmdline").read_bytes()
            if marker_bytes not in command:
                continue
            groups.add(os.getpgid(int(entry.name)))
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
    return groups


def reap_marked_process_groups(marker: str, grace_s: float = 3.0) -> int:
    groups = marked_process_groups(marker)
    for process_group_id in groups:
        try:
            os.killpg(process_group_id, signal.SIGTERM)
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + grace_s
    while time.monotonic() < deadline and marked_process_groups(marker):
        time.sleep(0.05)
    remaining = marked_process_groups(marker)
    for process_group_id in remaining:
        try:
            os.killpg(process_group_id, signal.SIGKILL)
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline and marked_process_groups(marker):
        time.sleep(0.05)
    if marked_process_groups(marker):
        raise RuntimeError("A2 child process tree did not drain")
    return len(groups)

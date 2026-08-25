#!/usr/bin/env python3
"""Deterministic NVTX capture-window state for the M2 profiler worker.

The controller changes no scheduling. It observes when pages enter the Python
OCR owner path and when Node reports completed page assembly. The caller owns
the actual NVTX start/end functions so this module remains locally testable.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from typing import Any


SYSTEMS_WINDOWS = ((11, 20), (31, 40))
SHORT_SYSTEMS_WINDOWS = ((11, 15), (31, 35))
CPU_WINDOWS = ((1, 50),)
M3_NATIVE_WINDOWS = ((11, 20),)


class CaptureWindowController:
    """Open fixed numeric page windows and close on completed assembly."""

    def __init__(
        self,
        *,
        run_id: str,
        capture_name: str,
        windows: tuple[tuple[int, int], ...],
        start_range: Callable[[str], Any],
        end_range: Callable[[Any], None],
        now_ns: Callable[[], int] = time.monotonic_ns,
    ) -> None:
        if not windows:
            raise ValueError("capture plan requires at least one window")
        previous_end = 0
        self._windows: list[dict[str, Any]] = []
        for index, (first, last) in enumerate(windows, start=1):
            if first < 1 or last < first or first <= previous_end:
                raise ValueError("capture windows must be positive and disjoint")
            previous_end = last
            self._windows.append(
                {
                    "windowIndex": index,
                    "firstTargetPage": first,
                    "lastTargetPage": last,
                    "targetPages": list(range(first, last + 1)),
                    "submittedTargetPages": [],
                    "assembledTargetPages": [],
                    "overlappingOcrPages": [],
                    "overlappingAssemblyPages": [],
                    "openedAtNs": None,
                    "closedAtNs": None,
                    "openRequestId": None,
                    "closeRequestId": None,
                    "handle": None,
                }
            )
        self.run_id = run_id
        self.capture_name = capture_name
        self._start_range = start_range
        self._end_range = end_range
        self._now_ns = now_ns
        self._active_index: int | None = None
        self._lock = threading.Lock()

    def observe_ocr_enter(self, page_number: int, request_id: str) -> None:
        with self._lock:
            target_index = self._target_window_index(page_number)
            if target_index is not None:
                window = self._windows[target_index]
                if page_number in window["submittedTargetPages"]:
                    raise RuntimeError(f"duplicate target OCR page {page_number}")
                if self._active_index is None:
                    if any(
                        earlier["closedAtNs"] is None
                        for earlier in self._windows[:target_index]
                    ):
                        raise RuntimeError("capture window opened out of order")
                    self._active_index = target_index
                    window["handle"] = self._start_range(self.capture_name)
                    window["openedAtNs"] = self._now_ns()
                    window["openRequestId"] = request_id
                elif self._active_index != target_index:
                    raise RuntimeError("capture windows overlap")
                window["submittedTargetPages"].append(page_number)
            if self._active_index is not None:
                active = self._windows[self._active_index]
                active["overlappingOcrPages"].append(
                    {"pageNumber": page_number, "requestId": request_id}
                )

    def observe_assembly_end(self, page_number: int, request_id: str) -> None:
        with self._lock:
            if self._active_index is None:
                return
            active = self._windows[self._active_index]
            active["overlappingAssemblyPages"].append(
                {"pageNumber": page_number, "requestId": request_id}
            )
            if page_number in active["targetPages"]:
                if page_number in active["assembledTargetPages"]:
                    raise RuntimeError(f"duplicate target assembly page {page_number}")
                active["assembledTargetPages"].append(page_number)
            if set(active["assembledTargetPages"]) == set(active["targetPages"]):
                self._end_range(active["handle"])
                active["closedAtNs"] = self._now_ns()
                active["closeRequestId"] = request_id
                active["handle"] = None
                self._active_index = None

    def finish(self) -> dict[str, Any]:
        with self._lock:
            if self._active_index is not None:
                raise RuntimeError("capture document ended with an open window")
            records = []
            for window in self._windows:
                missing_submitted = sorted(
                    set(window["targetPages"])
                    - set(window["submittedTargetPages"])
                )
                missing_assembled = sorted(
                    set(window["targetPages"])
                    - set(window["assembledTargetPages"])
                )
                if missing_submitted or missing_assembled:
                    raise RuntimeError(
                        "capture window is incomplete: "
                        f"submitted={missing_submitted}, assembled={missing_assembled}"
                    )
                if not isinstance(window["openedAtNs"], int) or not isinstance(
                    window["closedAtNs"], int
                ):
                    raise RuntimeError("capture window lacks timestamps")
                records.append(
                    {key: value for key, value in window.items() if key != "handle"}
                )
            return {
                "schemaVersion": "pagespatial-gpu-instrumentation-capture-v1",
                "runId": self.run_id,
                "captureName": self.capture_name,
                "completionRule": "first-target-ocr-entry-through-all-target-page-assembly",
                "windows": records,
            }

    def _target_window_index(self, page_number: int) -> int | None:
        for index, window in enumerate(self._windows):
            if page_number in window["targetPages"]:
                return index
        return None


def plan_for_mode(mode: str) -> dict[str, Any] | None:
    if mode == "m2-systems":
        return {"captureName": "m2.capture", "windows": SYSTEMS_WINDOWS}
    if mode == "m2-systems-short":
        return {"captureName": "m2.capture", "windows": SHORT_SYSTEMS_WINDOWS}
    if mode == "m2-cpu":
        return {"captureName": "m2.cpu.capture", "windows": CPU_WINDOWS}
    if mode == "m3-native":
        return {"captureName": "m3.native.capture", "windows": M3_NATIVE_WINDOWS}
    if mode == "m1":
        return None
    raise ValueError(f"unsupported trace-worker mode: {mode}")

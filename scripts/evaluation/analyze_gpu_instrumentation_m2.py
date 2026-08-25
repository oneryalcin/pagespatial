#!/usr/bin/env python3
"""Fail-closed analysis of the two M2 Systems windows and CPU capture."""

from __future__ import annotations

import argparse
import json
import math
import sqlite3
import statistics
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Iterable


REQUIRED_SYSTEMS_TABLES = {
    "NVTX_EVENTS",
    "StringIds",
    "CUPTI_ACTIVITY_KIND_RUNTIME",
    "CUPTI_ACTIVITY_KIND_KERNEL",
    "CUPTI_ACTIVITY_KIND_MEMCPY",
    "ENUM_CUDA_MEMCPY_OPER",
}
REQUIRED_CPU_TABLES = {
    "NVTX_EVENTS",
    "StringIds",
    "COMPOSITE_EVENTS",
    "SAMPLING_CALLCHAINS",
    "SCHED_EVENTS",
    "ENUM_SAMPLING_THREAD_STATE",
    "PROCESSES",
}
FIXED_STAGES = {
    "page.decode",
    "predict.total",
    "detector.prepare",
    "detector.backend",
    "detector.postprocess",
    "crop.generate",
    "recognizer.prepare",
    "recognizer.wait_backend",
    "recognizer.backend",
    "recognizer.decode",
    "result.assemble",
}
INNER_COVERAGE_STAGES = FIXED_STAGES - {
    "page.decode",
    "predict.total",
    "result.assemble",
}


def _tables(connection: sqlite3.Connection) -> set[str]:
    return {
        row[0]
        for row in connection.execute(
            "select name from sqlite_master where type='table'"
        )
        if not row[0].upper().startswith("ENUM_") or row[0] in {
            "ENUM_CUDA_MEMCPY_OPER",
            "ENUM_SAMPLING_THREAD_STATE",
        }
    }


def _require_tables(connection: sqlite3.Connection, required: set[str]) -> None:
    missing = sorted(required - _tables(connection))
    if missing:
        raise RuntimeError(f"Nsight SQLite lacks required tables: {missing}")


def _clip(interval: tuple[int, int], window: tuple[int, int]) -> tuple[int, int] | None:
    start = max(interval[0], window[0])
    end = min(interval[1], window[1])
    return (start, end) if end > start else None


def _merge(intervals: Iterable[tuple[int, int]]) -> list[tuple[int, int]]:
    rows = sorted((start, end) for start, end in intervals if end > start)
    merged: list[list[int]] = []
    for start, end in rows:
        if not merged or start > merged[-1][1]:
            merged.append([start, end])
        else:
            merged[-1][1] = max(merged[-1][1], end)
    return [(start, end) for start, end in merged]


def _duration(intervals: Iterable[tuple[int, int]]) -> int:
    return sum(end - start for start, end in _merge(intervals))


def _intersections(
    left: Iterable[tuple[int, int]], right: Iterable[tuple[int, int]]
) -> list[tuple[int, int]]:
    a = _merge(left)
    b = _merge(right)
    output = []
    i = j = 0
    while i < len(a) and j < len(b):
        overlap = _clip(a[i], b[j])
        if overlap is not None:
            output.append(overlap)
        if a[i][1] <= b[j][1]:
            i += 1
        else:
            j += 1
    return _merge(output)


def _subtract(
    base: Iterable[tuple[int, int]], remove: Iterable[tuple[int, int]]
) -> list[tuple[int, int]]:
    bases = _merge(base)
    cuts = _merge(remove)
    output = []
    cut_index = 0
    for start, end in bases:
        while cut_index < len(cuts) and cuts[cut_index][1] <= start:
            cut_index += 1
        cursor = start
        index = cut_index
        while index < len(cuts) and cuts[index][0] < end:
            cut_start, cut_end = cuts[index]
            if cut_start > cursor:
                output.append((cursor, min(cut_start, end)))
            cursor = max(cursor, cut_end)
            if cursor >= end:
                break
            index += 1
        if cursor < end:
            output.append((cursor, end))
        cut_index = index
    return output


def _percentile(values: list[float], quantile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    rank = (len(ordered) - 1) * quantile
    lower, upper = math.floor(rank), math.ceil(rank)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (rank - lower)


def _nvtx_ranges(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    return [
        {
            "start": int(row[0]),
            "end": int(row[1]),
            "message": str(row[2]),
            "globalTid": row[3],
            "endGlobalTid": row[4],
        }
        for row in connection.execute(
            """
            select n.start,n.end,coalesce(n.text,s.value),n.globalTid,n.endGlobalTid
            from NVTX_EVENTS n left join StringIds s on s.id=n.textId
            where n.end is not null and coalesce(n.text,s.value) is not null
            order by n.start
            """
        )
    ]


def _stage(message: str) -> str | None:
    prefix = message.split(";", 1)[0]
    return prefix if prefix in FIXED_STAGES else None


def _identity(message: str) -> dict[str, str]:
    fields = {}
    for item in message.split(";")[1:]:
        if "=" in item:
            key, value = item.split("=", 1)
            fields[key] = value
    return fields


def _summary(rows: list[tuple[int, int]], window: tuple[int, int]) -> dict[str, Any]:
    clipped = [value for row in rows if (value := _clip(row, window)) is not None]
    durations_ms = [(end - start) / 1_000_000 for start, end in clipped]
    return {
        "calls": len(clipped),
        "summedServiceMs": sum(durations_ms),
        "occupiedUnionMs": _duration(clipped) / 1_000_000,
        "medianMs": statistics.median(durations_ms) if durations_ms else None,
        "p95Ms": _percentile(durations_ms, 0.95),
        "maxMs": max(durations_ms) if durations_ms else None,
    }


def _decision(
    shares: dict[str, float],
    kernel_share: float,
    material_remainders: dict[str, float] | None = None,
    cpu_corroborated_rows: set[str] | None = None,
) -> dict[str, Any]:
    candidates = [
        {"row": row, "sharePercent": share}
        for row, share in shares.items()
        if share >= 20
    ]
    if kernel_share >= 70:
        candidates.append(
            {"row": "kernels-saturated", "sharePercent": kernel_share}
        )
    candidates.sort(key=lambda item: item["sharePercent"], reverse=True)
    blockers = [
        {"remainder": name, "sharePercent": share}
        for name, share in (material_remainders or {}).items()
        if share >= 20
    ]
    if 20 <= kernel_share < 70:
        blockers.append(
            {"remainder": "kernel-work-below-saturation-gate", "sharePercent": kernel_share}
        )
    blockers.sort(key=lambda item: item["sharePercent"], reverse=True)
    if blockers:
        return {
            "row": "ambiguous-stop",
            "candidates": candidates,
            "materialRemainders": blockers,
            "rule": "material captured wall remains unmapped or below a row-specific gate",
        }
    if not candidates:
        return {
            "row": "stop-no-20-percent",
            "candidates": [],
            "materialRemainders": [],
            "rule": "no measured removable cause reaches 20 percent",
        }
    if len(candidates) == 1 or (
        candidates[0]["sharePercent"] - candidates[1]["sharePercent"] >= 5
    ):
        selected = candidates[0]["row"]
        if selected in {"cpu-preparation", "ctc-result-decode"} and selected not in (
            cpu_corroborated_rows or set()
        ):
            return {
                "row": "ambiguous-stop",
                "provisionalCpuRow": selected,
                "candidates": candidates,
                "materialRemainders": [],
                "rule": "CPU wall-span candidate lacks separate on-CPU corroboration",
            }
        return {
            "row": selected,
            "candidates": candidates,
            "materialRemainders": [],
            "rule": "largest qualifying cause leads every other cause by at least 5 percentage points",
        }
    return {
        "row": "ambiguous-stop",
        "candidates": candidates,
        "materialRemainders": [],
        "rule": "qualifying causes are within 5 percentage points; no subjective tie-break",
    }


def _reconcile_target_stages(
    stage_identities: dict[str, list[dict[str, str]]], target_pages: list[int]
) -> None:
    identities_by_stage_page: dict[str, dict[int, list[dict[str, str]]]] = {}
    for stage, identities in stage_identities.items():
        for identity in identities:
            if identity.get("page", "").isdigit():
                identities_by_stage_page.setdefault(stage, {}).setdefault(
                    int(identity["page"]), []
                ).append(identity)
    for page in target_pages:
        for stage in (
            "page.decode",
            "predict.total",
            "detector.backend",
            "detector.postprocess",
            "crop.generate",
            "result.assemble",
        ):
            count = len(identities_by_stage_page.get(stage, {}).get(page, []))
            if count != 1:
                raise RuntimeError(
                    f"target page {page} has {count} {stage} ranges, expected 1"
                )
        if not identities_by_stage_page.get("detector.prepare", {}).get(page):
            raise RuntimeError(f"target page {page} lacks detector preparation")
        recognition_keys: dict[str, dict[tuple[int, int], int]] = {}
        for stage in (
            "recognizer.prepare",
            "recognizer.wait_backend",
            "recognizer.backend",
            "recognizer.decode",
        ):
            keys: dict[tuple[int, int], int] = {}
            for identity in identities_by_stage_page.get(stage, {}).get(page, []):
                try:
                    batch = int(identity["batch"])
                    crops = int(identity["crops"])
                except (KeyError, ValueError):
                    raise RuntimeError(
                        f"target page {page} {stage} lacks batch/crop identity"
                    ) from None
                if crops != 1:
                    raise RuntimeError(
                        f"target page {page} {stage} observed B{crops}, expected B1"
                    )
                keys[(batch, crops)] = keys.get((batch, crops), 0) + 1
            recognition_keys[stage] = keys
        backend_keys = recognition_keys["recognizer.backend"]
        if not backend_keys or any(count != 1 for count in backend_keys.values()):
            raise RuntimeError(
                f"target page {page} recognition backend batches do not reconcile"
            )
        expected_ordinals = set(range(1, len(backend_keys) + 1))
        if {batch for batch, _ in backend_keys} != expected_ordinals:
            raise RuntimeError(
                f"target page {page} recognition batch ordinals are not contiguous"
            )
        for stage in ("recognizer.wait_backend", "recognizer.decode"):
            if recognition_keys[stage] != backend_keys:
                raise RuntimeError(
                    f"target page {page} {stage} batches differ from backend batches"
                )
        if not set(backend_keys).issubset(recognition_keys["recognizer.prepare"]):
            raise RuntimeError(
                f"target page {page} recognizer preparation lacks a backend batch"
            )


def _analyze_window(
    connection: sqlite3.Connection,
    nvtx: list[dict[str, Any]],
    capture: dict[str, Any],
    index: int,
) -> dict[str, Any]:
    window = (capture["start"], capture["end"])
    wall_ns = window[1] - window[0]
    if wall_ns <= 0:
        raise RuntimeError("capture window has non-positive duration")
    stage_rows: dict[str, list[tuple[int, int]]] = {stage: [] for stage in FIXED_STAGES}
    stage_identities: dict[str, list[dict[str, str]]] = {stage: [] for stage in FIXED_STAGES}
    for row in nvtx:
        stage = _stage(row["message"])
        if stage is not None and _clip((row["start"], row["end"]), window):
            stage_rows[stage].append((row["start"], row["end"]))
            stage_identities[stage].append(_identity(row["message"]))

    kernels = []
    for start, end, name in connection.execute(
            """
            select k.start,k.end,s.value from CUPTI_ACTIVITY_KIND_KERNEL k
            join StringIds s on s.id=k.demangledName
            where k.end>? and k.start<?
            """,
            window,
        ):
        clipped = _clip((int(start), int(end)), window)
        if clipped is not None:
            kernels.append((*clipped, str(name)))
    copies = []
    for start, end, label, size in connection.execute(
            """
            select m.start,m.end,e.label,m.bytes from CUPTI_ACTIVITY_KIND_MEMCPY m
            join ENUM_CUDA_MEMCPY_OPER e on e.id=m.copyKind
            where m.end>? and m.start<?
            """,
            window,
        ):
        clipped = _clip((int(start), int(end)), window)
        if clipped is not None:
            copies.append((*clipped, str(label), int(size)))
    memset_rows: list[tuple[int, int]] = []
    if "CUPTI_ACTIVITY_KIND_MEMSET" in _tables(connection):
        for start, end in connection.execute(
                "select start,end from CUPTI_ACTIVITY_KIND_MEMSET where end>? and start<?",
                window,
            ):
            clipped = _clip((int(start), int(end)), window)
            if clipped is not None:
                memset_rows.append(clipped)
    runtime_calls = int(
        connection.execute(
            "select count(*) from CUPTI_ACTIVITY_KIND_RUNTIME where end>? and start<?",
            window,
        ).fetchone()[0]
    )
    if not kernels or runtime_calls == 0:
        raise RuntimeError("capture window lacks CUDA kernel or API evidence")

    kernel_intervals = [(start, end) for start, end, _ in kernels]
    copy_intervals = [(start, end) for start, end, _, _ in copies]
    device_intervals = _merge([*kernel_intervals, *copy_intervals, *memset_rows])
    gaps = _subtract([window], device_intervals)
    wait_in_gaps = _intersections(gaps, stage_rows["recognizer.wait_backend"])
    remaining_gaps = _subtract(gaps, wait_in_gaps)
    preparation = _merge(
        interval
        for stage in (
            "detector.prepare",
            "detector.backend",
            "detector.postprocess",
            "crop.generate",
            "recognizer.prepare",
            "recognizer.decode",
            "result.assemble",
        )
        for interval in stage_rows[stage]
    )
    preparation_in_gaps = _intersections(remaining_gaps, preparation)
    unattributed_gaps = _subtract(remaining_gaps, preparation_in_gaps)

    h2d = [(start, end) for start, end, label, _ in copies if "Host-to-Device" in label]
    d2h = [(start, end) for start, end, label, _ in copies if "Device-to-Host" in label]
    other_copies = [
        (start, end)
        for start, end, label, _ in copies
        if "Host-to-Device" not in label and "Device-to-Host" not in label
    ]
    detector_kernels = [
        (start, end)
        for start, end, _ in kernels
        if _intersections([(start, end)], stage_rows["detector.backend"])
    ]
    recognizer_kernels = [
        (start, end)
        for start, end, _ in kernels
        if _intersections([(start, end)], stage_rows["recognizer.backend"])
    ]
    other_kernels = _subtract(kernel_intervals, [*detector_kernels, *recognizer_kernels])
    gpu_partition_ns = _duration(device_intervals) + _duration(gaps)
    if gpu_partition_ns != wall_ns:
        raise RuntimeError("GPU activity and gaps do not partition the capture interval")

    inner = _merge(
        interval
        for stage in INNER_COVERAGE_STAGES
        for interval in stage_rows[stage]
    )
    predict = _merge(stage_rows["predict.total"])
    predict_ns = _duration(predict)
    coverage_ns = _duration(_intersections(inner, predict))
    coverage_percent = 100 * coverage_ns / predict_ns if predict_ns else 0
    if coverage_percent < 80:
        raise RuntimeError(
            f"named stages cover {coverage_percent:.2f}% of predict wall, below 80%"
        )

    target_pages = list(range(11, 21)) if index == 1 else list(range(31, 41))
    _reconcile_target_stages(stage_identities, target_pages)

    to_percent = lambda value: 100 * value / wall_ns
    shares = {
        "cpu-preparation": to_percent(
            _duration(_merge([*stage_rows["crop.generate"], *stage_rows["recognizer.prepare"]]))
        ),
        "host-to-device-copy": to_percent(_duration(h2d)),
        "device-to-host-copy": to_percent(_duration(d2h)),
        "blocking-backend-wait": to_percent(_duration(wait_in_gaps)),
        "ctc-result-decode": to_percent(_duration(stage_rows["recognizer.decode"])),
        "producer-starvation": to_percent(_duration(preparation_in_gaps)),
    }
    kernel_share = to_percent(_duration(kernel_intervals))
    other_device = _merge([*other_kernels, *other_copies, *memset_rows])
    material_remainders = {
        "unattributed-device-gap": to_percent(_duration(unattributed_gaps)),
        "other-identified-device-work": to_percent(_duration(other_device)),
        "uncovered-predict-wall": max(0.0, 100 - coverage_percent),
    }
    return {
        "windowIndex": index,
        "startNs": window[0],
        "endNs": window[1],
        "wallMs": wall_ns / 1_000_000,
        "targetPages": target_pages,
        "stageSummary": {
            stage: _summary(rows, window)
            for stage, rows in sorted(stage_rows.items())
            if rows
        },
        "stageCoveragePercentOfPredict": coverage_percent,
        "cuda": {
            "apiCalls": runtime_calls,
            "kernelCalls": len(kernels),
            "copyCalls": len(copies),
            "kernelServiceMs": sum((end - start) for start, end, _ in kernels) / 1_000_000,
            "kernelOccupiedUnionMs": _duration(kernel_intervals) / 1_000_000,
            "detectorKernelOccupiedUnionMs": _duration(detector_kernels) / 1_000_000,
            "recognizerKernelOccupiedUnionMs": _duration(recognizer_kernels) / 1_000_000,
            "otherKernelOccupiedUnionMs": _duration(other_kernels) / 1_000_000,
            "h2dOccupiedUnionMs": _duration(h2d) / 1_000_000,
            "d2hOccupiedUnionMs": _duration(d2h) / 1_000_000,
            "otherCopyOccupiedUnionMs": _duration(other_copies) / 1_000_000,
            "memsetOccupiedUnionMs": _duration(memset_rows) / 1_000_000,
            "deviceActivityOccupiedUnionMs": _duration(device_intervals) / 1_000_000,
            "noPageSpatialDeviceActivityMs": _duration(gaps) / 1_000_000,
            "gapClassification": {
                "recognizerWaitBackendMs": _duration(wait_in_gaps) / 1_000_000,
                "namedPreparationMs": _duration(preparation_in_gaps) / 1_000_000,
                "unattributedMs": _duration(unattributed_gaps) / 1_000_000,
            },
        },
        "candidateSharesPercent": shares,
        "materialRemaindersPercent": material_remainders,
        "decision": _decision(shares, kernel_share, material_remainders),
        "limitations": [
            "absence of traced PageSpatial CUDA activity does not prove physical L4 idleness",
            "result.assemble is a Python protocol proxy; source Node monotonic timestamps remain authoritative",
        ],
    }


def analyze_systems(sqlite_path: Path, *, first_window_index: int = 1) -> dict[str, Any]:
    with sqlite3.connect(sqlite_path) as connection:
        _require_tables(connection, REQUIRED_SYSTEMS_TABLES)
        nvtx = _nvtx_ranges(connection)
        captures = [row for row in nvtx if row["message"] == "m2.capture"]
        if len(captures) not in {1, 2}:
            raise RuntimeError(
                f"Systems trace has {len(captures)} capture ranges, expected 1 or 2"
            )
        windows = [
            _analyze_window(connection, nvtx, capture, index)
            for index, capture in enumerate(captures, start=first_window_index)
        ]
    rows = [window["decision"]["row"] for window in windows]
    agreement = len(set(rows)) == 1 and rows[0] != "ambiguous-stop"
    return {
        "windows": windows,
        "decisionRows": rows,
        "decisionAgreement": agreement,
        "selectedDecisionRow": rows[0] if agreement else "ambiguous-stop",
    }


def analyze_systems_reports(sqlite_paths: list[Path]) -> dict[str, Any]:
    windows = []
    for sqlite_path in sqlite_paths:
        report = analyze_systems(sqlite_path, first_window_index=len(windows) + 1)
        windows.extend(report["windows"])
    if len(windows) != 2:
        raise RuntimeError(f"Systems analysis retained {len(windows)} windows, expected 2")
    rows = [window["decision"]["row"] for window in windows]
    agreement = len(set(rows)) == 1 and rows[0] != "ambiguous-stop"
    return {
        "windows": windows,
        "decisionRows": rows,
        "decisionAgreement": agreement,
        "selectedDecisionRow": rows[0] if agreement else "ambiguous-stop",
    }


def corroborate_cpu_decisions(
    systems: dict[str, Any], cpu: dict[str, Any]
) -> dict[str, Any]:
    counts = cpu["onCpuSamplesByNamedStage"]
    unresolved = cpu["unresolvedLeafSamplePercentByNamedStage"]
    total = cpu["samples"]
    dominant = cpu["dominantNamedStage"]
    row_stages = {
        "cpu-preparation": {"crop.generate", "recognizer.prepare"},
        "ctc-result-decode": {"recognizer.decode"},
    }
    corroborated = set()
    evidence = {}
    for row, stages in row_stages.items():
        stage_samples = sum(int(counts.get(stage, 0)) for stage in stages)
        share = 100 * stage_samples / total if total else 0
        unresolved_samples = sum(
            int(counts.get(stage, 0))
            * float(unresolved.get(stage, 100))
            / 100
            for stage in stages
        )
        unresolved_percent = (
            100 * unresolved_samples / stage_samples if stage_samples else 100
        )
        passed = (
            share >= 20
            and unresolved_percent <= 10
            and dominant in stages
        )
        evidence[row] = {
            "stages": sorted(stages),
            "onCpuSamples": stage_samples,
            "shareOfAllSamplesPercent": share,
            "unresolvedLeafSamplePercent": unresolved_percent,
            "dominantNamedStage": dominant,
            "pass": passed,
        }
        if passed:
            corroborated.add(row)
    for window in systems["windows"]:
        window["decision"] = _decision(
            window["candidateSharesPercent"],
            window["cuda"]["kernelOccupiedUnionMs"] / window["wallMs"] * 100,
            window["materialRemaindersPercent"],
            corroborated,
        )
        window["cpuCorroboration"] = evidence
    rows = [window["decision"]["row"] for window in systems["windows"]]
    agreement = len(set(rows)) == 1 and rows[0] != "ambiguous-stop"
    systems.update(
        {
            "decisionRows": rows,
            "decisionAgreement": agreement,
            "selectedDecisionRow": rows[0] if agreement else "ambiguous-stop",
            "cpuCorroboratedRows": sorted(corroborated),
        }
    )
    return systems


def analyze_cpu(sqlite_path: Path) -> dict[str, Any]:
    with sqlite3.connect(sqlite_path) as connection:
        _require_tables(connection, REQUIRED_CPU_TABLES)
        nvtx = _nvtx_ranges(connection)
        captures = [row for row in nvtx if row["message"] == "m2.cpu.capture"]
        if len(captures) != 1:
            raise RuntimeError(f"CPU trace has {len(captures)} capture ranges, expected 1")
        window = (captures[0]["start"], captures[0]["end"])
        samples = list(
            connection.execute(
                "select id,start,globalTid from COMPOSITE_EVENTS where start>=? and start<?",
                window,
            )
        )
        if not samples:
            raise RuntimeError("CPU trace has no samples in the capture window")
        frames = list(
            connection.execute(
                """
                select c.id,c.stackDepth,s.value,m.value,c.unresolved
                from SAMPLING_CALLCHAINS c
                join COMPOSITE_EVENTS e on e.id=c.id
                join StringIds s on s.id=c.symbol
                join StringIds m on m.id=c.module
                where e.start>=? and e.start<?
                order by c.id,c.stackDepth
                """,
                window,
            )
        )
        leaf = [row for row in frames if int(row[1]) == 0]
        leaf_by_sample = {int(row[0]): row for row in leaf}
        unresolved = sum(
            sample_id not in leaf_by_sample or int(leaf_by_sample[sample_id][4]) != 0
            for sample_id, _, _ in samples
        )
        unresolved_percent = 100 * unresolved / len(samples)
        resolved_symbols: dict[str, int] = {}
        for _, _, symbol, module, is_unresolved in leaf:
            if not is_unresolved:
                key = f"{symbol} [{module}]"
                resolved_symbols[key] = resolved_symbols.get(key, 0) + 1

        stages_by_tid: dict[int, list[tuple[int, int, str]]] = {}
        for row in nvtx:
            stage = _stage(row["message"])
            if stage is not None and row["globalTid"] is not None:
                stages_by_tid.setdefault(int(row["globalTid"]), []).append(
                    (int(row["start"]), int(row["end"]), stage)
                )
        samples_by_stage: dict[str, int] = {}
        unresolved_by_stage: dict[str, int] = {}
        samples_by_process: dict[str, int] = {}
        process_names = {
            int(global_pid): str(name)
            for global_pid, _, name in connection.execute(
                "select globalPid,pid,name from PROCESSES"
            )
        }
        for sample_id, at_ns, global_tid in samples:
            global_tid = int(global_tid)
            enclosing = [
                (end - start, stage)
                for start, end, stage in stages_by_tid.get(global_tid, [])
                if start <= int(at_ns) < end
            ]
            stage = min(enclosing)[1] if enclosing else "unattributed"
            samples_by_stage[stage] = samples_by_stage.get(stage, 0) + 1
            leaf_row = leaf_by_sample.get(int(sample_id))
            if leaf_row is None or int(leaf_row[4]) != 0:
                unresolved_by_stage[stage] = unresolved_by_stage.get(stage, 0) + 1
            global_pid = global_tid & ~0xFFFFFF
            process = process_names.get(global_pid, f"globalPid:{global_pid}")
            samples_by_process[process] = samples_by_process.get(process, 0) + 1
        unresolved_percent_by_stage = {
            stage: 100 * unresolved_by_stage.get(stage, 0) / count
            for stage, count in samples_by_stage.items()
        }
        named_counts = {
            stage: count
            for stage, count in samples_by_stage.items()
            if stage != "unattributed"
        }
        dominant_named_stage = (
            max(named_counts, key=named_counts.get) if named_counts else None
        )
        dominant_unresolved_percent = (
            unresolved_percent_by_stage[dominant_named_stage]
            if dominant_named_stage is not None
            else 100
        )

        state_names = {
            int(row[0]): str(row[2])
            for row in connection.execute(
                "select id,name,label from ENUM_SAMPLING_THREAD_STATE"
            )
        }
        sched_rows = list(
            connection.execute(
                """
                select start,isSchedIn,globalTid,threadState from SCHED_EVENTS
                where start>=? and start<? order by globalTid,start
                """,
                window,
            )
        )
        by_thread: dict[int, list[tuple[int, int, int | None]]] = {}
        for start, scheduled_in, tid, state in sched_rows:
            if tid is not None:
                by_thread.setdefault(int(tid), []).append(
                    (int(start), int(scheduled_in), state)
                )
        running_ns = runnable_ns = blocked_ns = 0
        for rows in by_thread.values():
            for current, following in zip(rows, rows[1:]):
                start, scheduled_in, state = current
                end = following[0]
                if scheduled_in:
                    running_ns += end - start
                else:
                    label = state_names.get(int(state or 0), "Unknown").lower()
                    if "running" in label or "unscheduled" in label:
                        runnable_ns += end - start
                    else:
                        blocked_ns += end - start
        return {
            "captureWallMs": (window[1] - window[0]) / 1_000_000,
            "samples": len(samples),
            "leafFrames": len(leaf),
            "unresolvedLeafSamplePercent": unresolved_percent,
            "mayNameLowLevelFunction": dominant_unresolved_percent <= 10,
            "dominantNamedStage": dominant_named_stage,
            "dominantNamedStageUnresolvedLeafSamplePercent": dominant_unresolved_percent,
            "topResolvedLeafSymbols": [
                {"symbol": symbol, "samples": count}
                for symbol, count in sorted(
                    resolved_symbols.items(), key=lambda item: item[1], reverse=True
                )[:20]
            ],
            "onCpuSamplesByNamedStage": dict(sorted(samples_by_stage.items())),
            "unresolvedLeafSamplePercentByNamedStage": dict(
                sorted(unresolved_percent_by_stage.items())
            ),
            "onCpuSamplesByProcess": dict(sorted(samples_by_process.items())),
            "schedulerServiceMs": {
                "running": running_ns / 1_000_000,
                "runnableNotScheduled": runnable_ns / 1_000_000,
                "blockedOrWaiting": blocked_ns / 1_000_000,
            },
            "limitations": [
                "scheduler totals cover intervals bounded by retained scheduling events, not missing boundary tails"
            ],
        }


def analyze_lifetime(results: list[dict[str, Any]]) -> dict[str, Any]:
    reasons = []
    if len(results) != 4:
        raise RuntimeError("M2 lifetime requires four results")
    for index, result in enumerate(results, start=1):
        if (
            result.get("status") != "completed"
            or len(result.get("pages", [])) != 50
            or any(
                page.get("ok") is not True or page.get("pageNumber") != page_index
                for page_index, page in enumerate(result.get("pages", []), start=1)
            )
        ):
            reasons.append(f"call {index} is not exactly 50 ordered successful pages")
    cold = [result.get("method", {}).get("containerCold") for result in results]
    if cold != [True, False, False, False]:
        reasons.append(f"cold pattern is {cold}, expected [true,false,false,false]")
    pids = {result.get("method", {}).get("ownerPid") for result in results}
    worker_pids = {result.get("launch", {}).get("workerPid") for result in results}
    if len(pids) != 1 or len(worker_pids) != 1 or None in pids | worker_pids:
        reasons.append("four calls do not share one owner/worker PID")
    elif pids != worker_pids:
        reasons.append("method owner PID differs from traced worker PID")
    labels = [result.get("launch", {}).get("sequenceLabel") for result in results]
    if labels != ["warmup", "control-before", "trace", "control-after"]:
        reasons.append(f"four-call labels are invalid: {labels}")
    modes = {result.get("launch", {}).get("mode") for result in results}
    if len(modes) != 1 or next(iter(modes)) not in {"m2-systems", "m2-cpu"}:
        reasons.append(f"four-call profiler mode is invalid: {modes}")
    for field in ("document", "arm", "resources", "modelVerification", "deviceTruth", "ultraInferPatch"):
        if any(result.get(field) != results[0].get(field) for result in results[1:]):
            reasons.append(f"{field} differs across the four-call lifetime")
    rates = [
        50 / (result["method"]["totalMethodMs"] / 1000)
        if result.get("method", {}).get("totalMethodMs", 0) > 0
        else 0
        for result in results
    ]
    if min(rates) <= 0:
        reasons.append("one or more calls lacks positive timing")
    control_drift = (
        100 * abs(rates[1] - rates[3]) / rates[1] if rates[1] else math.inf
    )
    if control_drift > 10:
        reasons.append("control-before and control-after differ by more than 10%")
    control_wall = statistics.median(
        [results[1]["method"]["totalMethodMs"], results[3]["method"]["totalMethodMs"]]
    )
    overhead = 100 * (results[2]["method"]["totalMethodMs"] / control_wall - 1)
    capture = results[2].get("instrumentation", {}).get("capture")
    if any(
        result.get("instrumentation", {}).get("capture") is not None
        for index, result in enumerate(results)
        if index != 2
    ):
        reasons.append("a control call unexpectedly carries a capture plan")
    if not capture or len(capture.get("windows", [])) not in {1, 2}:
        reasons.append("trace result lacks completed capture-window evidence")
    else:
        mode = next(iter(modes)) if len(modes) == 1 else None
        expected_targets = (
            [list(range(11, 21)), list(range(31, 41))]
            if mode == "m2-systems"
            else [list(range(1, 51))]
        )
        observed_targets = [window.get("targetPages") for window in capture["windows"]]
        if observed_targets != expected_targets:
            reasons.append(
                f"capture targets are {observed_targets}, expected {expected_targets}"
            )
    arm = results[0].get("arm", {})
    if (
        arm.get("tier") != "tiny"
        or arm.get("precision") != "fp32"
        or arm.get("recognitionBatchSize") != 1
        or arm.get("inferenceOwners") != 2
        or arm.get("stageProfile") is not True
        or arm.get("nvtx") is not True
    ):
        reasons.append("lifetime is not the fixed Tiny FP32 B1 O2 profiled arm")
    return {
        "pass": not reasons,
        "reasons": reasons,
        "coldPattern": cold,
        "workerPid": next(iter(worker_pids)) if len(worker_pids) == 1 else None,
        "pagesPerS": rates,
        "controlDriftPercent": control_drift,
        "profilerOverheadPercent": overhead,
        "timelineDurationsAreQuantitative": overhead <= 15,
    }


def compare_output(results_path: Path) -> dict[str, Any]:
    script = Path(__file__).with_name("analyze_gpu_instrumentation_m2_output.mjs")
    with tempfile.TemporaryDirectory(prefix="pagespatial-m2-output-") as temporary:
        output = Path(temporary) / "comparison.json"
        process = subprocess.run(
            ["node", str(script), "--input", str(results_path), "--output", str(output)],
            capture_output=True,
            text=True,
            check=False,
        )
        if not output.is_file():
            raise RuntimeError(f"M2 output comparator produced no result: {process.stderr}")
        result = json.loads(output.read_text())
        result["processReturnCode"] = process.returncode
        return result


def output_pair_passes(
    systems_output: dict[str, Any], cpu_output: dict[str, Any]
) -> bool:
    """Require stable output from both independent profiler lifetimes."""
    return bool(
        systems_output.get("verdict", {}).get("pass")
        and cpu_output.get("verdict", {}).get("pass")
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--systems-sqlite", type=Path, action="append", required=True
    )
    parser.add_argument("--cpu-sqlite", type=Path, required=True)
    parser.add_argument("--systems-results", type=Path, required=True)
    parser.add_argument("--cpu-results", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    systems_results = json.loads(args.systems_results.read_text())
    cpu_results = json.loads(args.cpu_results.read_text())
    cpu = analyze_cpu(args.cpu_sqlite)
    systems = corroborate_cpu_decisions(
        analyze_systems_reports(args.systems_sqlite),
        cpu,
    )
    systems_output = compare_output(args.systems_results)
    cpu_output = compare_output(args.cpu_results)
    result = {
        "schemaVersion": "pagespatial-gpu-instrumentation-m2-analysis-v1",
        "systemsLifetime": analyze_lifetime(systems_results),
        "cpuLifetime": analyze_lifetime(cpu_results),
        "systemsOutput": systems_output,
        "cpuOutput": cpu_output,
        "systems": systems,
        "cpu": cpu,
        "limitations": [
            "GCP is a host control with a different driver; these rates are not Modal deployment throughput",
            "M2 uses Tiny only for bottleneck attribution; Tiny remains unqualified for production correctness",
            "the external Modal response-serialization gap is outside this host trace",
        ],
    }
    result["pass"] = (
        result["systemsLifetime"]["pass"]
        and result["cpuLifetime"]["pass"]
        and output_pair_passes(systems_output, cpu_output)
        and result["systems"]["decisionAgreement"]
    )
    args.output.write_text(json.dumps(result, indent=1) + "\n")
    print(json.dumps({"pass": result["pass"], "decision": result["systems"]["selectedDecisionRow"]}, indent=1))
    if not result["pass"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()

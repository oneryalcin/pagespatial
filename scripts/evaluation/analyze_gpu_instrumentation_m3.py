#!/usr/bin/env python3
"""Attribute one M3 capture using the six native TensorRT NVTX phases."""

from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path
from typing import Any

from analyze_gpu_instrumentation_m2 import (
    _duration,
    _intersections,
    _merge,
    _nvtx_ranges,
    _subtract,
    analyze_lifetime,
    compare_output,
)


NATIVE_STAGES = (
    "trt.input_prepare",
    "trt.host_to_device",
    "trt.enqueue",
    "trt.synchronize",
    "trt.device_to_host",
    "trt.output_materialize",
)
PARENT_STAGES = ("detector.backend", "recognizer.backend")
ROLE_BACKEND_ATTRS = {
    "detector.backend": "ocr.paddlex_pipeline._pipeline.text_det_model.runner._config.backend",
    "recognizer.backend": "ocr.paddlex_pipeline._pipeline.text_rec_model.runner._config.backend",
}


def _message_stage(message: str) -> str:
    return message.split(";", 1)[0]


def analyze(sqlite_path: Path, results_path: Path) -> dict[str, Any]:
    results = json.loads(results_path.read_text())
    lifetime = analyze_lifetime(results)
    backend_attrs = results[0].get("backendAttrs", {}) if results else {}
    role_backends = {
        role: backend_attrs.get(attribute)
        for role, attribute in ROLE_BACKEND_ATTRS.items()
    }
    expected_native_roles = {
        role for role, backend in role_backends.items() if backend == "tensorrt"
    }
    with sqlite3.connect(sqlite_path) as connection:
        rows = _nvtx_ranges(connection)
    captures = [row for row in rows if row["message"] == "m3.native.capture"]
    if len(captures) != 1:
        raise RuntimeError(f"M3 trace has {len(captures)} capture ranges, expected 1")
    window = (captures[0]["start"], captures[0]["end"])
    parents = [row for row in rows if _message_stage(row["message"]) in PARENT_STAGES]
    native = [row for row in rows if row["message"] in NATIVE_STAGES]
    by_role: dict[str, dict[str, list[tuple[int, int]]]] = {
        role: {stage: [] for stage in NATIVE_STAGES} for role in PARENT_STAGES
    }
    unowned = []
    for row in native:
        interval = (row["start"], row["end"])
        enclosing = [
            parent for parent in parents
            if parent["start"] <= row["start"] and row["end"] <= parent["end"]
        ]
        if not enclosing:
            unowned.append(row)
            continue
        parent = min(enclosing, key=lambda value: value["end"] - value["start"])
        by_role[_message_stage(parent["message"])][row["message"]].append(interval)

    roles: dict[str, Any] = {}
    missing = []
    for role, stages in by_role.items():
        parent_intervals = [
            (row["start"], row["end"])
            for row in parents
            if _message_stage(row["message"]) == role
        ]
        native_union = _merge(interval for values in stages.values() for interval in values)
        parent_ns = _duration(parent_intervals)
        stage_rows = {}
        for stage, intervals in stages.items():
            if role in expected_native_roles and not intervals:
                missing.append(f"{role}:{stage}")
            exclusive = intervals
            if stage == "trt.input_prepare":
                exclusive = _subtract(intervals, stages["trt.host_to_device"])
            stage_rows[stage] = {
                "calls": len(intervals),
                "summedServiceMs": sum(end - start for start, end in intervals) / 1_000_000,
                "occupiedUnionMs": _duration(intervals) / 1_000_000,
                "exclusiveOccupiedUnionMs": _duration(exclusive) / 1_000_000,
                "meanServiceUs": (
                    sum(end - start for start, end in intervals) / len(intervals) / 1_000
                    if intervals else 0.0
                ),
            }
        native_ns = _duration(_intersections(native_union, parent_intervals))
        coverage = 100 * native_ns / parent_ns if parent_ns else 0
        roles[role] = {
            "backend": role_backends.get(role),
            "nativeMarkersExpected": role in expected_native_roles,
            "backendOccupiedUnionMs": parent_ns / 1_000_000,
            "nativeCoveragePercent": coverage,
            "unattributedOccupiedMs": max(0, parent_ns - native_ns) / 1_000_000,
            "unattributedPercent": 100 * max(0, parent_ns - native_ns) / parent_ns if parent_ns else 0,
            "stages": stage_rows,
        }

    recognizer = roles["recognizer.backend"]
    shares = {
        stage: 100 * values["exclusiveOccupiedUnionMs"] / recognizer["backendOccupiedUnionMs"]
        if recognizer["backendOccupiedUnionMs"] else 0
        for stage, values in recognizer["stages"].items()
    }
    dominant = max(shares, key=shares.get)
    reasons = list(lifetime["reasons"])
    if unowned:
        reasons.append(f"{len(unowned)} native ranges lack a detector/recognizer backend parent")
    if missing:
        reasons.append(f"missing native marker observations: {missing}")
    if not expected_native_roles:
        reasons.append("no TensorRT backend role was attested")
    elif min(roles[role]["nativeCoveragePercent"] for role in expected_native_roles) < 80:
        reasons.append("native phases cover less than 80% of a TensorRT backend")
    correctness = compare_output(results_path)
    if not correctness.get("verdict", {}).get("pass"):
        reasons.append("owner-approved trusted-output correctness gate failed")
    passed = not reasons
    decision = {
        "row": dominant if shares[dominant] >= 20 and passed else "insufficient-native-visibility",
        "recognizerExclusiveSharePercent": shares,
        "rule": "largest exclusive recognizer phase must reach 20% with complete marker and 80% coverage gates",
    }
    return {
        "schemaVersion": "pagespatial-gpu-instrumentation-m3-analysis-v1",
        "pass": passed,
        "verdict": {"pass": passed, "reasons": reasons},
        "lifetime": lifetime,
        "captureWallMs": (window[1] - window[0]) / 1_000_000,
        "roles": roles,
        "decision": decision,
        "correctness": correctness,
        "limitations": [
            "durations are diagnostic when profiler overhead exceeds 15%",
            "input preparation is reported exclusive of its nested host-to-device copies",
            "native TensorRT marker coverage is required only for roles attested as TensorRT",
            "activity statements apply only to the traced PageSpatial CUDA context",
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sqlite", type=Path, required=True)
    parser.add_argument("--results", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = analyze(args.sqlite, args.results)
    args.output.write_text(json.dumps(result, indent=1) + "\n")
    if not result["verdict"]["pass"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()

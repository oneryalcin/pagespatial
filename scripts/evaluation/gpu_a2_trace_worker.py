#!/usr/bin/env python3
"""Child launch boundary for the shared A2 execution core.

The worker contains no page loop. It hydrates one A2ExecutionCore, then calls
that core for every request in the bounded manifest. Nsight Systems will later
launch this exact worker so its process tree owns all measured CUDA work.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from gpu_a2_modal import A2ExecutionCore
from gpu_instrumentation_capture import plan_for_mode


def _payload(request: dict, capture_plan: dict | None = None) -> dict:
    payload = {
        "run_id": request["run_id"],
        "pdf_bytes": Path(request["pdf_path"]).read_bytes(),
        "native_evidence_bytes": Path(request["native_evidence_path"]).read_bytes(),
        "native_evidence_sha256": request["native_evidence_sha256"],
        "expected_sha256": request["expected_sha256"],
        "expected_pages": request["expected_pages"],
    }
    if capture_plan is not None:
        payload["capture_plan"] = capture_plan
    return payload


def _validate_requests(requests: object, mode: str) -> list[dict]:
    expected_labels = {
        "m1": ["child-cold", "child-warm"],
        "m2-systems": ["warmup", "control-before", "trace", "control-after"],
        "m2-systems-short": [
            "warmup",
            "control-before",
            "trace",
            "control-after",
        ],
        "m2-cpu": ["warmup", "control-before", "trace", "control-after"],
        "m3-native": ["warmup", "control-before", "trace", "control-after"],
    }[mode]
    if not isinstance(requests, list) or len(requests) != len(expected_labels):
        raise ValueError(
            f"{mode} trace worker requires exactly {len(expected_labels)} requests"
        )
    labels = [request.get("label") for request in requests]
    if mode != "m1" and labels != expected_labels:
        raise ValueError(f"{mode} request labels must be {expected_labels}")
    return requests


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--requests", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--mode",
        choices=("m1", "m2-systems", "m2-systems-short", "m2-cpu", "m3-native"),
        default="m1",
    )
    args = parser.parse_args()
    requests = _validate_requests(json.loads(args.requests.read_text()), args.mode)
    capture_plan = plan_for_mode(args.mode)

    core = A2ExecutionCore()
    core.start_owner()
    results = []
    for index, request in enumerate(requests, start=1):
        if args.mode == "m1":
            result = core.parse_document(_payload(request))
        else:
            request_capture = capture_plan if index == 3 else None
            result = core.parse_document(_payload(request, request_capture))
        result["launch"] = {
            "boundary": "shared-core-child",
            "workerPid": os.getpid(),
            "sequenceIndex": index,
            "sequenceLabel": request.get("label"),
            "mode": args.mode,
            "coreClass": "gpu_a2_modal.A2ExecutionCore",
        }
        results.append(result)
    args.output.write_text(json.dumps(results, separators=(",", ":")))


if __name__ == "__main__":
    main()

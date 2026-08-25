#!/usr/bin/env python3
"""Run one bounded M3 native-NVTX capture in the instrumented image."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from run_gpu_instrumentation_m2_container import _profile, _utc


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--requests", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    result = {
        "schemaVersion": "pagespatial-gpu-instrumentation-m3-container-run-v1",
        "startedAtUtc": _utc(),
        "status": "running",
    }
    record = args.output_dir / "m3-container-run.json"
    try:
        result["systems"] = _profile(
            output_dir=args.output_dir,
            name="m3-native",
            capture_name="m3.native.capture",
            repeat=1,
            mode="m3-native",
            requests=args.requests,
            cpu_sampling=False,
        )
        result["status"] = "completed"
    except BaseException as error:
        result["status"] = "failed"
        result["error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        result["endedAtUtc"] = _utc()
        record.write_text(json.dumps(result, indent=1) + "\n")


if __name__ == "__main__":
    main()

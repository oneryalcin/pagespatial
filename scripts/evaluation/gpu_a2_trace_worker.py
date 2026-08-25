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


def _payload(request: dict) -> dict:
    return {
        "run_id": request["run_id"],
        "pdf_bytes": Path(request["pdf_path"]).read_bytes(),
        "native_evidence_bytes": Path(request["native_evidence_path"]).read_bytes(),
        "native_evidence_sha256": request["native_evidence_sha256"],
        "expected_sha256": request["expected_sha256"],
        "expected_pages": request["expected_pages"],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--requests", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    requests = json.loads(args.requests.read_text())
    if not isinstance(requests, list) or len(requests) != 2:
        raise ValueError("M1 trace worker requires exactly two requests")

    core = A2ExecutionCore()
    core.start_owner()
    results = []
    for index, request in enumerate(requests, start=1):
        result = core.parse_document(_payload(request))
        result["launch"] = {
            "boundary": "shared-core-child",
            "workerPid": os.getpid(),
            "sequenceIndex": index,
            "coreClass": "gpu_a2_modal.A2ExecutionCore",
        }
        results.append(result)
    args.output.write_text(json.dumps(results, separators=(",", ":")))


if __name__ == "__main__":
    main()

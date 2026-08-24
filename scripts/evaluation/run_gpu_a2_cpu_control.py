#!/usr/bin/env python3
"""Run the adopted CPU Modal parser on the frozen A2 50-page workload.

The control app must be deployed under a unique name first. This runner always
stops that named app in `finally`, then proves it has no active tasks.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import statistics
import subprocess
import time
import uuid
from pathlib import Path

import modal

from gpu_a2_budget import DEFAULT_LEDGER, validate_reservation


SCHEMA_VERSION = "0.6.0"
EXPECTED_PAGES = 50
EXPECTED_CPU_RESOURCES = {
    "cpu": 4.0,
    "memory_mib": 24576,
    "workers": 4,
    "sidecar_threads": 1,
}


def stop_and_verify(app_name: str) -> None:
    subprocess.run(
        ["modal", "app", "stop", "--yes", app_name],
        check=False,
        capture_output=True,
        text=True,
        timeout=120,
    )
    deadline = time.monotonic() + 30
    active = []
    while time.monotonic() < deadline:
        rows = json.loads(
            subprocess.run(
                ["modal", "app", "list", "--json"],
                check=True,
                capture_output=True,
                text=True,
                timeout=120,
            ).stdout
        )
        active = [
            row for row in rows
            if row.get("description") == app_name
            and (row.get("state") != "stopped" or str(row.get("tasks", "0")) != "0")
        ]
        if not active:
            return
        time.sleep(1)
    raise RuntimeError(f"CPU control app did not drain within 30s: {active}")


def container_snapshot(app_name: str, expected_app_id: str) -> list[dict]:
    deadline = time.monotonic() + 10
    mine = []
    while time.monotonic() < deadline:
        rows = json.loads(
            subprocess.run(
                ["modal", "container", "list", "--json"],
                check=True,
                capture_output=True,
                text=True,
                timeout=120,
            ).stdout
        )
        mine = [row for row in rows if row.get("app_name") == app_name]
        if len(mine) == 1:
            break
        time.sleep(0.5)
    if len(mine) != 1:
        raise RuntimeError(f"expected one live CPU control container, found {mine}")
    if mine[0].get("app_id") not in {None, expected_app_id}:
        raise RuntimeError(f"CPU container app id drift: {mine[0].get('app_id')}")
    if not mine[0].get("container_id"):
        raise RuntimeError("CPU container snapshot has no container_id")
    return mine


def attest_result(
    result: dict, *, app_name: str, document_sha256: str,
    adapter_revision: str, image_pin_revision: str, model_pins: dict,
) -> None:
    if result.get("app_name") != app_name or result.get("document_sha256") != document_sha256:
        raise RuntimeError("CPU control app/document identity drift")
    if result.get("adapter_revision") != adapter_revision:
        raise RuntimeError(f"CPU adapter revision drift: {result.get('adapter_revision')!r}")
    if result.get("image_pin_revision") != image_pin_revision:
        raise RuntimeError(f"CPU image pin drift: {result.get('image_pin_revision')!r}")
    for entry in result.get("pages", []):
        provenance = entry.get("pageSpatial", {}).get("provenance", {})
        backend = provenance.get("configuration", {}).get("ocrBackend", {})
        pins = backend.get("modelPins")
        engine_evidence = backend.get("engineEvidence", {})
        observed = {
            "provenance.backend": provenance.get("backend"),
            "executionProvider": backend.get("executionProvider"),
            "hpiRequested": backend.get("hpiRequested"),
            "useHpip": backend.get("useHpip"),
            "modelPins": pins,
            "engineEvidence": engine_evidence,
        }
        expected = {
            "provenance.backend": "hpi",
            "executionProvider": "hpi",
            "hpiRequested": True,
            "useHpip": True,
            "modelPins": model_pins,
            "engineEvidence.source": "log-derived (child stderr)",
            "engineEvidence.lineContains": "Backend::OPENVINO",
        }
        if (
            observed["provenance.backend"] != "hpi"
            or observed["executionProvider"] != "hpi"
            or observed["hpiRequested"] is not True
            or observed["useHpip"] is not True
            or observed["modelPins"] != model_pins
            or engine_evidence.get("source") != "log-derived (child stderr)"
            or "Backend::OPENVINO" not in str(engine_evidence.get("line", ""))
        ):
            raise RuntimeError(
                "CPU HPI/OpenVINO/model-pin attestation failed on page "
                f"{entry.get('pageNumber')}: observed={json.dumps(observed, sort_keys=True)}; "
                f"expected={json.dumps(expected, sort_keys=True)}"
            )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", required=True)
    parser.add_argument("--pdf-path", required=True, type=Path)
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument("--repeats", type=int, default=4)
    parser.add_argument("--reservation", required=True)
    parser.add_argument("--ledger", type=Path, default=DEFAULT_LEDGER)
    parser.add_argument("--expected-app-id", required=True)
    parser.add_argument("--expected-adapter-revision", required=True)
    parser.add_argument("--expected-image-pin-revision", required=True)
    args = parser.parse_args()
    if args.repeats != 4:
        raise SystemExit("E1 requires exactly four calls: one cold plus three warm")
    if not args.app.startswith("pagespatial-gpu-a2-"):
        raise SystemExit("refusing to operate on a non-A2 app name")
    validate_reservation(args.ledger, args.reservation, "E1-CPU")
    repo_root = Path(__file__).resolve().parents[2]
    manifest = json.loads(
        (repo_root / "evaluation/gpu-spike/a2-50page-v1.json").read_text()
    )
    pin_manifest = json.loads((repo_root / "service/sidecar/model-pins.json").read_text())
    expected_model_pins = {
        repo: descriptor["revision"] for repo, descriptor in pin_manifest["repos"].items()
    }
    pdf = args.pdf_path.read_bytes()
    sha = hashlib.sha256(pdf).hexdigest()
    if sha != manifest["output"]["sha256"] or len(pdf) != manifest["output"]["bytes"]:
        raise SystemExit("CPU control PDF does not match the frozen A2 workload")

    run_id = f"{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}-{uuid.uuid4().hex[:8]}"
    run_dir = args.out_dir / run_id
    run_dir.mkdir(parents=True, exist_ok=False)
    metadata = {
        "schemaVersion": "pagespatial-gpu-a2-cpu-control-v1",
        "runId": run_id,
        "appName": args.app,
        "workload": manifest,
        "repeats": args.repeats,
        "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "reservationId": args.reservation,
        "expectedAppId": args.expected_app_id,
    }
    (run_dir / "run.json").write_text(json.dumps(metadata, indent=1) + "\n")
    results = []
    try:
        parser_cls = modal.Cls.from_name(args.app, "ParseContainer").with_options(
            retries=0, max_containers=1
        )()
        container_ids = []
        for repeat in range(1, args.repeats + 1):
            started = time.monotonic()
            result = parser_cls.parse_document.remote(
                {
                    "request_id": f"{run_id}-cpu-r{repeat}",
                    "pdf_bytes": pdf,
                    "source_uri": "gpu-a2/a2-50page-v1",
                    "expected_sha256": sha,
                    "schema_version": SCHEMA_VERSION,
                    "enrichment": "off",
                }
            )
            client_wall_s = time.monotonic() - started
            # Preserve the exact returned record before any local assertion.
            # A failed attestation is evidence about the deployment and must
            # not be reduced to an exception string with the record discarded.
            received_path = run_dir / f"cpu-repeat-{repeat}.received.json"
            received_path.write_text(json.dumps(result, indent=1) + "\n")
            if result.get("status") != "completed" or result.get("page_count") != EXPECTED_PAGES:
                raise RuntimeError(f"CPU control did not complete 50 pages: {result.get('failure')}")
            if len(result.get("pages", [])) != EXPECTED_PAGES or result.get("pages_failed") != 0:
                raise RuntimeError("CPU control terminal pages did not reconcile")
            if result.get("resources") != EXPECTED_CPU_RESOURCES:
                raise RuntimeError(f"CPU control resource drift: {result.get('resources')}")
            attest_result(
                result,
                app_name=args.app,
                document_sha256=sha,
                adapter_revision=args.expected_adapter_revision,
                image_pin_revision=args.expected_image_pin_revision,
                model_pins=expected_model_pins,
            )
            snapshot = container_snapshot(args.app, args.expected_app_id)
            container_ids.append(snapshot[0]["container_id"])
            result["client"] = {
                "repeat": repeat,
                "spawnToResultS": client_wall_s,
                "inclusivePagesPerS": EXPECTED_PAGES / client_wall_s,
            }
            result["modelVerification"] = {
                "detector": {
                    "repo": "PaddlePaddle/PP-OCRv6_small_det",
                    "revision": pin_manifest["repos"]["PaddlePaddle/PP-OCRv6_small_det"]["revision"],
                    "files": {
                        name: digest for name, digest in
                        pin_manifest["repos"]["PaddlePaddle/PP-OCRv6_small_det"]["files"].items()
                        if name.startswith("inference.")
                    },
                },
                "recognizer": {
                    "repo": "PaddlePaddle/PP-OCRv6_small_rec",
                    "revision": pin_manifest["repos"]["PaddlePaddle/PP-OCRv6_small_rec"]["revision"],
                    "files": {
                        name: digest for name, digest in
                        pin_manifest["repos"]["PaddlePaddle/PP-OCRv6_small_rec"]["files"].items()
                        if name.startswith("inference.")
                    },
                },
                "evidence": "adopted image pin manifest; sidecar boot verified model pins",
            }
            path = run_dir / f"cpu-repeat-{repeat}.json"
            path.write_text(json.dumps(result, indent=1) + "\n")
            received_path.unlink()
            results.append(result)
            print(
                f"repeat {repeat}: {result['client']['inclusivePagesPerS']:.3f} terminal pages/s; "
                f"parse={result['timing']['parse_ms'] / 1000:.1f}s; "
                f"client={client_wall_s:.1f}s -> {path}",
                flush=True,
            )
        cold_pattern = [result["timing"]["container_cold"] for result in results]
        if cold_pattern != [True, False, False, False] or len(set(container_ids)) != 1:
            raise RuntimeError(
                f"CPU warm-lifetime proof failed: cold={cold_pattern}, containers={container_ids}"
            )
    finally:
        stop_and_verify(args.app)
    metadata["completedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    metadata["summary"] = {
        "medianInclusivePagesPerS": statistics.median(
            result["client"]["inclusivePagesPerS"] for result in results
        ),
        "warmReuse": {
            "coldPattern": [result["timing"]["container_cold"] for result in results],
            "containerIds": container_ids,
        },
    }
    (run_dir / "run.json").write_text(json.dumps(metadata, indent=1) + "\n")
    print(f"evidence={run_dir}")


if __name__ == "__main__":
    main()

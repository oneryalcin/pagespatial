#!/usr/bin/env python3
"""Measure one-document page scaling on the deployed Modal parse service.

The harness duplicates one source PDF page into 1/4/20/100-page documents,
submits them sequentially to one ParseContainer instance, and writes only
timing/count/resource summaries. It deliberately does not persist OCR text or
PageSpatial records.

Run one process per fresh container lifetime. Stop the dev-app container
between runs when measuring snapshot-restored repeats.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import shutil
import statistics
import subprocess
import tempfile
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import modal


DEFAULT_PAGE_COUNTS = (1, 4, 20, 100)
SCHEMA_VERSION = "0.6.0"


def percentile(values: list[float], quantile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, math.ceil(quantile * len(ordered)) - 1)
    return round(ordered[max(0, index)], 3)


def duplicate_page(source: Path, page_count: int, output: Path) -> None:
    pages = ",".join("1" for _ in range(page_count))
    subprocess.run(
        ["qpdf", str(source), "--pages", ".", pages, "--", str(output)],
        check=True,
        stdout=subprocess.DEVNULL,
    )


def summarize_result(page_count: int, pdf_bytes: bytes, result: dict[str, Any],
                     client_wall_s: float) -> dict[str, Any]:
    if result.get("status") != "completed":
        raise RuntimeError(
            f"{page_count}-page call failed: {result.get('failure')!r}")
    if result.get("page_count") != page_count:
        raise RuntimeError(
            f"expected {page_count} pages, received {result.get('page_count')!r}")
    pages = result.get("pages")
    if not isinstance(pages, list) or len(pages) != page_count:
        raise RuntimeError(
            f"expected {page_count} returned pages, received {len(pages or [])}")

    page_wall_ms = [
        float(page["wallMs"])
        for page in pages
        if isinstance(page.get("wallMs"), (int, float))
    ]
    rss_bytes = [
        int(page["rssBytes"])
        for page in pages
        if isinstance(page.get("rssBytes"), int)
    ]
    stage_totals_ms: dict[str, float] = {}
    for page in pages:
        for stage, value in (page.get("stageTimingsMs") or {}).items():
            if isinstance(value, (int, float)):
                stage_totals_ms[stage] = stage_totals_ms.get(stage, 0.0) + value

    timing = result["timing"]
    parse_ms = float(timing["parse_ms"])
    total_method_ms = float(timing["total_method_ms"])
    client_wall_ms = client_wall_s * 1000
    resources = result.get("resources") or {}
    memory_mib = int(resources.get("memory_mib", 0))
    return {
        "page_count": page_count,
        "input_bytes": len(pdf_bytes),
        "status": result["status"],
        "pages_ok": result["pages_ok"],
        "pages_failed": result["pages_failed"],
        "container_cold": timing["container_cold"],
        "service_ready_ms": timing["service_ready_ms"],
        "parse_ms": timing["parse_ms"],
        "total_method_ms": timing["total_method_ms"],
        "client_wall_ms": round(client_wall_ms, 3),
        "client_outside_method_ms": round(max(0.0, client_wall_ms - total_method_ms), 3),
        "parse_pages_per_s": round(page_count / (parse_ms / 1000), 4),
        "client_pages_per_s": round(page_count / client_wall_s, 4),
        "allocated_cpu_seconds_method": round(4 * total_method_ms / 1000, 3),
        "allocated_gib_seconds_method": (
            round((memory_mib / 1024) * total_method_ms / 1000, 3)
            if memory_mib else None
        ),
        "page_wall_ms": {
            "sum": round(sum(page_wall_ms), 3),
            "mean": round(statistics.fmean(page_wall_ms), 3),
            "p50": percentile(page_wall_ms, 0.50),
            "p95": percentile(page_wall_ms, 0.95),
            "max": round(max(page_wall_ms), 3),
        } if page_wall_ms else None,
        "effective_worker_parallelism": (
            round(sum(page_wall_ms) / parse_ms, 3) if page_wall_ms and parse_ms else None
        ),
        "node_worker_rss_peak_mib": (
            round(max(rss_bytes) / 1048576, 3) if rss_bytes else None
        ),
        "stage_service_ms": {
            key: round(value, 3) for key, value in sorted(stage_totals_ms.items())
        },
        "modal": result.get("retry"),
        "resources": resources,
        "memory": result.get("memory"),
        "adapter_revision": result.get("adapter_revision"),
        "image_pin_revision": result.get("image_pin_revision"),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--app", default="pagespatial-parse-m5-dev")
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument(
        "--pages", default=",".join(map(str, DEFAULT_PAGE_COUNTS)),
        help="comma-separated page counts in execution order",
    )
    parser.add_argument("--label", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    if shutil.which("qpdf") is None:
        raise RuntimeError("qpdf is required to duplicate the source page")
    source = args.source.resolve()
    if not source.is_file():
        raise FileNotFoundError(source)
    page_counts = tuple(int(value) for value in args.pages.split(","))
    if not page_counts or any(value <= 0 for value in page_counts):
        raise ValueError("--pages must contain positive page counts")

    remote = modal.Cls.from_name(args.app, "ParseContainer")()
    started_at = datetime.now(UTC).isoformat()
    summaries: list[dict[str, Any]] = []
    with tempfile.TemporaryDirectory(prefix="pagespatial-page-scaling-") as raw_tmp:
        tmp = Path(raw_tmp)
        for page_count in page_counts:
            pdf_path = tmp / f"repeated-{page_count}.pdf"
            duplicate_page(source, page_count, pdf_path)
            pdf_bytes = pdf_path.read_bytes()
            digest = hashlib.sha256(pdf_bytes).hexdigest()
            payload = {
                "request_id": f"page-scaling-{args.label}-{page_count}-{uuid.uuid4()}",
                "pdf_bytes": pdf_bytes,
                "source_uri": "generated:repeated-corpus-page-1",
                "expected_sha256": digest,
                "schema_version": SCHEMA_VERSION,
                "enrichment": "off",
            }
            t0 = time.monotonic()
            call = remote.parse_document.spawn(payload)
            result = call.get()
            client_wall_s = time.monotonic() - t0
            summary = summarize_result(page_count, pdf_bytes, result, client_wall_s)
            summaries.append(summary)
            print(json.dumps(summary, sort_keys=True), flush=True)

    output = {
        "schema_version": 1,
        "experiment": "one-document-repeated-page-scaling",
        "label": args.label,
        "started_at": started_at,
        "completed_at": datetime.now(UTC).isoformat(),
        "app": args.app,
        "source": str(source),
        "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "source_page": 1,
        "execution_order": list(page_counts),
        "results": summaries,
        "scope": {
            "content_persisted": False,
            "effective_worker_parallelism": "sum(page wall ms) / parse wall ms",
            "allocated_resource_seconds": "configured resources times method wall; not a Modal invoice",
            "rss": "Node worker RSS reported at page completion; excludes Python OCR sidecars",
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, indent=2) + "\n")
    print(f"wrote {args.output}")


if __name__ == "__main__":
    main()

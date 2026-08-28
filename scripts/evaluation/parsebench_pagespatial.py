"""ParseBench adapter for the deterministic PageSpatial Basic tier.

This file is intentionally outside the pinned ParseBench checkout. Run it with
ParseBench on ``PYTHONPATH`` so upstream code and data revisions stay immutable.
"""

from __future__ import annotations

import hashlib
import os
import re
import sys
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import modal
from parse_bench.cli import main as parsebench_main
from parse_bench.evaluation.layout_adapters import register_layout_adapter
from parse_bench.evaluation.layout_adapters.adapters import OIParserLayoutAdapter
from parse_bench.inference.pipelines import register_pipeline
from parse_bench.inference.providers.base import (
    Provider,
    ProviderPermanentError,
    ProviderTransientError,
)
from parse_bench.inference.providers.registry import register_provider
from parse_bench.schemas.parse_output import (
    LayoutItemIR,
    LayoutSegmentIR,
    PageIR,
    ParseLayoutPageIR,
    ParseOutput,
)
from parse_bench.schemas.pipeline import PipelineSpec
from parse_bench.schemas.pipeline_io import (
    InferenceRequest,
    InferenceResult,
    RawInferenceResult,
)
from parse_bench.schemas.product import ProductType

PIPELINE_NAME = "pagespatial_basic"
PROVIDER_NAME = "pagespatial"
SCHEMA_VERSION = "0.6.0"
DEFAULT_MODAL_APP = "pagespatial-parse-m5-dev"
_NATIVE_REFERENCE = re.compile(r"^## Native structure reference\s*$", re.MULTILINE)


def _native_structure_reference(markdown: str) -> str:
    """Return the final native projection without parsing its document headings."""
    marker = _NATIVE_REFERENCE.search(markdown)
    return markdown[marker.end() :].strip() if marker else ""


def _unmatched_ocr_rows(page: dict[str, Any]) -> list[dict[str, Any]]:
    matched = {item.get("ocrId") for item in page.get("sourceMatches", [])}
    return [
        row
        for row in page.get("spatialRows", [])
        if any(source_id not in matched for source_id in row.get("sourceIds", []))
    ]


def _pipe_tables_to_html(markdown: str) -> str:
    import markdown2

    output: list[str] = []
    table: list[str] = []

    def flush() -> None:
        if not table:
            return
        rendered = markdown2.markdown("\n".join(table), extras=["tables"]).strip()
        output.append(rendered if "<table" in rendered.lower() else "\n".join(table))
        table.clear()

    for line in markdown.splitlines():
        if line.lstrip().startswith("|") and "|" in line.lstrip()[1:]:
            table.append(line)
        else:
            flush()
            output.append(line)
    flush()
    return "\n".join(output).strip()


def benchmark_markdown(page: dict[str, Any]) -> str:
    """Project evidence into ParseBench content without PageSpatial metadata."""
    projection = page.get("projection") or {}
    native = _native_structure_reference(str(projection.get("markdown") or ""))
    if not native:
        native = "\n".join(str(line.get("text") or "").strip() for line in page.get("nativeLines", [])).strip()

    recovered = "\n".join(str(row.get("text") or "").strip() for row in _unmatched_ocr_rows(page)).strip()
    parts = [part for part in (native, recovered) if part]

    relations = [
        relation
        for relation in page.get("derivedRelations", [])
        if relation.get("kind") == "chart-category-value"
        and (relation.get("attributes") or {}).get("category")
        and (relation.get("attributes") or {}).get("value")
    ]
    if relations:
        table = ["| Category | Value |", "| --- | ---: |"]
        table.extend(
            f"| {(relation['attributes']['category'])} | {(relation['attributes']['value'])} |"
            for relation in relations
        )
        parts.append("\n".join(table))

    return _pipe_tables_to_html("\n\n".join(parts))


def _layout_box(box: Any, width: float, height: float) -> LayoutSegmentIR | None:
    if not isinstance(box, list) or len(box) != 4 or width <= 0 or height <= 0:
        return None
    x1, y1, x2, y2 = (float(value) for value in box)
    return LayoutSegmentIR(
        x=max(0.0, min(width, x1)),
        y=max(0.0, min(height, y1)),
        w=max(0.0, min(width - x1, x2 - x1)),
        h=max(0.0, min(height - y1, y2 - y1)),
        label="Text",
    )


def layout_page(page: dict[str, Any], markdown: str) -> ParseLayoutPageIR:
    geometry = page.get("geometry") or {}
    width = float(geometry.get("width") or 1)
    height = float(geometry.get("height") or 1)
    rows = [*page.get("nativeLines", []), *_unmatched_ocr_rows(page)]
    items: list[LayoutItemIR] = []
    for row in rows:
        text = str(row.get("text") or "").strip()
        box = _layout_box(row.get("box"), width, height)
        if text and box is not None:
            items.append(LayoutItemIR(type="text", md=text, value=text, bbox=box, layout_segments=[box]))
    return ParseLayoutPageIR(
        page_number=int(page["pageNumber"]),
        width=width,
        height=height,
        md=markdown,
        text=markdown,
        items=items,
    )


@register_layout_adapter(PROVIDER_NAME, priority=100)
class PageSpatialLayoutAdapter(OIParserLayoutAdapter):
    """Read typed absolute-pixel layout pages, never the vendor raw payload."""


@register_provider(PROVIDER_NAME)
class PageSpatialProvider(Provider):
    """Call the deployed deterministic PageSpatial Modal method."""

    def __init__(self, provider_name: str, base_config: dict[str, Any] | None = None):
        super().__init__(provider_name, base_config)
        app_name = os.getenv("PAGESPATIAL_PARSEBENCH_MODAL_APP", DEFAULT_MODAL_APP)
        self._remote = modal.Cls.from_name(app_name, "ParseContainer")()

    def run_inference(self, pipeline: PipelineSpec, request: InferenceRequest) -> RawInferenceResult:
        if request.product_type != ProductType.PARSE:
            raise ProviderPermanentError(f"PageSpatial supports PARSE, not {request.product_type}")
        path = Path(request.source_file_path)
        if not path.is_file():
            raise ProviderPermanentError(f"File not found: {path}")
        pdf_bytes = path.read_bytes()
        started_at = datetime.now(UTC)
        payload = {
            "request_id": f"parsebench-{request.example_id}-{uuid.uuid4()}",
            "pdf_bytes": pdf_bytes,
            "source_uri": "parsebench:pinned-test-data",
            "expected_sha256": hashlib.sha256(pdf_bytes).hexdigest(),
            "schema_version": SCHEMA_VERSION,
            "enrichment": "off",
        }
        try:
            result = self._remote.parse_document.remote(payload)
        except modal.exception.FunctionTimeoutError as error:
            raise ProviderTransientError("PageSpatial Modal call timed out") from error
        except modal.exception.RemoteError as error:
            raise ProviderPermanentError("PageSpatial worker rejected the document") from error
        except Exception as error:
            raise ProviderTransientError(f"PageSpatial Modal call unavailable: {type(error).__name__}") from error
        completed_at = datetime.now(UTC)
        if result.get("status") != "completed":
            raise ProviderPermanentError(f"PageSpatial parse status was {result.get('status')!r}")
        pages = result.get("pages")
        if not isinstance(pages, list) or result.get("pages_failed"):
            raise ProviderPermanentError("PageSpatial did not complete every page")
        records = []
        for page in pages:
            record = page.get("pageSpatial")
            if not isinstance(record, dict):
                raise ProviderPermanentError("PageSpatial result omitted a page record")
            records.append(record)
        raw_output = {
            "pages": records,
            "page_count": result.get("page_count"),
            "timing": result.get("timing"),
            "resources": result.get("resources"),
            "adapter_revision": result.get("adapter_revision"),
            "image_pin_revision": result.get("image_pin_revision"),
        }
        return RawInferenceResult(
            request=request,
            pipeline=pipeline,
            pipeline_name=pipeline.pipeline_name,
            product_type=request.product_type,
            raw_output=raw_output,
            started_at=started_at,
            completed_at=completed_at,
            latency_in_ms=int((completed_at - started_at).total_seconds() * 1000),
        )

    def normalize(self, raw_result: RawInferenceResult) -> InferenceResult:
        pages: list[PageIR] = []
        layout_pages: list[ParseLayoutPageIR] = []
        for index, page in enumerate(raw_result.raw_output["pages"]):
            markdown = benchmark_markdown(page)
            pages.append(PageIR(page_index=index, markdown=markdown))
            layout_pages.append(layout_page(page, markdown))
        output = ParseOutput(
            example_id=raw_result.request.example_id,
            pipeline_name=raw_result.pipeline_name,
            pages=pages,
            layout_pages=layout_pages,
            markdown="\n\n".join(page.markdown for page in pages),
        )
        return InferenceResult(
            request=raw_result.request,
            pipeline_name=raw_result.pipeline_name,
            product_type=raw_result.product_type,
            raw_output=raw_result.raw_output,
            output=output,
            started_at=raw_result.started_at,
            completed_at=raw_result.completed_at,
            latency_in_ms=raw_result.latency_in_ms,
        )


register_pipeline(
    PipelineSpec(
        pipeline_name=PIPELINE_NAME,
        provider_name=PROVIDER_NAME,
        product_type=ProductType.PARSE,
        config={"tier": "basic", "enrichment": "off"},
    )
)


if __name__ == "__main__":
    sys.exit(parsebench_main())

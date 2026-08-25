#!/usr/bin/env python3
"""Evaluation-only stage profiler for the pinned PaddleX OCR pipeline.

The profiler records synchronous Python-visible boundaries. A backend call
includes input copies, native inference, output copies, and synchronization;
it is deliberately not labelled as pure GPU-kernel time.
"""

from __future__ import annotations

import contextlib
import hashlib
import inspect
import math
import os
import statistics
import threading
import time
from collections.abc import Iterator, MutableMapping
from pathlib import Path
from typing import Any, Callable


NVTX_STAGE_NAMES = {
    "png.decode": "page.decode",
    "predict.total": "predict.total",
    "detector.backend": "detector.backend",
    "detector.postprocess": "detector.postprocess",
    "crop.total": "crop.generate",
    "recognizer.backend": "recognizer.backend",
    "recognizer.postprocess": "recognizer.decode",
}


def _nvtx_stage(stage: str) -> str | None:
    if stage.startswith("detector.preprocess.") or stage == "detector.batch_sampler":
        return "detector.prepare"
    if stage.startswith("recognizer.preprocess."):
        return "recognizer.prepare"
    return NVTX_STAGE_NAMES.get(stage)


def _percentile(values: list[float], percentile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    rank = (len(ordered) - 1) * percentile
    lower = math.floor(rank)
    upper = math.ceil(rank)
    if lower == upper:
        return ordered[lower]
    fraction = rank - lower
    return ordered[lower] + (ordered[upper] - ordered[lower]) * fraction


class StageProfiler:
    """One-owner recorder. An owner processes at most one page at a time."""

    def __init__(self, owner_index: int) -> None:
        self.owner_index = owner_index
        self._local = threading.local()
        self._method_started_ns = 0
        self.instrumented_paths: list[dict[str, str]] = []
        self.missing_paths: list[str] = []
        self._nvtx = None
        self._nvtx_domain = None
        self.recognizer_last_prepare_stage: str | None = None
        if os.environ.get("PAGESPATIAL_A2_NVTX", "0") == "1":
            import nvtx

            self._nvtx = nvtx
            self._nvtx_domain = nvtx.Domain("pagespatial.ocr")

    def _nvtx_start(self, message: str) -> Any:
        if self._nvtx_domain is None:
            return None
        return self._nvtx_domain.start_range(message=message)

    def _nvtx_end(self, handle: Any) -> None:
        if self._nvtx_domain is not None and handle is not None:
            self._nvtx_domain.end_range(handle)

    def begin_method(self, started_ns: int | None = None) -> None:
        self._method_started_ns = started_ns or time.monotonic_ns()

    def begin_page(
        self, page_number: int, message_id: str, run_id: str | None = None
    ) -> None:
        if getattr(self._local, "page", None) is not None:
            raise RuntimeError("stage profiler owner already has an active page")
        self._local.page = {
            "pageNumber": page_number,
            "messageId": message_id,
            "ownerIndex": self.owner_index,
            "runId": run_id,
            "startedNs": time.monotonic_ns(),
            "events": [],
            "stack": [],
            "recognitionBatchOrdinal": 0,
            "recognitionCropCount": None,
        }

    def finish_page(self) -> dict[str, Any]:
        page = getattr(self._local, "page", None)
        if page is None:
            raise RuntimeError("stage profiler owner has no active page")
        if page["stack"]:
            raise RuntimeError(f"stage profiler has unfinished spans: {page['stack']}")
        self._close_recognizer_wait()
        ended_ns = time.monotonic_ns()
        record = {
            "pageNumber": page["pageNumber"],
            "messageId": page["messageId"],
            "ownerIndex": page["ownerIndex"],
            "wallMs": (ended_ns - page["startedNs"]) / 1_000_000,
            "events": page["events"],
        }
        self._local.page = None
        return record

    def abort_page(self) -> None:
        self._close_recognizer_wait()
        self._local.page = None

    def _close_recognizer_wait(self) -> None:
        handle = getattr(self._local, "recognizer_wait_handle", None)
        self._nvtx_end(handle)
        self._local.recognizer_wait_handle = None

    def _start_recognizer_wait(self, page: dict[str, Any]) -> None:
        if self._nvtx is None:
            return
        if getattr(self._local, "recognizer_wait_handle", None) is not None:
            raise RuntimeError("recognizer wait range is already active")
        crop_count = page.get("recognitionCropCount")
        batch_ordinal = page.get("recognitionBatchOrdinal")
        if not isinstance(crop_count, int) or crop_count < 1 or batch_ordinal < 1:
            raise RuntimeError("recognizer wait lacks crop-count/batch identity")
        message = (
            f"recognizer.wait_backend;run={page.get('runId')};"
            f"page={page['pageNumber']};owner={self.owner_index};"
            f"request={page['messageId']};crops={crop_count};batch={batch_ordinal}"
        )
        self._local.recognizer_wait_handle = self._nvtx_start(message)

    def observe_recognition_batch(self, batch: Any) -> None:
        page = getattr(self._local, "page", None)
        if page is None:
            return
        instances = getattr(batch, "instances", None)
        if instances is None:
            raise RuntimeError("recognizer batch has no observable instances")
        crop_count = len(instances)
        if crop_count < 1:
            raise RuntimeError("recognizer batch has no crops")
        page["recognitionBatchOrdinal"] += 1
        page["recognitionCropCount"] = crop_count

    def _start(self, stage: str) -> dict[str, Any] | None:
        page = getattr(self._local, "page", None)
        if page is None:
            return None
        if stage == "recognizer.backend":
            self._close_recognizer_wait()
        started_ns = time.monotonic_ns()
        token = {
            "stage": stage,
            "startedNs": started_ns,
            "startedThreadCpuNs": time.thread_time_ns(),
            "depth": len(page["stack"]),
            "threadId": threading.get_native_id(),
        }
        nvtx_name = _nvtx_stage(stage)
        if self._nvtx is not None and nvtx_name is not None:
            recognition_tags = ""
            if nvtx_name.startswith("recognizer."):
                crop_count = page.get("recognitionCropCount")
                batch_ordinal = page.get("recognitionBatchOrdinal")
                if (
                    not isinstance(crop_count, int)
                    or crop_count < 1
                    or batch_ordinal < 1
                ):
                    raise RuntimeError(
                        f"{nvtx_name} lacks crop-count/batch identity"
                    )
                recognition_tags = f";crops={crop_count};batch={batch_ordinal}"
            message = (
                f"{nvtx_name};run={page.get('runId')};page={page['pageNumber']};"
                f"owner={self.owner_index};request={page['messageId']}"
                f"{recognition_tags}"
            )
            token["nvtxHandle"] = self._nvtx_start(message)
        page["stack"].append(token)
        return token

    def _finish(
        self,
        token: dict[str, Any] | None,
        status: str,
        error: BaseException | None = None,
    ) -> None:
        if token is None:
            return
        page = getattr(self._local, "page", None)
        if page is None or not page["stack"] or page["stack"][-1] is not token:
            raise RuntimeError(f"stage profiler nesting violation at {token['stage']}")
        page["stack"].pop()
        self._nvtx_end(token.get("nvtxHandle"))
        ended_ns = time.monotonic_ns()
        ended_cpu_ns = time.thread_time_ns()
        event = {
            "stage": token["stage"],
            "startMs": (token["startedNs"] - self._method_started_ns) / 1_000_000,
            "endMs": (ended_ns - self._method_started_ns) / 1_000_000,
            "wallMs": (ended_ns - token["startedNs"]) / 1_000_000,
            "threadCpuMs": (
                ended_cpu_ns - token["startedThreadCpuNs"]
            ) / 1_000_000,
            "depth": token["depth"],
            "threadId": token["threadId"],
            "status": status,
        }
        if error is not None:
            event["errorType"] = type(error).__name__
        page["events"].append(event)
        if (
            status == "success"
            and token["stage"] == self.recognizer_last_prepare_stage
        ):
            self._start_recognizer_wait(page)

    def _discard(self, token: dict[str, Any] | None) -> None:
        if token is None:
            return
        page = getattr(self._local, "page", None)
        if page is None or not page["stack"] or page["stack"][-1] is not token:
            raise RuntimeError(f"stage profiler nesting violation at {token['stage']}")
        page["stack"].pop()
        self._nvtx_end(token.get("nvtxHandle"))

    @contextlib.contextmanager
    def span(self, stage: str):
        token = self._start(stage)
        try:
            yield
        except BaseException as error:
            self._finish(token, "error", error)
            raise
        else:
            self._finish(token, "success")

    def wrap(self, stage: str, delegate: Callable[..., Any]) -> "_TimedCallable":
        return _TimedCallable(self, stage, delegate)


class _TimedCallable:
    def __init__(
        self, profiler: StageProfiler, stage: str, delegate: Callable[..., Any]
    ) -> None:
        self._profiler = profiler
        self._stage = stage
        self._delegate = delegate

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        token = self._profiler._start(self._stage)
        try:
            result = self._delegate(*args, **kwargs)
        except BaseException as error:
            self._profiler._finish(token, "error", error)
            raise
        if isinstance(result, Iterator):
            # Generator creation does not execute the body. Keeping this span
            # open across ``yield`` would wrongly charge the consumer's work
            # to the generator. Time each ``next()`` execution instead.
            self._profiler._discard(token)
            return self._iterate(result)
        self._profiler._finish(token, "success")
        return result

    def _iterate(self, iterator: Iterator[Any]):
        while True:
            token = self._profiler._start(self._stage)
            try:
                item = next(iterator)
            except StopIteration:
                self._profiler._discard(token)
                return
            except BaseException as error:
                self._profiler._finish(token, "error", error)
                raise
            else:
                if self._stage == "recognizer.batch_sampler":
                    self._profiler.observe_recognition_batch(item)
                self._profiler._finish(token, "success")
                yield item

    def __getattr__(self, name: str) -> Any:
        return getattr(self._delegate, name)


def _source_identity(value: Any) -> dict[str, str | None]:
    cls = type(value)
    try:
        source = inspect.getsourcefile(cls)
    except (OSError, TypeError):
        source = None
    digest = None
    if source and Path(source).is_file():
        digest = hashlib.sha256(Path(source).read_bytes()).hexdigest()
    return {
        "class": f"{cls.__module__}.{cls.__qualname__}",
        "sourceFile": source,
        "sourceSha256": digest,
    }


def _install_callable(
    profiler: StageProfiler,
    parent: Any,
    attribute: str,
    stage: str,
    path: str,
    *,
    required: bool,
) -> None:
    value = getattr(parent, attribute, None)
    if not callable(value):
        profiler.missing_paths.append(path)
        if required:
            raise RuntimeError(f"required stage boundary is unavailable: {path}")
        return
    setattr(parent, attribute, profiler.wrap(stage, value))
    profiler.instrumented_paths.append({"path": path, "stage": stage})


def _install_model_components(
    profiler: StageProfiler, model: Any, prefix: str, path: str
) -> None:
    batch_sampler = getattr(model, "batch_sampler", None)
    if callable(batch_sampler):
        setattr(
            model,
            "batch_sampler",
            profiler.wrap(f"{prefix}.batch_sampler", batch_sampler),
        )
        profiler.instrumented_paths.append(
            {"path": f"{path}.batch_sampler", "stage": f"{prefix}.batch_sampler"}
        )
    else:
        profiler.missing_paths.append(f"{path}.batch_sampler")

    transforms = getattr(model, "pre_tfs", None)
    if isinstance(transforms, MutableMapping):
        callable_transform_stages = []
        for name, value in list(transforms.items()):
            if callable(value):
                stage_name = str(name).lower().replace(" ", "_")
                wrapped_stage = f"{prefix}.preprocess.{stage_name}"
                transforms[name] = profiler.wrap(
                    wrapped_stage, value
                )
                callable_transform_stages.append(wrapped_stage)
                profiler.instrumented_paths.append(
                    {
                        "path": f"{path}.pre_tfs[{name!r}]",
                        "stage": f"{prefix}.preprocess.{stage_name}",
                    }
                )
        if prefix == "recognizer" and callable_transform_stages:
            profiler.recognizer_last_prepare_stage = callable_transform_stages[-1]
    else:
        profiler.missing_paths.append(f"{path}.pre_tfs")

    _install_callable(
        profiler,
        model,
        "runner",
        f"{prefix}.backend",
        f"{path}.runner",
        required=True,
    )
    _install_callable(
        profiler,
        model,
        "post_op",
        f"{prefix}.postprocess",
        f"{path}.post_op",
        required=False,
    )


def install_ocr_stage_profiler(
    ocr: Any, owner_index: int
) -> tuple[StageProfiler, dict[str, Any]]:
    """Instrument the exact synchronous boundaries exposed by PaddleX 3.7.2."""
    pipeline_owner = getattr(ocr, "paddlex_pipeline", None)
    pipeline = getattr(pipeline_owner, "_pipeline", None)
    if pipeline is None:
        raise RuntimeError("PaddleOCR internal pipeline boundary is unavailable")
    profiler = StageProfiler(owner_index)
    identity = {"pipeline": _source_identity(pipeline), "models": {}}

    _install_callable(
        profiler,
        pipeline,
        "img_reader",
        "pipeline.input_read",
        "ocr.paddlex_pipeline._pipeline.img_reader",
        required=False,
    )
    _install_callable(
        profiler,
        pipeline,
        "_sort_boxes",
        "detector.sort_boxes",
        "ocr.paddlex_pipeline._pipeline._sort_boxes",
        required=False,
    )
    _install_callable(
        profiler,
        pipeline,
        "_crop_by_polys",
        "crop.total",
        "ocr.paddlex_pipeline._pipeline._crop_by_polys",
        required=True,
    )

    for attribute, prefix in (
        ("text_det_model", "detector"),
        ("text_rec_model", "recognizer"),
    ):
        model = getattr(pipeline, attribute, None)
        path = f"ocr.paddlex_pipeline._pipeline.{attribute}"
        if model is None:
            raise RuntimeError(f"required model boundary is unavailable: {path}")
        identity["models"][prefix] = _source_identity(model)
        _install_model_components(profiler, model, prefix, path)
        setattr(pipeline, attribute, profiler.wrap(f"{prefix}.total", model))
        profiler.instrumented_paths.append(
            {"path": path, "stage": f"{prefix}.total"}
        )

    identity["instrumentedPaths"] = profiler.instrumented_paths
    identity["missingPaths"] = profiler.missing_paths
    return profiler, identity


def _merge_intervals(events: list[dict[str, Any]]) -> dict[str, Any]:
    intervals = sorted(
        (float(item["startMs"]), float(item["endMs"])) for item in events
    )
    if not intervals:
        return {
            "calls": 0,
            "windowMs": 0,
            "occupiedUnionMs": 0,
            "gapMs": 0,
            "occupancyPercent": None,
        }
    merged: list[list[float]] = []
    for start, end in intervals:
        if not merged or start > merged[-1][1]:
            merged.append([start, end])
        else:
            merged[-1][1] = max(merged[-1][1], end)
    window_end = max(end for _, end in intervals)
    window = window_end - intervals[0][0]
    occupied = sum(end - start for start, end in merged)
    return {
        "calls": len(intervals),
        "windowStartMs": intervals[0][0],
        "windowEndMs": window_end,
        "windowMs": window,
        "occupiedUnionMs": occupied,
        "gapMs": max(0.0, window - occupied),
        "occupancyPercent": 100 * occupied / window if window > 0 else None,
        "mergedIntervals": [
            {"startMs": start, "endMs": end} for start, end in merged
        ],
    }


def summarize_method_profile(
    pages: list[dict[str, Any]],
    identities: list[dict[str, Any]],
    method_wall_ms: float,
) -> dict[str, Any]:
    events = [event for page in pages for event in page["events"]]
    by_stage: dict[str, list[dict[str, Any]]] = {}
    for event in events:
        by_stage.setdefault(str(event["stage"]), []).append(event)
    stage_summary = {}
    for stage, rows in sorted(by_stage.items()):
        wall = [float(item["wallMs"]) for item in rows]
        cpu = [float(item["threadCpuMs"]) for item in rows]
        stage_summary[stage] = {
            "calls": len(rows),
            "summedWallMs": sum(wall),
            "summedThreadCpuMs": sum(cpu),
            "medianWallMs": statistics.median(wall),
            "p95WallMs": _percentile(wall, 0.95),
            "maxWallMs": max(wall),
            "errors": sum(item["status"] != "success" for item in rows),
        }

    predict_ms = stage_summary.get("predict.total", {}).get("summedWallMs", 0)
    explained_ms = sum(
        stage_summary.get(stage, {}).get("summedWallMs", 0)
        for stage in ("detector.total", "crop.total", "recognizer.total")
    )
    backend_events = {
        stage: _merge_intervals(by_stage.get(stage, []))
        for stage in ("detector.backend", "recognizer.backend")
    }
    backend_events["combined"] = _merge_intervals(
        by_stage.get("detector.backend", [])
        + by_stage.get("recognizer.backend", [])
    )
    return {
        "schemaVersion": "pagespatial-gpu-a3-stage-profile-v1",
        "scope": "python-visible synchronous PaddleX boundaries",
        "pages": pages,
        "stageSummary": stage_summary,
        "predictBreakdown": {
            "summedPredictWallMs": predict_ms,
            "summedDetectorCropRecognizerWallMs": explained_ms,
            "summedUnattributedPredictWallMs": max(0.0, predict_ms - explained_ms),
        },
        "backendOccupancy": backend_events,
        "methodWallMs": method_wall_ms,
        "identitiesByOwner": identities,
        "limitations": [
            "backend wall includes host-to-device copy, native execution, device-to-host copy, and synchronization",
            "backend wall is not pure GPU kernel time",
            "nvidia-smi utilization samples do not identify individual stages",
            "summed service times can exceed method wall when two owners overlap",
        ],
    }

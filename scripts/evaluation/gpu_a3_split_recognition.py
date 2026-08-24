#!/usr/bin/env python3
"""Evaluation-only bounded pipeline around PaddleX text recognition.

The pinned PaddleX predictor performs preparation, synchronous inference, and
CTC decoding serially for every crop batch. This adapter preserves those exact
operations and their order, but overlaps CPU preparation for the next batch and
CPU decoding for the previous batch with the one serialized backend call.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any, Iterator


class SplitRecognitionModel:
    """A transparent, bounded wrapper for one PaddleX recognition owner."""

    def __init__(self, model: Any, queue_depth: int = 2) -> None:
        if queue_depth != 2:
            raise ValueError("A3 split-recognition queue_depth is fixed at 2")
        object.__setattr__(self, "_model", model)
        object.__setattr__(self, "_queue_depth", queue_depth)
        object.__setattr__(self, "_metrics_lock", threading.Lock())
        self.reset_metrics()

    def __getattr__(self, name: str) -> Any:
        return getattr(self._model, name)

    def __setattr__(self, name: str, value: Any) -> None:
        if name.startswith("_"):
            object.__setattr__(self, name, value)
        else:
            setattr(self._model, name, value)

    def reset_metrics(self) -> None:
        with self._metrics_lock:
            object.__setattr__(self, "_metrics", {
                "schemaVersion": "pagespatial-gpu-a3-split-recognition-v1",
                "queueDepth": self._queue_depth,
                "preparation": {"calls": 0, "summedWallMs": 0.0},
                "backend": {"calls": 0, "summedWallMs": 0.0},
                "postprocess": {"calls": 0, "summedWallMs": 0.0},
                "maxPreparedInFlight": 0,
                "maxPostprocessInFlight": 0,
            })

    def metrics(self) -> dict[str, Any]:
        with self._metrics_lock:
            return {
                **self._metrics,
                "preparation": dict(self._metrics["preparation"]),
                "backend": dict(self._metrics["backend"]),
                "postprocess": dict(self._metrics["postprocess"]),
            }

    def _record(self, stage: str, started: float) -> None:
        wall_ms = (time.monotonic() - started) * 1000
        with self._metrics_lock:
            self._metrics[stage]["calls"] += 1
            self._metrics[stage]["summedWallMs"] += wall_ms

    def _observe_depth(self, key: str, value: int) -> None:
        with self._metrics_lock:
            self._metrics[key] = max(self._metrics[key], value)

    def _prepare(self, batch_data: Any) -> dict[str, Any]:
        started = time.monotonic()
        try:
            raw_images = self._model.pre_tfs["Read"](imgs=batch_data.instances)
            process_globals = getattr(self._model.process, "__globals__", {})
            validate = process_globals.get("validate_text_rec_image_array")
            if validate is not None:
                for index, image in enumerate(raw_images):
                    validate(image, index=index)
            width_ratios = [image.shape[1] / float(image.shape[0]) for image in raw_images]
            indices = sorted(range(len(width_ratios)), key=width_ratios.__getitem__)
            batch_images = self._model.pre_tfs["ReisizeNorm"](imgs=raw_images)
            tensor = self._model.pre_tfs["ToBatch"](imgs=batch_images)
            rec_shape = next(
                operation["RecResizeImg"]["image_shape"]
                for operation in self._model.config["PreProcess"]["transform_ops"]
                if "RecResizeImg" in operation
            )
            max_ratio = rec_shape[2] / rec_shape[1]
            end = min(len(raw_images), self._model.batch_sampler.batch_size)
            ordered_ratios = []
            for offset in range(end):
                image = raw_images[indices[offset]]
                ratio = image.shape[1] / float(image.shape[0])
                max_ratio = max(max_ratio, ratio)
                ordered_ratios.append(ratio)
            return {
                "batch": batch_data,
                "rawImages": raw_images,
                "tensor": tensor,
                "widthRatios": ordered_ratios,
                "maxWidthRatio": max_ratio,
            }
        finally:
            self._record("preparation", started)

    def _run_backend(self, prepared: dict[str, Any]) -> tuple[dict[str, Any], Any]:
        started = time.monotonic()
        try:
            return prepared, self._model.runner(x=prepared["tensor"])
        finally:
            self._record("backend", started)

    def _postprocess(
        self,
        prepared: dict[str, Any],
        predictions: Any,
        return_word_box: bool,
    ) -> dict[str, Any]:
        started = time.monotonic()
        try:
            texts, scores = self._model.post_op(
                predictions,
                return_word_box=return_word_box or self._model.return_word_box,
                wh_ratio_list=prepared["widthRatios"],
                max_wh_ratio=prepared["maxWidthRatio"],
            )
            return {
                "input_path": prepared["batch"].input_paths,
                "page_index": prepared["batch"].page_indexes,
                "input_img": prepared["rawImages"],
                "rec_text": texts,
                "rec_score": scores,
                "vis_font": [self._model.vis_font] * len(prepared["rawImages"]),
            }
        finally:
            self._record("postprocess", started)

    def _yield_prediction(self, prediction: dict[str, Any]) -> Iterator[Any]:
        first = next(iter(prediction.values()), None)
        count = len(first) if isinstance(first, list) else 1
        for index in range(count):
            item = {}
            for key, value in prediction.items():
                item[key] = value[index] if isinstance(value, list) and index < len(value) else value
            yield self._model.result_class(item)

    def __call__(
        self,
        input: Any,
        batch_size: int | None = None,
        return_word_box: bool = False,
        **kwargs: Any,
    ) -> Iterator[Any]:
        if kwargs:
            raise TypeError(f"unsupported split-recognition arguments: {sorted(kwargs)}")
        if batch_size is not None:
            self._model.batch_sampler.batch_size = batch_size
        batches = iter(self._model.batch_sampler(input))
        prepared: deque[Future[dict[str, Any]]] = deque()
        decoded: deque[Future[dict[str, Any]]] = deque()

        with (
            ThreadPoolExecutor(max_workers=1, thread_name_prefix="a3-rec-prep") as prep_pool,
            ThreadPoolExecutor(max_workers=1, thread_name_prefix="a3-rec-post") as post_pool,
        ):
            def submit_preparation() -> bool:
                try:
                    batch = next(batches)
                except StopIteration:
                    return False
                prepared.append(prep_pool.submit(self._prepare, batch))
                self._observe_depth("maxPreparedInFlight", len(prepared))
                return True

            for _ in range(self._queue_depth):
                if not submit_preparation():
                    break

            while prepared:
                next_prepared = prepared.popleft().result()
                submit_preparation()
                item, predictions = self._run_backend(next_prepared)
                decoded.append(
                    post_pool.submit(self._postprocess, item, predictions, return_word_box)
                )
                self._observe_depth("maxPostprocessInFlight", len(decoded))
                if len(decoded) >= self._queue_depth:
                    yield from self._yield_prediction(decoded.popleft().result())

            while decoded:
                yield from self._yield_prediction(decoded.popleft().result())


def install_split_recognition(ocr: Any, queue_depth: int = 2) -> SplitRecognitionModel:
    pipeline_owner = getattr(ocr, "paddlex_pipeline", None)
    pipeline = getattr(pipeline_owner, "_pipeline", None)
    model = getattr(pipeline, "text_rec_model", None)
    if model is None:
        raise RuntimeError("PaddleX recognition boundary is unavailable")
    if isinstance(model, SplitRecognitionModel):
        raise RuntimeError("split recognition is already installed")
    wrapped = SplitRecognitionModel(model, queue_depth=queue_depth)
    pipeline.text_rec_model = wrapped
    return wrapped

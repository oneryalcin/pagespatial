#!/usr/bin/env python3
"""Small CUDA/NVTX/CPU workload used only by the M0 capability probe."""

from __future__ import annotations

import json
import os
import time

import nvtx
import paddle


def main() -> None:
    paddle.set_device("gpu:0")
    domain = "pagespatial.ocr"
    with nvtx.annotate("m0.cuda", domain=domain):
        left = paddle.randn([1024, 1024], dtype="float32")
        right = paddle.randn([1024, 1024], dtype="float32")
        value = left
        for _ in range(24):
            value = paddle.matmul(value, right)
        checksum = float(value.mean().numpy().item())

    with nvtx.annotate("m0.cpu", domain=domain):
        deadline = time.perf_counter() + 0.75
        accumulator = 0
        while time.perf_counter() < deadline:
            accumulator = (accumulator * 33 + 17) % 1_000_003

    print(
        json.dumps(
            {
                "pid": os.getpid(),
                "checksumFinite": checksum == checksum,
                "cpuAccumulator": accumulator,
            }
        ),
        flush=True,
    )


if __name__ == "__main__":
    main()

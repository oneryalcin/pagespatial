#!/usr/bin/env python3
"""Prove that the pinned Nsight build retains two repeated NVTX captures."""

from __future__ import annotations

import time

import nvtx
import paddle


def main() -> None:
    domain = nvtx.Domain("pagespatial.ocr")
    paddle.device.set_device("gpu:0")
    left = paddle.randn([1024, 1024])
    right = paddle.randn([1024, 1024])
    for _ in range(2):
        handle = domain.start_range(message="m2.preflight")
        value = paddle.matmul(left, right)
        _ = float(value[0, 0])
        paddle.device.cuda.synchronize()
        domain.end_range(handle)
        time.sleep(0.05)


if __name__ == "__main__":
    main()

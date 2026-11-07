"""Speed of PP-OCRv6 small rec with its CTC head pruned to Latin/Greek/Cyrillic + symbols.

Trial: docs/trials/2026-11-07-rec-vocab-pruning-spike.md

  mkdir -p $S && tar xf .evaluation/ocr-assets-small/models/PP-OCRv6_small_rec_onnx_infer.tar -C $S
  uv run --with onnx --with onnxruntime --with openvino --with pyyaml --with numpy \
    python scripts/evaluation/rec_vocab_prune_speed.py $S/PP-OCRv6_small_rec_onnx_infer

Pruning slices the final linear layer's columns (linear_8.w_0 [120, 18710] and
linear_8.b_0). Kept-class logits are unchanged, so decoded text is identical
wherever the full model's argmax is a kept class; softmax confidences rise.
Timing uses synthetic [1, 3, 48, W] inputs: cost depends on shape, not content.
"""
import sys
import time
from pathlib import Path

import numpy as np
import onnx
import yaml
from onnx import numpy_helper

W_NAME, B_NAME = "linear_8.w_0", "linear_8.b_0"


def classes(model_dir: Path) -> list[str]:
    y = yaml.safe_load(open(model_dir / "inference.yml"))
    # class 0 = CTC blank, 1..N = dict, N+1 = space
    return ["<blank>"] + y["PostProcess"]["character_dict"] + [" "]


def latin_keep(chars: list[str]) -> list[int]:
    def ok(c):
        o = ord(c)
        return o < 0x530 or 0x1E00 <= o < 0x2C00  # Latin, Greek, Cyrillic, Latin ext. additional, punct/symbols
    return [i for i, c in enumerate(chars) if i == 0 or ok(c)]


def prune(src: Path, keep: list[int], out: Path) -> None:
    assert keep[0] == 0 and keep == sorted(keep)
    m = onnx.load(src)
    for t in m.graph.initializer:
        if t.name == W_NAME:
            t.CopyFrom(numpy_helper.from_array(numpy_helper.to_array(t)[:, keep], W_NAME))
        elif t.name == B_NAME:
            t.CopyFrom(numpy_helper.from_array(numpy_helper.to_array(t)[keep], B_NAME))
    m.graph.output[0].type.tensor_type.shape.dim[2].dim_value = len(keep)
    m.graph.ClearField("value_info")
    onnx.save(m, out)


def median_ms(run, x, warm=5, reps=40) -> float:
    for _ in range(warm):
        run(x)
    ts = []
    for _ in range(reps):
        t = time.perf_counter(); run(x); ts.append(time.perf_counter() - t)
    return float(np.median(ts) * 1000)


def runners(path: Path, threads: int):
    import onnxruntime as ort
    import openvino as ov

    so = ort.SessionOptions()
    so.intra_op_num_threads, so.inter_op_num_threads = threads, 1
    s = ort.InferenceSession(str(path), so, providers=["CPUExecutionProvider"])
    c = ov.Core().compile_model(str(path), "CPU", {"INFERENCE_NUM_THREADS": threads})
    return {"onnxruntime": lambda x: s.run(None, {"x": x}), "openvino": lambda x: c(x)}


def main(model_dir: Path) -> None:
    import onnxruntime as ort
    import openvino as ov

    src = model_dir / "inference.onnx"
    chars = classes(model_dir)
    keep = latin_keep(chars)
    pruned = model_dir / "inference.pruned.onnx"
    prune(src, keep, pruned)
    probe = np.zeros((1, 3, 48, 320), np.float32)
    shape = runners(pruned, 1)["onnxruntime"](probe)[0].shape
    print(f"onnxruntime {ort.__version__}, openvino {ov.__version__}; kept {len(keep)}/{len(chars)} classes; pruned output {shape}")
    rng = np.random.default_rng(0)
    for threads in (1, 4):
        full, cut = runners(src, threads), runners(pruned, threads)
        for backend in full:
            for w in (320, 640, 1280):
                x = rng.standard_normal((1, 3, 48, w)).astype(np.float32)
                a, b = median_ms(full[backend], x), median_ms(cut[backend], x)
                print(f"{backend:11} threads={threads} W={w:4d}  full {a:6.2f} ms  pruned {b:6.2f} ms  {a / b:.2f}x")


if __name__ == "__main__":
    main(Path(sys.argv[1]))

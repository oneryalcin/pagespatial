"""PP-OCRv6 sidecar — the adopted canonical OCR witness (issue #2).

One Python child per Node page-worker, speaking JSONL over stdin/stdout:
  request:  {"id": 7, "path": "/tmp/....png"}
  response: {"id": 7, "lines": [{"text","poly","score"}], "ms": 123.4}
  errors:   {"id": 7, "error": "..."}       (page fails closed upstream)

Selective OCR (docs/design/2026-11-07-selective-ocr.md) splits a page into
two kinds of request, so the caller can decide which detected boxes to read:
  {"id": 8, "op": "detect", "path": "/tmp/....png"}
      -> {"id": 8, "polys": [[[x,y],...],...], "ms": ...}
  {"id": 9, "op": "recognize", "path": "/tmp/....png", "indices": [0, 3]}
      -> {"id": 9, "lines": [{"index","text","score"}], "ms": ...}
They drive the pipeline's own detect, sort, crop and recognize steps, the
ones predict() runs. Only the recognizer's batching differs: predict() pads
each batch of 6 to its widest crop, so a line's reading depends on which
other lines are read with it. Here crops no wider than the recognizer's base
shape, which all pad to that one width, go in batches of 6, and wider crops
go one at a time, so no crop's input depends on its batch-mates.
"""

import hashlib
import json
import os
import platform
import sys
import time
from pathlib import Path

MANIFEST = Path(__file__).parent / "model-pins.json"


def fail(msg: str) -> None:
    print(json.dumps({"kind": "fatal", "error": msg}), flush=True)
    sys.exit(1)


def verify_pins(models_dir: Path) -> dict:
    if not MANIFEST.exists():
        fail("model-pins.json missing — run fetch_models.py --record and commit it")
    manifest = json.loads(MANIFEST.read_text())
    pins = {}
    for repo, pin in manifest["repos"].items():
        target = models_dir / repo.split("/")[-1]
        for rel, expected in pin["files"].items():
            path = target / rel
            if not path.is_file():
                fail(f"pinned model file missing: {path}")
            digest = hashlib.sha256()
            with path.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1 << 20), b""):
                    digest.update(chunk)
            if digest.hexdigest() != expected:
                fail(f"pin mismatch for {repo}/{rel}: refusing to serve unvalidated weights")
        pins[repo] = pin["revision"]
    return pins


def _os_thread_count():
    try:
        return len(os.listdir("/proc/self/task"))
    except OSError:
        return None


def main() -> None:
    models_dir = Path(os.environ["SIDECAR_MODELS_DIR"])
    threads = int(os.environ.get("SIDECAR_THREADS", "1"))
    check_only = "--check" in sys.argv

    # SIDECAR_THREADS is the ONLY thread knob. `cpu_threads=` below never
    # reaches the OpenVINO/ONNX HPI runners: PaddleX sizes those pools from
    # PADDLE_PDX_CPU_NUM_THREADS (default 10) at pipeline construction
    # (paddlex/inference/models/runners/hpi/config.py). Left unset, four
    # sidecars on four cores ran 40 inference threads (issue #126).
    os.environ["PADDLE_PDX_CPU_NUM_THREADS"] = str(threads)

    t0 = time.monotonic()
    pins = verify_pins(models_dir)

    import importlib.metadata

    from paddleocr import PaddleOCR

    # SIDECAR_DISABLE_HPI=1 forces paddle-default on Linux — the EP-control
    # knob the era rule requires (same host, same models, HPI off). Meta and
    # the descriptor stay truthful either way: useHpip is introspected, not
    # asserted.
    hpi_requested = platform.system() == "Linux" and os.environ.get("SIDECAR_DISABLE_HPI") != "1"
    kwargs = dict(
        text_detection_model_name="PP-OCRv6_small_det",
        text_detection_model_dir=str(models_dir / "PP-OCRv6_small_det"),
        text_recognition_model_name="PP-OCRv6_small_rec",
        text_recognition_model_dir=str(models_dir / "PP-OCRv6_small_rec"),
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        device="cpu",
    )
    if hpi_requested:
        kwargs["enable_hpi"] = True
    try:
        ocr = PaddleOCR(**kwargs, cpu_threads=threads)
        thread_kwarg_applied = True
    except TypeError:
        ocr = PaddleOCR(**kwargs)
        thread_kwarg_applied = False
    init_s = time.monotonic() - t0

    # In-band backend truth: the same attributes the adoption ceremony
    # introspected. Absence is reported as null, never guessed.
    def probe_use_hpip():
        for holder in (getattr(ocr, "paddlex_pipeline", None), ocr):
            for attr in ("use_hpip", "_use_hpip"):
                value = getattr(holder, attr, None)
                if isinstance(value, bool):
                    return value
                inner = getattr(holder, "_pipeline", None)
                value = getattr(inner, attr, None) if inner is not None else None
                if isinstance(value, bool):
                    return value
        return None

    meta = {
        "kind": "meta",
        "versions": {
            pkg: importlib.metadata.version(pkg)
            for pkg in ("paddleocr", "paddlepaddle")
        },
        "platform": platform.system(),
        "machine": platform.machine(),
        "osCpuCount": os.cpu_count(),
        "threads": threads,
        "threadKwargApplied": thread_kwarg_applied,
        # In-band attestation for the thread setting (issue #126 step 1):
        # the env PaddleX read, and this process's live OS thread count
        # after engine construction (Linux only; null elsewhere).
        "pdxCpuNumThreadsEnv": os.environ.get("PADDLE_PDX_CPU_NUM_THREADS"),
        "osThreadCount": _os_thread_count(),
        "hpiRequested": hpi_requested,
        "useHpip": probe_use_hpip(),
        "modelPins": pins,
        "initS": round(init_s, 2),
    }
    print(json.dumps(meta), flush=True)
    if check_only:
        return

    import cv2

    def split_pipeline():
        """The PaddleX pipeline object owning the detector and recognizer; raises if its shape changed."""
        pipe = ocr.paddlex_pipeline
        while not hasattr(pipe, "text_det_model"):
            pipe = pipe._pipeline
        for attr in ("get_text_det_params", "text_det_model", "_sort_boxes", "_crop_by_polys", "text_rec_model"):
            if not hasattr(pipe, attr):
                raise RuntimeError(f"PaddleX OCR pipeline has no {attr}; detect/recognize cannot be split")
        return pipe

    held = {"path": None, "crops": []}  # the last detected page's crops, for its recognize requests

    def detect(image, path):
        # The same steps, in the same order, as the pipeline's predict().
        pipe = split_pipeline()
        det = list(pipe.text_det_model([image], **pipe.get_text_det_params()))[0]
        polys = pipe._sort_boxes(det["dt_polys"])
        crops = list(pipe._crop_by_polys(image, polys))
        kept = [(c, p) for c, p in zip(crops, polys) if c.size > 0 and c.shape[0] > 0 and c.shape[1] > 0]
        held["path"], held["crops"] = path, [c for c, _ in kept]
        return [[[float(x), float(y)] for x, y in p] for _, p in kept]

    def recognize(path, indices):
        if held["path"] != path:
            raise ValueError("recognize without a preceding detect of the same page")
        crops = held["crops"]
        if any(not isinstance(i, int) or i < 0 or i >= len(crops) for i in indices) or len(set(indices)) != len(indices):
            raise ValueError("recognize indices must be distinct detected-box indices")
        pipe = split_pipeline()
        rec = pipe.text_rec_model
        shape = next(op["RecResizeImg"]["image_shape"]
                     for op in rec.config["PreProcess"]["transform_ops"] if "RecResizeImg" in op)
        base_ratio = shape[2] / float(shape[1])
        ratio = lambda i: crops[i].shape[1] / float(crops[i].shape[0])
        lines = {}
        original = rec.batch_sampler.batch_size
        try:
            for batch_size, group in ((6, [i for i in indices if ratio(i) <= base_ratio]),
                                      (1, [i for i in indices if ratio(i) > base_ratio])):
                if not group:
                    continue
                group.sort(key=ratio)  # the pipeline's aspect-ratio order
                for i, out in zip(group, rec([crops[i] for i in group], batch_size=batch_size, return_word_box=False)):
                    lines[i] = {"index": i, "text": str(out["rec_text"]), "score": float(out["rec_score"])}
        finally:
            rec.batch_sampler.batch_size = original  # predict() must keep the batching it was built with
        return [lines[i] for i in indices]

    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            request = json.loads(raw)
        except json.JSONDecodeError:
            print(json.dumps({"kind": "fatal", "error": "bad request framing"}), flush=True)
            sys.exit(1)
        rid = request.get("id")
        op = request.get("op")
        try:
            if op in ("detect", "recognize"):
                t = time.monotonic()
                if op == "detect":
                    image = cv2.imread(request["path"], cv2.IMREAD_COLOR)
                    if image is None:
                        raise ValueError(f"unreadable image: {request['path']}")
                    payload = {"polys": detect(image, request["path"])}
                else:
                    payload = {"lines": recognize(request["path"], request["indices"])}
                print(json.dumps({"id": rid, **payload, "ms": round((time.monotonic() - t) * 1000, 1)}), flush=True)
                continue
            if op is not None:
                raise ValueError(f"unknown op: {op}")
            image = cv2.imread(request["path"], cv2.IMREAD_COLOR)
            if image is None:
                raise ValueError(f"unreadable image: {request['path']}")
            t = time.monotonic()
            result = ocr.predict(image)
            ms = (time.monotonic() - t) * 1000
            lines = []
            for res in result:
                data = res if isinstance(res, dict) else res.json.get("res", res.json)
                texts = data.get("rec_texts", [])
                scores = data.get("rec_scores", [])
                polys = data.get("rec_polys", data.get("dt_polys", []))
                for i, text in enumerate(texts):
                    poly = polys[i] if i < len(polys) else None
                    lines.append(
                        {
                            "text": str(text),
                            "poly": [[float(p[0]), float(p[1])] for p in poly]
                            if poly is not None
                            else None,
                            "score": float(scores[i]) if i < len(scores) else None,
                        }
                    )
            print(json.dumps({"id": rid, "lines": lines, "ms": round(ms, 1)}), flush=True)
        except Exception as error:  # per-request containment: page fails closed upstream
            print(json.dumps({"id": rid, "error": f"{type(error).__name__}: {error}"}), flush=True)


if __name__ == "__main__":
    main()

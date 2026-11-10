"""Fine-tune the PP-OCRv6 Tiny recognizer on text-layer-labelled line crops (Modal).

Trial: docs/trials/2026-11-10-fast-recognizer-options.md

Training data is DocLayNet-v1.2 (CDLA-Permissive-1.0), used only as a source of
born-digital single-page PDFs. Nothing from .evaluation is read here.

  export  one container per parquet shard: render each sampled page with
          pdfium at production scale, cut word-group crops of at most
          MAX_CHARS characters from pdfium's own lines, label them from the
          text layer, and keep a crop only when the Small recognizer (the
          production witness) reads nearly the same text. That drops hidden,
          clipped and broken text layers. The label is the text layer, never
          the teacher.
  train   PaddleOCR tools/train.py from the published Tiny weights.

  uvx --from modal==1.5.3 modal run scripts/evaluation/rec_finetune_modal.py::export --shards 24
  uvx --from modal==1.5.3 modal run scripts/evaluation/rec_finetune_modal.py::train --epochs 10

Local smoke of the cropper (no Modal, no teacher):
  uv run --with pypdfium2 --with numpy --with opencv-python-headless --with pyarrow \
      --with huggingface_hub python scripts/evaluation/rec_finetune_modal.py smoke <out dir>
"""
import random
import sys

SCALE = 1.6  # production render scale (docs/trials/2026-11-07-ocr-arms-linux.md)
# Half the pages render smaller, so 10 pt body text also appears at the pixel size
# of the 4-6 pt print that the first fine-tune misread (ceremony lines 7-10 px high).
MIN_SCALE = 0.55
CHECK_SCALE = 2.0  # the teacher checks each label on a large render of the same box
MAX_CHARS = 25  # the published Tiny config's max_text_length
DATASET = "datasets/docling-project/DocLayNet-v1.2"
CURRENCY = "$€£¥%"


def page_chunks(pdf_bytes: bytes, rng: random.Random, limit: int = 60) -> list:
    """[(BGR crop, large check crop, label)] for one single-page PDF.

    Lines are pdfium's own (it emits a line break between them). A chunk is a
    run of whole words on one line; its box is the union of the words' loose
    character boxes, padded by a few pixels like a detector box. Chunks with
    digits or currency are taken first: they are the values the witness must
    not misread.
    """
    import cv2
    import numpy as np
    import pypdfium2 as pdfium

    page = pdfium.PdfDocument(pdf_bytes)[0]
    if page.get_rotation():
        return []
    scale = SCALE if rng.random() < 0.5 else rng.uniform(MIN_SCALE, SCALE)

    def render(at):
        return cv2.cvtColor(np.asarray(page.render(scale=at).to_pil().convert("RGB")), cv2.COLOR_RGB2BGR)

    image, check = render(scale), render(CHECK_SCALE)
    page_height = page.get_height()
    text_page = page.get_textpage()
    text = text_page.get_text_range()

    # words per line: [(text, left, bottom, right, top)] in PDF points
    lines, words, word, box = [], [], "", None
    for i, ch in enumerate(text):
        if ch.isspace():
            if word:
                words.append((word, *box))
                word, box = "", None
            if ch in "\r\n" and words:
                lines.append(words)
                words = []
            continue
        left, bottom, right, top = text_page.get_charbox(i, loose=True)
        if right <= left or top <= bottom:
            continue
        word += ch
        box = (left, bottom, right, top) if box is None else (
            min(box[0], left), min(box[1], bottom), max(box[2], right), max(box[3], top))
    if word:
        words.append((word, *box))
    if words:
        lines.append(words)

    chunks = []
    for words in lines:
        start = 0
        while start < len(words):
            target = rng.randint(1, MAX_CHARS)
            end, length = start + 1, len(words[start][0])
            while end < len(words) and length + 1 + len(words[end][0]) <= target:
                length += 1 + len(words[end][0])
                end += 1
            group = words[start:end]
            start = end
            label = " ".join(w[0] for w in group)
            left, right = min(w[1] for w in group), max(w[3] for w in group)
            bottom, top = min(w[2] for w in group), max(w[4] for w in group)
            # A horizontal line: words advance left to right and the box is
            # wider than tall unless it is one or two characters.
            if len(label) > MAX_CHARS or any(a[1] > b[1] for a, b in zip(group, group[1:])):
                continue
            if len(label) > 2 and (right - left) < (top - bottom):
                continue
            chunks.append((label, left, bottom, right, top))

    valued = [c for c in chunks if any(ch.isdigit() or ch in CURRENCY for ch in c[0])]
    plain = [c for c in chunks if c not in valued]
    rng.shuffle(valued)
    rng.shuffle(plain)
    picked = valued[: limit // 2]
    picked += plain[: limit - len(picked)]

    def crop(source, at, pad):
        height_px, width_px = source.shape[:2]
        x0 = max(int(left * at) - pad[0], 0)
        x1 = min(int(right * at + 1) + pad[1], width_px)
        y0 = max(int((page_height - top) * at) - pad[2], 0)
        y1 = min(int((page_height - bottom) * at + 1) + pad[3], height_px)
        return source[y0:y1, x0:x1].copy()

    out = []
    for label, left, bottom, right, top in picked:
        small = crop(image, scale, (rng.randint(0, 4), rng.randint(0, 4), rng.randint(0, 3), rng.randint(0, 3)))
        if small.shape[0] < 6 or small.shape[1] < 4:
            continue
        out.append((small, crop(check, CHECK_SCALE, (3, 3, 2, 2)), label))
    return out


def shard_pages(path: str, rng: random.Random, per_group: int):
    """Yield (doc_category, pdf bytes) for a sample of pages from each row group of one shard."""
    import pyarrow.parquet as pq
    from huggingface_hub import HfFileSystem

    parquet = pq.ParquetFile(HfFileSystem().open(path))
    for group in range(parquet.num_row_groups):
        table = parquet.read_row_group(group, columns=["pdf", "metadata"])
        rows = rng.sample(range(table.num_rows), min(per_group, table.num_rows))
        pdfs, meta = table.column("pdf"), table.column("metadata")
        for row in rows:
            yield meta[row].as_py()["doc_category"], pdfs[row].as_py()


def smoke(out_dir: str) -> None:
    import os

    import cv2

    os.makedirs(out_dir, exist_ok=True)
    rng = random.Random(0)
    count = 0
    for category, pdf in shard_pages(f"{DATASET}/data/train-00000-of-00072.parquet", rng, 2):
        chunks = page_chunks(pdf, rng, limit=12)
        print(category, len(chunks), [(crop.shape[0], label) for crop, _, label in chunks[:6]])
        for crop, _, label in chunks:
            cv2.imwrite(f"{out_dir}/{count:04d}.png", crop)
            count += 1
        if count > 120:
            break


# ---------------------------------------------------------------- Modal ----
try:
    import modal
except ImportError:  # local smoke needs no Modal
    modal = None

PADDLEOCR_SHA = "dab3fe35379033fdcb2d0e9572fac0b36c9a9ebf"  # main, 2026-09-16
DICT_URL = f"https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/{PADDLEOCR_SHA}/ppocr/utils/dict/ppocrv6_tiny_dict.txt"
PRETRAINED_URL = "https://paddle-model-ecology.bj.bcebos.com/paddlex/official_pretrained_model/PP-OCRv6_tiny_rec_pretrained.pdparams"
CONFIG = "configs/rec/PP-OCRv6/PP-OCRv6_tiny_rec.yml"
LIGATURES = {"ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl", " ": " "}
MIN_TEACHER_SIMILARITY = 0.8

if modal:
    app = modal.App("pagespatial-rec-finetune")
    volume = modal.Volume.from_name("pagespatial-rec-finetune", create_if_missing=True)
    APT = ("libgl1", "libglib2.0-0", "libgomp1", "git")
    export_image = (
        modal.Image.debian_slim(python_version="3.11")
        .apt_install(*APT)
        .pip_install("paddlepaddle==3.2.1", "paddleocr==3.7.0", "setuptools", "pypdfium2", "pyarrow",
                     "huggingface_hub", "opencv-python-headless", "pillow", "numpy")
    )
    train_image = (
        modal.Image.debian_slim(python_version="3.11")
        .apt_install(*APT)
        .run_commands(
            # The wheel by URL: Paddle's package index answered 502 on 2026-11-10.
            "pip install https://paddle-whl.bj.bcebos.com/stable/cu126/paddlepaddle-gpu/"
            "paddlepaddle_gpu-3.2.1-cp311-cp311-linux_x86_64.whl",
            "git clone https://github.com/PaddlePaddle/PaddleOCR /PaddleOCR",
            f"cd /PaddleOCR && git checkout {PADDLEOCR_SHA} && pip install -r requirements.txt setuptools",
        )
    )

    @app.function(image=export_image, cpu=4.0, memory=8192, timeout=2 * 3600, volumes={"/vol": volume},
                  max_containers=24)
    def export_shard(data: str, split: str, index: int, total: int, per_group: int) -> dict:
        import collections
        import difflib
        import io
        import json
        import os
        import shutil
        import tarfile
        import urllib.request

        import cv2

        os.environ["PADDLE_PDX_CPU_NUM_THREADS"] = "4"
        os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"
        from paddleocr import TextRecognition

        allowed = set(urllib.request.urlopen(DICT_URL).read().decode("utf8").split("\n")) | {" "}
        small = TextRecognition(model_name="PP-OCRv6_small_rec")
        tiny = TextRecognition(model_name="PP-OCRv6_tiny_rec")

        def read(model, crops):
            return [r.json["res"]["rec_text"] for r in model.predict(crops, batch_size=32)]

        def similar(a, b):
            return difflib.SequenceMatcher(None, a.replace(" ", ""), b.replace(" ", "")).ratio()

        name = f"{split}-{index:05d}"
        rng = random.Random(index)
        stats = collections.Counter()
        os.makedirs(f"/vol/{data}/{split}", exist_ok=True)
        records = []
        with tarfile.open(f"/tmp/{name}.tar", "w") as tar:
            for category, pdf in shard_pages(f"{DATASET}/data/{split}-{index:05d}-of-{total:05d}.parquet", rng, per_group):
                try:
                    chunks = page_chunks(pdf, rng)
                except Exception:
                    stats["page_error"] += 1
                    continue
                stats["pages"] += 1
                kept = []
                for crop, check, label in chunks:
                    for ligature, plain in LIGATURES.items():
                        label = label.replace(ligature, plain)
                    if all(ch in allowed for ch in label):
                        kept.append((crop, check, label))
                    else:
                        stats["chars_outside_dict"] += 1
                if not kept:
                    continue
                crops = [crop for crop, _, _ in kept]
                checked = read(small, [check for _, check, _ in kept])
                for (crop, _, label), check_text, small_text, tiny_text in zip(
                        kept, checked, read(small, crops), read(tiny, crops)):
                    # The label must be legible at CHECK_SCALE; the training crop may be far smaller.
                    if similar(label, check_text) < MIN_TEACHER_SIMILARITY:
                        stats["teacher_disagrees"] += 1
                        continue
                    file = f"{name}/{len(records):06d}.png"
                    png = cv2.imencode(".png", crop)[1].tobytes()
                    info = tarfile.TarInfo(file)
                    info.size = len(png)
                    tar.addfile(info, io.BytesIO(png))
                    records.append({"file": file, "label": label, "small": small_text, "tiny": tiny_text,
                                    "category": category, "height": crop.shape[0]})
                    stats["kept"] += 1
                    stats["small_exact"] += small_text == label
                    stats["tiny_exact"] += tiny_text == label
                    stats[f"category:{category}"] += 1
        shutil.move(f"/tmp/{name}.tar", f"/vol/{data}/{split}/{name}.tar")
        with open(f"/vol/{data}/{split}/{name}.jsonl", "w") as f:
            f.writelines(json.dumps(r, ensure_ascii=False) + "\n" for r in records)
        volume.commit()
        return {"shard": name, **stats}

    @app.function(image=train_image, gpu="L4", cpu=8.0, memory=32768, timeout=10 * 3600, volumes={"/vol": volume})
    def train_run(name: str, data_name: str, epochs: int, lr: float) -> dict:
        import glob
        import json
        import os
        import re
        import subprocess
        import tarfile
        import urllib.request

        data = "/tmp/train_data"
        counts = {}
        for split, listing in (("train", "train_list.txt"), ("validation", "val_list.txt")):
            os.makedirs(f"{data}/{split}", exist_ok=True)
            lines = []
            for tar_path in sorted(glob.glob(f"/vol/{data_name}/{split}/*.tar")):
                with tarfile.open(tar_path) as tar:
                    tar.extractall(f"{data}/{split}")
                for record in map(json.loads, open(tar_path[:-4] + ".jsonl")):
                    lines.append(f"{split}/{record['file']}\t{record['label']}\n")
            open(f"{data}/{listing}", "w").writelines(lines)
            counts[split] = len(lines)
        print("crops", counts, flush=True)
        urllib.request.urlretrieve(PRETRAINED_URL, "/tmp/pretrained.pdparams")

        out = f"/vol/runs/{name}"
        common = [
            f"Train.dataset.data_dir={data}", f"Train.dataset.label_file_list=['{data}/train_list.txt']",
            f"Eval.dataset.data_dir={data}", f"Eval.dataset.label_file_list=['{data}/val_list.txt']",
            "Global.distributed=false",
        ]

        def tool(script, *options):
            command = ["python", f"tools/{script}", "-c", CONFIG, "-o", *common, *options]
            print(" ".join(command), flush=True)
            process = subprocess.Popen(command, cwd="/PaddleOCR", stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            tail = []
            for line in process.stdout:
                print(line, end="", flush=True)
                tail = (tail + [line])[-400:]
            if process.wait():
                raise RuntimeError(f"{script} failed:\n" + "".join(tail[-40:]))
            return "".join(tail)

        def metrics(log):
            return {key: float(value) for key, value in re.findall(r"(acc|norm_edit_dis):\s*([\d.]+)", log)[-2:]}

        result = {"crops": counts, "data": data_name, "epochs": epochs, "lr": lr}
        result["pretrained"] = metrics(tool("eval.py", "Global.pretrained_model=/tmp/pretrained"))
        tool("train.py", "Global.pretrained_model=/tmp/pretrained", f"Global.epoch_num={epochs}",
             f"Global.save_model_dir={out}", "Global.eval_batch_step=[0,1000]", "Global.save_epoch_step=100",
             f"Optimizer.lr.learning_rate={lr}", "Optimizer.lr.warmup_epoch=1")
        volume.commit()
        result["finetuned"] = metrics(tool("eval.py", f"Global.pretrained_model={out}/best_accuracy"))
        tool("export_model.py", f"Global.pretrained_model={out}/best_accuracy", f"Global.save_inference_dir={out}/inference")
        result["inference_files"] = sorted(os.listdir(f"{out}/inference"))
        json.dump(result, open(f"{out}/result.json", "w"), indent=1)
        volume.commit()
        return result

    @app.function(image=export_image, cpu=4.0, memory=8192, timeout=3600, volumes={"/vol": volume})
    def evaluate_run(name: str, data_name: str) -> dict:
        """Validation crops through the production inference path (PaddleX keeps the
        aspect ratio; tools/eval.py squashes to 320 wide, so its acc is not comparable)."""
        import glob
        import io
        import json
        import os
        import tarfile

        import cv2
        import numpy as np

        os.environ["PADDLE_PDX_CPU_NUM_THREADS"] = "4"
        os.environ["PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK"] = "True"
        from paddleocr import TextRecognition

        model = TextRecognition(model_name="PP-OCRv6_tiny_rec", model_dir=f"/vol/runs/{name}/inference")
        rows = []
        for tar_path in sorted(glob.glob(f"/vol/{data_name}/validation/*.tar")):
            records = [json.loads(line) for line in open(tar_path[:-4] + ".jsonl")]
            with tarfile.open(tar_path) as tar:
                crops = [cv2.imdecode(np.frombuffer(tar.extractfile(r["file"]).read(), np.uint8), cv2.IMREAD_COLOR)
                         for r in records]
            for record, result in zip(records, model.predict(crops, batch_size=32)):
                rows.append({**record, "finetuned": result.json["res"]["rec_text"]})

        def squeeze(text):
            return text.replace(" ", "")

        def share(reader, subset, exact=False):
            if not subset:
                return None
            same = (lambda r: r[reader] == r["label"]) if exact else (
                lambda r: squeeze(r[reader]) == squeeze(r["label"]))
            return round(sum(map(same, subset)) / len(subset), 4)

        valued = [r for r in rows if any(ch.isdigit() or ch in CURRENCY for ch in r["label"])]
        tiny_print = [r for r in valued if r.get("height", 99) <= 12]
        summary = {"crops": len(rows), "valueCrops": len(valued), "valueCropsUpTo12px": len(tiny_print)}
        for reader in ("small", "tiny", "finetuned"):
            summary[reader] = {
                "exact": share(reader, rows, exact=True),
                "ignoringSpaces": share(reader, rows),
                "valueCropsIgnoringSpaces": share(reader, valued),
                "valueCropsUpTo12pxIgnoringSpaces": share(reader, tiny_print),
            }
        with open(f"/vol/runs/{name}/validation-{data_name}.jsonl", "w") as f:
            f.writelines(json.dumps(r, ensure_ascii=False) + "\n" for r in rows)
        volume.commit()
        return summary

    @app.local_entrypoint()
    def evaluate(name: str, data: str = "crops-v2"):
        import json

        print(json.dumps(evaluate_run.remote(name, data), indent=1))

    @app.local_entrypoint()
    def export(data: str = "crops-v2", shards: int = 24, validation_shards: int = 2, per_group: int = 20):
        import json

        jobs = [(data, "train", round(i * 72 / shards), 72, per_group) for i in range(shards)]
        jobs += [(data, "validation", round(i * 7 / validation_shards), 7, max(2, per_group // 4))
                 for i in range(validation_shards)]
        for stats in export_shard.starmap(jobs, return_exceptions=True):
            print(json.dumps(stats) if isinstance(stats, dict) else f"FAILED {stats!r}")

    @app.local_entrypoint()
    def train(name: str, data: str = "crops-v2", epochs: int = 4, lr: float = 1e-4):
        import json

        print(json.dumps(train_run.remote(name, data, epochs, lr), indent=1))


if __name__ == "__main__" and len(sys.argv) > 2 and sys.argv[1] == "smoke":
    smoke(sys.argv[2])

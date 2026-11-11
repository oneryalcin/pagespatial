"""Fresh pages for checking an OCR rule chosen on the ceremony sample.

Trial: docs/trials/2026-11-10-fast-recognizer-options.md

Two sources, neither seen by any earlier run:
  corpus    pages of the corpus PDFs that no run record covers (same
            documents as the ceremony sample, different pages)
  doclaynet pages from the DocLayNet-v1.2 test split (other documents; the
            fine-tune used only train and validation shards)
Only pages with a text layer are kept, because the text layer is the truth
for native-token-precision.mjs. Rendered with pdftoppm at production scale.

Output dir (must be under .evaluation/, it holds page content):
  <name>.png, manifest.json [{page, png}], native.json {page: [text lines]}

  uv run --with pyarrow --with huggingface_hub python scripts/evaluation/build_fresh_ocr_sample.py \
      --run-root .evaluation/runs/<run-id> --corpus-root .evaluation/corpus --out .evaluation/ocr-arms/fresh
"""
import argparse
import glob
import json
import os
import random
import re
import subprocess
import tempfile

SCALE = 1.6
MIN_WORDS = 30
PER_DOCUMENT = 8
SEED = 20261110

parser = argparse.ArgumentParser()
parser.add_argument("--run-root", required=True)
parser.add_argument("--corpus-root", required=True)
parser.add_argument("--out", required=True)
parser.add_argument("--doclaynet-pages", type=int, default=60)
args = parser.parse_args()
os.makedirs(args.out, exist_ok=True)
rng = random.Random(SEED)
manifest, native = [], {}


def add(key: str, pdf: str, page_number: int) -> bool:
    text = subprocess.run(["pdftotext", "-f", str(page_number), "-l", str(page_number), pdf, "-"],
                          capture_output=True, text=True).stdout
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if sum(len(line.split()) for line in lines) < MIN_WORDS:
        return False
    name = re.sub(r"[^A-Za-z0-9]+", "_", key)
    prefix = os.path.join(args.out, name)
    subprocess.run(["pdftoppm", "-f", str(page_number), "-l", str(page_number), "-r", str(SCALE * 72),
                    "-png", "-singlefile", pdf, prefix], check=True)
    manifest.append({"page": key, "png": name + ".png"})
    native[key] = lines
    return True


# corpus: pages no run record covers
documents = {}
for path in glob.glob(os.path.join(args.run_root, "documents", "*", "pages", "*.json")):
    record = json.load(open(path))
    if record.get("pageSpatial"):
        documents.setdefault(record["objectId"], {"path": record["path"], "seen": set()})["seen"].add(record["pageNumber"])
for object_id, document in sorted(documents.items()):
    pdf = os.path.join(args.corpus_root, document["path"])
    pages = int(re.search(r"Pages:\s+(\d+)", subprocess.run(["pdfinfo", pdf], capture_output=True, text=True).stdout).group(1))
    unseen = [n for n in range(1, pages + 1) if n not in document["seen"]]
    rng.shuffle(unseen)
    kept = 0
    for page_number in unseen:
        if kept == PER_DOCUMENT:
            break
        kept += add(f"{object_id}#{page_number}", pdf, page_number)

# doclaynet test split: one page per row group, across all shards
import pyarrow.parquet as pq
from huggingface_hub import HfFileSystem

fs = HfFileSystem()
shards = sorted(fs.glob("datasets/docling-project/DocLayNet-v1.2/data/test-*.parquet"))
taken = 0
with tempfile.TemporaryDirectory() as tmp:
    for shard in shards:
        parquet = pq.ParquetFile(fs.open(shard))
        for group in range(parquet.num_row_groups):
            if taken >= args.doclaynet_pages:
                break
            table = parquet.read_row_group(group, columns=["pdf", "metadata"])
            row = rng.randrange(table.num_rows)
            meta = table.column("metadata")[row].as_py()
            pdf = os.path.join(tmp, "page.pdf")
            open(pdf, "wb").write(table.column("pdf")[row].as_py())
            taken += add(f"doclaynet:{meta['doc_category']}:{meta['page_hash'][:12]}#1", pdf, 1)

json.dump(manifest, open(os.path.join(args.out, "manifest.json"), "w"), indent=1)
json.dump(native, open(os.path.join(args.out, "native.json"), "w"))
print(len(manifest), "pages:", sum(p["page"].startswith("doclaynet") for p in manifest), "doclaynet")

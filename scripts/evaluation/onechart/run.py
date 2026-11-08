"""Crop the gold charts and run upstream OneChart (kppkkp/OneChart, Apache-2.0) on CPU.
  run.py OUT_DIR MODEL_DIR PAGES_DIR  -> OUT_DIR/crops/*.png, OUT_DIR/onechart.jsonl

PAGES_DIR holds p50.png, p51.png, p52.png, p67.png copied from the gold review images
(.evaluation/gold/batch{3,4}-v1/images/public-comps_ares_2026-q1_002-p*.png). MODEL_DIR is a local
snapshot of kppkkp/OneChart. Environment that works (newer transformers corrupts generation):
  uv run -p 3.11 --with transformers==4.32.1 --with torch==2.1.2 --with torchvision==0.16.2 \
    --with pillow --with "numpy<2" --with sentencepiece --with "accelerate<0.30" python run.py ...
"""
import json
import sys
import time
from pathlib import Path

from PIL import Image

out, model_dir, pages_dir = map(Path, sys.argv[1:4])
sys.path.insert(0, str(Path(__file__).parent))
from charts import CHARTS  # noqa: E402

(out / "crops").mkdir(parents=True, exist_ok=True)
for name, (page, box, _) in CHARTS.items():
    Image.open(pages_dir / f"p{page}.png").convert("RGB").crop(box).save(out / "crops" / f"{name}.png")

import torch  # noqa: E402
from transformers import AutoModel, AutoTokenizer  # noqa: E402

torch.set_num_threads(4)
t0 = time.perf_counter()
tok = AutoTokenizer.from_pretrained(str(model_dir), trust_remote_code=True, use_fast=False, padding_side="right")
model = AutoModel.from_pretrained(str(model_dir), trust_remote_code=True, low_cpu_mem_usage=True).eval()
load_s = time.perf_counter() - t0
print(f"loaded in {load_s:.1f}s", flush=True)
with open(out / "onechart.jsonl", "w") as f:
    for name in CHARTS:
        t = time.perf_counter()
        with torch.no_grad():
            res = model.chat(tok, str(out / "crops" / f"{name}.png"), reliable_check=True)
        s = time.perf_counter() - t
        f.write(json.dumps({"chart": name, "seconds": round(s, 2), "output": res}, ensure_ascii=False) + "\n")
        print(f"{name}: {s:.1f}s\n{res}\n", flush=True)

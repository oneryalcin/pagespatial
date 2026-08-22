"""Fetch and PIN the sidecar's PP-OCRv6 models (adoption precondition 2).

The ceremony could only OBSERVE one model revision after the fact; this
script is the pin. Two modes:

  record  — download the current revision of each repo, resolve the exact
            commit sha from the Hub, hash every file, and write the pin
            manifest (service/sidecar/model-pins.json). Run ONCE, commit
            the manifest, and the validated sanity check freezes it.
  verify  — (default) download/verify against the committed manifest:
            exact revision, exact per-file sha256. Any drift is a hard
            failure — a host can never silently run weights the ceremony
            lineage did not validate.

Usage (uv keeps this dependency-light):
  uv run --with huggingface_hub python service/sidecar/fetch_models.py \
      --models-dir <dir> [--record]

The manifest is configuration, not corpus data: repo names, commit shas,
file hashes only.
"""

import argparse
import hashlib
import json
import sys
from pathlib import Path

REPOS = [
    "PaddlePaddle/PP-OCRv6_small_det",
    "PaddlePaddle/PP-OCRv6_small_rec",
]
MANIFEST = Path(__file__).parent / "model-pins.json"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def snapshot(repo: str, models_dir: Path, revision: str | None) -> Path:
    from huggingface_hub import snapshot_download

    target = models_dir / repo.split("/")[-1]
    snapshot_download(
        repo_id=repo,
        revision=revision,
        local_dir=str(target),
    )
    return target


def hash_tree(root: Path) -> dict:
    hashes = {}
    for path in sorted(root.rglob("*")):
        if path.is_file() and ".cache" not in path.parts:
            hashes[str(path.relative_to(root))] = sha256_file(path)
    return hashes


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--models-dir", required=True)
    parser.add_argument("--record", action="store_true")
    args = parser.parse_args()
    models_dir = Path(args.models_dir)
    models_dir.mkdir(parents=True, exist_ok=True)

    if args.record:
        from huggingface_hub import HfApi

        api = HfApi()
        manifest = {"repos": {}}
        for repo in REPOS:
            revision = api.repo_info(repo).sha
            target = snapshot(repo, models_dir, revision)
            manifest["repos"][repo] = {
                "revision": revision,
                "files": hash_tree(target),
            }
            print(f"recorded {repo}@{revision} ({len(manifest['repos'][repo]['files'])} files)")
        MANIFEST.write_text(json.dumps(manifest, indent=1) + "\n")
        print(f"wrote {MANIFEST}")
        return 0

    if not MANIFEST.exists():
        print("No model-pins.json — run with --record once (and commit it).", file=sys.stderr)
        return 1
    manifest = json.loads(MANIFEST.read_text())
    failures = []
    for repo, pin in manifest["repos"].items():
        target = snapshot(repo, models_dir, pin["revision"])
        actual = hash_tree(target)
        for rel, expected in pin["files"].items():
            got = actual.get(rel)
            if got != expected:
                failures.append(f"{repo}/{rel}: expected {expected[:12]}, got {str(got)[:12]}")
    if failures:
        print("PIN MISMATCH — refusing:\n" + "\n".join(failures), file=sys.stderr)
        return 1
    print(f"verified {len(manifest['repos'])} pinned repos into {models_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

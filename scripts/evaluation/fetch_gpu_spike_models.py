"""Download and verify the exact PP-OCRv6 Tiny/Small spike models.

The input manifest is committed configuration. The script resolves each
repository at the recorded immutable revision, then refuses any mismatch in
the inference files that can affect execution. It is used while building the
Modal images; no model download is allowed during a measured call.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fetch_and_verify(manifest_path: Path, models_dir: Path) -> dict[str, dict]:
    from huggingface_hub import snapshot_download

    manifest = json.loads(manifest_path.read_text())
    verified: dict[str, dict] = {}
    for tier, tier_pin in manifest["models"].items():
        verified[tier] = {}
        for role in ("detector", "recognizer"):
            pin = tier_pin[role]
            target = models_dir / tier / role
            snapshot_download(
                repo_id=pin["repo"],
                revision=pin["revision"],
                local_dir=str(target),
            )
            actual = {}
            for relative, expected in pin["files"].items():
                path = target / relative
                if not path.is_file():
                    raise RuntimeError(f"missing pinned file: {tier}/{role}/{relative}")
                got = sha256_file(path)
                if got != expected:
                    raise RuntimeError(
                        f"model pin mismatch: {tier}/{role}/{relative}: "
                        f"expected {expected}, got {got}"
                    )
                actual[relative] = got
            verified[tier][role] = {
                "repo": pin["repo"],
                "revision": pin["revision"],
                "directory": str(target),
                "files": actual,
            }
    return verified


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--models-dir", required=True, type=Path)
    parser.add_argument("--verification-out", type=Path)
    args = parser.parse_args()
    args.models_dir.mkdir(parents=True, exist_ok=True)
    verified = fetch_and_verify(args.manifest, args.models_dir)
    if args.verification_out:
        args.verification_out.parent.mkdir(parents=True, exist_ok=True)
        args.verification_out.write_text(json.dumps(verified, indent=1) + "\n")
    print(
        "verified "
        + ", ".join(
            f"{tier}/{role}"
            for tier in sorted(verified)
            for role in ("detector", "recognizer")
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

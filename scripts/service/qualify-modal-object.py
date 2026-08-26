#!/usr/bin/env python3
"""Focused real-R2 qualification for ParseContainer.parse_object.

Run from the repository root:

  uv run --with modal==1.5.3 --with boto3==1.43.74 --with python-dotenv \
    python scripts/service/qualify-modal-object.py --pdf path/to/document.pdf

The script never prints credentials. It uploads one input, runs two direct
controls and two pointer executions, verifies the stored envelopes by GET and
LIST, checks the digest-mismatch failure, writes local captures for the
existing comparator, then removes every object it created unless --keep-r2 is
set.
"""

import argparse
import hashlib
import json
import os
import uuid
from pathlib import Path

import boto3
import modal
from dotenv import dotenv_values


def config() -> dict[str, str]:
    values = {**dotenv_values(".env"), **os.environ}
    names = ("R2_ENDPOINT", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY")
    missing = [name for name in names if not values.get(name)]
    if missing:
        raise SystemExit(f"missing R2 configuration: {', '.join(missing)}")
    return {name: str(values[name]) for name in names}


def write_json(path: Path, value) -> None:
    path.write_text(json.dumps(value, indent=1) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf", required=True, type=Path)
    parser.add_argument("--app", default="pagespatial-parse-m1-dev")
    parser.add_argument("--out", type=Path)
    parser.add_argument("--keep-r2", action="store_true")
    args = parser.parse_args()

    pdf = args.pdf.read_bytes()
    digest = hashlib.sha256(pdf).hexdigest()
    job_id = str(uuid.uuid4())
    attempt_id = str(uuid.uuid4())
    bad_attempt_id = str(uuid.uuid4())
    input_key = f"inputs/{job_id}.pdf"
    result_prefix = f"results/{job_id}/{attempt_id}"
    bad_prefix = f"results/{job_id}/{bad_attempt_id}"
    out = args.out or Path(".evaluation/service-m1-object") / job_id
    out.mkdir(parents=True, exist_ok=False)

    env = config()
    client = boto3.client(
        "s3", endpoint_url=env["R2_ENDPOINT"].rstrip("/"), region_name="auto",
        aws_access_key_id=env["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=env["R2_SECRET_ACCESS_KEY"],
    )
    bucket = env["R2_BUCKET"]
    created_keys = [input_key]

    parse_cls = modal.Cls.from_name(args.app, "ParseContainer")
    remote = parse_cls()
    direct_payload = {
        "request_id": job_id,
        "pdf_bytes": pdf,
        "expected_sha256": digest,
        "schema_version": "0.6.0",
        "enrichment": "off",
    }
    object_payload = {
        "job_id": job_id,
        "attempt_id": attempt_id,
        "expected_sha256": digest,
        "input_key": input_key,
        "result_prefix": result_prefix,
    }

    try:
        client.put_object(Bucket=bucket, Key=input_key, Body=pdf,
                          ContentType="application/pdf")

        direct_a = remote.parse_document.remote(direct_payload)
        direct_b = remote.parse_document.remote(direct_payload)
        pointers = []
        for _ in range(2):
            pointer = remote.parse_object.remote(object_payload)
            pointers.append(pointer)
            created_keys.append(pointer["result_key"])
        pointer_a, pointer_b = pointers

        object_results = []
        for pointer in pointers:
            key = pointer["result_key"]
            stored = client.get_object(Bucket=bucket, Key=key)["Body"].read()
            if hashlib.sha256(stored).hexdigest() != pointer["result_digest"]:
                raise RuntimeError(f"stored result digest mismatch for {key}")
            envelope = json.loads(stored)
            identity = (envelope["job_id"], envelope["attempt_id"],
                        envelope["execution_id"], envelope["input_sha256"])
            expected = (job_id, attempt_id, pointer["execution_id"], digest)
            if identity != expected:
                raise RuntimeError(f"stored result identity mismatch for {key}")
            object_results.append(envelope["parse_result"])

        if pointer_a["result_key"] == pointer_b["result_key"]:
            raise RuntimeError("two executions reused one result key")
        listed = {
            item["Key"] for item in client.list_objects_v2(
                Bucket=bucket, Prefix=f"{result_prefix}/").get("Contents", [])
        }
        if not {pointer_a["result_key"], pointer_b["result_key"]}.issubset(listed):
            raise RuntimeError("result prefix LIST did not recover both executions")

        mismatch_failed = False
        try:
            remote.parse_object.remote({
                **object_payload,
                "attempt_id": bad_attempt_id,
                "result_prefix": bad_prefix,
                "expected_sha256": "0" * 64,
            })
        except Exception:
            mismatch_failed = True
        if not mismatch_failed:
            raise RuntimeError("digest mismatch unexpectedly succeeded")
        bad_objects = client.list_objects_v2(Bucket=bucket, Prefix=f"{bad_prefix}/")
        if bad_objects.get("Contents"):
            raise RuntimeError("digest mismatch published a result object")

        write_json(out / "direct-a.json", direct_a)
        write_json(out / "direct-b.json", direct_b)
        write_json(out / "object-a.json", object_results[0])
        write_json(out / "object-b.json", object_results[1])
        write_json(out / "metadata.json", {
            "app": args.app,
            "pdf": str(args.pdf),
            "input_bytes": len(pdf),
            "input_sha256": digest,
            "job_id": job_id,
            "attempt_id": attempt_id,
            "pointer_a": pointer_a,
            "pointer_b": pointer_b,
            "digest_mismatch_failed": mismatch_failed,
            "r2_list_recovered_both": True,
            "r2_objects_retained": args.keep_r2,
        })
        print(out)
    finally:
        if not args.keep_r2:
            # The UUID-scoped prefixes are ours alone. LIST also catches an
            # object published just before a client or harness failure.
            for prefix in (result_prefix, bad_prefix):
                for item in client.list_objects_v2(
                        Bucket=bucket, Prefix=f"{prefix}/").get("Contents", []):
                    created_keys.append(item["Key"])
            for key in reversed(created_keys):
                client.delete_object(Bucket=bucket, Key=key)


if __name__ == "__main__":
    main()

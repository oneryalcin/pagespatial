"""Unit tests for the pure adapter helpers (validation, job budget,
stop-fetching helper, scratch sweep) with the Modal SDK stubbed out.

Run:  python3 deploy/modal/test_modal_app.py

Deliberately NOT wired into `npm test` (the JS suite must not require a
Python SDK); the Modal SDK itself is not required either — a stub module
is installed before import.
"""

import hashlib
import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path

# ---------------------------------------------------------------------------
# Stub `modal` before importing the adapter.
# ---------------------------------------------------------------------------
STOP_CALLS = []


def _install_modal_stub():
    stub = types.ModuleType("modal")
    stub.is_local = lambda: True

    class _App:
        def __init__(self, name):
            self.name = name

        def cls(self, **_kwargs):
            return lambda c: c

        def local_entrypoint(self, **_kwargs):
            return lambda f: f

    class _Image:
        @staticmethod
        def from_dockerfile(*_args, **_kwargs):
            return _Image()

        def env(self, *_args, **_kwargs):
            return self

    class _Cls:
        @staticmethod
        def from_name(*_args, **_kwargs):
            raise RuntimeError("from_name is not available under the stub")

    def _decorator(*_args, **_kwargs):
        return lambda f: f

    experimental = types.ModuleType("modal.experimental")
    experimental.stop_fetching_inputs = lambda: STOP_CALLS.append(1)

    stub.App = _App
    stub.Image = _Image
    stub.Cls = _Cls
    stub.enter = _decorator
    stub.exit = _decorator
    stub.method = _decorator
    stub.experimental = experimental
    sys.modules["modal"] = stub
    sys.modules["modal.experimental"] = experimental


_install_modal_stub()

_SPEC = importlib.util.spec_from_file_location(
    "modal_app", Path(__file__).resolve().parent / "modal_app.py")
modal_app = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(modal_app)


def _payload(**overrides):
    pdf = b"%PDF-1.4 test bytes"
    base = {
        "request_id": "req-1",
        "pdf_bytes": pdf,
        "expected_sha256": hashlib.sha256(pdf).hexdigest(),
        "schema_version": modal_app.SCHEMA_VERSION,
        "enrichment": "off",
    }
    base.update(overrides)
    return base


class ValidateInputTest(unittest.TestCase):
    def test_accepts_a_well_formed_payload(self):
        self.assertEqual(modal_app.validate_input(_payload()), b"%PDF-1.4 test bytes")

    def test_rejects_missing_or_malformed_request_id(self):
        for bad in (None, "", "   ", 7, "x" * 257):
            with self.assertRaises(modal_app.InputRejected):
                modal_app.validate_input(_payload(request_id=bad))

    def test_rejects_unsupported_schema_version(self):
        with self.assertRaises(modal_app.InputRejected):
            modal_app.validate_input(_payload(schema_version="0.5.0"))

    def test_rejects_any_enrichment_other_than_off(self):
        for bad in ("batch", "on", None):
            with self.assertRaises(modal_app.InputRejected):
                modal_app.validate_input(_payload(enrichment=bad))

    def test_rejects_empty_and_oversized_bodies(self):
        with self.assertRaises(modal_app.InputRejected):
            modal_app.validate_input(_payload(pdf_bytes=b""))
        modal_app.MAX_INPUT_BYTES, saved = 8, modal_app.MAX_INPUT_BYTES
        try:
            with self.assertRaises(modal_app.InputRejected):
                modal_app.validate_input(_payload())
        finally:
            modal_app.MAX_INPUT_BYTES = saved

    def test_rejects_sha256_mismatch_and_malformed_hash(self):
        with self.assertRaises(modal_app.InputRejected):
            modal_app.validate_input(_payload(expected_sha256="a" * 64))
        with self.assertRaises(modal_app.InputRejected):
            modal_app.validate_input(_payload(expected_sha256="NOT-HEX"))
        upper = hashlib.sha256(b"%PDF-1.4 test bytes").hexdigest().upper()
        with self.assertRaises(modal_app.InputRejected):
            modal_app.validate_input(_payload(expected_sha256=upper))

    def test_never_accepts_a_server_side_pdf_path(self):
        with self.assertRaises(modal_app.InputRejected):
            modal_app.validate_input(_payload(pdfPath="/etc/passwd"))
        with self.assertRaises(modal_app.InputRejected):
            modal_app.validate_input(_payload(pdf_path="/etc/passwd"))


class JobBudgetTest(unittest.TestCase):
    def test_exhausts_exactly_at_the_limit(self):
        budget = modal_app.JobBudget(limit=3)
        self.assertFalse(budget.record_created())
        self.assertFalse(budget.record_created())
        self.assertTrue(budget.record_created())
        self.assertEqual(budget.created, 3)

    def test_default_limit_is_100(self):
        self.assertEqual(modal_app.JobBudget().limit, 100)


class StopFetchingHelperTest(unittest.TestCase):
    def test_helper_calls_the_experimental_api(self):
        before = len(STOP_CALLS)
        modal_app.stop_fetching_inputs()
        self.assertEqual(len(STOP_CALLS), before + 1)


class SweepScratchTest(unittest.TestCase):
    def test_removes_job_dirs_and_uploads_but_keeps_current_job_and_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            (base / "job_old" / "pages").mkdir(parents=True)
            (base / "job_current" / "pages").mkdir(parents=True)
            (base / "uploads").mkdir()
            (base / "uploads" / "upload_dead.pdf").write_bytes(b"x")
            (base / "node.log").write_text("log")
            removed = modal_app.sweep_scratch(str(base), keep_job_id="job_current")
            self.assertEqual(sorted(removed), ["job_old", "uploads/upload_dead.pdf"])
            self.assertTrue((base / "job_current").is_dir())
            self.assertTrue((base / "uploads").is_dir())
            self.assertTrue((base / "node.log").exists())

    def test_missing_dir_is_a_no_op(self):
        self.assertEqual(modal_app.sweep_scratch("/nonexistent/path"), [])


if __name__ == "__main__":
    unittest.main()

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


class InjectionGateTest(unittest.TestCase):
    """§14.2 hard rule: the production deployment configuration cannot
    reach an injected failure. Both gates (explicit env flag AND dev/test
    app name) must be present; either missing is a visible rejection."""

    DEV_ENV = {"PAGESPATIAL_ENABLE_TEST_FAILURES": "1",
               "PAGESPATIAL_APP_NAME": "pagespatial-parse-m1-dev"}

    def test_no_injection_requested_is_a_no_op_everywhere(self):
        self.assertIsNone(modal_app.validate_injection(_payload(), environ={}))
        self.assertIsNone(modal_app.validate_injection(_payload(), environ=self.DEV_ENV))

    def test_production_env_without_flag_rejects_injection(self):
        env = {"PAGESPATIAL_APP_NAME": "pagespatial-parse-m1-dev"}  # flag never set in prod config
        with self.assertRaises(modal_app.InputRejected):
            modal_app.validate_injection(_payload(test_failure="exception"), environ=env)

    def test_flag_on_a_non_dev_app_name_rejects_injection(self):
        env = {"PAGESPATIAL_ENABLE_TEST_FAILURES": "1",
               "PAGESPATIAL_APP_NAME": "pagespatial-parse"}
        with self.assertRaises(modal_app.InputRejected):
            modal_app.validate_injection(_payload(test_failure="exception"), environ=env)

    def test_both_gates_open_accepts_only_known_modes(self):
        for mode in modal_app.INJECTION_MODES:
            self.assertEqual(
                modal_app.validate_injection(_payload(test_failure=mode), environ=self.DEV_ENV),
                mode)
        with self.assertRaises(modal_app.InputRejected):
            modal_app.validate_injection(_payload(test_failure="kill-container"), environ=self.DEV_ENV)

    def test_no_container_self_kill_mode_exists(self):
        # §14.2: container failure is injected externally and one-shot;
        # a self-kill input would be rescheduled and could crash-loop.
        self.assertEqual(modal_app.INJECTION_MODES, ("exception", "timeout", "kill-node"))

    def test_dev_app_name_rule(self):
        self.assertTrue(modal_app._is_dev_app("x-dev"))
        self.assertTrue(modal_app._is_dev_app("x-test"))
        for bad in ("pagespatial-parse", "dev-parse", "", None):
            self.assertFalse(modal_app._is_dev_app(bad))


class DeployTimeGateTest(unittest.TestCase):
    """Deploy-time half of the §14.2 double gate: enabling injection for a
    non-dev app name must refuse to even build the deployment."""

    @staticmethod
    def _import_adapter(extra_env):
        import os
        import subprocess
        env = {**os.environ, **extra_env}
        return subprocess.run(
            [sys.executable, "-c",
             f"import sys; sys.path.insert(0, {str(Path(__file__).resolve().parent)!r}); "
             "import test_modal_app; print('import-ok')"],
            capture_output=True, text=True, timeout=60, env=env)

    def test_injection_flag_with_non_dev_app_name_refuses_at_deploy_time(self):
        result = self._import_adapter({
            "PAGESPATIAL_ENABLE_TEST_FAILURES": "1",
            "PAGESPATIAL_MODAL_APP_NAME": "pagespatial-parse"})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("refusing for 'pagespatial-parse'", result.stderr)

    def test_injection_flag_with_dev_app_name_deploys(self):
        result = self._import_adapter({
            "PAGESPATIAL_ENABLE_TEST_FAILURES": "1",
            "PAGESPATIAL_MODAL_APP_NAME": "pagespatial-parse-arm9-dev"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("import-ok", result.stdout)


class SurvivingChildrenTest(unittest.TestCase):
    """§14.4 criterion 8 instrument, exercised against a fake /proc."""

    @staticmethod
    def _fake_proc(base, pid, comm, ppid):
        d = Path(base) / str(pid)
        d.mkdir()
        (d / "stat").write_text(f"{pid} ({comm}) S {ppid} 1 1 0 -1")

    def test_lists_everything_except_pid1_and_self(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._fake_proc(tmp, 1, "init", 0)
            self._fake_proc(tmp, 40, "python3", 1)      # the adapter (self)
            self._fake_proc(tmp, 41, "node", 40)
            self._fake_proc(tmp, 42, "pdf worker", 41)  # comm with a space
            procs = modal_app.surviving_children(proc_root=tmp, self_pid=40)
            self.assertEqual(procs, [
                {"pid": 41, "ppid": 40, "comm": "node"},
                {"pid": 42, "ppid": 41, "comm": "pdf worker"},
            ])

    def test_leak_filter_flags_node_and_orphaned_workers_only(self):
        procs = [
            {"pid": 41, "ppid": 40, "comm": "node"},          # leaked node
            {"pid": 42, "ppid": 41, "comm": "python3"},       # child of dead service
            {"pid": 50, "ppid": 1, "comm": "modal-runtime"},  # unrelated platform proc
        ]
        leaked = modal_app.leaked_service_processes(procs, service_pid=41, self_pid=40)
        self.assertEqual([p["pid"] for p in leaked], [41, 42])

    def test_clean_container_reports_zero_survivors(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._fake_proc(tmp, 1, "init", 0)
            self._fake_proc(tmp, 40, "python3", 1)
            procs = modal_app.surviving_children(proc_root=tmp, self_pid=40)
            self.assertEqual(procs, [])
            self.assertEqual(modal_app.leaked_service_processes(procs, service_pid=41), [])

    def test_missing_proc_root_is_empty_not_fatal(self):
        self.assertEqual(modal_app.surviving_children(proc_root="/nonexistent"), [])


if __name__ == "__main__":
    unittest.main()

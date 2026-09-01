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
from unittest import mock
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

        def uv_pip_install(self, *_args, **_kwargs):
            return self

    class _Cls:
        @staticmethod
        def from_name(*_args, **_kwargs):
            raise RuntimeError("from_name is not available under the stub")

    class _Secret:
        @staticmethod
        def from_name(name):
            return name

    def _decorator(*_args, **_kwargs):
        return lambda f: f

    experimental = types.ModuleType("modal.experimental")
    experimental.stop_fetching_inputs = lambda: STOP_CALLS.append(1)

    stub.App = _App
    stub.Image = _Image
    stub.Cls = _Cls
    stub.Secret = _Secret
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


class ValidateObjectInputTest(unittest.TestCase):
    JOB_ID = "11111111-1111-4111-8111-111111111111"
    ATTEMPT_ID = "22222222-2222-4222-8222-222222222222"

    def payload(self, **overrides):
        base = {
            "job_id": self.JOB_ID,
            "attempt_id": self.ATTEMPT_ID,
            "expected_sha256": "a" * 64,
            "input_key": f"inputs/{self.JOB_ID}.pdf",
            "result_prefix": f"results/{self.JOB_ID}/{self.ATTEMPT_ID}",
        }
        base.update(overrides)
        return base

    def test_accepts_the_exact_pointer_contract(self):
        self.assertEqual(modal_app.validate_object_input(self.payload()), self.payload())

    def test_rejects_noncanonical_ids_and_foreign_result_prefixes(self):
        with self.assertRaises(modal_app.InputRejected):
            modal_app.validate_object_input(self.payload(
                job_id="AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"))
        with self.assertRaises(modal_app.InputRejected):
            modal_app.validate_object_input(self.payload(result_prefix="results/other/attempt"))
        with self.assertRaises(modal_app.InputRejected):
            modal_app.validate_object_input(self.payload(input_key="inputs/other.pdf"))

    def test_rejects_unknown_fields_and_unsafe_keys(self):
        with self.assertRaises(modal_app.InputRejected):
            modal_app.validate_object_input(self.payload(extra="not-v1"))
        with self.assertRaises(modal_app.InputRejected):
            modal_app.validate_object_input(self.payload(input_key="inputs/../secret"))

    def test_r2_config_requires_https_and_all_four_values(self):
        good = {
            "R2_INPUT_ENDPOINT": "https://example.r2.cloudflarestorage.com/",
            "R2_INPUT_BUCKET": "pagespatial-inputs-dev",
            "R2_INPUT_ACCESS_KEY_ID": "input-id",
            "R2_INPUT_SECRET_ACCESS_KEY": "input-secret",
            "R2_RESULTS_ENDPOINT": "https://example.r2.cloudflarestorage.com/",
            "R2_RESULTS_BUCKET": "pagespatial-results-dev",
            "R2_RESULTS_ACCESS_KEY_ID": "result-id",
            "R2_RESULTS_SECRET_ACCESS_KEY": "result-secret",
        }
        config = modal_app.load_r2_config(good)
        self.assertEqual(config.input.bucket, "pagespatial-inputs-dev")
        self.assertEqual(config.results.bucket, "pagespatial-results-dev")
        with self.assertRaises(RuntimeError):
            modal_app.load_r2_config({**good, "R2_INPUT_ENDPOINT": "http://example.test"})
        with self.assertRaises(RuntimeError):
            modal_app.load_r2_config({key: value for key, value in good.items()
                                      if key != "R2_RESULTS_SECRET_ACCESS_KEY"})

    def test_r2_config_requires_distinct_buckets_and_credentials(self):
        good = {
            "R2_INPUT_ENDPOINT": "https://example.r2.cloudflarestorage.com",
            "R2_INPUT_BUCKET": "inputs",
            "R2_INPUT_ACCESS_KEY_ID": "input-id",
            "R2_INPUT_SECRET_ACCESS_KEY": "input-secret",
            "R2_RESULTS_ENDPOINT": "https://example.r2.cloudflarestorage.com",
            "R2_RESULTS_BUCKET": "results",
            "R2_RESULTS_ACCESS_KEY_ID": "result-id",
            "R2_RESULTS_SECRET_ACCESS_KEY": "result-secret",
        }
        with self.assertRaises(RuntimeError):
            modal_app.load_r2_config({**good, "R2_RESULTS_BUCKET": "inputs"})
        with self.assertRaises(RuntimeError):
            modal_app.load_r2_config({**good,
                                      "R2_RESULTS_ACCESS_KEY_ID": "input-id"})

    def test_r2_clients_are_split_and_cached_per_warm_container(self):
        env = {
            "R2_INPUT_ENDPOINT": "https://example.r2.cloudflarestorage.com",
            "R2_INPUT_BUCKET": "inputs",
            "R2_INPUT_ACCESS_KEY_ID": "input-id",
            "R2_INPUT_SECRET_ACCESS_KEY": "input-secret",
            "R2_RESULTS_ENDPOINT": "https://example.r2.cloudflarestorage.com",
            "R2_RESULTS_BUCKET": "results",
            "R2_RESULTS_ACCESS_KEY_ID": "result-id",
            "R2_RESULTS_SECRET_ACCESS_KEY": "result-secret",
        }
        calls = []
        boto3 = types.ModuleType("boto3")
        boto3.client = lambda *args, **kwargs: calls.append((args, kwargs)) or object()
        instance = modal_app.ParseContainer.__new__(modal_app.ParseContainer)
        with mock.patch.dict(sys.modules, {"boto3": boto3}), mock.patch.dict(
                modal_app.os.environ, env, clear=True):
            first = instance._r2()
            second = instance._r2()
        self.assertIs(first, second)
        self.assertEqual(len(calls), 2)
        self.assertEqual(first.input_bucket, "inputs")
        self.assertEqual(first.results_bucket, "results")
        self.assertEqual(calls[0][1]["aws_access_key_id"], "input-id")
        self.assertEqual(calls[1][1]["aws_access_key_id"], "result-id")


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

    def test_dev_app_name_rule_is_an_anchored_allowlist(self):
        for good in ("pagespatial-parse-dev", "pagespatial-parse-test",
                     "pagespatial-parse-m1-dev", "pagespatial-parse-arm16-dev"):
            self.assertTrue(modal_app._is_dev_app(good), good)
        # A bare '-dev' suffix on an arbitrary name must NOT qualify.
        for bad in ("pagespatial-parse", "dev-parse", "x-dev", "x-test",
                    "pagespatial-parse-prod-dev", "evil-pagespatial-parse-m1-dev",
                    "pagespatial-parse-m1-dev-prod", "", None):
            self.assertFalse(modal_app._is_dev_app(bad), repr(bad))


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

    def test_unlisted_max_containers_refuses_at_deploy_time(self):
        # §7.3/§10: the M3 arm knob is an ALLOWLIST (1/4/16), never a free
        # integer — a fat-fingered 160 or 0 must refuse to build.
        result = self._import_adapter({"PAGESPATIAL_MAX_CONTAINERS": "160"})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("PAGESPATIAL_MAX_CONTAINERS must be one of", result.stderr)

    def test_allowlisted_max_containers_deploys(self):
        result = self._import_adapter({"PAGESPATIAL_MAX_CONTAINERS": "16"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("import-ok", result.stdout)

    def test_unlisted_memory_allocation_refuses_at_deploy_time(self):
        result = self._import_adapter({"PAGESPATIAL_MEMORY_MIB": "8192"})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("PAGESPATIAL_MEMORY_MIB must be one of", result.stderr)

    def test_allowlisted_memory_allocations_deploy(self):
        for memory_mib in ("12288", "16384", "24576"):
            with self.subTest(memory_mib=memory_mib):
                result = self._import_adapter({
                    "PAGESPATIAL_MEMORY_MIB": memory_mib,
                })
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("import-ok", result.stdout)

    def test_injection_flag_with_dev_app_name_deploys(self):
        result = self._import_adapter({
            "PAGESPATIAL_ENABLE_TEST_FAILURES": "1",
            "PAGESPATIAL_MODAL_APP_NAME": "pagespatial-parse-arm9-dev"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("import-ok", result.stdout)


class SurvivingChildrenTest(unittest.TestCase):
    """§14.4 criterion 8 instrument, exercised against a fake /proc."""

    @staticmethod
    def _fake_proc(base, pid, comm, ppid, cmdline="", state="S"):
        d = Path(base) / str(pid)
        d.mkdir()
        (d / "stat").write_text(f"{pid} ({comm}) {state} {ppid} 1 1 0 -1")
        (d / "cmdline").write_bytes(cmdline.replace(" ", "\0").encode())

    def test_lists_everything_except_pid1_and_self(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._fake_proc(tmp, 1, "init", 0)
            self._fake_proc(tmp, 40, "python3", 1)      # the adapter (self)
            self._fake_proc(tmp, 41, "node-MainThread", 40, "node service/server.mjs")
            self._fake_proc(tmp, 42, "pdf worker", 41)  # comm with a space
            procs = modal_app.surviving_children(proc_root=tmp, self_pid=40)
            self.assertEqual(procs, [
                {"pid": 41, "ppid": 40, "comm": "node-MainThread", "state": "S", "cmdline": "node service/server.mjs"},
                {"pid": 42, "ppid": 41, "comm": "pdf worker", "state": "S", "cmdline": ""},
            ])

    def test_leak_filter_flags_node_and_orphaned_workers_only(self):
        procs = [
            {"pid": 41, "ppid": 40, "comm": "node-MainThread", "cmdline": "node service/server.mjs"},
            {"pid": 42, "ppid": 41, "comm": "python3", "cmdline": ""},  # child of dead service
            {"pid": 50, "ppid": 1, "comm": "modal-runtime", "cmdline": "modal-runtime supervise"},
        ]
        leaked = modal_app.leaked_service_processes(procs, service_pid=41, self_pid=40)
        self.assertEqual([p["pid"] for p in leaked], [41, 42])

    def test_orphaned_sidecar_reparented_to_pid1_is_caught_by_cmdline_marker(self):
        # The realistic criterion-8 leak: a Python sidecar escapes its
        # worker's group-kill and reparents to pid 1 — comm "python3",
        # ppid 1, indistinguishable from platform processes except by argv.
        with tempfile.TemporaryDirectory() as tmp:
            self._fake_proc(tmp, 1, "init", 0)
            self._fake_proc(tmp, 40, "python3", 1)  # the adapter (self)
            self._fake_proc(tmp, 60, "python3", 1,
                            "python3 /app/service/sidecar/ppocr_sidecar.py --threads 1")
            self._fake_proc(tmp, 61, "python3", 1,
                            "python3 -m modal._container_entrypoint")  # platform proc
            procs = modal_app.surviving_children(proc_root=tmp, self_pid=40)
            leaked = modal_app.leaked_service_processes(
                procs, service_pid=41, self_pid=40,
                markers=("ppocr_sidecar.py", "/tmp/psvc-abc123"))
            self.assertEqual([p["pid"] for p in leaked], [60])
            # Without the cmdline markers this orphan is invisible — the
            # exact vacuous-pass the marker check exists to prevent.
            self.assertEqual(modal_app.leaked_service_processes(
                procs, service_pid=41, self_pid=40), [])

    def test_clean_container_reports_zero_survivors(self):
        with tempfile.TemporaryDirectory() as tmp:
            self._fake_proc(tmp, 1, "init", 0)
            self._fake_proc(tmp, 40, "python3", 1)
            procs = modal_app.surviving_children(proc_root=tmp, self_pid=40)
            self.assertEqual(procs, [])
            self.assertEqual(modal_app.leaked_service_processes(procs, service_pid=41), [])

    def test_missing_proc_root_is_empty_not_fatal(self):
        self.assertEqual(modal_app.surviving_children(proc_root="/nonexistent"), [])

    def test_leaked_live_worker_with_real_comm_is_caught(self):
        # PR #93 review, HIGH: the real container's Node comm is
        # "node-MainThread" (closure-probe baseline), so a comm EQUALITY
        # check was dead code in production. The reviewer's exact repro:
        # server dead, a wedged worker with intact argv reparents to
        # pid 1 — it must be a survivor via the comm prefix AND via the
        # worker.mjs argv marker independently.
        wedged = {"pid": 117, "ppid": 1, "comm": "node-MainThread",
                  "state": "S", "cmdline": "/usr/local/bin/node /app/service/worker.mjs"}
        procs = [wedged,
                 {"pid": 200, "ppid": 1, "comm": "python3", "state": "S",
                  "cmdline": "python3 -m modal._container_entrypoint"}]
        by_comm = modal_app.leaked_service_processes(procs, service_pid=5, self_pid=40)
        self.assertEqual([p["pid"] for p in by_comm], [117])
        # And with comm hypothetically renamed, the argv marker still catches it.
        renamed = [{**wedged, "comm": "MainThread"}, procs[1]]
        by_marker = modal_app.leaked_service_processes(
            renamed, service_pid=5, self_pid=40,
            markers=("ppocr_sidecar.py", "service/worker.mjs", "service/server.mjs", "/tmp/psvc-x"))
        self.assertEqual([p["pid"] for p in by_marker], [117])
        # The pre-fix behavior (equality + no worker marker) is the pinned
        # vacuous pass: nothing would have been flagged.
        equality_only = [p for p in renamed if p["comm"] == "node"]
        self.assertEqual(equality_only, [])

    def test_empty_cmdline_python_is_indeterminate_never_silently_clean(self):
        # Criterion-8 closure (external review, 2026-08-24): the M3 arm-8
        # artifact listed four `python` processes at ppid 1 with EMPTY
        # cmdlines — unmatchable by any marker — and still reported
        # clean:true. The state field must classify them: 'Z' = provably
        # dead zombie awaiting reap (reported, not a leak); anything else
        # with a service-class comm and no argv = indeterminate-live and
        # MUST fail the probe.
        procs = [
            {"pid": 154, "ppid": 1, "comm": "python", "state": "Z", "cmdline": ""},
            {"pid": 155, "ppid": 1, "comm": "python", "state": "S", "cmdline": ""},
            {"pid": 156, "ppid": 1, "comm": "node", "state": "Z", "cmdline": ""},
            # platform proc with argv: not indeterminate
            {"pid": 200, "ppid": 1, "comm": "python3", "state": "S",
             "cmdline": "python3 -m modal._container_entrypoint"},
            # non-service comm with no argv (kernel thread style): ignored
            {"pid": 201, "ppid": 2, "comm": "kworker/0:1", "state": "I", "cmdline": ""},
        ]
        classified = modal_app.indeterminate_processes(procs)
        by_pid = {p["pid"]: p["classification"] for p in classified}
        self.assertEqual(by_pid, {154: "zombie", 155: "indeterminate-live", 156: "zombie"})
        # The marker filter alone STILL sees none of them — the vacuous
        # pass the classification exists to close.
        self.assertEqual(modal_app.leaked_service_processes(
            procs, service_pid=41, self_pid=40,
            markers=("ppocr_sidecar.py", "/tmp/psvc-abc")), [
            procs[2]])  # only via the node comm prefix; the pythons stay invisible


if __name__ == "__main__":
    unittest.main()

"""Integration tests for `ParseContainer.parse_document`'s FULL body against
a fake loopback service (PR #89 review finding 4, M2 scope): the Modal
decorators are stubbed (via test_modal_app) and the Node service is replaced
by a scripted local HTTP server plus a dummy child process.

Proves each failure path is REACHABLE and BOUNDED (§16 M2 acceptance):
retire-on-transport-failure ordering, ServiceRefused, ResultTooLarge, the
poisoned-instance gate, finally-cleanup interplay, `stop_fetching_inputs()`
itself throwing, the three test-only injections behind their double gate,
and the dev-only lifecycle probes.

Run:  python3 deploy/modal/test_modal_integration.py
"""

import contextlib
import hashlib
import io
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_modal_app import STOP_CALLS, modal_app  # noqa: E402  (installs the modal stub)

DEV_ENV = {"PAGESPATIAL_ENABLE_TEST_FAILURES": "1",
           "PAGESPATIAL_APP_NAME": "pagespatial-parse-m1-dev"}

PDF = b"%PDF-1.4 integration bytes"
SHA = hashlib.sha256(PDF).hexdigest()
JOB_ID = "11111111-1111-4111-8111-111111111111"
ATTEMPT_ID = "22222222-2222-4222-8222-222222222222"
INPUT_KEY = f"inputs/{JOB_ID}.pdf"
RESULT_PREFIX = f"results/{JOB_ID}/{ATTEMPT_ID}"


def _payload(**overrides):
    base = {
        "request_id": "int-req-1",
        "pdf_bytes": PDF,
        "expected_sha256": SHA,
        "schema_version": modal_app.SCHEMA_VERSION,
        "enrichment": "off",
    }
    base.update(overrides)
    return base


def _object_payload(**overrides):
    base = {
        "job_id": JOB_ID,
        "attempt_id": ATTEMPT_ID,
        "expected_sha256": SHA,
        "input_key": INPUT_KEY,
        "result_prefix": RESULT_PREFIX,
    }
    base.update(overrides)
    return base


class _FakeR2:
    def __init__(self):
        self.objects = {INPUT_KEY: PDF}
        self.fail_put = False

    def get_object(self, *, Bucket, Key):
        data = self.objects[Key]
        return {"ContentLength": len(data), "Body": io.BytesIO(data)}

    def put_object(self, *, Bucket, Key, Body, ContentType):
        if self.fail_put:
            raise OSError("injected R2 PUT failure")
        self.objects[Key] = bytes(Body)
        return {"ETag": "fake"}


class _FakeService:
    """Scripted stand-in for the loopback Node service."""

    def __init__(self):
        self.script = {
            "submit_status": 202,
            "submit_body": {"jobId": "job-1", "sha256": SHA, "pageCount": 2},
            "job_responses": [
                {"status": "completed",
                 "pages": [{"pageNumber": 1, "ok": True,
                            "pageSpatial": {"pageNumber": 1}},
                           {"pageNumber": 2, "ok": False}]},
            ],
            "health_status": 200,
        }
        self.posts = 0
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _json(self, status, body):
                payload = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def do_GET(self):
                if self.path == "/health":
                    return self._json(fake.script["health_status"], {"status": "ok"})
                if self.path.startswith("/v1/jobs/"):
                    responses = fake.script["job_responses"]
                    body = responses[0] if len(responses) == 1 else responses.pop(0)
                    return self._json(200, body)
                return self._json(404, {"error": "unknown"})

            def do_POST(self):
                self.rfile.read(int(self.headers.get("content-length", 0)))
                fake.posts += 1
                return self._json(fake.script["submit_status"], fake.script["submit_body"])

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def _dummy_node():
    return subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(300)"],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


class ParseDocumentIntegrationTest(unittest.TestCase):
    def setUp(self):
        self.fake = _FakeService()
        self.saved_port = modal_app.SERVICE_PORT
        modal_app.SERVICE_PORT = self.fake.port
        self.tmp = tempfile.TemporaryDirectory()
        (Path(self.tmp.name) / "uploads").mkdir()
        self.node = _dummy_node()
        self.instance = self._make_instance()
        self.r2 = _FakeR2()
        self.instance._r2 = lambda: modal_app.R2Store(
            self.r2, "pagespatial-inputs-dev",
            self.r2, "pagespatial-results-dev")

    def tearDown(self):
        modal_app.SERVICE_PORT = self.saved_port
        if self.node.poll() is None:
            self.node.kill()
            self.node.wait(timeout=10)
        self.fake.close()
        self.tmp.cleanup()

    def _make_instance(self):
        inst = modal_app.ParseContainer.__new__(modal_app.ParseContainer)
        inst.cold = False
        inst.budget = modal_app.JobBudget()
        inst.retired = False
        inst.data_dir = self.tmp.name
        inst.service_ready_ms = 4321
        inst.node = self.node
        inst.log_context = {"app_name": "pagespatial-parse-m1-dev",
                            "adapter_revision": "testrev",
                            "image_pin_revision": "testpin",
                            "resources": modal_app.RESOURCES}
        inst.method_context = {}
        return inst

    def _call(self, payload):
        """Run parse_document, capturing structured log events."""
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            result = self.instance.parse_document(payload)
        return result, [json.loads(line) for line in out.getvalue().splitlines() if line]

    def _call_expect_raise(self, payload, exc):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            with self.assertRaises(exc) as ctx:
                self.instance.parse_document(payload)
        return ctx.exception, [json.loads(line) for line in out.getvalue().splitlines() if line]

    def _call_object(self, payload):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            result = self.instance.parse_object(payload)
        return result, [json.loads(line) for line in out.getvalue().splitlines() if line]

    # -- happy path: §12 field audit ------------------------------------

    def test_completed_result_carries_the_full_field_set(self):
        stale = Path(self.tmp.name) / "job_stale"
        stale.mkdir()
        (Path(self.tmp.name) / "uploads" / "upload_stale.pdf").write_bytes(b"x")
        result, events = self._call(_payload())
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["page_count"], 2)
        self.assertEqual(result["pages_ok"], 1)
        self.assertEqual(result["pages_failed"], 1)
        self.assertEqual(result["document_sha256"], SHA)
        self.assertEqual(result["resources"],
                         {"cpu": 4.0, "memory_mib": 8192, "workers": 4, "sidecar_threads": 1})
        self.assertEqual(result["adapter_revision"], "unknown")  # env not baked under stub
        self.assertIn("image_pin_revision", result)
        self.assertIn("app_name", result)
        self.assertEqual(set(result["timing"]),
                         {"container_cold", "queue_wait_ms", "service_ready_ms",
                          "parse_ms", "total_method_ms"})
        self.assertEqual(set(result["retry"]), {"attempt", "function_call_id", "input_id"})
        # Method-entry sweep removed the abandoned state, visibly.
        swept = [e for e in events if e["event"] == "swept_abandoned_state"]
        self.assertEqual(len(swept), 1)
        self.assertIn("job_stale", swept[0]["removed"])
        # Every event carries the identity context (§12).
        for event in events:
            self.assertEqual(event["adapter_revision"], "testrev")
            self.assertEqual(event["resources"]["cpu"], 4.0)
        for event in events:
            if event["event"] != "swept_abandoned_state":
                self.assertEqual(event["request_id"], "int-req-1")
                self.assertEqual(event["sha_prefix"], SHA[:12])
        # Cleanup ran in finally with a visible outcome.
        cleanup = [e for e in events if e["event"] == "cleanup"]
        self.assertEqual(len(cleanup), 1)
        self.assertTrue(cleanup[0]["cleanup_ok"])
        self.assertFalse(stale.exists())

    # -- pointer transport ------------------------------------------------

    def test_parse_object_stores_an_identity_bound_envelope(self):
        pointer, _ = self._call_object(_object_payload())

        stored = self.r2.objects[pointer["result_key"]]
        envelope = json.loads(stored)
        self.assertEqual(pointer["result_digest"], hashlib.sha256(stored).hexdigest())
        self.assertEqual(
            {key: envelope[key] for key in
             ("job_id", "attempt_id", "execution_id", "input_sha256")},
            {"job_id": JOB_ID, "attempt_id": ATTEMPT_ID,
             "execution_id": pointer["execution_id"], "input_sha256": SHA},
        )
        self.assertEqual(set(envelope), {
            "schema_version", "job_id", "attempt_id", "execution_id",
            "input_sha256", "page_count", "pages",
        })
        self.assertEqual(envelope["page_count"], 2)
        self.assertEqual(envelope["pages"][0]["page_spatial"]["pageNumber"], 1)
        self.assertEqual(envelope["pages"][1], {
            "page_number": 2, "ok": False,
            "failure": {"code": "page_failed", "message": "Page could not be parsed."},
        })
        self.assertEqual(pointer["result_uri"],
                         f"r2://pagespatial-results-dev/{pointer['result_key']}")

    def test_parse_object_matches_parse_document_on_stable_fields(self):
        direct, _ = self._call(_payload(request_id=ATTEMPT_ID))
        pointer, _ = self._call_object(_object_payload())
        stored = json.loads(self.r2.objects[pointer["result_key"]])
        self.assertEqual(stored["input_sha256"], direct["document_sha256"])
        self.assertEqual(stored["page_count"], direct["page_count"])
        self.assertEqual(
            stored["pages"][0]["page_spatial"], direct["pages"][0]["pageSpatial"])

    def test_parse_object_returns_a_typed_failure_without_a_public_object(self):
        self.fake.script["submit_status"] = 400
        self.fake.script["submit_body"] = {
            "code": "page_limit_exceeded", "error": "Document has 900 pages; max 200"}
        failure, _ = self._call_object(_object_payload())
        self.assertEqual(failure["status"], "failed")
        self.assertEqual(failure["failure_code"], "page_limit_exceeded")
        self.assertEqual(set(self.r2.objects), {INPUT_KEY})

    def test_parse_object_verifies_downloaded_bytes_before_node_work(self):
        failure = self.instance.parse_object(
            _object_payload(expected_sha256="a" * 64))
        self.assertEqual(failure["failure_code"], "input_digest_mismatch")
        self.assertEqual(self.fake.posts, 0)
        self.assertEqual(set(self.r2.objects), {INPUT_KEY})

    def test_parse_object_upload_failure_returns_no_pointer(self):
        self.r2.fail_put = True
        with self.assertRaisesRegex(OSError, "injected R2 PUT failure"):
            self.instance.parse_object(_object_payload())
        self.assertEqual(self.fake.posts, 1)
        self.assertEqual(set(self.r2.objects), {INPUT_KEY})

    def test_parse_object_bypasses_the_modal_result_size_guard(self):
        saved = modal_app.MAX_RESULT_BYTES
        modal_app.MAX_RESULT_BYTES = 64
        try:
            pointer, _ = self._call_object(_object_payload())
        finally:
            modal_app.MAX_RESULT_BYTES = saved
        stored = json.loads(self.r2.objects[pointer["result_key"]])
        self.assertEqual(stored["page_count"], 2)
        self.assertGreater(pointer["result_bytes"], 64)

    def test_parse_object_refuses_an_oversized_object_result_before_upload(self):
        saved = modal_app.MAX_OBJECT_RESULT_BYTES
        modal_app.MAX_OBJECT_RESULT_BYTES = 64
        try:
            with self.assertRaises(modal_app.ObjectResultTooLarge):
                self.instance.parse_object(_object_payload())
        finally:
            modal_app.MAX_OBJECT_RESULT_BYTES = saved
        self.assertEqual(set(self.r2.objects), {INPUT_KEY})

    def test_two_executions_use_two_immutable_result_keys(self):
        one, _ = self._call_object(_object_payload())
        two, _ = self._call_object(_object_payload())
        self.assertNotEqual(one["result_key"], two["result_key"])
        self.assertIn(one["result_key"], self.r2.objects)
        self.assertIn(two["result_key"], self.r2.objects)

    # -- visible refusals and bounded failures --------------------------

    def test_service_refusal_is_a_terminal_failed_result_not_an_exception(self):
        self.fake.script["submit_status"] = 400
        self.fake.script["submit_body"] = {
            "code": "page_limit_exceeded", "error": "Document has 900 pages; max 200"}
        result, events = self._call(_payload())
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["failure"]["class"], "ServiceRefused400")
        self.assertEqual(result["failure"]["code"], "page_limit_exceeded")
        self.assertIn("900 pages", result["failure"]["message"])
        self.assertEqual(result["pages"], [])
        self.assertEqual(self.instance.budget.created, 0)  # no job ID -> no budget burn
        self.assertFalse(self.instance.retired)
        self.assertTrue(any(e["event"] == "cleanup" and e["cleanup_ok"] for e in events))

    def test_result_too_large_is_a_visible_failure_never_truncation(self):
        saved = modal_app.MAX_RESULT_BYTES
        modal_app.MAX_RESULT_BYTES = 64
        try:
            result, _ = self._call(_payload())
        finally:
            modal_app.MAX_RESULT_BYTES = saved
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["failure"]["class"], "ResultTooLarge")
        self.assertEqual(result["pages"], [])
        self.assertEqual(result["page_count"], 2)  # probed count stays visible

    def test_submit_transport_failure_retires_before_raising(self):
        # Point the adapter at a dead port: connection refused on POST.
        sacrifice = socket.socket()
        sacrifice.bind(("127.0.0.1", 0))
        dead_port = sacrifice.getsockname()[1]
        sacrifice.close()
        # Health probe happens BEFORE submit and also hits the dead port —
        # use a health-only alive server? No: the gate would retire first.
        # Instead keep health on the live fake but fail only the POST, by
        # swapping the port between the health check and the submit.
        real_http = self.instance._http

        def flaky(method, path, *args, **kwargs):
            if method == "POST":
                modal_app.SERVICE_PORT = dead_port
            try:
                return real_http(method, path, *args, **kwargs)
            finally:
                modal_app.SERVICE_PORT = self.fake.port

        before = len(STOP_CALLS)
        with mock.patch.object(self.instance, "_http", side_effect=flaky):
            error, events = self._call_expect_raise(_payload(), RuntimeError)
        self.assertIn("loopback submit transport failure", str(error))
        self.assertIn("container retired", str(error))
        self.assertTrue(self.instance.retired)
        # Ordering: stop_fetching_inputs fired BEFORE the exception left
        # the method (it is already recorded by the time we observe it).
        self.assertEqual(len(STOP_CALLS), before + 1)
        self.assertTrue(any(e["event"] == "retiring"
                            and e["reason"] == "submit_transport_failure" for e in events))
        self.assertTrue(any(e["event"] == "cleanup" and e["cleanup_ok"] for e in events))

    def test_poisoned_instance_gate_rejects_after_node_death(self):
        self.node.kill()
        self.node.wait(timeout=10)
        before = len(STOP_CALLS)
        error, _ = self._call_expect_raise(_payload(), RuntimeError)
        self.assertIn("unhealthy", str(error))
        self.assertTrue(self.instance.retired)
        self.assertEqual(len(STOP_CALLS), before + 1)
        self.assertEqual(self.fake.posts, 0)  # no document reached the service
        # A later input on the same (retired) instance is also refused
        # without touching the service, and retire stays idempotent.
        error, _ = self._call_expect_raise(_payload(request_id="int-req-2"), RuntimeError)
        self.assertEqual(self.fake.posts, 0)
        self.assertEqual(len(STOP_CALLS), before + 1)

    def test_stop_fetching_inputs_throwing_does_not_mask_the_failure(self):
        # PR #89 LOW: retire must proceed and the original failure must
        # stay visible even when the experimental API itself throws.
        self.node.kill()
        self.node.wait(timeout=10)
        experimental = sys.modules["modal.experimental"]
        saved = experimental.stop_fetching_inputs

        def boom():
            raise RuntimeError("experimental API exploded")

        experimental.stop_fetching_inputs = boom
        try:
            error, events = self._call_expect_raise(_payload(), RuntimeError)
        finally:
            experimental.stop_fetching_inputs = saved
        self.assertIn("unhealthy", str(error))  # original failure, not the API error
        self.assertTrue(self.instance.retired)
        failures = [e for e in events if e["event"] == "stop_fetching_inputs_failed"]
        self.assertEqual(len(failures), 1)
        self.assertIn("experimental API exploded", failures[0]["error"])

    # -- test-only failure injection (§14.2 arms 8/9) --------------------

    def test_injected_exception_is_visible_and_precedes_node_work(self):
        with mock.patch.dict(os.environ, DEV_ENV):
            error, events = self._call_expect_raise(
                _payload(test_failure="exception"), modal_app.InjectedFailure)
        self.assertIn("injected application exception", str(error))
        self.assertEqual(self.fake.posts, 0)
        self.assertTrue(any(e["event"] == "injected_failure"
                            and e["mode"] == "exception" for e in events))
        self.assertFalse(self.instance.retired)  # a retry may land here per config

    def test_injected_timeout_is_bounded(self):
        saved = modal_app.TIMEOUT_INJECTION_SLEEP_S
        modal_app.TIMEOUT_INJECTION_SLEEP_S = 0.05
        t0 = time.monotonic()
        try:
            with mock.patch.dict(os.environ, DEV_ENV):
                error, events = self._call_expect_raise(
                    _payload(test_failure="timeout"), RuntimeError)
        finally:
            modal_app.TIMEOUT_INJECTION_SLEEP_S = saved
        self.assertIn("timeout injection outlived", str(error))
        self.assertLess(time.monotonic() - t0, 5)  # terminates even without a platform kill
        self.assertEqual(self.fake.posts, 0)
        self.assertTrue(any(e["event"] == "injected_failure"
                            and e["mode"] == "timeout" for e in events))

    def test_injected_node_kill_mid_document_is_classified_and_bounded(self):
        self.fake.script["job_responses"] = [{"status": "running", "pages": []}]
        before = len(STOP_CALLS)
        t0 = time.monotonic()
        with mock.patch.dict(os.environ, DEV_ENV):
            error, events = self._call_expect_raise(
                _payload(test_failure="kill-node"), RuntimeError)
        self.assertIn("node child died mid-parse", str(error))
        self.assertLess(time.monotonic() - t0, 30)  # bounded: no hang to method timeout
        self.assertEqual(self.fake.posts, 1)        # the document DID reach the service
        self.assertTrue(self.instance.retired)
        self.assertEqual(len(STOP_CALLS), before + 1)
        self.assertTrue(any(e["event"] == "injected_failure"
                            and e["mode"] == "kill-node" for e in events))
        self.assertTrue(any(e["event"] == "retiring"
                            and e["reason"] == "node_child_died" for e in events))

    def test_injection_is_unreachable_without_the_dev_gates(self):
        # Production configuration: env flag never set -> visible rejection
        # BEFORE any Node work, regardless of payload.
        env = {"PAGESPATIAL_APP_NAME": "pagespatial-parse-m1-dev"}
        with mock.patch.dict(os.environ, env, clear=True):
            self._call_expect_raise(
                _payload(test_failure="exception"), modal_app.InputRejected)
        # Flag set but app name is not a dev/test app -> also rejected.
        env = {"PAGESPATIAL_ENABLE_TEST_FAILURES": "1",
               "PAGESPATIAL_APP_NAME": "pagespatial-parse"}
        with mock.patch.dict(os.environ, env, clear=True):
            self._call_expect_raise(
                _payload(test_failure="exception"), modal_app.InputRejected)
        self.assertEqual(self.fake.posts, 0)


class LifecycleProbeTest(unittest.TestCase):
    """Dev-only §14.4 criteria 8/9 instruments, run against a dummy child."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data_dir = os.path.join(self.tmp.name, "scratch")
        os.makedirs(os.path.join(self.data_dir, "uploads"))
        self.node = _dummy_node()
        inst = modal_app.ParseContainer.__new__(modal_app.ParseContainer)
        inst.cold = False
        inst.budget = modal_app.JobBudget()
        inst.retired = False
        inst.data_dir = self.data_dir
        inst.service_ready_ms = 1
        inst.node = self.node
        inst.node_log = open(os.path.join(self.tmp.name, "node.log"), "ab")
        inst.log_context = {}
        inst.method_context = {}
        self.instance = inst

    def tearDown(self):
        if self.node.poll() is None:
            self.node.kill()
            self.node.wait(timeout=10)
        if not self.instance.node_log.closed:
            self.instance.node_log.close()
        self.tmp.cleanup()

    def _run(self, method):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            report = method()
        return report

    def test_probes_are_refused_without_the_dev_gates(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(modal_app.InputRejected):
                self.instance.probe_scratch()
            with self.assertRaises(modal_app.InputRejected):
                self.instance.probe_exit_drain()
        self.assertIsNone(self.node.poll())  # gate refused before any kill

    def test_probe_scratch_flags_leftover_job_state_and_uploads(self):
        Path(self.data_dir, "job_zombie").mkdir()
        Path(self.data_dir, "uploads", "upload_zombie.pdf").write_bytes(b"x")
        Path(self.data_dir, "node.log").write_text("log")
        with mock.patch.dict(os.environ, DEV_ENV):
            report = self._run(self.instance.probe_scratch)
        self.assertFalse(report["clean"])
        self.assertEqual(sorted(report["leftovers"]),
                         ["job_zombie", "uploads/upload_zombie.pdf"])
        # After a sweep the same probe reports clean.
        modal_app.sweep_scratch(self.data_dir)
        with mock.patch.dict(os.environ, DEV_ENV):
            report = self._run(self.instance.probe_scratch)
        self.assertTrue(report["clean"])
        self.assertEqual(report["leftovers"], [])

    def test_probe_exit_drain_terminates_the_child_and_removes_scratch(self):
        before = len(STOP_CALLS)
        with mock.patch.dict(os.environ, DEV_ENV):
            report = self._run(self.instance.probe_exit_drain)
        self.assertIsNotNone(self.node.poll())          # child actually exited
        self.assertIsNotNone(report["node_exit_code"])
        self.assertTrue(report["scratch_removed"])
        self.assertFalse(Path(self.data_dir).exists())
        self.assertTrue(self.instance.retired)          # never accepts another input
        self.assertEqual(len(STOP_CALLS), before + 1)
        # On this host /proc may not exist; the survivor check must still
        # be a real list (empty on non-Linux, populated on the container).
        self.assertIsInstance(report["survivors"], list)
        self.assertIn("clean", report)


if __name__ == "__main__":
    unittest.main()

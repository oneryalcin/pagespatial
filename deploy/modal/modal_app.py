"""Modal adapter for the PageSpatial parse service — M1 skeleton.

Source of truth: docs/design/2026-08-23-modal-scaling-and-deployment.md.
One Modal asynchronous input owns one document (§2). A warm `modal.Cls`
container starts the existing Node service once (@enter), methods drive it
over loopback HTTP, and @exit drains it. No public URL, no web endpoint,
enrichment forced off, private ephemeral scratch only.

Deploy (repo root, Modal SDK pinned in deploy/modal/README.md):

    modal deploy deploy/modal/modal_app.py

Acceptance (M1 §16): two sequential calls with a generated non-corpus PDF —
the second must reuse the warm container (container_cold=False,
service_ready_ms=0):

    modal run deploy/modal/modal_app.py::acceptance

This module is re-imported INSIDE the container (parentless, no .git); all
repo-path and git lookups are guarded by modal.is_local().
"""

import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

import modal

# ---------------------------------------------------------------------------
# Bounds (§1, §7). Qualification limits, not product promises.
# ---------------------------------------------------------------------------
MAX_INPUT_BYTES = 90 * 1024 * 1024        # below Modal's 100 MB gRPC cap (§7.1)
MAX_PAGES_PER_JOB = 200                    # enforced service-side (SERVICE_MAX_PAGES_PER_JOB)
MAX_RESULT_BYTES = 64 * 1024 * 1024        # serialized output cap — visible ResultTooLarge, never truncation
MAX_NODE_JOBS_PER_LIFETIME = 100           # created loopback job IDs per warm Node lifetime (§7.3)
SCHEMA_VERSION = "0.6.0"
SERVICE_PORT = 8571                        # private: Node binds 127.0.0.1 only
STARTUP_TIMEOUT_S = 1200                   # explicit (§7.3): > measured cold readiness (~70-88 s engine
                                           # init x 4 workers, sequential warm-up) with generous margin
METHOD_TIMEOUT_S = 1800                    # explicit (§7.3): 200-page max document at the measured
                                           # 0.723 pages/s worst case ≈ 277 s; margin for retries/tenancy
PARSE_DEADLINE_S = 1500                    # loopback poll deadline, inside METHOD_TIMEOUT_S
EXIT_SIGTERM_GRACE_S = 22                  # SIGTERM drain wait; + force-kill fits Modal's 30 s @exit window
MIN_FREE_DISK_BYTES = 2 * 1024 * 1024 * 1024  # method-level free-space check (§7.4)

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")

app = modal.App("pagespatial-parse-m1-dev")

REPO_ROOT = Path(__file__).resolve().parents[2] if modal.is_local() else Path("/app")


def _git_revision() -> str:
    """Deploy-time code revision, baked into the image env (§12: results
    include an immutable revision). Client-side only."""
    try:
        out = subprocess.run(
            ["git", "-C", str(REPO_ROOT), "rev-parse", "--short=12", "HEAD"],
            capture_output=True, text=True, timeout=10,
        )
        rev = out.stdout.strip()
        dirty = subprocess.run(
            ["git", "-C", str(REPO_ROOT), "status", "--porcelain"],
            capture_output=True, text=True, timeout=10,
        ).stdout.strip()
        return f"{rev}{'-dirty' if dirty else ''}" if rev else "unknown"
    except Exception:
        return "unknown"


image = modal.Image.from_dockerfile(
    REPO_ROOT / "Dockerfile",
    context_dir=REPO_ROOT,
    add_python="3.11",
)
if modal.is_local():
    image = image.env({"PAGESPATIAL_GIT_REV": _git_revision()})


# ---------------------------------------------------------------------------
# Pure helpers — unit-testable without the Modal runtime.
# ---------------------------------------------------------------------------

class InputRejected(ValueError):
    """Invalid caller input (§7.1) — rejected before any Node work."""


def validate_input(payload) -> bytes:
    """§7.1 validation. Returns the PDF bytes; raises InputRejected
    otherwise. Runs BEFORE any Node work; never logs content."""
    if not isinstance(payload, dict):
        raise InputRejected("input must be a dict")
    if "pdfPath" in payload or "pdf_path" in payload:
        raise InputRejected("server-side pdfPath is never accepted")
    request_id = payload.get("request_id")
    if not isinstance(request_id, str) or not request_id.strip() or len(request_id) > 256:
        raise InputRejected("request_id must be a non-empty string (max 256 chars)")
    if payload.get("schema_version") != SCHEMA_VERSION:
        raise InputRejected(f"unsupported schema_version (expected {SCHEMA_VERSION!r})")
    if payload.get("enrichment") != "off":
        raise InputRejected('enrichment must be "off" for the Modal prototype')
    pdf_bytes = payload.get("pdf_bytes")
    if not isinstance(pdf_bytes, (bytes, bytearray)) or len(pdf_bytes) == 0:
        raise InputRejected("pdf_bytes must be non-empty bytes")
    if len(pdf_bytes) > MAX_INPUT_BYTES:
        raise InputRejected(f"pdf_bytes exceeds {MAX_INPUT_BYTES} bytes")
    expected = payload.get("expected_sha256")
    if not isinstance(expected, str) or not _SHA256_RE.fullmatch(expected):
        raise InputRejected("expected_sha256 must be 64 lowercase hex chars")
    actual = hashlib.sha256(bytes(pdf_bytes)).hexdigest()
    if actual != expected:
        raise InputRejected("sha256 mismatch between expected_sha256 and pdf_bytes")
    return bytes(pdf_bytes)


def stop_fetching_inputs() -> None:
    """The ONLY call site of Modal's experimental input-fetch stop (§7.3).
    Verified present in the pinned SDK; replace here when Modal ships a
    stable equivalent."""
    modal.experimental.stop_fetching_inputs()


class JobBudget:
    """Counts CREATED Node job IDs per warm lifetime (§7.3). Incremented
    when the loopback POST returns a job ID, not when the method ends —
    failed methods that created a job still consume budget."""

    def __init__(self, limit: int = MAX_NODE_JOBS_PER_LIFETIME):
        self.limit = limit
        self.created = 0

    def record_created(self) -> bool:
        """Record one created Node job; True when the budget is exhausted
        and the container must stop fetching inputs."""
        self.created += 1
        return self.created >= self.limit


def sweep_scratch(data_dir: str, keep_job_id: str | None = None) -> list:
    """§7.4 method-entry sweep + per-method cleanup: remove job directories
    (except `keep_job_id`) and uploaded PDFs. Input concurrency is 1, so
    everything else in scratch is abandoned state from a prior exception
    or timeout. Returns removed names (ids only — never content)."""
    removed = []
    base = Path(data_dir)
    if not base.is_dir():
        return removed
    for entry in base.iterdir():
        if entry.name == "uploads":
            for upload in entry.glob("upload_*.pdf"):
                upload.unlink(missing_ok=True)
                removed.append(f"uploads/{upload.name}")
            continue
        if entry.is_dir() and entry.name != keep_job_id:
            shutil.rmtree(entry, ignore_errors=True)
            removed.append(entry.name)
    return removed


def _minimal_pdf(page_count: int) -> bytes:
    """Tiny generated PDF (same construction as the service tests) — the
    M1 acceptance document. Deliberately NON-corpus: Modal retains Function
    inputs/outputs up to 7 days (§7.1)."""
    objects = ["<< /Type /Catalog /Pages 2 0 R >>"]
    kids = " ".join(f"{i + 3} 0 R" for i in range(page_count))
    objects.append(f"<< /Type /Pages /Kids [{kids}] /Count {page_count} >>")
    for _ in range(page_count):
        objects.append("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>")
    body = "%PDF-1.4\n"
    offsets = []
    for index, content in enumerate(objects):
        offsets.append(len(body))
        body += f"{index + 1} 0 obj {content} endobj\n"
    xref = len(body)
    body += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n"
    for offset in offsets:
        body += f"{offset:010d} 00000 n \n"
    body += f"trailer << /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n"
    return body.encode()


# ---------------------------------------------------------------------------
# Warm parse container (§7.2, §7.3).
# ---------------------------------------------------------------------------

@app.cls(
    image=image,
    cpu=4.0,                    # physical cores — matches the measured trial topology
    memory=24576,               # MiB
    timeout=METHOD_TIMEOUT_S,
    startup_timeout=STARTUP_TIMEOUT_S,
    retries=1,                  # §7.3 table: 1 application retry for the failure trial
    min_containers=0,
    buffer_containers=0,
    max_containers=1,           # M1 skeleton; M3 trial arms use 1/4/16 — never unbounded
    # Input concurrency is 1 by default for a Modal Cls (no @modal.concurrent).
)
class ParseContainer:
    @modal.enter()
    def start_service(self):
        self.cold = True
        self.budget = JobBudget()
        self.retired = False
        # Private ephemeral scratch (§7.4): no Volume, no shared state.
        self.data_dir = tempfile.mkdtemp(prefix="psvc-", dir="/tmp")
        # Node's stdout/stderr go to a FILE, not a PIPE: an undrained pipe
        # buffer would deadlock the child; the service does not log content.
        self.node_log_path = os.path.join(self.data_dir, "node.log")
        self.node_log = open(self.node_log_path, "ab")
        env = {**os.environ}
        # Parse-only, loopback-only, bounded (§7.2, §11). Modal ignores the
        # Dockerfile CMD/USER, so Node is started explicitly here.
        env.pop("GEMINI_API_KEY", None)          # no enrichment credentials in the parse app
        env.pop("SERVICE_ALLOW_PDF_PATH", None)  # pdfPath mode stays disabled
        env.update({
            "HOST": "127.0.0.1",
            "PORT": str(SERVICE_PORT),
            "SERVICE_DATA_DIR": self.data_dir,
            "SERVICE_WORKERS": "4",              # measured topology: 4 workers x 1 thread
            "SERVICE_SIDECAR_THREADS": "1",
            "SERVICE_MAX_PAGES_PER_JOB": str(MAX_PAGES_PER_JOB),
        })
        t0 = time.monotonic()
        self.node = subprocess.Popen(
            ["node", "service/server.mjs"],
            cwd="/app",
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=self.node_log,
            stderr=self.node_log,
        )
        self._wait_health(deadline_s=STARTUP_TIMEOUT_S - 60)
        self.service_ready_ms = int((time.monotonic() - t0) * 1000)
        self._log_event("service_started", node_pid=self.node.pid,
                        service_ready_ms=self.service_ready_ms)

    def _wait_health(self, deadline_s: float):
        start = time.monotonic()
        while time.monotonic() - start < deadline_s:
            if self.node.poll() is not None:
                raise RuntimeError(
                    f"node exited during startup (code {self.node.returncode}); "
                    f"see container log {self.node_log_path}")
            try:
                with urllib.request.urlopen(
                        f"http://127.0.0.1:{SERVICE_PORT}/health", timeout=10) as response:
                    if response.status == 200:
                        return
            except urllib.error.HTTPError:
                pass  # 503 while warming up
            except Exception:
                pass  # not listening yet
            time.sleep(2)
        raise RuntimeError(f"/health not ready within {deadline_s}s")

    def _health_ok(self) -> bool:
        if self.node.poll() is not None:
            return False
        try:
            with urllib.request.urlopen(
                    f"http://127.0.0.1:{SERVICE_PORT}/health", timeout=10) as response:
                return response.status == 200
        except Exception:
            return False

    def _retire(self, reason: str):
        """Poisoned or exhausted warm instance (§7.3, §8): stop fetching
        inputs BEFORE anything else; no in-place repair, no Node restart."""
        if self.retired:
            return
        self.retired = True
        self._log_event("retiring", reason=reason, jobs_created=self.budget.created)
        try:
            stop_fetching_inputs()
        except Exception as error:  # never mask the original failure path
            self._log_event("stop_fetching_inputs_failed", error=str(error))

    def _http(self, method: str, path: str, body: bytes = None, content_type: str = None,
              timeout: int = 120):
        request = urllib.request.Request(
            f"http://127.0.0.1:{SERVICE_PORT}{path}", data=body, method=method)
        if content_type:
            request.add_header("content-type", content_type)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read())

    @staticmethod
    def _log_event(event: str, **fields):
        # Structured, content-free (§11, §12): ids, durations, counts only.
        print(json.dumps({"event": event, **fields}, sort_keys=True), flush=True)

    @modal.method()
    def parse_document(self, payload: dict) -> dict:
        method_t0 = time.monotonic()
        # Cold/warm attribution is a property of the CONTAINER, not of the
        # input: capture and clear it before validation, or a rejected
        # first call would make the next successful call misreport
        # container_cold=true (cold review PR #89, finding 2 — §8).
        container_cold = self.cold
        service_ready_ms = self.service_ready_ms if self.cold else 0
        self.cold = False
        pdf_bytes = validate_input(payload)  # raises InputRejected before Node work
        request_id = payload["request_id"]
        sha256 = payload["expected_sha256"]

        # §7.4: sweep abandoned state from a prior exception/timeout, and
        # refuse to start on a nearly-full disk.
        swept = sweep_scratch(self.data_dir)
        if swept:
            self._log_event("swept_abandoned_state", request_id=request_id, removed=swept)
        free = shutil.disk_usage(self.data_dir).free
        if free < max(MIN_FREE_DISK_BYTES, 4 * len(pdf_bytes)):
            self._retire("low_disk")
            raise RuntimeError(f"insufficient free disk in scratch ({free} bytes)")

        # Poisoned-instance gate (§8): dead child / degraded pool retires
        # this container before it can fail another document.
        if self.retired or not self._health_ok():
            self._retire("unhealthy_before_method")
            raise RuntimeError("warm instance unhealthy (node dead or /health degraded); retired")

        job_id = None
        try:
            parse_t0 = time.monotonic()
            # Submit transport failure retires the container (cold review
            # PR #89, finding 1): the service may have ACCEPTED the job
            # while the response was lost — a later method's entry sweep
            # would then delete a still-processing job's directory out from
            # under active workers. Retiring hands the retry a fresh
            # container instead. Timeout is generous because 202 arrives
            # only after upload + hash + probe of a potentially-90 MiB PDF
            # (design §3.1).
            try:
                status, body = self._http(
                    "POST", "/v1/jobs?enrichment=off", pdf_bytes,
                    "application/pdf", timeout=600)
            except Exception as error:
                self._retire("submit_transport_failure")
                raise RuntimeError(
                    f"loopback submit transport failure ({type(error).__name__}); "
                    "container retired — job state on this instance is unknowable"
                ) from error
            if status == 202:
                job_id = body["jobId"]
                if self.budget.record_created():
                    self._retire("job_budget_exhausted")
            self._log_event("job_submitted", request_id=request_id,
                            sha_prefix=sha256[:12], http_status=status,
                            job_id=job_id, jobs_created=self.budget.created)
            if status != 202:
                # Visible client-side refusal (e.g. page cap) — a terminal
                # failed result, not an exception: the input was validly
                # formed but the document is out of bounds.
                return self._result(request_id, sha256, container_cold,
                                    service_ready_ms, method_t0,
                                    page_count=0, pages=[],
                                    failure={"class": f"ServiceRefused{status}",
                                             "message": str(body.get("error", ""))[:500]},
                                    parse_ms=0)
            if body["sha256"] != sha256:
                raise RuntimeError("service-computed sha256 disagrees with the validated input")
            page_count = body["pageCount"]

            deadline = time.monotonic() + PARSE_DEADLINE_S
            while True:
                if self.node.poll() is not None:
                    self._retire("node_child_died")
                    raise RuntimeError("node child died mid-parse; instance retired")
                status, job = self._http("GET", f"/v1/jobs/{job_id}")
                if status == 200 and job["status"] == "completed":
                    break
                if time.monotonic() > deadline:
                    self._retire("parse_deadline_exceeded")
                    raise RuntimeError(
                        f"job {job_id} not terminal within {PARSE_DEADLINE_S}s; instance retired")
                time.sleep(2)
            parse_ms = int((time.monotonic() - parse_t0) * 1000)

            result = self._result(request_id, sha256, container_cold,
                                  service_ready_ms, method_t0,
                                  page_count=page_count, pages=job["pages"],
                                  failure=None, parse_ms=parse_ms)
            serialized = len(json.dumps(result).encode())
            if serialized > MAX_RESULT_BYTES:
                # Visible bound (§7.1): never truncate pages.
                return self._result(request_id, sha256, container_cold,
                                    service_ready_ms, method_t0,
                                    page_count=page_count, pages=[],
                                    failure={"class": "ResultTooLarge",
                                             "message": f"serialized result {serialized} bytes exceeds {MAX_RESULT_BYTES}"},
                                    parse_ms=parse_ms)
            self._log_event("job_terminal", request_id=request_id, job_id=job_id,
                            page_count=page_count, parse_ms=parse_ms,
                            result_bytes=serialized, container_cold=container_cold)
            return result
        finally:
            # §7.4: job dir + uploaded PDF removed after every terminal
            # method; a crash skips this, and the next method's sweep (or
            # container disposal) covers it.
            cleaned = sweep_scratch(self.data_dir)
            self._log_event("cleanup", request_id=request_id, removed=cleaned)

    @staticmethod
    def _result(request_id, sha256, container_cold, service_ready_ms, method_t0,
                *, page_count, pages, failure, parse_ms):
        return {
            "request_id": request_id,
            "document_sha256": sha256,
            "page_count": page_count,
            "status": "failed" if failure else "completed",
            "pages": pages,
            "failure": failure,
            "timing": {
                "container_cold": container_cold,
                "queue_wait_ms": None,  # not exposed by the platform per-input
                "service_ready_ms": service_ready_ms,
                "parse_ms": parse_ms,
                "total_method_ms": int((time.monotonic() - method_t0) * 1000),
            },
            "adapter_revision": os.environ.get("PAGESPATIAL_GIT_REV", "unknown"),
        }

    @modal.exit()
    def stop_service(self):
        # SIGTERM -> bounded wait -> SIGKILL fallback; total fits Modal's
        # 30 s exit window with margin (§7.2). The server's own graceful
        # path drains workers (which group-kill their Python sidecars).
        if getattr(self, "node", None) is None:
            return
        t0 = time.monotonic()
        if self.node.poll() is None:
            self.node.terminate()
            try:
                self.node.wait(timeout=EXIT_SIGTERM_GRACE_S)
            except subprocess.TimeoutExpired:
                self.node.kill()
                try:
                    self.node.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    pass
        self._log_event("service_stopped", exit_code=self.node.returncode,
                        drain_ms=int((time.monotonic() - t0) * 1000))
        self.node_log.close()
        shutil.rmtree(self.data_dir, ignore_errors=True)


# ---------------------------------------------------------------------------
# M1 acceptance entrypoint (§16): one real deployed asynchronous call, then
# a second call proving warm reuse. Uses a GENERATED non-corpus PDF only.
# ---------------------------------------------------------------------------

@app.local_entrypoint()
def acceptance(pages: int = 3):
    import uuid

    pdf = _minimal_pdf(pages)
    sha = hashlib.sha256(pdf).hexdigest()
    # Target the DEPLOYED app (modal deploy deploy/modal/modal_app.py), not
    # this run's ephemeral copy: M1 acceptance requires a real deployed call.
    deployed = modal.Cls.from_name("pagespatial-parse-m1-dev", "ParseContainer")
    parser = deployed()
    results = []
    for call in (1, 2):
        payload = {
            "request_id": f"m1-acceptance-{call}-{uuid.uuid4()}",
            "pdf_bytes": pdf,
            "source_uri": "m1-acceptance-generated",
            "expected_sha256": sha,
            "schema_version": SCHEMA_VERSION,
            "enrichment": "off",
        }
        t0 = time.monotonic()
        handle = parser.parse_document.spawn(payload)   # asynchronous call (§7.1)
        result = handle.get()
        wall_s = round(time.monotonic() - t0, 1)
        summary = {
            "call": call,
            "request_id": result["request_id"],
            "status": result["status"],
            "page_count": result["page_count"],
            "pages_returned": len(result["pages"]),
            "pages_ok": sum(1 for p in result["pages"] if p.get("ok")),
            "timing": result["timing"],
            "adapter_revision": result["adapter_revision"],
            "spawn_to_result_s": wall_s,
        }
        results.append(summary)
        print(json.dumps(summary, indent=1))
    warm = results[1]["timing"]
    assert warm["container_cold"] is False, "second call hit a cold container"
    assert warm["service_ready_ms"] == 0, "second call re-paid Node startup"
    print("ACCEPTANCE PASS: warm reuse proven "
          f"(call 2 container_cold={warm['container_cold']}, "
          f"service_ready_ms={warm['service_ready_ms']})")

"""Modal adapter for the PageSpatial parse service — M1 skeleton + M2
failure and measurement instruments.

Source of truth: docs/design/2026-08-23-modal-scaling-and-deployment.md.
One Modal asynchronous input owns one document (§2). A warm `modal.Cls`
container starts the existing Node service once (@enter), methods drive it
over loopback HTTP, and @exit drains it. No public URL, no web endpoint,
enrichment forced off, private ephemeral scratch only.

M2 adds (§16 M2): the full §12 identity/timing field set on results and
structured log events; test-only failure injection (§14.2 arm 8/9) that is
double-gated so the production deployment configuration cannot reach it;
and dev-only cleanup / child-exit probes (§14.4 criteria 8/9 instruments).
Container-kill injection is deliberately NOT here: §14.2 requires it to be
external and one-shot (`modal container stop`), because a self-kill input
would be rescheduled and could crash-loop.

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
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, TypedDict

import modal

# ---------------------------------------------------------------------------
# Bounds (§1, §7). Qualification limits, not product promises.
# ---------------------------------------------------------------------------
MAX_INPUT_BYTES = 90 * 1024 * 1024        # below Modal's 100 MB gRPC cap (§7.1)
MAX_PAGES_PER_JOB = 200                    # enforced service-side (SERVICE_MAX_PAGES_PER_JOB)
MAX_RESULT_BYTES = 64 * 1024 * 1024        # serialized output cap — visible ResultTooLarge, never truncation
MAX_OBJECT_RESULT_BYTES = 128 * 1024 * 1024 # explicit R2 publication cap, separate from Modal gRPC
MAX_NODE_JOBS_PER_LIFETIME = 100           # created loopback job IDs per warm Node lifetime (§7.3)
SCHEMA_VERSION = "0.6.0"
OBJECT_RESULT_SCHEMA_VERSION = 1
SERVICE_PORT = 8571                        # private: Node binds 127.0.0.1 only
STARTUP_TIMEOUT_S = 1200                   # explicit (§7.3): > measured cold readiness (~70-88 s engine
                                           # init x 4 workers, sequential warm-up) with generous margin
METHOD_TIMEOUT_S = 1800                    # explicit (§7.3): 200-page max document at the measured
                                           # 0.723 pages/s worst case ≈ 277 s; margin for retries/tenancy
PARSE_DEADLINE_S = 1500                    # loopback poll deadline, inside METHOD_TIMEOUT_S
EXIT_SIGTERM_GRACE_S = 22                  # SIGTERM drain wait; + force-kill fits Modal's 30 s @exit window
MIN_FREE_DISK_BYTES = 2 * 1024 * 1024 * 1024  # method-level free-space check (§7.4)
TIMEOUT_INJECTION_SLEEP_S = METHOD_TIMEOUT_S + 120  # bounded even if the platform misses the kill

# Resource configuration (§12: every result/log event carries it).
CPU_CORES = 4.0                            # physical cores — measured trial topology
DEFAULT_MEMORY_MIB = 8192
MEMORY_LOW_HEADROOM_BYTES = 512 * 1024 * 1024
MEMORY_PRESSURE_RATIO = 0.90
SERVICE_WORKERS = 4
SERVICE_SIDECAR_THREADS = 1
RESOURCES = {
    "cpu": CPU_CORES,
    "memory_mib": DEFAULT_MEMORY_MIB,
    "workers": SERVICE_WORKERS,
    "sidecar_threads": SERVICE_SIDECAR_THREADS,
}

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")

DEFAULT_APP_NAME = "pagespatial-parse-m1-dev"
DEFAULT_R2_INPUT_SECRET_NAME = "pagespatial-r2-input-dev"
DEFAULT_R2_RESULTS_SECRET_NAME = "pagespatial-r2-results-dev"


_DEV_APP_RE = re.compile(r"pagespatial-parse(-m\d+|-arm\d+)?-(dev|test)")


def _is_dev_app(name) -> bool:
    """Test-only instruments are refused unless the app name is one of the
    KNOWN dev/test app shapes (§14.2 hard rule). Anchored full-match — a
    bare '-dev' suffix on an arbitrary name (e.g. '…-prod-dev') does not
    qualify."""
    return isinstance(name, str) and _DEV_APP_RE.fullmatch(name) is not None


if modal.is_local():
    # Deploy-time app identity. §10: each trial arm gets a unique app tag
    # (e.g. PAGESPATIAL_MODAL_APP_NAME=pagespatial-parse-arm4-dev).
    APP_NAME = os.environ.get("PAGESPATIAL_MODAL_APP_NAME", DEFAULT_APP_NAME)
else:
    # Inside the container the module re-imports; identity was baked into
    # the image env at deploy time.
    APP_NAME = os.environ.get("PAGESPATIAL_APP_NAME", DEFAULT_APP_NAME)

app = modal.App(APP_NAME)

# §7.3/§10: max_containers is 1, 4, or 16 in separate M3 trial arms — never
# unbounded. The bound is baked at deploy time from an ALLOWLISTED value;
# any other value refuses to deploy. In-container re-imports ignore the
# decorator arguments, so the container branch pins the default.
ALLOWED_MAX_CONTAINERS = (1, 4, 16)
ALLOWED_MEMORY_MIB = (8192, 12288, 16384, 24576)


def _snapshot_enabled(value: str) -> bool:
    """Parse the deploy-time snapshot switch without a truthy-string trap."""
    if value not in {"0", "1"}:
        raise RuntimeError(
            "PAGESPATIAL_ENABLE_MEMORY_SNAPSHOT must be '0' or '1'; "
            f"refusing {value!r}")
    return value == "1"


if modal.is_local():
    _raw_max_containers = os.environ.get("PAGESPATIAL_MAX_CONTAINERS", "1")
    if _raw_max_containers not in {str(n) for n in ALLOWED_MAX_CONTAINERS}:
        raise RuntimeError(
            "PAGESPATIAL_MAX_CONTAINERS must be one of "
            f"{ALLOWED_MAX_CONTAINERS}; refusing {_raw_max_containers!r}")
    MAX_CONTAINERS = int(_raw_max_containers)
    _raw_memory_mib = os.environ.get(
        "PAGESPATIAL_MEMORY_MIB", str(DEFAULT_MEMORY_MIB))
    if _raw_memory_mib not in {str(n) for n in ALLOWED_MEMORY_MIB}:
        raise RuntimeError(
            "PAGESPATIAL_MEMORY_MIB must be one of "
            f"{ALLOWED_MEMORY_MIB}; refusing {_raw_memory_mib!r}")
    MEMORY_MIB = int(_raw_memory_mib)
    ENABLE_MEMORY_SNAPSHOT = _snapshot_enabled(os.environ.get(
        "PAGESPATIAL_ENABLE_MEMORY_SNAPSHOT", "1"))
else:
    MAX_CONTAINERS = 1
    MEMORY_MIB = int(os.environ.get(
        "PAGESPATIAL_CONFIGURED_MEMORY_MIB", str(DEFAULT_MEMORY_MIB)))
    ENABLE_MEMORY_SNAPSHOT = _snapshot_enabled(os.environ.get(
        "PAGESPATIAL_MEMORY_SNAPSHOT_ENABLED", "1"))

RESOURCES["memory_mib"] = MEMORY_MIB

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


def _image_pin_revision() -> str:
    """Immutable image/model-pin revision (§12): a digest over the files
    that pin the runtime image, engine versions, AND the OCR model pins
    (service/sidecar/model-pins.json + its fetcher) — a model-pin-only
    commit must change this revision. Client-side only; baked into the
    image env at deploy time."""
    try:
        digest = hashlib.sha256()
        for name in ("Dockerfile", "package-lock.json",
                      "service/sidecar/model-pins.json",
                      "service/sidecar/fetch_models.py"):
            digest.update(name.encode())
            digest.update((REPO_ROOT / name).read_bytes())
        return digest.hexdigest()[:12]
    except Exception:
        return "unknown"


image = modal.Image.from_dockerfile(
    REPO_ROOT / "Dockerfile",
    context_dir=REPO_ROOT,
    add_python="3.11",
).uv_pip_install("boto3==1.43.74")
if modal.is_local():
    # Test-only failure injection (§14.2) is enabled ONLY here, at deploy
    # time, by an operator explicitly setting the env var — the production
    # deployment configuration never sets it, and enabling it on a non-dev
    # app name refuses to deploy. The container double-checks both gates.
    _enable_test_failures = os.environ.get("PAGESPATIAL_ENABLE_TEST_FAILURES") == "1"
    if _enable_test_failures and not _is_dev_app(APP_NAME):
        raise RuntimeError(
            "PAGESPATIAL_ENABLE_TEST_FAILURES=1 is only deployable to a "
            f"'-dev'/'-test' app name; refusing for {APP_NAME!r}")
    _baked_env = {
        "PAGESPATIAL_GIT_REV": _git_revision(),
        "PAGESPATIAL_IMAGE_PIN_REV": _image_pin_revision(),
        "PAGESPATIAL_APP_NAME": APP_NAME,
        "PAGESPATIAL_CONFIGURED_MEMORY_MIB": str(MEMORY_MIB),
        "PAGESPATIAL_MEMORY_SNAPSHOT_ENABLED": (
            "1" if ENABLE_MEMORY_SNAPSHOT else "0"),
    }
    if _enable_test_failures:
        _baked_env["PAGESPATIAL_ENABLE_TEST_FAILURES"] = "1"
    image = image.env(_baked_env)


# ---------------------------------------------------------------------------
# Pure helpers — unit-testable without the Modal runtime.
# ---------------------------------------------------------------------------

_CGROUP_MEMORY_CURRENT_PATHS = (
    Path("/sys/fs/cgroup/memory.current"),
    Path("/sys/fs/cgroup/memory/memory.usage_in_bytes"),
)
_CGROUP_MEMORY_EVENTS_PATHS = (
    Path("/sys/fs/cgroup/memory.events"),
    Path("/sys/fs/cgroup/memory/memory.failcnt"),
)


class MemoryUsageReport(TypedDict):
    current_bytes: int | None
    sampled_peak_bytes: int | None
    container_sampled_peak_bytes: int | None
    configured_limit_bytes: int
    headroom_bytes: int | None
    utilization_ratio: float | None
    oom_events_delta: int
    oom_kill_events_delta: int
    pressure: bool
    sample_interval_ms: int
    peak_is_lower_bound: Literal[True]


def _read_first_int(paths: tuple[Path, ...]) -> int | None:
    for path in paths:
        try:
            return int(path.read_text().strip())
        except (OSError, ValueError):
            continue
    return None


def _read_memory_events() -> dict[str, int]:
    for path in _CGROUP_MEMORY_EVENTS_PATHS:
        try:
            text = path.read_text().strip()
        except OSError:
            continue
        if path.name == "memory.failcnt":
            try:
                return {"oom": int(text), "oom_kill": 0}
            except ValueError:
                continue
        events = {}
        for line in text.splitlines():
            try:
                key, value = line.split(maxsplit=1)
                if key in {"oom", "oom_kill"}:
                    events[key] = int(value)
            except ValueError:
                continue
        return events
    return {}


def memory_usage_report(*, current_bytes: int | None,
                        sampled_peak_bytes: int | None,
                        container_sampled_peak_bytes: int | None = None,
                        configured_limit_bytes: int,
                        events_start: dict[str, int],
                        events_now: dict[str, int]) -> MemoryUsageReport:
    """Build one content-free memory-pressure report.

    Modal's gVisor environment does not expose a reliable kernel high-water
    mark, so sampled_peak_bytes is explicitly a lower bound. OOM counters are
    retained separately because an allocation failure matters even when the
    sampled peak misses a short spike.
    """
    peak = sampled_peak_bytes if isinstance(sampled_peak_bytes, int) else None
    headroom = (
        max(0, configured_limit_bytes - peak) if peak is not None else None)
    utilization = (
        round(peak / configured_limit_bytes, 4)
        if peak is not None and configured_limit_bytes > 0 else None)
    oom_delta = max(0, events_now.get("oom", 0) - events_start.get("oom", 0))
    oom_kill_delta = max(
        0, events_now.get("oom_kill", 0) - events_start.get("oom_kill", 0))
    pressure = (
        oom_delta > 0
        or oom_kill_delta > 0
        or (headroom is not None and headroom < MEMORY_LOW_HEADROOM_BYTES)
        or (utilization is not None and utilization >= MEMORY_PRESSURE_RATIO)
    )
    return {
        "current_bytes": current_bytes,
        "sampled_peak_bytes": peak,
        "container_sampled_peak_bytes": container_sampled_peak_bytes,
        "configured_limit_bytes": configured_limit_bytes,
        "headroom_bytes": headroom,
        "utilization_ratio": utilization,
        "oom_events_delta": oom_delta,
        "oom_kill_events_delta": oom_kill_delta,
        "pressure": pressure,
        "sample_interval_ms": 2000,
        "peak_is_lower_bound": True,
    }

class InputRejected(ValueError):
    """Invalid caller input (§7.1) — rejected before any Node work."""


class InputDigestMismatch(InputRejected):
    """Downloaded input bytes do not match the control-plane digest."""


class ObjectResultTooLarge(RuntimeError):
    """Canonical R2 result exceeds the object-publication bound."""


class ParseObjectInput(TypedDict):
    job_id: str
    attempt_id: str
    expected_sha256: str
    input_key: str
    result_prefix: str
    page_limit: int


class ParseObjectTiming(TypedDict):
    download_ms: int
    parse_method_ms: int
    upload_ms: int
    total_method_ms: int
    memory: MemoryUsageReport


class ParseObjectSuccess(TypedDict):
    job_id: str
    attempt_id: str
    execution_id: str
    document_sha256: str
    result_uri: str
    result_key: str
    result_digest: str
    result_bytes: int
    page_count: int
    status: Literal["completed"]
    timing: ParseObjectTiming


class ParseObjectFailure(TypedDict):
    job_id: str
    attempt_id: str
    document_sha256: str
    status: Literal["failed"]
    failure_code: str
    failure_detail: str
    timing: ParseObjectTiming


ParseObjectOutput = ParseObjectSuccess | ParseObjectFailure


PUBLIC_FAILURE_CODES = frozenset({
    "upload_expired", "invalid_upload", "input_digest_mismatch",
    "input_too_large", "invalid_pdf", "page_limit_exceeded",
    "processing_deadline_exceeded", "dispatch_failed", "processing_failed",
})


@dataclass(frozen=True)
class S3Location:
    endpoint: str
    bucket: str
    access_key_id: str
    secret_access_key: str


@dataclass(frozen=True)
class R2Config:
    input: S3Location
    results: S3Location


@dataclass(frozen=True)
class R2Store:
    input_client: object
    input_bucket: str
    results_client: object
    results_bucket: str


def load_r2_config(environ=None) -> R2Config:
    env = os.environ if environ is None else environ
    names = (
        "R2_INPUT_ENDPOINT", "R2_INPUT_BUCKET",
        "R2_INPUT_ACCESS_KEY_ID", "R2_INPUT_SECRET_ACCESS_KEY",
        "R2_RESULTS_ENDPOINT", "R2_RESULTS_BUCKET",
        "R2_RESULTS_ACCESS_KEY_ID", "R2_RESULTS_SECRET_ACCESS_KEY",
    )
    missing = [name for name in names if not isinstance(env.get(name), str) or not env[name]]
    if missing:
        raise RuntimeError(f"missing R2 configuration: {', '.join(missing)}")

    def location(prefix: str) -> S3Location:
        endpoint = env[f"R2_{prefix}_ENDPOINT"].rstrip("/")
        if not endpoint.startswith("https://"):
            raise RuntimeError(f"R2_{prefix}_ENDPOINT must use https")
        return S3Location(
            endpoint, env[f"R2_{prefix}_BUCKET"],
            env[f"R2_{prefix}_ACCESS_KEY_ID"],
            env[f"R2_{prefix}_SECRET_ACCESS_KEY"])

    input_location = location("INPUT")
    results_location = location("RESULTS")
    if input_location.bucket == results_location.bucket:
        raise RuntimeError("R2 input and results buckets must be distinct")
    if input_location.access_key_id == results_location.access_key_id:
        raise RuntimeError("R2 input and results credentials must be distinct")
    return R2Config(input=input_location, results=results_location)


def _canonical_uuid(name: str, value) -> str:
    if not isinstance(value, str):
        raise InputRejected(f"{name} must be a canonical UUID")
    try:
        parsed = uuid.UUID(value)
    except (ValueError, AttributeError) as error:
        raise InputRejected(f"{name} must be a canonical UUID") from error
    if str(parsed) != value:
        raise InputRejected(f"{name} must be a canonical lowercase UUID")
    return value


def _object_key(name: str, value) -> str:
    if not isinstance(value, str) or not value or len(value) > 1024:
        raise InputRejected(f"{name} must be a non-empty object key")
    if value.startswith("/") or "\\" in value or any(
            part in ("", ".", "..") for part in value.split("/")):
        raise InputRejected(f"{name} contains an unsafe path segment")
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise InputRejected(f"{name} contains a control character")
    return value


def validate_object_input(payload) -> ParseObjectInput:
    fields = {
        "job_id", "attempt_id", "expected_sha256", "input_key",
        "result_prefix", "page_limit",
    }
    if not isinstance(payload, dict) or set(payload) != fields:
        raise InputRejected(f"parse_object input must contain exactly {sorted(fields)}")
    job_id = _canonical_uuid("job_id", payload["job_id"])
    attempt_id = _canonical_uuid("attempt_id", payload["attempt_id"])
    expected = payload["expected_sha256"]
    if not isinstance(expected, str) or not _SHA256_RE.fullmatch(expected):
        raise InputRejected("expected_sha256 must be 64 lowercase hex chars")
    input_key = _object_key("input_key", payload["input_key"])
    result_prefix = _object_key("result_prefix", payload["result_prefix"])
    expected_input_key = f"inputs/{job_id}.pdf"
    if input_key != expected_input_key:
        raise InputRejected(f"input_key must equal {expected_input_key}")
    expected_prefix = f"results/{job_id}/{attempt_id}"
    if result_prefix != expected_prefix:
        raise InputRejected(f"result_prefix must equal {expected_prefix}")
    page_limit = payload["page_limit"]
    if (not isinstance(page_limit, int) or isinstance(page_limit, bool)
            or not 1 <= page_limit <= MAX_PAGES_PER_JOB):
        raise InputRejected(
            f"page_limit must be an integer from 1 to {MAX_PAGES_PER_JOB}")
    return {
        "job_id": job_id,
        "attempt_id": attempt_id,
        "expected_sha256": expected,
        "input_key": input_key,
        "result_prefix": result_prefix,
        "page_limit": page_limit,
    }


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
        raise InputDigestMismatch(
            "sha256 mismatch between expected_sha256 and pdf_bytes")
    return bytes(pdf_bytes)


def _failure_code(value) -> str:
    return value if value in PUBLIC_FAILURE_CODES else "processing_failed"


def public_result_envelope(request: ParseObjectInput, execution_id: str,
                           parse_result: dict) -> dict:
    """Project the internal parser result to the closed public object.

    Operational timing, Modal identifiers, revisions, resource data and raw
    page exceptions never cross this boundary.
    """
    if parse_result.get("status") != "completed" or parse_result.get("failure") is not None:
        raise InputRejected("only a completed parse can be published")
    page_count = parse_result.get("page_count")
    pages = parse_result.get("pages")
    if (not isinstance(page_count, int) or isinstance(page_count, bool)
            or not 1 <= page_count <= request["page_limit"]
            or not isinstance(pages, list) or len(pages) != page_count):
        raise InputRejected("completed parse has an invalid page collection")
    projected = []
    for index, page in enumerate(pages, 1):
        if not isinstance(page, dict) or page.get("pageNumber") != index:
            raise InputRejected("completed parse pages are not contiguous")
        if page.get("ok") is True:
            spatial = page.get("pageSpatial")
            if not isinstance(spatial, dict) or spatial.get("pageNumber") != index:
                raise InputRejected("completed parse page identity is invalid")
            projected.append({
                "page_number": index, "ok": True, "page_spatial": spatial,
            })
        elif page.get("ok") is False:
            projected.append({
                "page_number": index,
                "ok": False,
                "failure": {
                    "code": "page_failed",
                    "message": "Page could not be parsed.",
                },
            })
        else:
            raise InputRejected("completed parse page has no boolean outcome")
    return {
        "schema_version": OBJECT_RESULT_SCHEMA_VERSION,
        "job_id": request["job_id"],
        "attempt_id": request["attempt_id"],
        "execution_id": execution_id,
        "input_sha256": request["expected_sha256"],
        "page_count": page_count,
        "pages": projected,
    }


def parse_object_failure(request: ParseObjectInput, failure_code: str,
                         detail: str,
                         timing: ParseObjectTiming) -> ParseObjectFailure:
    return {
        "job_id": request["job_id"],
        "attempt_id": request["attempt_id"],
        "document_sha256": request["expected_sha256"],
        "status": "failed",
        "failure_code": _failure_code(failure_code),
        "failure_detail": str(detail)[:500],
        "timing": timing,
    }


# ---------------------------------------------------------------------------
# Test-only failure injection (§14.2 arms 8/9). Double-gated: the env var is
# baked into the image only when an operator explicitly sets it at deploy
# time (never in the production deployment configuration), AND the baked app
# name must be a dev/test app. Either gate missing -> visible InputRejected.
# There is deliberately NO container self-kill mode: §14.2 requires container
# failure to be injected externally and one-shot.
# ---------------------------------------------------------------------------

INJECTION_MODES = ("exception", "timeout", "kill-node")


class InjectedFailure(RuntimeError):
    """Deliberate test-only application exception (§14.2 arm 9)."""


def injection_allowed(environ=None) -> bool:
    env = os.environ if environ is None else environ
    return (env.get("PAGESPATIAL_ENABLE_TEST_FAILURES") == "1"
            and _is_dev_app(env.get("PAGESPATIAL_APP_NAME")))


def validate_injection(payload, environ=None):
    """Returns the requested injection mode or None. Any `test_failure`
    request on a deployment without both gates is a visible rejection —
    the production path cannot reach an injected failure."""
    mode = payload.get("test_failure")
    if mode is None:
        return None
    if not injection_allowed(environ):
        raise InputRejected("test_failure is not available on this deployment")
    if mode not in INJECTION_MODES:
        raise InputRejected(f"unknown test_failure mode (expected one of {INJECTION_MODES})")
    return mode


def surviving_children(proc_root="/proc", self_pid=None) -> list:
    """§14.4 criterion 8 instrument: every process visible in this PID
    namespace except pid 1 and the caller — [{pid, ppid, comm, cmdline}].
    cmdline (argv joined) is required because the realistic leak — a
    Python sidecar escaping its worker's group-kill — reparents to pid 1
    with comm "python3", indistinguishable from platform processes by
    comm/ppid alone. Names/argv only, never content. Parameterized for
    tests (no /proc on macOS)."""
    self_pid = os.getpid() if self_pid is None else self_pid
    procs = []
    root = Path(proc_root)
    if not root.is_dir():
        return procs
    for entry in root.iterdir():
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        if pid in (1, self_pid):
            continue
        try:
            stat = (entry / "stat").read_text()
            # pid (comm) state ppid ... — comm may contain spaces/parens;
            # split at the LAST ')'.
            head, _, tail = stat.rpartition(")")
            comm = head.split("(", 1)[1]
            fields = tail.split()
            state = fields[0]
            ppid = int(fields[1])
        except (OSError, IndexError, ValueError):
            continue
        try:
            cmdline = (entry / "cmdline").read_bytes().replace(b"\0", b" ").decode(
                "utf-8", "replace").strip()
        except OSError:
            cmdline = ""
        procs.append({"pid": pid, "ppid": ppid, "comm": comm, "state": state,
                      "cmdline": cmdline})
    return sorted(procs, key=lambda p: p["pid"])


def leaked_service_processes(procs, service_pid=None, self_pid=None, markers=()) -> list:
    """Filter `surviving_children()` output down to what counts as a leak
    after service drain: any `node` process, anything parented to the
    adapter process or the (now dead) service pid, or — the case comm/ppid
    cannot see — any process whose argv carries one of `markers` (the
    sidecar script name or this container's private data dir), which
    catches an escaped sidecar reparented to pid 1."""
    self_pid = os.getpid() if self_pid is None else self_pid
    live_markers = [marker for marker in markers if marker]
    # comm PREFIX, not equality: the real container's Node processes carry
    # comm "node-MainThread" (closure-probe baseline), so an equality
    # check was dead code in production (PR #93 review, HIGH).
    return [p for p in procs
            if p["comm"].startswith("node")
            or p["ppid"] == self_pid
            or (service_pid is not None and p["ppid"] == service_pid)
            or any(marker in p.get("cmdline", "") for marker in live_markers)]


# Comm prefixes whose unattributable remnants matter for criterion 8: the
# service tree is Node plus Python sidecars; anything else at pid 1 is the
# platform's.
_SERVICE_COMM_PREFIXES = ("node", "python")


def indeterminate_processes(procs) -> list:
    """Criterion-8 closure (external review, 2026-08-23): a process whose
    argv the kernel has already freed reads an EMPTY cmdline — so the
    marker filter above can never attribute it, and the M3 arm-8 probe
    listed four such `python` processes while reporting `survivors: []`
    and `clean: true` (a vacuous pass). The state field settles it:

      - state 'Z' (zombie): PROVABLY DEAD — the group-kill worked and the
        corpse merely awaits pid 1's reap. Reported, never a leak.
      - any other state with a service-class comm and no cmdline:
        INDETERMINATE-LIVE — cannot be told apart from a leaked sidecar
        that zeroed its argv, so it must fail the probe rather than pass
        it silently.
    """
    out = []
    for p in procs:
        if p.get("cmdline"):
            continue
        if not any(p["comm"].startswith(prefix) for prefix in _SERVICE_COMM_PREFIXES):
            continue
        kind = "zombie" if p.get("state") == "Z" else "indeterminate-live"
        out.append({**p, "classification": kind})
    return out


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
    secrets=[
        modal.Secret.from_name(os.environ.get(
            "PAGESPATIAL_R2_INPUT_SECRET_NAME", DEFAULT_R2_INPUT_SECRET_NAME)),
        modal.Secret.from_name(os.environ.get(
            "PAGESPATIAL_R2_RESULTS_SECRET_NAME", DEFAULT_R2_RESULTS_SECRET_NAME)),
    ],
    cpu=CPU_CORES,              # physical cores — matches the measured trial topology
    memory=MEMORY_MIB,          # MiB
    timeout=METHOD_TIMEOUT_S,
    startup_timeout=STARTUP_TIMEOUT_S,
    retries=1,                  # §7.3 table: 1 application retry for the failure trial
    min_containers=0,
    buffer_containers=0,
    max_containers=MAX_CONTAINERS,  # allowlisted 1/4/16 per M3 trial arm — never unbounded
    enable_memory_snapshot=ENABLE_MEMORY_SNAPSHOT,
    # Input concurrency is 1 by default for a Modal Cls (no @modal.concurrent).
)
class ParseContainer:
    @modal.enter(snap=ENABLE_MEMORY_SNAPSHOT)
    def start_service(self):
        self.cold = True
        self.budget = JobBudget()
        self.retired = False
        self.memory_limit_bytes = MEMORY_MIB * 1024 * 1024
        self.memory_container_sample_peak_bytes = None
        self.memory_method_sample_peak_bytes = None
        self.memory_events_at_container_start = _read_memory_events()
        self.memory_events_at_method_start = self.memory_events_at_container_start
        # §12 identity context: attached to EVERY structured log event.
        self.log_context = {
            "app_name": os.environ.get("PAGESPATIAL_APP_NAME", APP_NAME),
            "adapter_revision": os.environ.get("PAGESPATIAL_GIT_REV", "unknown"),
            "image_pin_revision": os.environ.get("PAGESPATIAL_IMAGE_PIN_REV", "unknown"),
            "resources": RESOURCES,
            "memory_snapshot": ENABLE_MEMORY_SNAPSHOT,
        }
        self.method_context = {}
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
            "SERVICE_WORKERS": str(SERVICE_WORKERS),   # measured topology: 4 workers x 1 thread
            "SERVICE_SIDECAR_THREADS": str(SERVICE_SIDECAR_THREADS),
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
        self.snapshot_prepare_ms = self.service_ready_ms
        # `service_started` is the CANONICAL carrier of cold readiness:
        # after a rejected first call the next result reports
        # service_ready_ms=0, so aggregation must read readiness from this
        # log event, never from results (§12; PR #89 closure).
        if ENABLE_MEMORY_SNAPSHOT:
            self._log_event("snapshot_prepared", node_pid=self.node.pid,
                            snapshot_prepare_ms=self.snapshot_prepare_ms,
                            memory=self._memory_report())
        else:
            self._log_event("service_started", node_pid=self.node.pid,
                            container_cold=True,
                            service_ready_ms=self.service_ready_ms,
                            memory=self._memory_report())

    @modal.enter(snap=False)
    def after_snapshot_restore(self):
        """Revalidate restored native children and start fresh measurements.

        The snapshot contains the warmed Node process, OCR sidecars, and their
        open log file. It deliberately does not contain an R2 client or a job.
        Modal also invokes this hook on the container that creates a snapshot,
        so the same health gate applies to both paths.
        """
        if not ENABLE_MEMORY_SNAPSHOT:
            return
        self.cold = True
        self.memory_container_sample_peak_bytes = None
        self.memory_method_sample_peak_bytes = None
        self.memory_events_at_container_start = _read_memory_events()
        self.memory_events_at_method_start = self.memory_events_at_container_start
        t0 = time.monotonic()
        self._wait_health(deadline_s=60)
        self.service_ready_ms = int((time.monotonic() - t0) * 1000)
        self._log_event("service_started", node_pid=self.node.pid,
                        container_cold=True,
                        service_ready_ms=self.service_ready_ms,
                        snapshot_prepare_ms=self.snapshot_prepare_ms,
                        memory=self._memory_report())

    def _sample_memory(self) -> int | None:
        current = _read_first_int(_CGROUP_MEMORY_CURRENT_PATHS)
        if current is not None:
            container_peak = getattr(
                self, "memory_container_sample_peak_bytes", None)
            method_peak = getattr(self, "memory_method_sample_peak_bytes", None)
            self.memory_container_sample_peak_bytes = (
                current if container_peak is None else max(container_peak, current))
            self.memory_method_sample_peak_bytes = (
                current if method_peak is None else max(method_peak, current))
        self.memory_current_bytes = current
        return current

    def _memory_report(self) -> MemoryUsageReport:
        current = self._sample_memory()
        return memory_usage_report(
            current_bytes=current,
            sampled_peak_bytes=getattr(
                self, "memory_method_sample_peak_bytes", current),
            container_sampled_peak_bytes=getattr(
                self, "memory_container_sample_peak_bytes", current),
            configured_limit_bytes=getattr(
                self, "memory_limit_bytes", MEMORY_MIB * 1024 * 1024),
            events_start=getattr(self, "memory_events_at_method_start", {}),
            events_now=_read_memory_events())

    def _wait_health(self, deadline_s: float):
        start = time.monotonic()
        while time.monotonic() - start < deadline_s:
            self._sample_memory()
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
        self._sample_memory()
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

    def _log_event(self, event: str, **fields):
        # Structured, content-free (§11, §12): ids, durations, counts only.
        # Every event carries the container identity context (revision,
        # resources, app name) plus the current method context (request id,
        # sha prefix, cold/warm, call/input ids) so any single log line is
        # attributable on its own.
        # ts (epoch ms, wall clock) makes §12's time-derived aggregation
        # rows (completion percentiles, containers over time, pages/s)
        # reconstructable from logs alone.
        record = {"event": event,
                  "ts": int(time.time() * 1000),
                  **getattr(self, "log_context", {}),
                  **getattr(self, "method_context", {}),
                  **fields}
        print(json.dumps(record, sort_keys=True), flush=True)

    @staticmethod
    def _modal_ids() -> dict:
        """Best-effort Modal call/input identity (§12 'retry attempt when
        available'): the pinned SDK exposes no per-input attempt counter,
        but retries of one input reuse its function_call_id, so the
        reconciler derives attempt counts from repeated log events sharing
        one call id across containers."""
        ids = {"function_call_id": None, "input_id": None}
        try:
            ids["function_call_id"] = modal.current_function_call_id()
            ids["input_id"] = modal.current_input_id()
        except Exception:
            pass
        return ids

    def _require_dev_instrument(self, what: str):
        """Probes and injection are dev/test-app-only (§14.2 hard rule)."""
        if not injection_allowed():
            raise InputRejected(f"{what} is not available on this deployment")

    def _begin_method(self):
        method_t0 = time.monotonic()
        self.memory_method_sample_peak_bytes = None
        self.memory_events_at_method_start = _read_memory_events()
        self._sample_memory()
        container_cold = self.cold
        service_ready_ms = self.service_ready_ms if self.cold else 0
        self.cold = False
        return method_t0, container_cold, service_ready_ms

    @modal.method()
    def parse_document(self, payload: dict) -> dict:
        method_t0, container_cold, service_ready_ms = self._begin_method()
        return self._parse_document(
            payload, method_t0=method_t0, container_cold=container_cold,
            service_ready_ms=service_ready_ms, enforce_result_limit=True)

    def _r2(self):
        cached = getattr(self, "_r2_store", None)
        if cached is not None:
            return cached
        config = load_r2_config()
        import boto3

        def client(location: S3Location):
            return boto3.client(
                "s3", endpoint_url=location.endpoint, region_name="auto",
                aws_access_key_id=location.access_key_id,
                aws_secret_access_key=location.secret_access_key)

        self._r2_store = R2Store(
            client(config.input), config.input.bucket,
            client(config.results), config.results.bucket)
        return self._r2_store

    @staticmethod
    def _download_object(client, bucket: str, key: str) -> bytes:
        response = client.get_object(Bucket=bucket, Key=key)
        declared = response.get("ContentLength")
        if isinstance(declared, int) and declared > MAX_INPUT_BYTES:
            raise InputRejected(f"input object exceeds {MAX_INPUT_BYTES} bytes")
        body = response["Body"]
        try:
            data = body.read(MAX_INPUT_BYTES + 1)
        finally:
            close = getattr(body, "close", None)
            if close:
                close()
        if len(data) > MAX_INPUT_BYTES:
            raise InputRejected(f"input object exceeds {MAX_INPUT_BYTES} bytes")
        return bytes(data)

    @modal.method()
    def parse_object(self, payload: dict) -> ParseObjectOutput:
        object_t0, container_cold, service_ready_ms = self._begin_method()
        request = validate_object_input(payload)
        store = self._r2()

        download_t0 = time.monotonic()
        pdf_bytes = self._download_object(
            store.input_client, store.input_bucket, request["input_key"])
        download_ms = int((time.monotonic() - download_t0) * 1000)

        parse_payload = {
            "request_id": request["attempt_id"],
            "pdf_bytes": pdf_bytes,
            "expected_sha256": request["expected_sha256"],
            "schema_version": SCHEMA_VERSION,
            "enrichment": "off",
            "page_limit": request["page_limit"],
        }
        parse_t0 = time.monotonic()
        try:
            parse_result = self._parse_document(
                parse_payload, method_t0=parse_t0, container_cold=container_cold,
                service_ready_ms=service_ready_ms, enforce_result_limit=False)
        except InputDigestMismatch as error:
            return parse_object_failure(
                request, "input_digest_mismatch", str(error), {
                    "download_ms": download_ms,
                    "parse_method_ms": int((time.monotonic() - parse_t0) * 1000),
                    "upload_ms": 0,
                    "total_method_ms": int((time.monotonic() - object_t0) * 1000),
                    "memory": self._memory_report(),
                })

        if parse_result.get("status") != "completed":
            failure = parse_result.get("failure") or {}
            return parse_object_failure(
                request, failure.get("code"), failure.get("message", "parse failed"), {
                    "download_ms": download_ms,
                    "parse_method_ms": parse_result.get("timing", {}).get(
                        "total_method_ms", int((time.monotonic() - parse_t0) * 1000)),
                    "upload_ms": 0,
                    "total_method_ms": int((time.monotonic() - object_t0) * 1000),
                    "memory": parse_result.get("memory", self._memory_report()),
                })

        execution_id = uuid.uuid4().hex
        result_key = f"{request['result_prefix']}/{execution_id}.json"
        envelope = public_result_envelope(request, execution_id, parse_result)
        result_bytes = json.dumps(
            envelope, sort_keys=True, separators=(",", ":"),
            ensure_ascii=False).encode("utf-8")
        if len(result_bytes) > MAX_OBJECT_RESULT_BYTES:
            raise ObjectResultTooLarge(
                f"serialized object result {len(result_bytes)} bytes exceeds "
                f"{MAX_OBJECT_RESULT_BYTES}")
        result_digest = hashlib.sha256(result_bytes).hexdigest()

        upload_t0 = time.monotonic()
        store.results_client.put_object(
            Bucket=store.results_bucket, Key=result_key, Body=result_bytes,
            ContentType="application/json")
        upload_ms = int((time.monotonic() - upload_t0) * 1000)

        return {
            "job_id": request["job_id"],
            "attempt_id": request["attempt_id"],
            "execution_id": execution_id,
            "document_sha256": request["expected_sha256"],
            "result_uri": f"r2://{store.results_bucket}/{result_key}",
            "result_key": result_key,
            "result_digest": result_digest,
            "result_bytes": len(result_bytes),
            "page_count": envelope["page_count"],
            "status": "completed",
            "timing": {
                "download_ms": download_ms,
                "parse_method_ms": parse_result["timing"]["total_method_ms"],
                "upload_ms": upload_ms,
                "total_method_ms": int((time.monotonic() - object_t0) * 1000),
                "memory": parse_result["memory"],
            },
        }

    def _parse_document(self, payload: dict, *, method_t0: float,
                        container_cold: bool, service_ready_ms: int,
                        enforce_result_limit: bool) -> dict:
        # Cold/warm attribution is a property of the CONTAINER, not of the
        # input: capture and clear it before validation, or a rejected
        # first call would make the next successful call misreport
        # container_cold=true (cold review PR #89, finding 2 — §8).
        pdf_bytes = validate_input(payload)  # raises InputRejected before Node work
        page_limit = payload.get("page_limit", MAX_PAGES_PER_JOB)
        if (not isinstance(page_limit, int) or isinstance(page_limit, bool)
                or not 1 <= page_limit <= MAX_PAGES_PER_JOB):
            raise InputRejected(
                f"page_limit must be an integer from 1 to {MAX_PAGES_PER_JOB}")
        injection = validate_injection(payload)  # test-only; double-gated (§14.2)
        request_id = payload["request_id"]
        sha256 = payload["expected_sha256"]
        # §12 method identity context — merged into every log event below.
        self.method_context = {
            "request_id": request_id,
            "sha_prefix": sha256[:12],
            "container_cold": container_cold,
            **self._modal_ids(),
        }

        if injection == "exception":
            # Arm 9a: one forced application exception — retries per the
            # configured `retries`, then a visible failed FunctionCall.
            self._log_event("injected_failure", mode=injection)
            raise InjectedFailure(f"injected application exception for {request_id}")
        if injection == "timeout":
            # Arm 9b: a forced method timeout — hang past the configured
            # method timeout so the platform kills the call visibly. The
            # sleep is bounded so the path terminates even without the
            # platform kill (local/stub runs).
            self._log_event("injected_failure", mode=injection,
                            sleep_s=TIMEOUT_INJECTION_SLEEP_S)
            time.sleep(TIMEOUT_INJECTION_SLEEP_S)
            raise RuntimeError(
                f"timeout injection outlived the {METHOD_TIMEOUT_S}s method timeout")

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
                    "POST", f"/v1/jobs?enrichment=off&page_limit={page_limit}", pdf_bytes,
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
            self._log_event("job_submitted", http_status=status,
                            job_id=job_id, jobs_created=self.budget.created)
            if injection == "kill-node" and status == 202:
                # Arm 8: terminate the Node child MID-DOCUMENT — the poll
                # loop below must classify it and retire this instance
                # bounded, not hang until the method timeout.
                self._log_event("injected_failure", mode=injection,
                                node_pid=self.node.pid, job_id=job_id)
                self.node.kill()
                try:  # reap so the poll loop classifies the death promptly
                    self.node.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    pass
            if status != 202:
                # Visible client-side refusal (e.g. page cap) — a terminal
                # failed result, not an exception: the input was validly
                # formed but the document is out of bounds.
                return self._result(request_id, sha256, container_cold,
                                    service_ready_ms, method_t0,
                                    page_count=0, pages=[],
                                    failure={"code": body.get("code", "processing_failed"),
                                             "class": f"ServiceRefused{status}",
                                             "message": str(body.get("error", ""))[:500]},
                                    parse_ms=0)
            if body["sha256"] != sha256:
                raise RuntimeError("service-computed sha256 disagrees with the validated input")
            page_count = body["pageCount"]

            deadline = time.monotonic() + PARSE_DEADLINE_S
            while True:
                self._sample_memory()
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
            # json.dumps length is a PROXY for Modal's own (pickle-based)
            # result serialization — close enough for a 64 MiB order-of-
            # magnitude guard, not an exact byte-for-byte bound (PR #89 LOW).
            serialized = len(json.dumps(result).encode())
            if enforce_result_limit and serialized > MAX_RESULT_BYTES:
                # Visible bound (§7.1): never truncate pages.
                return self._result(request_id, sha256, container_cold,
                                    service_ready_ms, method_t0,
                                    page_count=page_count, pages=[],
                                    failure={"class": "ResultTooLarge",
                                             "message": f"serialized result {serialized} bytes exceeds {MAX_RESULT_BYTES}"},
                                    parse_ms=parse_ms)
            self._log_event("job_terminal", job_id=job_id,
                            page_count=page_count, parse_ms=parse_ms,
                            total_method_ms=result["timing"]["total_method_ms"],
                            pages_ok=result["pages_ok"],
                            pages_failed=result["pages_failed"],
                            result_bytes=serialized,
                            memory=result["memory"])
            if result["memory"]["pressure"]:
                self._log_event("memory_pressure", job_id=job_id,
                                memory=result["memory"])
            return result
        finally:
            # §7.4: job dir + uploaded PDF removed after every terminal
            # method; a crash skips this, and the next method's sweep (or
            # container disposal) covers it. Outcome is a §12 field: a
            # cleanup failure must be visible, never silent.
            try:
                cleaned = sweep_scratch(self.data_dir)
                self._log_event("cleanup", cleanup_ok=True, removed=cleaned)
            except Exception as error:
                self._log_event("cleanup", cleanup_ok=False,
                                error=f"{type(error).__name__}: {error}"[:200])
            # Reset method identity so later container-scope events
            # (service_stopped, probes) are not misattributed to this input.
            self.method_context = {}

    def _result(self, request_id, sha256, container_cold, service_ready_ms, method_t0,
                *, page_count, pages, failure, parse_ms):
        # Full §12 field set. Note the cold-readiness caveat: after a
        # rejected first call, the next successful result carries
        # service_ready_ms=0 — cold readiness lives ONLY in the
        # `service_started` log event; aggregation reads it from logs.
        memory = self._memory_report()
        return {
            "request_id": request_id,
            "document_sha256": sha256,
            "page_count": page_count,
            "status": "failed" if failure else "completed",
            "pages": pages,
            "pages_ok": sum(1 for page in pages if page.get("ok")),
            "pages_failed": sum(1 for page in pages if not page.get("ok")),
            "failure": failure,
            "timing": {
                "container_cold": container_cold,
                "queue_wait_ms": None,  # not exposed by the platform per-input
                "service_ready_ms": service_ready_ms,
                "parse_ms": parse_ms,
                "total_method_ms": int((time.monotonic() - method_t0) * 1000),
            },
            "retry": {
                # No stable per-input attempt counter in the pinned SDK;
                # the reconciler counts attempts from repeated log events
                # sharing one function_call_id (§12 'when available').
                "attempt": None,
                **self._modal_ids(),
            },
            "resources": RESOURCES,
            "memory": memory,
            "app_name": os.environ.get("PAGESPATIAL_APP_NAME", APP_NAME),
            "adapter_revision": os.environ.get("PAGESPATIAL_GIT_REV", "unknown"),
            "image_pin_revision": os.environ.get("PAGESPATIAL_IMAGE_PIN_REV", "unknown"),
        }

    def _drain_service(self):
        # SIGTERM -> bounded wait -> SIGKILL fallback; total fits Modal's
        # 30 s exit window with margin (§7.2). The server's own graceful
        # path drains workers (which group-kill their Python sidecars).
        # Shared by @exit and the dev-only exit-drain probe below.
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

    @modal.exit()
    def stop_service(self):
        self._drain_service()

    # -----------------------------------------------------------------
    # Dev-only lifecycle probes (§14.4 criteria 8/9 instruments). Gated
    # exactly like failure injection: unavailable on any deployment that
    # is not an explicit dev/test app with the env flag baked.
    # -----------------------------------------------------------------

    @modal.method()
    def probe_scratch(self) -> dict:
        """Criterion 9 instrument: scratch content (names only) and disk
        use after terminal methods. `clean` means no job state and no
        uploaded PDF bytes survive — only the Node log and the empty
        uploads/ directory may remain."""
        self._require_dev_instrument("probe_scratch")
        base = Path(self.data_dir)
        entries = sorted(entry.name for entry in base.iterdir()) if base.is_dir() else []
        uploads = sorted(
            f"uploads/{item.name}" for item in (base / "uploads").iterdir()
        ) if (base / "uploads").is_dir() else []
        leftovers = [name for name in entries if name not in ("node.log", "uploads")] + uploads
        usage = shutil.disk_usage(self.data_dir)
        report = {
            "data_dir_entries": entries,
            "upload_entries": uploads,
            "leftovers": leftovers,
            "clean": not leftovers,
            "disk_used_bytes": usage.used,
            "disk_free_bytes": usage.free,
        }
        self._log_event("probe_scratch", **report)
        return report

    @modal.method()
    def probe_exit_drain(self) -> dict:
        """Criterion 8 instrument: run the @exit drain NOW, then assert
        zero surviving Node/worker processes and removed scratch. This
        kills the warm Node on purpose, so the instance retires first and
        never accepts another document."""
        self._require_dev_instrument("probe_exit_drain")
        self._retire("exit_drain_probe")
        node_pid = self.node.pid if getattr(self, "node", None) else None
        data_dir = self.data_dir
        # Pre-drain baseline: the full attributable service tree while it
        # is alive (ancestry + argv intact), so the post-drain scan can be
        # compared against what actually existed.
        baseline = surviving_children()
        self._drain_service()
        # Markers catch the sidecar-escaped-the-group-kill case: argv holds
        # the sidecar script and/or this container's private data dir even
        # after the orphan reparents to pid 1 as a bare "python3". The
        # bounded re-poll gives pid 1 a reap window: zombies (provably
        # dead) that vanish were reaped; anything indeterminate-live that
        # PERSISTS is treated as a leak, never passed silently.
        deadline = time.monotonic() + 10.0
        while True:
            procs = surviving_children()
            survivors = leaked_service_processes(
                procs, service_pid=node_pid,
                markers=("ppocr_sidecar.py", "service/worker.mjs",
                         "service/server.mjs", data_dir))
            unattributed = indeterminate_processes(procs)
            live_unattributed = [p for p in unattributed
                                 if p["classification"] == "indeterminate-live"]
            if not survivors and not live_unattributed:
                break
            if time.monotonic() >= deadline:
                break
            time.sleep(0.5)
        zombies = [p for p in unattributed if p["classification"] == "zombie"]
        report = {
            "node_pid": node_pid,
            "node_exit_code": self.node.returncode if node_pid else None,
            "baseline_processes": baseline,
            "processes_seen": procs,
            "survivors": survivors,
            "zombies": zombies,
            "indeterminate_live": live_unattributed,
            "scratch_removed": not Path(self.data_dir).exists(),
            # Zombies are dead by definition (state Z) and merely await
            # pid 1's reap — reported, never failed on. Anything live and
            # unattributable fails the probe.
            "clean": (not survivors and not live_unattributed
                      and not Path(self.data_dir).exists()),
        }
        self._log_event("probe_exit_drain", **report)
        return report


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
    deployed = modal.Cls.from_name(APP_NAME, "ParseContainer")
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

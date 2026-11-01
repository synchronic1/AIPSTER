"""Leased inference job runner for the AIPSTER worker (dark by default).

One job at a time: `serve-jobs` leases a redeemed job for THIS resource
through the AIPSTER worker job route using the stored heartbeat-scoped
key, validates the bound CPU envelope strictly, runs it once on the local
upstream (Ganglion or llama-server, over the OpenAI `/v1` surface), and
posts an EIF-shaped result. It is an outbound client only: it opens no port
and never touches the daemon's loopback API on 8090, its enrollment, or its
credentials.

Standard library only, like pairing.py, so the installed launcher can
freeze this tree without a new dependency. The heartbeat key is read
through pairing.py's existing private-store helpers and is never printed,
logged, or placed in a URL; neither is the prompt or the completion.

Safety rules this module enforces:

  * Nothing runs unless the operator starts `serve-jobs` explicitly; the
    server keeps `POST /api/jobs` disabled until INFERENCE_ENABLED is set.
  * The upstream must be loopback unless --allow-non-loopback-ganglion is
    given; its optional bearer token comes from the environment, never
    from pairing state.
  * The claimed runtime id is one of `ganglion` | `llama-server` (Addendum
    B) and a job addressed to any other runtime is refused with
    ENVELOPE_INVALID, so a result never claims a runtime that did not run it.
  * Exactly one non-streaming completion per job, temperature 0, timeout
    = the job deadline minus now, no redirects, no retries. A model the
    upstream does not list is refused before any completion call.
  * A failure is always reported as `failed` with a stable reason. There
    is no path that reports simulated output as success.
  * The job id is written to a private started-job ledger before the
    completion call. After a crash, an already-started job id is never
    executed again; its outcome stays uncertain instead of being guessed.

Wire shapes (canonical worker wire shapes, dispatch lane Addendum A):

  GET  /api/worker/jobs/next            -> 204 | {job_id, lease_id, envelope, deadline_at}
  envelope -> {protocol: 'aipster-bound-cpu-internal/1',
               task: {capability, model_id, prompt, max_tokens, temperature,
                      allow_simulated, idempotency_key, placement},
               binding: {op_id, generation, runtime_instance,
                         model_fingerprint, deadline_at}}
  POST /api/worker/jobs/:job_id/result -> {lease_id, status, result}

  A succeeded result is exactly {request_id, node_id, runtime_id, model_id,
  runtime_instance, model_fingerprint, simulated:false, content, elapsed_ms,
  usage, cache}; runtime_instance and model_fingerprint are echoed from the
  binding. A failed result is exactly {reason, detail?, elapsed_ms?, usage?,
  cache?}. L2's website/src/inference/worker-transport.mjs validates both.
"""

import argparse
import http.client
import json
import os
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlparse
from urllib.request import Request, build_opener

try:
    import msvcrt
except ImportError:  # POSIX: fcntl path below
    msvcrt = None
try:
    import fcntl
except ImportError:  # Windows: msvcrt path above
    fcntl = None

import pairing
from pairing import PairingError, RePairRequired, USER_AGENT

DEFAULT_GANGLION_BASE = "http://127.0.0.1:8471"
GANGLION_BASE_ENV = "AIPSTER_GANGLION_URL"
GANGLION_TOKEN_ENV = "AIPSTER_GANGLION_TOKEN"
LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")
# Runtime identity this worker may claim (Addendum B). A plain llama-server
# on a Mac serves the same /v1 surface; a result must never say "ganglion"
# when llama-server ran it.
RUNTIME_ALLOWLIST = ("ganglion", "llama-server")
DEFAULT_RUNTIME_ID = "ganglion"

JOBS_POLL_INTERVAL_SEC = 2.0
JOBS_MAX_IDLE_SEC = 30.0
MODELS_CACHE_TTL_SEC = 30.0
GANGLION_MODELS_TIMEOUT_SEC = 5
JOBS_LOCK_NAME = "jobs.lock"
STARTED_LEDGER_NAME = "jobs-started.json"
STARTED_LEDGER_LIMIT = 5000

PROMPT_MAX_CHARS = 65536
MAX_TOKENS_CEILING = 4096
ECHO_ID_MAX_CHARS = 256
ENVELOPE_PROTOCOL = "aipster-bound-cpu-internal/1"
ENVELOPE_KEYS = frozenset({"protocol", "task", "binding"})
TASK_KEYS = frozenset({
    "capability", "model_id", "prompt", "max_tokens", "temperature",
    "allow_simulated", "idempotency_key", "placement",
})
BINDING_KEYS = frozenset({
    "op_id", "generation", "runtime_instance", "model_fingerprint", "deadline_at",
})
PLACEMENT_KEYS = frozenset({"device", "node_id", "runtime_id"})

# Stable failure reasons. They are reported verbatim in the failed result
# and in the operator log; do not reword them without a protocol change.
ENVELOPE_INVALID = "ENVELOPE_INVALID"
MODEL_UNAVAILABLE = "MODEL_UNAVAILABLE"
GANGLION_UNAVAILABLE = "GANGLION_UNAVAILABLE"
GANGLION_HTTP_ERROR = "GANGLION_HTTP_ERROR"
GANGLION_TIMEOUT = "GANGLION_TIMEOUT"
GANGLION_INVALID_RESPONSE = "GANGLION_INVALID_RESPONSE"
EMPTY_CONTENT = "EMPTY_CONTENT"
DEADLINE_EXCEEDED = "DEADLINE_EXCEEDED"


class EnvelopeRejected(Exception):
    """A leased envelope this worker will not execute. Carries no secret."""

    def __init__(self, reason, detail):
        super().__init__(f"{reason}: {detail}")
        self.reason = reason
        self.detail = detail


class LeaseFrameError(Exception):
    """A lease frame without usable ids: no result can be reported for it."""


class GanglionError(Exception):
    """A completion attempt that produced no usable content. Stable reason."""

    def __init__(self, reason, detail=None):
        super().__init__(f"{reason}: {detail}" if detail else reason)
        self.reason = reason
        self.detail = detail


def default_ganglion_base():
    return os.environ.get(GANGLION_BASE_ENV) or DEFAULT_GANGLION_BASE


def check_runtime_id(raw):
    """The runtime identity this worker is allowed to claim.

    Addendum B's allowlist. Anything else is a configuration error, not a
    per-job failure: refusing at startup keeps a mislabelled worker from
    leasing jobs it would then have to fail.
    """
    if raw not in RUNTIME_ALLOWLIST:
        raise PairingError(None, "BAD_RUNTIME",
                           f"runtime id must be one of {', '.join(RUNTIME_ALLOWLIST)}")
    return raw


def check_ganglion_base(raw, allow_non_loopback=False):
    """Validate the upstream base. Loopback HTTP(S) unless explicitly allowed."""
    try:
        parsed = urlparse(raw)
    except ValueError as exc:
        raise PairingError(None, "BAD_GANGLION_BASE", f"invalid upstream base: {exc}")
    if "@" in (parsed.netloc or ""):
        raise PairingError(None, "BAD_GANGLION_BASE",
                           "credentials in the upstream URL are refused")
    if parsed.query or parsed.fragment:
        raise PairingError(None, "BAD_GANGLION_BASE",
                           "upstream base must not carry a query or fragment")
    host = (parsed.hostname or "").lower()
    if parsed.scheme not in ("http", "https") or not host:
        raise PairingError(None, "BAD_GANGLION_BASE",
                           "upstream base must be an http(s) URL")
    if host not in LOOPBACK_HOSTS and not allow_non_loopback:
        raise PairingError(None, "BAD_GANGLION_BASE",
                           "upstream base must be loopback; pass "
                           "--allow-non-loopback-ganglion to override")
    return raw.rstrip("/")


def get_json(url, secret=None, timeout=pairing.REQUEST_TIMEOUT_SEC):
    """GET JSON, returning (status, body-dict, retry-after).

    Mirrors pairing.post_json: product User-Agent, no redirects, sanitized
    edge diagnostics for non-JSON error bodies, secrets only in the header.
    """
    headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
    if secret is not None:
        headers["Authorization"] = "Bearer " + secret
    request = Request(url, headers=headers, method="GET")
    try:
        with build_opener(pairing.NoRedirects()).open(request, timeout=timeout) as response:
            status = response.status
            raw = response.read().decode("utf-8", "replace")
            retry_after = response.headers.get("Retry-After")
            content_type = response.headers.get("Content-Type")
    except HTTPError as exc:
        try:
            if 300 <= exc.code < 400:
                raise PairingError(None, "REDIRECT_BLOCKED", "API redirects are refused")
            raw = exc.read().decode("utf-8", "replace")
            status = exc.code
            retry_after = exc.headers.get("Retry-After") if exc.headers else None
            content_type = exc.headers.get("Content-Type") if exc.headers else None
        except (http.client.HTTPException, OSError) as fault:
            raise PairingError(None, "NETWORK", "incomplete API response") from fault
        finally:
            exc.close()
    except (URLError, TimeoutError, OSError, http.client.HTTPException) as exc:
        raise PairingError(None, "NETWORK", "API transport failed") from exc
    parsed = True
    try:
        body = json.loads(raw) if raw.strip() else {}
    except ValueError:
        body = {}
        parsed = False
    if not isinstance(body, dict):
        body = {}
        parsed = False
    if not parsed and status >= 400:
        body = pairing.edge_block_marker(status, raw, content_type)
    retry_sec = None
    for candidate in (body.get("retryAfterSec"), retry_after):
        try:
            retry_sec = max(1, int(candidate))
            break
        except (TypeError, ValueError):
            continue
    return status, body, retry_sec


def fetch_next(api_base, secret, timeout=pairing.REQUEST_TIMEOUT_SEC):
    """Lease one job for this key's bound resource. Returns (frame|None, retry)."""
    base = pairing.check_api_base(api_base)
    status, body, retry_after = get_json(base + "/api/worker/jobs/next", secret, timeout)
    if status == 204:
        return None, retry_after
    if status == 200:
        if not body:
            return None, retry_after
        return body, retry_after
    err = body.get("code") or "JOBS_FAILED"
    msg = body.get("error") or f"job lease failed (HTTP {status})"
    if status in (401, 403) and err in ("KEY_REVOKED", "KEY_EXPIRED"):
        raise RePairRequired(status, err, msg)
    if status == 404:
        raise PairingError(status, err,
                           "worker job route unavailable; inference is disabled server-side")
    if status == 429:
        raise PairingError(status, err, msg, retry_after)
    raise PairingError(status, err, msg)


def post_result(api_base, job_id, secret, lease_id, status, result):
    """Post one job result. Returns the accepted response body."""
    base = pairing.check_api_base(api_base)
    url = f"{base}/api/worker/jobs/{quote(str(job_id), safe='')}/result"
    code, body, retry_after = pairing.post_json(
        url, {"lease_id": lease_id, "status": status, "result": result}, secret)
    err = body.get("code") or "RESULT_FAILED"
    msg = body.get("error") or f"result post failed (HTTP {code})"
    if code in (200, 201, 202):
        return body
    if code in (401, 403) and err in ("KEY_REVOKED", "KEY_EXPIRED"):
        raise RePairRequired(code, err, msg)
    if code == 429:
        raise PairingError(code, err, msg, retry_after)
    raise PairingError(code, err, msg)


def _is_identifier(value, maximum=256):
    return (isinstance(value, str) and 0 < len(value) <= maximum
            and not any(ch.isspace() or ord(ch) < 32 for ch in value))


def validate_lease(frame):
    """Accept only a complete lease frame. Returns (job_id, lease_id, env, deadline).

    The frame is server-issued, so only the ids this worker needs to report
    back are required; envelope strictness starts one level down.
    """
    if not isinstance(frame, dict):
        raise LeaseFrameError("lease frame is not an object")
    job_id = frame.get("job_id")
    lease_id = frame.get("lease_id")
    if not _is_identifier(job_id) or not _is_identifier(lease_id):
        raise LeaseFrameError("lease frame lacks a usable job_id/lease_id")
    deadline = frame.get("deadline_at")
    return job_id, lease_id, frame.get("envelope"), deadline


def _is_echo_string(value):
    """A binding value the worker can echo into an L2-valid result.

    L2 accepts any non-empty string up to 256 characters for
    runtime_instance and model_fingerprint, so that is exactly the range
    this worker is willing to repeat back.
    """
    return (isinstance(value, str) and 0 < len(value) <= ECHO_ID_MAX_CHARS)


def validate_envelope(envelope, resource_id, deadline_ms, now_ms,
                      runtime_id=DEFAULT_RUNTIME_ID):
    """Strict bound-envelope check. Raises EnvelopeRejected on anything odd.

    The lease envelope is nested: {protocol, task, binding}. `task` is the
    bound-CPU codec output and is validated field by field; `binding` is the
    coordinator's internal instance pin and must carry exactly its five
    fields. The task's placement runtime must be the runtime this worker is
    configured to claim (Addendum B), so a llama-server worker never runs a
    job addressed to Ganglion, nor the other way round. Anything else is
    refused: authority, placement and sampling fields are decided
    server-side and must never travel back in from a job.
    """
    if not isinstance(envelope, dict):
        raise EnvelopeRejected(ENVELOPE_INVALID, "envelope")
    if envelope.get("protocol") != ENVELOPE_PROTOCOL:
        raise EnvelopeRejected(ENVELOPE_INVALID, "protocol")
    if set(envelope) - ENVELOPE_KEYS:
        raise EnvelopeRejected(ENVELOPE_INVALID, "unknown_field")
    task = envelope.get("task")
    if not isinstance(task, dict):
        raise EnvelopeRejected(ENVELOPE_INVALID, "task")
    if set(task) - TASK_KEYS:
        raise EnvelopeRejected(ENVELOPE_INVALID, "task_field")
    binding = envelope.get("binding")
    if not isinstance(binding, dict):
        raise EnvelopeRejected(ENVELOPE_INVALID, "binding")
    if set(binding) != BINDING_KEYS:
        raise EnvelopeRejected(ENVELOPE_INVALID, "binding_field")
    if task.get("capability") != "complete":
        raise EnvelopeRejected(ENVELOPE_INVALID, "capability")
    model_id = task.get("model_id")
    if not _is_identifier(model_id):
        raise EnvelopeRejected(ENVELOPE_INVALID, "model_id")
    prompt = task.get("prompt")
    if (not isinstance(prompt, str) or not prompt.strip()
            or len(prompt) > PROMPT_MAX_CHARS):
        raise EnvelopeRejected(ENVELOPE_INVALID, "prompt")
    max_tokens = task.get("max_tokens")
    if (isinstance(max_tokens, bool) or not isinstance(max_tokens, int)
            or not 1 <= max_tokens <= MAX_TOKENS_CEILING):
        raise EnvelopeRejected(ENVELOPE_INVALID, "max_tokens")
    temperature = task.get("temperature")
    if (isinstance(temperature, bool) or not isinstance(temperature, (int, float))
            or temperature != 0):
        raise EnvelopeRejected(ENVELOPE_INVALID, "temperature")
    if task.get("allow_simulated") is not False:
        raise EnvelopeRejected(ENVELOPE_INVALID, "allow_simulated")
    idempotency_key = task.get("idempotency_key")
    if not _is_identifier(idempotency_key, maximum=128):
        raise EnvelopeRejected(ENVELOPE_INVALID, "idempotency_key")
    placement = task.get("placement")
    if not isinstance(placement, dict) or set(placement) != PLACEMENT_KEYS:
        raise EnvelopeRejected(ENVELOPE_INVALID, "placement")
    if placement["device"] != "cpu":
        raise EnvelopeRejected(ENVELOPE_INVALID, "device")
    if placement["node_id"] != resource_id:
        raise EnvelopeRejected(ENVELOPE_INVALID, "node_id")
    if placement["runtime_id"] != runtime_id:
        raise EnvelopeRejected(ENVELOPE_INVALID, "runtime_id")
    if not _is_identifier(binding["op_id"], maximum=128):
        raise EnvelopeRejected(ENVELOPE_INVALID, "binding_value")
    generation = binding["generation"]
    if (isinstance(generation, bool) or not isinstance(generation, int)
            or generation < 1):
        raise EnvelopeRejected(ENVELOPE_INVALID, "binding_value")
    if not _is_echo_string(binding["runtime_instance"]):
        raise EnvelopeRejected(ENVELOPE_INVALID, "binding_value")
    if not _is_echo_string(binding["model_fingerprint"]):
        raise EnvelopeRejected(ENVELOPE_INVALID, "binding_value")
    # The lease deadline is the only deadline; a binding that disagrees with
    # it means the two sides are looking at different jobs.
    if isinstance(deadline_ms, bool) or not isinstance(deadline_ms, int):
        raise EnvelopeRejected(ENVELOPE_INVALID, "deadline")
    if binding["deadline_at"] != deadline_ms:
        raise EnvelopeRejected(ENVELOPE_INVALID, "deadline")
    if deadline_ms <= now_ms:
        raise EnvelopeRejected(ENVELOPE_INVALID, "deadline")
    return {
        "model_id": model_id,
        "prompt": prompt,
        "max_tokens": max_tokens,
        "deadline_ms": deadline_ms,
        "node_id": placement["node_id"],
        "runtime_id": placement["runtime_id"],
        "runtime_instance": binding["runtime_instance"],
        "model_fingerprint": binding["model_fingerprint"],
    }


class GanglionClient:
    """One-way client for the local upstream (Ganglion or llama-server) /v1 API."""

    def __init__(self, base, token=None, allow_non_loopback=False,
                 models_cache_ttl=MODELS_CACHE_TTL_SEC, clock=None):
        self.base = check_ganglion_base(base, allow_non_loopback)
        self.token = token
        self.models_cache_ttl = max(0.0, float(models_cache_ttl))
        self.clock = clock or time.monotonic
        self._models = None
        self._models_at = 0.0

    def models(self):
        """Model ids the upstream says it can serve. Briefly cached."""
        now = self.clock()
        if self._models is not None and now - self._models_at < self.models_cache_ttl:
            return self._models
        try:
            status, body, _ = get_json(self.base + "/v1/models", self.token,
                                       timeout=GANGLION_MODELS_TIMEOUT_SEC)
        except PairingError as exc:
            raise GanglionError(GANGLION_UNAVAILABLE, f"models {exc.code}") from exc
        if status != 200:
            raise GanglionError(GANGLION_UNAVAILABLE, f"models HTTP {status}")
        data = body.get("data")
        ids = [entry["id"] for entry in data
               if isinstance(entry, dict) and isinstance(entry.get("id"), str)] \
            if isinstance(data, list) else []
        if not ids:
            raise GanglionError(GANGLION_UNAVAILABLE, "no listed models")
        self._models, self._models_at = ids, now
        return ids

    def _post(self, path, payload, deadline_monotonic):
        remaining = deadline_monotonic - self.clock()
        if remaining <= 0:
            raise GanglionError(DEADLINE_EXCEEDED)
        try:
            status, body, _ = pairing.post_json(self.base + path, payload, self.token,
                                                timeout=remaining)
        except PairingError as exc:
            if exc.code == "REDIRECT_BLOCKED":
                raise GanglionError(GANGLION_UNAVAILABLE, "redirect refused")
            cause = exc.__cause__
            timed_out = isinstance(cause, TimeoutError) or (
                isinstance(cause, URLError)
                and isinstance(getattr(cause, "reason", None), TimeoutError))
            if timed_out:
                raise GanglionError(GANGLION_TIMEOUT)
            raise GanglionError(GANGLION_UNAVAILABLE, "transport")
        return status, body

    def complete(self, model_id, prompt, max_tokens, deadline_monotonic):
        """Run exactly one non-streaming completion. No retries.

        A 404 on /v1/completions means the route does not exist (nothing was
        executed), so the documented single-message chat fallback is used
        once. Any other failure is final.
        """
        body = {"model": model_id, "prompt": prompt, "max_tokens": max_tokens,
                "temperature": 0, "stream": False}
        status, response = self._post("/v1/completions", body, deadline_monotonic)
        if status == 404:
            chat = {"model": model_id,
                    "messages": [{"role": "user", "content": prompt}],
                    "max_tokens": max_tokens, "temperature": 0, "stream": False}
            status, response = self._post("/v1/chat/completions", chat, deadline_monotonic)
        if status != 200:
            raise GanglionError(GANGLION_HTTP_ERROR, f"HTTP {status}")
        choices = response.get("choices")
        text = None
        if isinstance(choices, list) and choices and isinstance(choices[0], dict):
            choice = choices[0]
            text = choice.get("text")
            if text is None and isinstance(choice.get("message"), dict):
                text = choice["message"].get("content")
        if not isinstance(text, str):
            raise GanglionError(GANGLION_INVALID_RESPONSE, "no completion text")
        if not text.strip():
            raise GanglionError(EMPTY_CONTENT)
        usage = response.get("usage")
        return {"content": text, "usage": usage if isinstance(usage, dict) else {}}


class StartedLedger:
    """Private record of job ids handed to the upstream, written before the call.

    A job whose execution started but whose result POST was never confirmed
    must not be executed a second time: the outcome is uncertain, and
    guessing either way would be a false claim. The file holds only job
    ids, is written atomically through pairing.write_private, and is read
    fail-closed.
    """

    def __init__(self, data_dir, limit=STARTED_LEDGER_LIMIT):
        self.path = Path(data_dir) / STARTED_LEDGER_NAME
        self.limit = limit
        self._ids = self._load()

    def _load(self):
        if not self.path.exists():
            return []
        try:
            record = json.loads(self.path.read_text(encoding="utf-8"))
            ids = record.get("job_ids") if isinstance(record, dict) else None
            if not isinstance(ids, list) or not all(
                    isinstance(job_id, str) and job_id for job_id in ids):
                raise ValueError("unexpected ledger shape")
            return ids
        except (OSError, ValueError) as exc:
            raise PairingError(None, "BAD_JOB_LEDGER",
                               f"started-job ledger {self.path.name} is unreadable; "
                               "fix or remove it before serving jobs") from exc

    def contains(self, job_id):
        return job_id in self._ids

    def record(self, job_id):
        if job_id in self._ids:
            return
        ids = (self._ids + [job_id])[-self.limit:]
        pairing.write_private(self.path, json.dumps({"job_ids": ids}, indent=2) + "\n")
        self._ids = ids


class _Lock:
    def __init__(self, handle):
        self.handle = handle

    def release(self):
        handle, self.handle = self.handle, None
        if handle is not None:
            try:
                handle.close()
            except OSError:
                pass


def _hold_lock(data_dir, name):
    """Take an OS-held lock non-blocking. Never wedges on a stale marker."""
    path = Path(data_dir) / name
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
    except OSError:
        return None
    if os.name == "nt":
        try:
            handle = os.open(str(path), os.O_CREAT | os.O_RDWR, 0o600)
        except OSError:
            return None
        try:
            msvcrt.locking(handle, msvcrt.LK_NBLCK, 1)
        except (OSError, ImportError):
            os.close(handle)
            return None
        try:
            stream = os.fdopen(handle, "r")
        except OSError:
            os.close(handle)
            return None
        return _Lock(stream)
    try:
        handle = open(path, "a+b")
    except OSError:
        return None
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (OSError, ImportError):
        handle.close()
        return None
    return _Lock(handle)


class JobRunner:
    """Lease -> validate -> one upstream completion -> result, with backoff."""

    def __init__(self, data_dir, ganglion_base=None, ganglion_token=None,
                 allow_non_loopback=False, poll_interval=JOBS_POLL_INTERVAL_SEC,
                 models_cache_ttl=MODELS_CACHE_TTL_SEC, sleep=None, clock=None,
                 now_ms=None, max_idle_sec=JOBS_MAX_IDLE_SEC,
                 runtime_id=DEFAULT_RUNTIME_ID):
        self.data_dir = Path(data_dir)
        self.clock = clock or time.monotonic
        self.now_ms = now_ms or (lambda: int(time.time() * 1000))
        self.sleep = sleep or time.sleep
        self.poll_interval = max(0.001, float(poll_interval))
        self.max_idle = max(self.poll_interval, float(max_idle_sec))
        # Both are checked here so a bad runtime id or a non-loopback or
        # malformed upstream is refused before a stored credential is read.
        self.runtime_id = check_runtime_id(runtime_id)
        self.ganglion = GanglionClient(ganglion_base or default_ganglion_base(),
                                       token=ganglion_token,
                                       allow_non_loopback=allow_non_loopback,
                                       models_cache_ttl=models_cache_ttl,
                                       clock=self.clock)
        self.ledger = None

    def run(self, max_cycles=None):
        """Serve jobs until stopped. max_cycles bounds the polls (--once: 1)."""
        try:
            # Provision before writing anything: the lock and ledger must not
            # be the first files to create an inherited, non-private store.
            pairing.private_dir(self.data_dir)
            self.ledger = StartedLedger(self.data_dir)
        except (PairingError, OSError) as exc:
            code = getattr(exc, "code", "PRIVATE_STORAGE")
            print(f"jobs: [{code}] {exc}", file=sys.stderr)
            return pairing.EXIT_USAGE
        guard = _hold_lock(self.data_dir, JOBS_LOCK_NAME)
        if guard is None:
            print("jobs: [JOBS_RUNNING] another serve-jobs already holds this "
                  "data dir; not starting a second", file=sys.stderr)
            return pairing.EXIT_SENDER_RUNNING
        if max_cycles is None and hasattr(sys.stdout, "reconfigure"):
            try:
                sys.stdout.reconfigure(line_buffering=True)
            except (OSError, ValueError):
                pass
        try:
            return self._loop(max_cycles)
        finally:
            guard.release()

    def _loop(self, max_cycles):
        cycles = 0
        idle = 0
        failures = 0
        while max_cycles is None or cycles < max_cycles:
            cycles += 1
            try:
                with pairing.pair_lock(self.data_dir):
                    meta = pairing.load_pairing(self.data_dir)
            except PairingError as exc:
                if exc.code == "PAIR_IN_PROGRESS":
                    print("jobs: pair in progress; rechecking after the interval",
                          file=sys.stderr)
                    self.sleep(self.poll_interval)
                    continue
                print(f"jobs: [{exc.code}] {exc}", file=sys.stderr)
                return pairing.EXIT_REPAIR_REQUIRED if exc.code == "NOT_PAIRED" \
                    else pairing.EXIT_USAGE
            try:
                frame, retry_after = fetch_next(meta["api_base"], meta["heartbeat_key"])
            except RePairRequired as exc:
                print(f"jobs: [{exc.code}] worker key is dead; pair again with a new code",
                      file=sys.stderr)
                return pairing.EXIT_REPAIR_REQUIRED
            except PairingError as exc:
                stop, failures = self._poll_failure(exc, failures)
                if stop is not None:
                    return stop
                continue
            failures = 0
            if frame is None:
                wait = retry_after if retry_after else min(
                    self.poll_interval * (2 ** idle), self.max_idle)
                idle += 1
                self.sleep(wait)
                continue
            idle = 0
            try:
                stop = self._handle(meta, frame)
            except RePairRequired as exc:
                print(f"jobs: [{exc.code}] worker key is dead; pair again with a new code",
                      file=sys.stderr)
                return pairing.EXIT_REPAIR_REQUIRED
            if stop is not None:
                return stop
        return pairing.EXIT_OK

    def _poll_failure(self, exc, failures):
        if exc.status == 429:
            wait = exc.retry_after or self.poll_interval
            print(f"jobs: rate limited; retrying in {wait}s", file=sys.stderr)
            self.sleep(wait)
            return None, 0
        if exc.status is None or (isinstance(exc.status, int) and exc.status >= 500):
            failures += 1
            if failures > pairing.MAX_ATTEMPTS_NETWORK:
                print(f"jobs: giving up after {pairing.MAX_ATTEMPTS_NETWORK} tries: "
                      f"[{exc.code}] {exc}", file=sys.stderr)
                return pairing.EXIT_NETWORK, failures
            wait = min(2 ** failures, 60)
            print(f"jobs: [{exc.code}] {exc}; retry {failures}/"
                  f"{pairing.MAX_ATTEMPTS_NETWORK} in {wait}s", file=sys.stderr)
            self.sleep(wait)
            return None, failures
        print(f"jobs: [{exc.code}] {exc}", file=sys.stderr)
        return pairing.EXIT_PAIRING_REJECTED, failures

    def _handle(self, meta, frame):
        """Run or refuse one leased job. Returns a stop code or None."""
        resource_id = meta["resource_id"]
        try:
            job_id, lease_id, envelope, deadline = validate_lease(frame)
        except LeaseFrameError as exc:
            print(f"jobs: [LEASE_FRAME] {exc}; no result can be reported",
                  file=sys.stderr)
            return pairing.EXIT_USAGE
        try:
            lease = validate_envelope(envelope, resource_id, deadline, self.now_ms(),
                                      self.runtime_id)
        except EnvelopeRejected as exc:
            return self._post_failure(meta, job_id, lease_id, exc.reason, exc.detail)
        if self.ledger.contains(job_id):
            # Re-leasing a started job means the earlier result was never
            # confirmed. Re-running it could double-charge and double-run,
            # so refuse; the job's outcome stays uncertain.
            print(f"jobs: {job_id} [JOB_ALREADY_STARTED] not re-executed; "
                  "its outcome stays uncertain", file=sys.stderr)
            return None
        model_id = lease["model_id"]
        try:
            listed = self.ganglion.models()
        except GanglionError as exc:
            return self._post_failure(meta, job_id, lease_id,
                                      GANGLION_UNAVAILABLE, exc.detail)
        if model_id not in listed:
            return self._post_failure(meta, job_id, lease_id,
                                      MODEL_UNAVAILABLE, None)
        remaining = (lease["deadline_ms"] - self.now_ms()) / 1000.0
        if remaining <= 0:
            return self._post_failure(meta, job_id, lease_id,
                                      DEADLINE_EXCEEDED, None)
        # Commit the attempt before calling the upstream: a crash after this
        # point must leave the job marked as started, never silently rerun.
        try:
            self.ledger.record(job_id)
        except (PairingError, OSError):
            # Without a durable record a crash could re-execute this job, so
            # executing now would be the unsafe choice. Fail closed.
            print(f"jobs: {job_id} [BAD_JOB_LEDGER] cannot record the started "
                  "job; refusing to execute", file=sys.stderr)
            return pairing.EXIT_USAGE
        started = self.clock()
        try:
            completed = self.ganglion.complete(model_id, lease["prompt"],
                                               lease["max_tokens"],
                                               self.clock() + remaining)
        except GanglionError as exc:
            elapsed = int(round((self.clock() - started) * 1000))
            return self._post_failure(meta, job_id, lease_id,
                                      exc.reason, exc.detail, elapsed)
        elapsed_ms = int(round((self.clock() - started) * 1000))
        # Exactly L2's succeeded key set. runtime_instance and
        # model_fingerprint are echoed from the binding, never invented.
        result = {
            "request_id": job_id,
            "node_id": lease["node_id"],
            "runtime_id": lease["runtime_id"],
            "model_id": model_id,
            "runtime_instance": lease["runtime_instance"],
            "model_fingerprint": lease["model_fingerprint"],
            "simulated": False,
            "content": completed["content"],
            "elapsed_ms": elapsed_ms,
            "usage": completed["usage"],
            "cache": {},
        }
        return self._post(meta, job_id, lease_id, "succeeded", result)

    def _post_failure(self, meta, job_id, lease_id, reason, detail,
                      elapsed_ms=None):
        # Exactly L2's failed key set: {reason, detail?, elapsed_ms?,
        # usage?, cache?}. No request/node/runtime/model identity, no
        # simulated flag and no content: a failure claims nothing.
        result = {"reason": reason}
        if detail:
            result["detail"] = detail
        if elapsed_ms is not None:
            result["elapsed_ms"] = elapsed_ms
        print(f"jobs: {job_id} failed [{reason}]"
              + (f" ({detail})" if detail else ""), file=sys.stderr)
        return self._post(meta, job_id, lease_id, "failed", result)

    def _post(self, meta, job_id, lease_id, status, result):
        try:
            post_result(meta["api_base"], job_id, meta["heartbeat_key"],
                        lease_id, status, result)
        except RePairRequired:
            raise
        except PairingError as exc:
            if exc.status == 409:
                print(f"jobs: result for {job_id} refused (409 {exc.code}); "
                      "not retried", file=sys.stderr)
            else:
                print(f"jobs: result for {job_id} unconfirmed [{exc.code}]"
                      + (f" (HTTP {exc.status})" if exc.status else "")
                      + "; the job stays uncertain", file=sys.stderr)
            return None
        print(f"jobs: {job_id} {status} posted")
        return None


def cmd_serve_jobs(args):
    """`pairing.py serve-jobs`: run leased jobs until stopped."""
    try:
        data_dir = Path(args.data_dir) if args.data_dir else pairing.default_data_dir()
        runner = JobRunner(
            data_dir,
            ganglion_base=args.ganglion_base or default_ganglion_base(),
            ganglion_token=os.environ.get(GANGLION_TOKEN_ENV) or None,
            allow_non_loopback=args.allow_non_loopback_ganglion,
            poll_interval=args.interval,
            models_cache_ttl=args.models_cache_ttl,
            runtime_id=getattr(args, "runtime_id", DEFAULT_RUNTIME_ID))
        return runner.run(max_cycles=1 if args.once else None)
    except PairingError as exc:
        print(f"jobs failed [{exc.code}]: {exc}", file=sys.stderr)
        return pairing.EXIT_USAGE


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="AIPSTER worker inference job runner (uses stored pairing)")
    parser.add_argument("--data-dir", default=None,
                        help="worker data dir (default: installed location)")
    parser.add_argument("--ganglion-base", "--upstream-url", dest="ganglion_base",
                        default=None,
                        help="local upstream base URL, Ganglion or llama-server "
                             f"(default: {DEFAULT_GANGLION_BASE}); "
                             "--upstream-url is an alias")
    parser.add_argument("--allow-non-loopback-ganglion", action="store_true",
                        help="permit a non-loopback upstream base (not qualified)")
    parser.add_argument("--runtime-id", default=DEFAULT_RUNTIME_ID,
                        help="runtime identity this worker claims, one of "
                             f"{', '.join(RUNTIME_ALLOWLIST)} "
                             f"(default: {DEFAULT_RUNTIME_ID})")
    parser.add_argument("--interval", type=float, default=JOBS_POLL_INTERVAL_SEC,
                        help="base idle poll interval in seconds")
    parser.add_argument("--models-cache-ttl", type=float, default=MODELS_CACHE_TTL_SEC,
                        help="seconds to cache the upstream model list")
    parser.add_argument("--once", action="store_true", help="poll once and exit")
    return cmd_serve_jobs(parser.parse_args(argv))


if __name__ == "__main__":
    raise SystemExit(main())

"""Inference job runner tests. Stdlib only; no venv needed.

Two fake in-thread HTTP servers stand in for the AIPSTER worker job routes
and the local Ganglion OpenAI-compatible surface. Everything is loopback
and synthetic: no live Ganglion, no AIPSTER network, no model load, no
inference. Pairing credentials are synthetic fixtures stored in a
throwaway private data dir.

Shapes under test (canonical worker wire shapes, Addendum A of
DS-INFERENCE-LANES-20261101.md; the coordinator builds the envelope at
website/src/inference/dispatch-coordinator.mjs ~L331 and L2 validates the
result in website/src/inference/worker-transport.mjs):
  GET  /api/worker/jobs/next            -> 204 | {job_id, lease_id, envelope, deadline_at}
  envelope                             -> {protocol, task, binding}
  POST /api/worker/jobs/:job_id/result  -> {lease_id, status, result}
  GET  /v1/models                       -> {object: 'list', data: [{id}]}
  POST /v1/completions                  -> OpenAI text_completion
  POST /v1/chat/completions             -> OpenAI chat.completion (fallback only)
"""
import copy
import json
import math
import re
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stdout, redirect_stderr
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import StringIO
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import pairing
import inference_worker
from inference_worker import (EnvelopeRejected, JobRunner, StartedLedger,
                              check_ganglion_base)

FAKE_CODE = "pair-01234567-89AB-CDEF-GHJKMNPQ"[:27]
FAKE_SECRET = "synthetic-heartbeat-key-0123456789abcdef"
FAKE_RESOURCE = "r_fake01"
MODEL = "qwen3-27b"
PROTOCOL = "aipster-bound-cpu-internal/1"
RUNTIME_INSTANCE = "ganglion-instance-0001"
MODEL_FINGERPRINT = "sha256:0f1e2d3c4b5a69788796a5b4c3d2e1f0"


def now_ms():
    return int(time.time() * 1000)


def task(model=MODEL, prompt="hello there", max_tokens=16,
         node_id=FAKE_RESOURCE, runtime_id="ganglion", **over):
    """One bound-CPU task: exactly what encodeBoundCpuTask emits.

    website/src/inference/eif-task-contract.mjs @ 9f2fc29: encodeCpuTask
    returns {capability, model_id, prompt, max_tokens, temperature,
    allow_simulated, idempotency_key}; encodeBoundCpuTask adds placement.
    """
    body = {
        "capability": "complete",
        "model_id": model,
        "prompt": prompt,
        "max_tokens": max_tokens,
        "temperature": 0,
        "allow_simulated": False,
        "idempotency_key": "dispatch-op-000001",
        "placement": {"device": "cpu", "node_id": node_id, "runtime_id": runtime_id},
    }
    body.update(over)
    return body


def binding(deadline_ms=None, **over):
    """The coordinator's internal binding (dispatch-coordinator.mjs ~L331)."""
    body = {
        "op_id": "dispatch-op-000001",
        "generation": 1,
        "runtime_instance": RUNTIME_INSTANCE,
        "model_fingerprint": MODEL_FINGERPRINT,
        "deadline_at": now_ms() + 60000 if deadline_ms is None else deadline_ms,
    }
    body.update(over)
    return body


def envelope(task_body=None, binding_body=None, deadline_ms=None, **over):
    """The nested lease envelope: {protocol, task, binding}."""
    env = {
        "protocol": PROTOCOL,
        "task": task() if task_body is None else task_body,
        "binding": binding(deadline_ms) if binding_body is None else binding_body,
    }
    env.update(over)
    return env


def lease(job_id="job_1", lease_id="lease_1", env=None, deadline_ms=None):
    if env is None:
        if deadline_ms is None:
            deadline_ms = now_ms() + 60000
        env = envelope(deadline_ms=deadline_ms)
    elif deadline_ms is None:
        # Keep the lease deadline and the binding deadline agreeing unless a
        # test deliberately sets one of them apart.
        inner = env.get("binding") if isinstance(env, dict) else None
        deadline_ms = inner.get("deadline_at") if isinstance(inner, dict) else None
        if not isinstance(deadline_ms, int) or isinstance(deadline_ms, bool):
            deadline_ms = now_ms() + 60000
    return {
        "job_id": job_id,
        "lease_id": lease_id,
        "envelope": env,
        "deadline_at": deadline_ms,
    }


def completion_body(text="hello", usage=None):
    return {
        "id": "cmpl-1", "object": "text_completion", "created": 0, "model": MODEL,
        "choices": [{"index": 0, "text": text, "finish_reason": "stop"}],
        "usage": usage if usage is not None else {
            "prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5},
    }


def chat_body(content="hello"):
    return {
        "id": "chatcmpl-1", "object": "chat.completion", "created": 0, "model": MODEL,
        "choices": [{"index": 0, "message": {"role": "assistant", "content": content},
                     "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5},
    }


# -- Mirror of L2's worker result validator ------------------------------
#
# Copied rule for rule from website/src/inference/worker-transport.mjs on
# branch ds/inference-routes-20261101 at commit 9f2fc29. Line numbers below
# are that file's. The worker has no JS runtime, so the contract test
# restates the rules here and holds the posted bodies to them.
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")   # L17
MODEL_ID_MAX = 256                                          # L18
CONTENT_MAX = 65536                                         # L19
WORKER_RESULT_MAX_BYTES = 1024 * 1024                       # L20
SUCCEEDED_ALLOWED = frozenset({                             # L48-49
    "request_id", "node_id", "runtime_id", "model_id", "runtime_instance",
    "model_fingerprint", "simulated", "content", "elapsed_ms", "usage", "cache",
    "truncated",
})
FAILED_ALLOWED = frozenset({"reason", "detail", "elapsed_ms", "usage", "cache"})  # L63


def _is_str(value, maximum=MODEL_ID_MAX):                   # L23
    return isinstance(value, str) and 0 < len(value) <= maximum


def _is_obj(value):                                         # L22
    return isinstance(value, dict)


def _valid_succeeded_result(result):                        # L46-59
    if not _is_obj(result):
        return False
    if set(result) - SUCCEEDED_ALLOWED:                     # L50
        return False
    if not all(_is_str(result.get(key)) for key in (       # L51
            "request_id", "node_id", "runtime_id", "model_id")):
        return False
    if not all(_is_str(result.get(key)) for key in (       # L52
            "runtime_instance", "model_fingerprint")):
        return False
    if result.get("simulated") is not False:                # L53
        return False
    if "truncated" in result and result["truncated"] is not False:  # L54
        return False
    content = result.get("content")                         # L55
    if (not isinstance(content, str) or not content.strip()
            or len(content) > CONTENT_MAX):
        return False
    elapsed = result.get("elapsed_ms")                      # L56
    if (isinstance(elapsed, bool) or not isinstance(elapsed, (int, float))
            or not math.isfinite(elapsed) or elapsed < 0):
        return False
    if not _is_obj(result.get("usage")) or not _is_obj(result.get("cache")):  # L57
        return False
    return True


def _valid_failed_result(result):                           # L61-66
    if not _is_obj(result):
        return False
    if set(result) - FAILED_ALLOWED:                        # L64
        return False
    return _is_str(result.get("reason"), 128)                # L65


def validate_worker_result_report(body):                    # L74-97
    """L2's rules. Returns None when accepted, else a rejection code."""
    if not _is_obj(body):                                   # L75
        return "INVALID_RESULT"
    if len(body) != 3 or set(body) != {"lease_id", "status", "result"}:  # L77
        return "REPORT_SHAPE"
    if not isinstance(body["lease_id"], str) or not ID_RE.match(body["lease_id"]):  # L80
        return "LEASE_ID"
    if body["status"] not in ("succeeded", "failed"):       # L83-84
        return "STATUS"
    wire = json.dumps(body, separators=(",", ":")).encode("utf-8")  # L87
    if len(wire) > WORKER_RESULT_MAX_BYTES:
        return "BODY_TOO_LARGE"
    if body["status"] == "succeeded" and not _valid_succeeded_result(body["result"]):  # L90
        return "INVALID_RESULT"
    if body["status"] == "failed" and not _valid_failed_result(body["result"]):  # L93
        return "INVALID_RESULT"
    return None


class FakeApiState:
    def __init__(self):
        self.leases = []          # queued lease frames served as 200
        self.next_plan = []       # (status, body, headers) overriding the lease queue
        self.results = []         # {"job_id", "body", "key"}
        self.result_plan = []     # (status, body) overriding the accepted result
        self.live_keys = {FAKE_SECRET}
        self.claims = []
        self.next_hits = 0
        self.auth_seen = []
        self.user_agents = []


def make_api_server(state):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, status, body=None, headers=None):
            if body is None:
                data = b""
            else:
                data = json.dumps(body).encode()
            self.send_response(status)
            if body is not None:
                self.send_header("Content-Type", "application/json")
            for name, value in (headers or {}).items():
                self.send_header(name, value)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            if data:
                self.wfile.write(data)

        def _auth(self):
            return (self.headers.get("Authorization") or "").replace("Bearer ", "")

        def do_GET(self):
            path = urlparse(self.path).path
            if path == "/api/worker/jobs/next":
                state.next_hits += 1
                key = self._auth()
                state.auth_seen.append(key)
                state.user_agents.append(self.headers.get("User-Agent"))
                if key not in state.live_keys:
                    return self._send(401, {"code": "KEY_REVOKED", "error": "revoked"})
                if state.next_plan:
                    status, body, headers = state.next_plan.pop(0)
                elif state.leases:
                    status, body, headers = 200, state.leases.pop(0), {}
                else:
                    status, body, headers = 204, None, {}
                return self._send(status, body, headers)
            return self._send(404, {"code": "NOT_FOUND", "error": "no route"})

        def do_POST(self):
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            try:
                body = json.loads(raw.decode())
            except ValueError:
                body = {}
            path = urlparse(self.path).path
            if path == "/api/pairing/claim":
                state.claims.append(body)
                return self._send(201, {"resourceId": FAKE_RESOURCE,
                                        "heartbeatKey": FAKE_SECRET,
                                        "keyId": "k_fake01",
                                        "keyPrefix": "aip_live_k_fake01_synthe",
                                        "heartbeatUrl": "/api/resources/%s/heartbeat" % FAKE_RESOURCE,
                                        "created": True})
            if path.startswith("/api/worker/jobs/") and path.endswith("/result"):
                job_id = path[len("/api/worker/jobs/"):-len("/result")]
                key = self._auth()
                state.results.append({"job_id": job_id, "body": body, "key": key})
                if key not in state.live_keys:
                    return self._send(401, {"code": "KEY_REVOKED", "error": "revoked"})
                if state.result_plan:
                    status, payload = state.result_plan.pop(0)
                else:
                    status, payload = 200, {"accepted": True}
                return self._send(status, payload)
            return self._send(404, {"code": "NOT_FOUND", "error": "no route"})

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, "http://127.0.0.1:%d" % server.server_port


class FakeGanglionState:
    def __init__(self):
        self.models = [MODEL]
        self.models_status = 200
        self.models_hits = 0
        self.completion_status = 200
        self.completion_body = completion_body()
        self.completion_delay = 0.0
        self.chat_status = 200
        self.chat_body = chat_body()
        self.hits = {"completions": 0, "chat": 0}
        self.requests = {"completions": [], "chat": []}
        self.headers = []


def make_ganglion_server(state):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, status, body):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            try:
                self.wfile.write(data)
                self.wfile.flush()
            except OSError:
                pass  # the client may already have timed out and gone away

        def do_GET(self):
            if urlparse(self.path).path == "/v1/models":
                state.models_hits += 1
                if state.models_status != 200:
                    return self._send(state.models_status, {"error": "boom"})
                return self._send(200, {"object": "list",
                                        "data": [{"id": m, "object": "model",
                                                  "owned_by": "ganglion"} for m in state.models]})
            self._send(404, {"error": "no route"})

        def do_POST(self):
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            try:
                body = json.loads(raw.decode())
            except ValueError:
                body = {}
            path = urlparse(self.path).path
            state.headers.append(dict(self.headers))
            if path == "/v1/completions":
                state.hits["completions"] += 1
                state.requests["completions"].append(body)
                if state.completion_delay:
                    time.sleep(state.completion_delay)
                return self._send(state.completion_status, state.completion_body)
            if path == "/v1/chat/completions":
                state.hits["chat"] += 1
                state.requests["chat"].append(body)
                return self._send(state.chat_status, state.chat_body)
            self._send(404, {"error": "no route"})

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, "http://127.0.0.1:%d" % server.server_port


class InferenceWorkerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data = Path(self.tmp.name) / "data"
        self.api = FakeApiState()
        self.api_server, self.base = make_api_server(self.api)
        self.addCleanup(self.api_server.server_close)
        self.addCleanup(self.api_server.shutdown)
        self.ganglion = FakeGanglionState()
        self.ganglion_server, self.gbase = make_ganglion_server(self.ganglion)
        self.addCleanup(self.ganglion_server.server_close)
        self.addCleanup(self.ganglion_server.shutdown)
        self._pair()

    def _pair(self):
        args = type("Args", (), {})()
        args.api_base = self.base
        args.data_dir = str(self.data)
        args.config = None
        args.name = None
        args.code = FAKE_CODE
        with redirect_stdout(StringIO()), redirect_stderr(StringIO()):
            self.assertEqual(pairing.cmd_pair(args), pairing.EXIT_OK)

    def runner(self, **kwargs):
        kwargs.setdefault("ganglion_base", self.gbase)
        kwargs.setdefault("poll_interval", 0.01)
        return JobRunner(self.data, **kwargs)

    def run_quiet(self, runner, **kwargs):
        out, err = StringIO(), StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = runner.run(**kwargs)
        return code, out.getvalue(), err.getvalue()

    # -- happy path -------------------------------------------------------

    def test_happy_path_runs_one_job_and_posts_eif_result(self):
        self.api.leases = [lease()]
        runner = self.runner()
        code, out, err = self.run_quiet(runner, max_cycles=1)
        self.assertEqual(code, pairing.EXIT_OK, err)
        self.assertEqual(self.ganglion.hits["completions"], 1)
        self.assertEqual(self.ganglion.hits["chat"], 0)

        sent = self.ganglion.requests["completions"][0]
        self.assertEqual(sent["model"], MODEL)
        self.assertEqual(sent["prompt"], "hello there")
        self.assertEqual(sent["max_tokens"], 16)
        self.assertEqual(sent["temperature"], 0)
        self.assertFalse(sent["stream"])
        self.assertNotIn("tools", sent)

        self.assertEqual(len(self.api.results), 1)
        posted = self.api.results[0]
        self.assertEqual(posted["job_id"], "job_1")
        self.assertEqual(posted["key"], FAKE_SECRET)
        self.assertEqual(set(posted["body"]), {"lease_id", "status", "result"})
        self.assertEqual(posted["body"]["lease_id"], "lease_1")
        self.assertEqual(posted["body"]["status"], "succeeded")
        result = posted["body"]["result"]
        self.assertEqual(set(result), {"request_id", "node_id", "runtime_id", "model_id",
                                       "runtime_instance", "model_fingerprint", "simulated",
                                       "content", "elapsed_ms", "usage", "cache"})
        self.assertEqual(result["request_id"], "job_1")
        self.assertEqual(result["node_id"], FAKE_RESOURCE)
        self.assertEqual(result["runtime_id"], "ganglion")
        self.assertEqual(result["model_id"], MODEL)
        # Echoed from the binding, never invented by the worker.
        self.assertEqual(result["runtime_instance"], RUNTIME_INSTANCE)
        self.assertEqual(result["model_fingerprint"], MODEL_FINGERPRINT)
        self.assertIs(result["simulated"], False)
        self.assertEqual(result["content"], "hello")
        self.assertIsInstance(result["elapsed_ms"], int)
        self.assertGreaterEqual(result["elapsed_ms"], 0)
        self.assertEqual(result["usage"], {"prompt_tokens": 3, "completion_tokens": 2,
                                           "total_tokens": 5})
        self.assertEqual(result["cache"], {})

    def test_api_calls_carry_heartbeat_key_and_product_user_agent(self):
        self.api.leases = [lease()]
        self.run_quiet(self.runner(), max_cycles=1)
        self.assertTrue(self.api.auth_seen)
        self.assertTrue(all(key == FAKE_SECRET for key in self.api.auth_seen))
        self.assertTrue(all(ua == pairing.USER_AGENT for ua in self.api.user_agents))
        self.assertEqual(self.api.results[0]["key"], FAKE_SECRET)

    def test_models_are_cached_briefly(self):
        self.api.leases = [lease("job_1"), lease("job_2", lease_id="lease_2")]
        code, _, err = self.run_quiet(self.runner(), max_cycles=2)
        self.assertEqual(code, pairing.EXIT_OK, err)
        self.assertEqual(self.ganglion.hits["completions"], 2)
        self.assertEqual(self.ganglion.models_hits, 1, "second job reuses the model cache")

    # -- idle polling -----------------------------------------------------

    def test_204_backs_off_between_polls(self):
        sleeps = []
        self.api.next_plan = [(204, None, {}), (204, None, {})]
        self.api.leases = [lease()]
        runner = self.runner(sleep=sleeps.append)
        code, _, err = self.run_quiet(runner, max_cycles=3)
        self.assertEqual(code, pairing.EXIT_OK, err)
        self.assertEqual(len(self.api.results), 1)
        self.assertGreaterEqual(len(sleeps), 2)
        self.assertGreaterEqual(sleeps[0], 0.005)
        self.assertGreaterEqual(sleeps[1], sleeps[0], "idle waits grow instead of hot-looping")
        self.assertGreaterEqual(self.api.next_hits, 3)

    def test_retry_after_on_204_is_honored(self):
        sleeps = []
        self.api.next_plan = [(204, None, {"Retry-After": "7"})]
        self.api.leases = [lease()]
        runner = self.runner(sleep=sleeps.append)
        code, _, err = self.run_quiet(runner, max_cycles=2)
        self.assertEqual(code, pairing.EXIT_OK, err)
        self.assertGreaterEqual(sleeps[0], 7)
        self.assertEqual(len(self.api.results), 1)

    def test_429_is_retried_after_retry_after(self):
        sleeps = []
        self.api.next_plan = [(429, {"code": "RATE_LIMITED", "error": "slow down"},
                               {"Retry-After": "5"})]
        self.api.leases = [lease()]
        runner = self.runner(sleep=sleeps.append)
        code, _, err = self.run_quiet(runner, max_cycles=2)
        self.assertEqual(code, pairing.EXIT_OK, err)
        self.assertGreaterEqual(sleeps[0], 5)
        self.assertEqual(len(self.api.results), 1)

    # -- revoked key ------------------------------------------------------

    def test_revoked_key_stops_with_repair_required(self):
        self.api.live_keys = set()
        code, _, err = self.run_quiet(self.runner(), max_cycles=1)
        self.assertEqual(code, pairing.EXIT_REPAIR_REQUIRED)
        self.assertIn("KEY_REVOKED", err)
        self.assertEqual(self.ganglion.hits["completions"], 0)
        self.assertEqual(self.api.results, [])

    def test_forbidden_key_stops_with_repair_required(self):
        self.api.next_plan = [(403, {"code": "KEY_REVOKED", "error": "revoked"}, {})]
        code, _, err = self.run_quiet(self.runner(), max_cycles=1)
        self.assertEqual(code, pairing.EXIT_REPAIR_REQUIRED)
        self.assertIn("KEY_REVOKED", err)

    def test_revoked_key_at_result_post_stops_with_repair_required(self):
        self.api.leases = [lease()]
        self.api.result_plan = [(401, {"code": "KEY_REVOKED", "error": "revoked"})]
        code, _, err = self.run_quiet(self.runner(), max_cycles=1)
        self.assertEqual(code, pairing.EXIT_REPAIR_REQUIRED)
        self.assertEqual(self.ganglion.hits["completions"], 1)

    # -- strict envelope validation --------------------------------------

    def assert_envelope_rejected(self, frame, detail):
        before = len(self.api.results)
        self.api.leases = [frame]
        code, out, err = self.run_quiet(self.runner(), max_cycles=1)
        self.assertEqual(code, pairing.EXIT_OK, err)
        self.assertEqual(self.ganglion.hits["completions"], 0,
                         "a rejected envelope never reaches Ganglion")
        self.assertEqual(len(self.api.results), before + 1)
        body = self.api.results[-1]["body"]
        self.assertEqual(body["status"], "failed")
        result = body["result"]
        self.assertEqual(set(result) - {"reason", "detail", "elapsed_ms", "usage", "cache"},
                         set(), "a failed result carries no EIF identity fields")
        self.assertEqual(result["reason"], "ENVELOPE_INVALID")
        self.assertEqual(result.get("detail"), detail)
        for forbidden in ("request_id", "node_id", "runtime_id", "model_id",
                          "simulated", "content"):
            self.assertNotIn(forbidden, result)
        return result

    def test_rejects_flat_envelope(self):
        # The pre-Addendum-A flat envelope is gone: no dual format.
        self.assert_envelope_rejected(lease(env=task()), "protocol")

    def test_rejects_wrong_protocol(self):
        self.assert_envelope_rejected(
            lease(env=envelope(protocol="aipster-bound-cpu-internal/2")), "protocol")

    def test_rejects_unknown_envelope_field(self):
        self.assert_envelope_rejected(lease(env=envelope(authenticated=True)),
                                      "unknown_field")

    def test_rejects_unknown_task_field(self):
        self.assert_envelope_rejected(
            lease(env=envelope(task_body=task(authenticated=True))), "task_field")

    def test_rejects_non_object_task(self):
        self.assert_envelope_rejected(lease(env=envelope(task_body="complete")), "task")

    def test_rejects_missing_binding(self):
        env = envelope()
        del env["binding"]
        self.assert_envelope_rejected(lease(env=env), "binding")

    def test_rejects_non_object_binding(self):
        self.assert_envelope_rejected(lease(env=envelope(binding_body="binding")), "binding")

    def test_rejects_unknown_binding_field(self):
        self.assert_envelope_rejected(
            lease(env=envelope(binding_body=binding(extra="x"))), "binding_field")

    def test_rejects_missing_binding_field(self):
        inner = binding()
        del inner["model_fingerprint"]
        self.assert_envelope_rejected(lease(env=envelope(binding_body=inner)),
                                      "binding_field")

    def test_rejects_malformed_binding_value(self):
        for inner in (binding(op_id=""), binding(generation=0),
                      binding(runtime_instance=""), binding(model_fingerprint=None)):
            with self.subTest(binding=inner):
                self.assert_envelope_rejected(
                    lease(env=envelope(binding_body=inner)), "binding_value")

    def test_rejects_foreign_resource(self):
        self.assert_envelope_rejected(
            lease(env=envelope(task_body=task(node_id="r_someone_else"))), "node_id")

    def test_rejects_wrong_runtime(self):
        self.assert_envelope_rejected(
            lease(env=envelope(task_body=task(runtime_id="eif-llama"))), "runtime_id")

    def test_rejects_gpu_placement(self):
        env = envelope(task_body=task(placement={"device": "gpu", "node_id": FAKE_RESOURCE,
                                                  "runtime_id": "ganglion"}))
        self.assert_envelope_rejected(lease(env=env), "device")

    def test_rejects_extra_placement_field(self):
        env = envelope(task_body=task(placement={"device": "cpu", "node_id": FAKE_RESOURCE,
                                                  "runtime_id": "ganglion",
                                                  "gpu_index": 0}))
        self.assert_envelope_rejected(lease(env=env), "placement")

    def test_rejects_unknown_capability(self):
        self.assert_envelope_rejected(
            lease(env=envelope(task_body=task(capability="summarize"))), "capability")

    def test_rejects_oversized_max_tokens(self):
        self.assert_envelope_rejected(
            lease(env=envelope(task_body=task(max_tokens=4097))), "max_tokens")

    def test_rejects_non_integer_max_tokens(self):
        self.assert_envelope_rejected(
            lease(env=envelope(task_body=task(max_tokens="16"))), "max_tokens")

    def test_rejects_empty_prompt(self):
        self.assert_envelope_rejected(
            lease(env=envelope(task_body=task(prompt="   "))), "prompt")

    def test_rejects_nonzero_temperature(self):
        self.assert_envelope_rejected(
            lease(env=envelope(task_body=task(temperature=0.7))), "temperature")

    def test_rejects_missing_temperature(self):
        body = task()
        del body["temperature"]
        self.assert_envelope_rejected(lease(env=envelope(task_body=body)), "temperature")

    def test_rejects_simulated_allowance(self):
        self.assert_envelope_rejected(
            lease(env=envelope(task_body=task(allow_simulated=True))), "allow_simulated")

    def test_rejects_missing_simulated_flag(self):
        body = task()
        del body["allow_simulated"]
        self.assert_envelope_rejected(lease(env=envelope(task_body=body)), "allow_simulated")

    def test_rejects_missing_idempotency_key(self):
        body = task()
        del body["idempotency_key"]
        self.assert_envelope_rejected(lease(env=envelope(task_body=body)), "idempotency_key")

    def test_rejects_past_deadline(self):
        self.assert_envelope_rejected(lease(deadline_ms=now_ms() - 1000), "deadline")

    def test_rejects_binding_deadline_mismatch(self):
        env = envelope(binding_body=binding(now_ms() + 90000))
        self.assert_envelope_rejected(lease(env=env, deadline_ms=now_ms() + 60000),
                                      "deadline")

    def test_rejects_non_integer_binding_deadline(self):
        env = envelope(binding_body=binding(deadline_ms="2026-11-01T19:00:00.000Z"))
        self.assert_envelope_rejected(lease(env=env, deadline_ms=now_ms() + 60000),
                                      "deadline")

    def test_accepts_coordinator_envelope_and_echoes_binding(self):
        deadline = now_ms() + 60000
        env = envelope(deadline_ms=deadline)
        self.api.leases = [lease(env=env, deadline_ms=deadline)]
        code, _, err = self.run_quiet(self.runner(), max_cycles=1)
        self.assertEqual(code, pairing.EXIT_OK, err)
        body = self.api.results[0]["body"]
        self.assertEqual(body["status"], "succeeded")
        self.assertEqual(body["result"]["runtime_instance"], RUNTIME_INSTANCE)
        self.assertEqual(body["result"]["model_fingerprint"], MODEL_FINGERPRINT)

    # -- coordinator wire contract ---------------------------------------

    def test_posted_reports_pass_l2_worker_result_validation(self):
        """The real coordinator envelope, held to L2's exact result rules.

        The lease frames below carry the envelope literal the coordinator
        builds at website/src/inference/dispatch-coordinator.mjs ~L331 on
        branch ds/inference-routes-20261101 @ 9f2fc29: TRANSPORT_PROTOCOL +
        encodeBoundCpuTask({modelId, prompt, maxTokens, operationKey},
        {device:'cpu', nodeId, runtimeId}) + the internal binding. Both a
        succeeded and a failed report must pass
        validateWorkerResultReport (website/src/inference/worker-transport.mjs
        L74-97), whose rules are mirrored above.
        """
        deadline = now_ms() + 60000
        coordinator_envelope = {
            "protocol": "aipster-bound-cpu-internal/1",
            "task": {
                "capability": "complete",
                "model_id": "qwen3-27b",
                "prompt": "hello there",
                "max_tokens": 16,
                "temperature": 0,
                "allow_simulated": False,
                "idempotency_key": "dispatch-op-000001",
                "placement": {"device": "cpu", "node_id": "r_fake01",
                              "runtime_id": "ganglion"},
            },
            "binding": {
                "op_id": "dispatch-op-000001",
                "generation": 1,
                "runtime_instance": "ganglion-instance-0001",
                "model_fingerprint": "sha256:0f1e2d3c4b5a69788796a5b4c3d2e1f0",
                "deadline_at": deadline,
            },
        }
        unlisted = copy.deepcopy(coordinator_envelope)
        unlisted["task"]["model_id"] = "qwen-not-there"

        self.api.leases = [
            {"job_id": "dispatch-job-000001", "lease_id": "lease-000001",
             "envelope": coordinator_envelope, "deadline_at": deadline},
            {"job_id": "dispatch-job-000002", "lease_id": "lease-000002",
             "envelope": unlisted, "deadline_at": deadline},
        ]
        code, _, err = self.run_quiet(self.runner(), max_cycles=2)
        self.assertEqual(code, pairing.EXIT_OK, err)
        self.assertEqual([entry["body"]["status"] for entry in self.api.results],
                         ["succeeded", "failed"])

        succeeded = self.api.results[0]["body"]
        failed = self.api.results[1]["body"]
        self.assertIsNone(validate_worker_result_report(succeeded),
                          "L2 would reject the succeeded report")
        self.assertIsNone(validate_worker_result_report(failed),
                          "L2 would reject the failed report")
        self.assertEqual(succeeded["lease_id"], "lease-000001")
        self.assertEqual(set(succeeded["result"]), {
            "request_id", "node_id", "runtime_id", "model_id", "runtime_instance",
            "model_fingerprint", "simulated", "content", "elapsed_ms", "usage", "cache"})
        self.assertEqual(succeeded["result"]["runtime_instance"],
                         "ganglion-instance-0001")
        self.assertEqual(succeeded["result"]["model_fingerprint"],
                         "sha256:0f1e2d3c4b5a69788796a5b4c3d2e1f0")
        self.assertEqual(set(failed["result"]) - FAILED_ALLOWED, set())
        self.assertEqual(failed["result"]["reason"], "MODEL_UNAVAILABLE")

    def test_malformed_lease_frame_cannot_be_reported_and_stops(self):
        frame = lease()
        del frame["lease_id"]
        self.api.leases = [frame]
        code, _, err = self.run_quiet(self.runner(), max_cycles=1)
        self.assertEqual(code, pairing.EXIT_USAGE)
        self.assertEqual(self.ganglion.hits["completions"], 0)
        self.assertEqual(self.api.results, [])

    def test_unknown_lease_frame_field_is_tolerated(self):
        # The lease frame is server-issued; only the envelope it carries is
        # the strict boundary. Extra bookkeeping fields must not fail a job.
        frame = lease()
        frame["resource_id"] = FAKE_RESOURCE
        self.api.leases = [frame]
        code, _, err = self.run_quiet(self.runner(), max_cycles=1)
        self.assertEqual(code, pairing.EXIT_OK, err)
        self.assertEqual(self.api.results[0]["body"]["status"], "succeeded")

    # -- Ganglion model gate and failures --------------------------------

    def test_unlisted_model_fails_without_calling_completions(self):
        self.api.leases = [lease(env=envelope(task_body=task(model="qwen-not-there")))]
        code, _, err = self.run_quiet(self.runner(), max_cycles=1)
        self.assertEqual(code, pairing.EXIT_OK, err)
        self.assertEqual(self.ganglion.hits["completions"], 0)
        self.assertEqual(self.ganglion.models_hits, 1)
        body = self.api.results[0]["body"]
        self.assertEqual(body["status"], "failed")
        result = body["result"]
        self.assertEqual(set(result) - {"reason", "detail", "elapsed_ms", "usage", "cache"},
                         set(), "a failed result carries no EIF identity fields")
        self.assertEqual(result["reason"], "MODEL_UNAVAILABLE")
        self.assertNotIn("model_id", result)
        self.assertNotIn("content", result)

    def test_unreachable_model_list_fails_closed(self):
        self.ganglion.models_status = 500
        self.api.leases = [lease()]
        code, _, err = self.run_quiet(self.runner(), max_cycles=1)
        self.assertEqual(code, pairing.EXIT_OK, err)
        self.assertEqual(self.ganglion.hits["completions"], 0)
        self.assertEqual(self.api.results[0]["body"]["result"]["reason"],
                         "GANGLION_UNAVAILABLE")

    def test_ganglion_500_fails_without_retry(self):
        self.ganglion.completion_status = 500
        self.ganglion.completion_body = {"error": "boom"}
        self.api.leases = [lease()]
        code, _, err = self.run_quiet(self.runner(), max_cycles=1)
        self.assertEqual(code, pairing.EXIT_OK, err)
        self.assertEqual(self.ganglion.hits["completions"], 1, "no retries")
        body = self.api.results[0]["body"]
        self.assertEqual(body["status"], "failed")
        self.assertEqual(body["result"]["reason"], "GANGLION_HTTP_ERROR")
        self.assertNotIn("content", body["result"])

    def test_ganglion_timeout_fails_without_retry(self):
        self.ganglion.completion_delay = 2.0
        self.api.leases = [lease(deadline_ms=now_ms() + 300)]
        started = time.monotonic()
        code, _, err = self.run_quiet(self.runner(), max_cycles=1)
        elapsed = time.monotonic() - started
        self.assertEqual(code, pairing.EXIT_OK, err)
        self.assertLess(elapsed, 1.8, "the request is bounded by the job deadline")
        self.assertEqual(self.ganglion.hits["completions"], 1, "no retries")
        body = self.api.results[0]["body"]
        self.assertEqual(body["status"], "failed")
        self.assertEqual(body["result"]["reason"], "GANGLION_TIMEOUT")

    def test_empty_content_never_claims_success(self):
        self.ganglion.completion_body = completion_body(text="   ")
        self.api.leases = [lease()]
        code, _, err = self.run_quiet(self.runner(), max_cycles=1)
        self.assertEqual(code, pairing.EXIT_OK, err)
        body = self.api.results[0]["body"]
        self.assertEqual(body["status"], "failed")
        self.assertEqual(body["result"]["reason"], "EMPTY_CONTENT")
        self.assertNotIn("content", body["result"])

    def test_missing_choices_is_an_invalid_response(self):
        self.ganglion.completion_body = {"object": "text_completion", "choices": []}
        self.api.leases = [lease()]
        code, _, err = self.run_quiet(self.runner(), max_cycles=1)
        self.assertEqual(code, pairing.EXIT_OK, err)
        self.assertEqual(self.api.results[0]["body"]["result"]["reason"],
                         "GANGLION_INVALID_RESPONSE")
        self.assertEqual(self.ganglion.hits["completions"], 1)

    def test_404_completions_falls_back_to_chat_once(self):
        self.ganglion.completion_status = 404
        self.ganglion.completion_body = {"error": "no route"}
        self.api.leases = [lease()]
        code, _, err = self.run_quiet(self.runner(), max_cycles=1)
        self.assertEqual(code, pairing.EXIT_OK, err)
        self.assertEqual(self.ganglion.hits["completions"], 1)
        self.assertEqual(self.ganglion.hits["chat"], 1)
        sent = self.ganglion.requests["chat"][0]
        self.assertEqual(sent["messages"], [{"role": "user", "content": "hello there"}])
        self.assertEqual(sent["temperature"], 0)
        self.assertFalse(sent["stream"])
        self.assertEqual(self.api.results[0]["body"]["status"], "succeeded")
        self.assertEqual(self.api.results[0]["body"]["result"]["content"], "hello")

    def test_500_does_not_fall_back_to_chat(self):
        self.ganglion.completion_status = 500
        self.ganglion.completion_body = {"error": "boom"}
        self.api.leases = [lease()]
        self.run_quiet(self.runner(), max_cycles=1)
        self.assertEqual(self.ganglion.hits["chat"], 0)

    # -- started-job ledger ---------------------------------------------

    def test_started_job_is_never_executed_twice(self):
        self.api.leases = [lease()]
        self.api.result_plan = [(500, {"error": "store down"})]
        code, _, err = self.run_quiet(self.runner(), max_cycles=1)
        self.assertEqual(code, pairing.EXIT_OK, err)
        self.assertEqual(self.ganglion.hits["completions"], 1)
        self.assertEqual(len(self.api.results), 1)

        # A restart after the unconfirmed post re-reads the ledger.
        self.assertTrue(StartedLedger(self.data).contains("job_1"))
        self.api.leases = [lease()]
        code, _, err = self.run_quiet(self.runner(), max_cycles=1)
        self.assertEqual(code, pairing.EXIT_OK, err)
        self.assertEqual(self.ganglion.hits["completions"], 1,
                         "an already-started job is never re-executed")
        self.assertEqual(len(self.api.results), 1,
                         "nothing is posted for an already-started job")

    def test_second_runner_exits_jobs_running(self):
        guard = inference_worker._hold_lock(self.data, inference_worker.JOBS_LOCK_NAME)
        self.assertIsNotNone(guard)
        self.addCleanup(guard.release)
        code, _, err = self.run_quiet(self.runner(), max_cycles=1)
        self.assertEqual(code, pairing.EXIT_SENDER_RUNNING)
        self.assertIn("JOBS_RUNNING", err)
        self.assertEqual(self.api.next_hits, 0, "a second runner does not poll")

    def test_prerecorded_job_is_refused(self):
        ledger = StartedLedger(self.data)
        ledger.record("job_1")
        self.assertTrue(StartedLedger(self.data).contains("job_1"))
        self.api.leases = [lease()]
        code, _, err = self.run_quiet(self.runner(), max_cycles=1)
        self.assertEqual(code, pairing.EXIT_OK, err)
        self.assertEqual(self.ganglion.hits["completions"], 0)
        self.assertEqual(self.api.results, [])

    def test_ledger_is_private_and_holds_no_credential(self):
        self.api.leases = [lease()]
        self.run_quiet(self.runner(), max_cycles=1)
        ledger_path = self.data / inference_worker.STARTED_LEDGER_NAME
        self.assertTrue(ledger_path.exists())
        text = ledger_path.read_text(encoding="utf-8")
        self.assertIn("job_1", text)
        self.assertNotIn(FAKE_SECRET, text)
        pairing.check_private_store(self.data)

    def test_corrupt_ledger_fails_closed(self):
        (self.data / inference_worker.STARTED_LEDGER_NAME).write_text(
            "{not json", encoding="utf-8")
        self.api.leases = [lease()]
        code, _, err = self.run_quiet(self.runner(), max_cycles=1)
        self.assertEqual(code, pairing.EXIT_USAGE)
        self.assertEqual(self.ganglion.hits["completions"], 0)
        self.assertIn("BAD_JOB_LEDGER", err)

    # -- result post edge cases ------------------------------------------

    def test_conflicting_result_is_not_retried(self):
        self.api.leases = [lease()]
        self.api.result_plan = [(409, {"code": "LEASE_MISMATCH", "error": "late"})]
        code, _, err = self.run_quiet(self.runner(), max_cycles=1)
        self.assertEqual(code, pairing.EXIT_OK, err)
        self.assertEqual(len(self.api.results), 1)
        self.assertIn("409", err)

    # -- secrets ---------------------------------------------------------

    def test_key_never_appears_in_output(self):
        self.api.leases = [lease()]
        code, out, err = self.run_quiet(self.runner(), max_cycles=1)
        self.assertEqual(code, pairing.EXIT_OK, err)
        self.api.leases = [lease("job_2", "lease_2",
                                 env=envelope(task_body=task(model="qwen-not-there")))]
        code, out2, err2 = self.run_quiet(self.runner(), max_cycles=1)
        self.assertEqual(code, pairing.EXIT_OK, err2)
        self.api.leases = [lease("job_3", "lease_3",
                                 env=envelope(task_body=task(node_id="r_foreign")))]
        code, out3, err3 = self.run_quiet(self.runner(), max_cycles=1)
        self.assertEqual(code, pairing.EXIT_OK, err3)
        self.assertEqual([r["body"]["status"] for r in self.api.results],
                         ["succeeded", "failed", "failed"])
        combined = out + err + out2 + err2 + out3 + err3
        self.assertNotIn(FAKE_SECRET, combined)
        posted = json.dumps([entry["body"] for entry in self.api.results])
        self.assertNotIn(FAKE_SECRET, posted, "the key never rides in a result body")
        self.assertNotIn("hello there", out + err, "prompt is not echoed to logs")

    # -- transport policy ------------------------------------------------

    def test_non_loopback_ganglion_base_is_refused_without_flag(self):
        with self.assertRaises(pairing.PairingError) as cm:
            check_ganglion_base("http://192.168.1.203:8471")
        self.assertEqual(cm.exception.code, "BAD_GANGLION_BASE")
        self.assertEqual(check_ganglion_base("http://192.168.1.203:8471",
                                             allow_non_loopback=True),
                         "http://192.168.1.203:8471")
        self.assertEqual(check_ganglion_base("http://127.0.0.1:8471/"), "http://127.0.0.1:8471")
        with self.assertRaises(pairing.PairingError):
            check_ganglion_base("http://user:pw@127.0.0.1:8471")

    def test_runner_refuses_non_loopback_before_polling(self):
        with self.assertRaises(pairing.PairingError):
            JobRunner(self.data, ganglion_base="http://10.1.2.3:8471")
        self.assertEqual(self.api.next_hits, 0)

    # -- CLI wiring ------------------------------------------------------

    def test_cli_serve_jobs_once(self):
        self.api.leases = [lease()]
        out = StringIO()
        with redirect_stdout(out):
            code = pairing.main(["--data-dir", str(self.data), "serve-jobs", "--once",
                                 "--ganglion-base", self.gbase, "--interval", "0.01"])
        self.assertEqual(code, pairing.EXIT_OK)
        self.assertIn("succeeded posted", out.getvalue())
        self.assertNotIn(FAKE_SECRET, out.getvalue())
        self.assertEqual(self.ganglion.hits["completions"], 1)
        self.assertEqual(self.api.results[0]["body"]["status"], "succeeded")

    def test_cli_refuses_non_loopback_ganglion_base(self):
        err = StringIO()
        with redirect_stderr(err):
            code = pairing.main(["--data-dir", str(self.data), "serve-jobs", "--once",
                                 "--ganglion-base", "http://192.168.1.203:8471"])
        self.assertEqual(code, pairing.EXIT_USAGE)
        self.assertIn("BAD_GANGLION_BASE", err.getvalue())
        self.assertEqual(self.api.next_hits, 0)


if __name__ == "__main__":
    unittest.main()

"""Inference job runner tests. Stdlib only; no venv needed.

Two fake in-thread HTTP servers stand in for the AIPSTER worker job routes
and the local Ganglion OpenAI-compatible surface. Everything is loopback
and synthetic: no live Ganglion, no AIPSTER network, no model load, no
inference. Pairing credentials are synthetic fixtures stored in a
throwaway private data dir.

Shapes under test:
  GET  /api/worker/jobs/next            -> 204 | {job_id, lease_id, envelope, deadline_at}
  POST /api/worker/jobs/:job_id/result  -> {lease_id, status, result}
  GET  /v1/models                       -> {object: 'list', data: [{id}]}
  POST /v1/completions                  -> OpenAI text_completion
  POST /v1/chat/completions             -> OpenAI chat.completion (fallback only)
"""
import json
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


def now_ms():
    return int(time.time() * 1000)


def envelope(model=MODEL, prompt="hello there", max_tokens=16,
             node_id=FAKE_RESOURCE, runtime_id="ganglion", **over):
    env = {
        "capability": "complete",
        "model_id": model,
        "prompt": prompt,
        "max_tokens": max_tokens,
        "temperature": 0,
        "allow_simulated": False,
        "idempotency_key": "op_0123456789abcdef",
        "placement": {"device": "cpu", "node_id": node_id, "runtime_id": runtime_id},
    }
    env.update(over)
    return env


def lease(job_id="job_1", lease_id="lease_1", env=None, deadline_ms=None):
    return {
        "job_id": job_id,
        "lease_id": lease_id,
        "envelope": envelope() if env is None else env,
        "deadline_at": now_ms() + 60000 if deadline_ms is None else deadline_ms,
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
                                       "simulated", "content", "elapsed_ms", "usage", "cache"})
        self.assertEqual(result["request_id"], "job_1")
        self.assertEqual(result["node_id"], FAKE_RESOURCE)
        self.assertEqual(result["runtime_id"], "ganglion")
        self.assertEqual(result["model_id"], MODEL)
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
        code, out, err = self.run_quiet(self.runner(), max_cycles=1)
        self.assertEqual(code, pairing.EXIT_OK, err)
        self.assertEqual(self.ganglion.hits["completions"], 0,
                         "a rejected envelope never reaches Ganglion")
        self.assertEqual(len(self.api.results), before + 1)
        body = self.api.results[-1]["body"]
        self.assertEqual(body["status"], "failed")
        self.assertEqual(body["result"]["reason"], "ENVELOPE_INVALID")
        self.assertEqual(body["result"].get("detail"), detail)
        self.assertIs(body["result"]["simulated"], False)
        self.assertNotIn("content", body["result"])
        return body["result"]

    def test_rejects_foreign_resource(self):
        env = envelope(node_id="r_someone_else")
        self.assert_envelope_rejected(lease(env=env), "node_id")

    def test_rejects_wrong_runtime(self):
        env = envelope(runtime_id="eif-llama")
        self.assert_envelope_rejected(lease(env=env), "runtime_id")

    def test_rejects_gpu_placement(self):
        env = envelope(placement={"device": "gpu", "node_id": FAKE_RESOURCE,
                                  "runtime_id": "ganglion"})
        self.assert_envelope_rejected(lease(env=env), "device")

    def test_rejects_extra_placement_field(self):
        env = envelope(placement={"device": "cpu", "node_id": FAKE_RESOURCE,
                                  "runtime_id": "ganglion", "gpu_index": 0})
        self.assert_envelope_rejected(lease(env=env), "placement")

    def test_rejects_unknown_envelope_field(self):
        env = envelope(authenticated=True)
        self.assert_envelope_rejected(lease(env=env), "unknown_field")

    def test_rejects_unknown_capability(self):
        env = envelope(capability="summarize")
        self.assert_envelope_rejected(lease(env=env), "capability")

    def test_rejects_oversized_max_tokens(self):
        env = envelope(max_tokens=4097)
        self.assert_envelope_rejected(lease(env=env), "max_tokens")

    def test_rejects_non_integer_max_tokens(self):
        env = envelope(max_tokens="16")
        self.assert_envelope_rejected(lease(env=env), "max_tokens")

    def test_rejects_empty_prompt(self):
        env = envelope(prompt="   ")
        self.assert_envelope_rejected(lease(env=env), "prompt")

    def test_rejects_nonzero_temperature(self):
        env = envelope(temperature=0.7)
        self.assert_envelope_rejected(lease(env=env), "temperature")

    def test_rejects_simulated_allowance(self):
        env = envelope(allow_simulated=True)
        self.assert_envelope_rejected(lease(env=env), "allow_simulated")

    def test_rejects_missing_idempotency_key(self):
        env = envelope()
        del env["idempotency_key"]
        self.assert_envelope_rejected(lease(env=env), "idempotency_key")

    def test_rejects_past_deadline(self):
        self.assert_envelope_rejected(lease(deadline_ms=now_ms() - 1000), "deadline")

    def test_rejects_binding_deadline_mismatch(self):
        env = envelope(binding={"op_id": "op_1", "generation": 1,
                                "deadline_at": now_ms() + 90000})
        self.assert_envelope_rejected(lease(env=env, deadline_ms=now_ms() + 60000),
                                      "deadline")

    def test_accepts_documented_binding(self):
        deadline = now_ms() + 60000
        env = envelope(binding={"op_id": "op_1", "generation": 1,
                                "runtime_instance": "ganglion@local",
                                "model_fingerprint": "sha256:abc",
                                "deadline_at": deadline})
        self.api.leases = [lease(env=env, deadline_ms=deadline)]
        code, _, err = self.run_quiet(self.runner(), max_cycles=1)
        self.assertEqual(code, pairing.EXIT_OK, err)
        self.assertEqual(self.api.results[0]["body"]["status"], "succeeded")

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
        self.api.leases = [lease(env=envelope(model="qwen-not-there"))]
        code, _, err = self.run_quiet(self.runner(), max_cycles=1)
        self.assertEqual(code, pairing.EXIT_OK, err)
        self.assertEqual(self.ganglion.hits["completions"], 0)
        self.assertEqual(self.ganglion.models_hits, 1)
        body = self.api.results[0]["body"]
        self.assertEqual(body["status"], "failed")
        self.assertEqual(body["result"]["reason"], "MODEL_UNAVAILABLE")
        self.assertIs(body["result"]["simulated"], False)
        self.assertNotIn("content", body["result"])

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
        self.api.leases = [lease("job_2", "lease_2", env=envelope(model="qwen-not-there"))]
        code, out2, err2 = self.run_quiet(self.runner(), max_cycles=1)
        self.assertEqual(code, pairing.EXIT_OK, err2)
        self.api.leases = [lease("job_3", "lease_3", env=envelope(node_id="r_foreign"))]
        code, out3, err3 = self.run_quiet(self.runner(), max_cycles=1)
        self.assertEqual(code, pairing.EXIT_OK, err3)
        self.assertEqual([r["body"]["status"] for r in self.api.results],
                         ["succeeded", "failed", "failed"])
        combined = out + err + out2 + err2 + out3 + err3
        self.assertNotIn(FAKE_SECRET, combined)
        self.assertNotIn(FAKE_SECRET, json.dumps(self.api.results))
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
        code = pairing.main(["--data-dir", str(self.data), "serve-jobs", "--once",
                             "--ganglion-base", self.gbase, "--interval", "0.01"])
        self.assertEqual(code, pairing.EXIT_OK)
        self.assertEqual(self.ganglion.hits["completions"], 1)
        self.assertEqual(self.api.results[0]["body"]["status"], "succeeded")

    def test_cli_refuses_non_loopback_ganglion_base(self):
        code = pairing.main(["--data-dir", str(self.data), "serve-jobs", "--once",
                             "--ganglion-base", "http://192.168.1.203:8471"])
        self.assertEqual(code, pairing.EXIT_USAGE)
        self.assertEqual(self.api.next_hits, 0)


if __name__ == "__main__":
    unittest.main()

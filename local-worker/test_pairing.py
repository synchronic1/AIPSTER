"""Worker pairing/heartbeat sender tests. Stdlib only; no venv needed.

A fake in-thread HTTP server stands in for the AIPSTER API (protocol
shapes per docs/pairing.md); the true cross-language exchange against the
real worker.js is covered by test_pairing_e2e.py. All codes/keys are
synthetic fixtures. Never touches a real data dir or network host.
"""
import io
import json
import os
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stdout, redirect_stderr
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import pairing
from pairing import (PairingError, RePairRequired, check_api_base,
                     decide_usable, load_or_create_node_id, probe_hardware,
                     claim, send_heartbeat, load_pairing, cmd_heartbeat,
                     EXIT_OK, EXIT_USAGE, EXIT_REPAIR_REQUIRED)

FAKE_CODE = "pair-01234567-89AB-CDEF-GHJKMNPQ"[:27]
FAKE_SECRET = "synthetic-heartbeat-key-0123456789abcdef"


class FakeApiState:
    def __init__(self):
        self.claims = []
        self.beats = []
        self.claim_status = 201
        self.claim_body = None
        self.beat_plan = []  # list of (status, body, retry_after)
        self.live_keys = {FAKE_SECRET}
        self.claim_hook = None  # optional fn(body) -> claim payload (per-claim keys)


def make_server(state):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, status, body, retry_after=None):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            if retry_after is not None:
                self.send_header("Retry-After", str(retry_after))
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            try:
                body = json.loads(raw.decode())
            except ValueError:
                body = {}
            if self.path == "/api/pairing/claim":
                state.claims.append(body)
                if state.claim_hook is not None:
                    payload = dict(state.claim_hook(body))
                else:
                    payload = dict(state.claim_body or {})
                payload.setdefault("resourceId", "r_fake01")
                payload.setdefault("heartbeatKey", FAKE_SECRET)
                payload.setdefault("keyId", "k_fake01")
                payload.setdefault("keyPrefix", "aip_live_k_fake01_synthe")
                payload.setdefault("heartbeatUrl", "/api/resources/r_fake01/heartbeat")
                payload.setdefault("created", True)
                self._send(state.claim_status, payload)
            elif self.path.endswith("/heartbeat"):
                secret = (self.headers.get("Authorization") or "").replace("Bearer ", "")
                state.beats.append({"usable": body.get("usable"), "key": secret})
                if state.beat_plan:
                    status, payload, retry = state.beat_plan.pop(0)
                elif secret not in state.live_keys:
                    status, payload, retry = 401, {"error": "revoked", "code": "KEY_REVOKED"}, None
                else:
                    status, payload, retry = 200, {"ok": True, "heartbeatAt": "2026-10-29T00:00:00.000Z",
                                                  "online": True, "usable": body.get("usable")}, None
                self._send(status, payload, retry)
            else:
                self._send(404, {"error": "no", "code": "NOT_FOUND"})

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, f"http://127.0.0.1:{server.server_port}"


class PairingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data = Path(self.tmp.name) / "data"
        self.state = FakeApiState()
        self.server, self.base = make_server(self.state)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def pair_args(self, **kw):
        args = {"api_base": self.base, "data_dir": str(self.data),
                "config": None, "name": None, "code": FAKE_CODE}
        args.update(kw)
        return argparse_namespace(args)

    def test_api_base_policy(self):
        self.assertEqual(check_api_base("https://aipster.net/"), "https://aipster.net")
        self.assertEqual(check_api_base("http://127.0.0.1:9/"), "http://127.0.0.1:9")
        self.assertEqual(check_api_base("http://localhost:9"), "http://localhost:9")
        for bad in ("http://aipster.net", "http://192.168.1.1:9", "ftp://x",
                    "https://user:pw@aipster.net", "not-a-url"):
            with self.subTest(bad=bad), self.assertRaises(PairingError) as cm:
                check_api_base(bad)
            self.assertEqual(cm.exception.code, "BAD_API_BASE")

    def test_node_id_stable_and_private(self):
        first = load_or_create_node_id(self.data / "state")
        second = load_or_create_node_id(self.data / "state")
        self.assertEqual(first, second)
        self.assertRegex(first, r"^[A-Za-z0-9_-]{1,64}$")
        node_file = self.data / "state" / "node-id"
        if os.name != "nt":
            mode = stat.S_IMODE(node_file.stat().st_mode)
            self.assertEqual(mode, 0o600, oct(mode))
        node_file.write_text("has spaces!")
        with self.assertRaises(PairingError) as cm:
            load_or_create_node_id(self.data / "state")
        self.assertEqual(cm.exception.code, "BAD_NODE_ID")

    def test_pair_stores_private_credential_and_prints_no_secret(self):
        out, err, code = run_cli("pair", self.pair_args())
        self.assertEqual(code, EXIT_OK, err)
        meta = json.loads((self.data / "pairing.json").read_text())
        self.assertEqual(meta["resource_id"], "r_fake01")
        self.assertNotIn(FAKE_SECRET, json.dumps(meta), "secret must not be in metadata")
        key_file = self.data / meta["key_file"]
        self.assertEqual(key_file.read_text().strip(), FAKE_SECRET)
        if os.name != "nt":
            self.assertEqual(stat.S_IMODE(key_file.stat().st_mode), 0o600)
        self.assertIn("r_fake01", out)
        self.assertNotIn(FAKE_SECRET, out + err, "secret must not be printed")
        # The worker sent discovered hardware, not empty filler.
        sent = self.state.claims[0]
        self.assertEqual(sent["nodeId"], meta["node_id"])
        self.assertIn("name", sent)
        self.assertIn("cpu", sent)

    def test_pair_rejected_maps_server_codes(self):
        for status, code in ((404, "PAIRING_INVALID"), (410, "PAIRING_EXPIRED"),
                             (409, "KEY_LIMIT"), (429, "WRITE_RATE_LIMITED")):
            with self.subTest(status=status):
                self.state.claim_status = status
                self.state.claim_body = {"error": "nope", "code": code}
                with self.assertRaises(PairingError) as cm:
                    claim(self.base, FAKE_CODE, "n_x", {"name": "h"})
                self.assertEqual(cm.exception.code, code)
                self.assertEqual(cm.exception.status, status)

    def test_pair_network_failure_is_network_code(self):
        with self.assertRaises(PairingError) as cm:
            claim("http://127.0.0.1:1", FAKE_CODE, "n_x", {"name": "h"})
        self.assertEqual(cm.exception.code, "NETWORK")

    def test_heartbeat_success_and_status_file(self):
        run_cli("pair", self.pair_args())
        meta = load_pairing(self.data)
        body = send_heartbeat(meta["api_base"], meta["resource_id"], meta["heartbeat_key"], False)
        self.assertTrue(body["ok"])
        self.assertEqual(self.state.beats[0]["usable"], False)

    def test_heartbeat_revoked_key_demands_repair(self):
        run_cli("pair", self.pair_args())
        meta = load_pairing(self.data)
        self.state.live_keys.clear()
        with self.assertRaises(RePairRequired) as cm:
            send_heartbeat(meta["api_base"], meta["resource_id"], meta["heartbeat_key"], True)
        self.assertEqual(cm.exception.code, "KEY_REVOKED")

    def test_heartbeat_rate_limit_carries_retry(self):
        run_cli("pair", self.pair_args())
        meta = load_pairing(self.data)
        self.state.beat_plan.append((429, {"error": "slow", "code": "HEARTBEAT_TOO_SOON",
                                           "retryAfterSec": 7}, "7"))
        with self.assertRaises(PairingError) as cm:
            send_heartbeat(meta["api_base"], meta["resource_id"], meta["heartbeat_key"], False)
        self.assertEqual(cm.exception.code, "HEARTBEAT_TOO_SOON")
        self.assertEqual(cm.exception.retry_after, 7)

    def test_heartbeat_loop_honors_retry_then_succeeds(self):
        run_cli("pair", self.pair_args())
        args = argparse_namespace({"api_base": self.base, "data_dir": str(self.data),
                                   "config": None, "interval": 60})
        limited = PairingError(429, "HEARTBEAT_TOO_SOON", "slow", retry_after=3)
        beats = [limited, {"heartbeatAt": "2026-10-29T00:00:01.000Z"},
                 RePairRequired(401, "KEY_REVOKED", "dead")]
        slept = []
        with patch.object(pairing, "send_heartbeat", side_effect=beats) as mocked, \
                patch.object(pairing.time, "sleep", side_effect=lambda s: slept.append(s)):
            code = cmd_heartbeat(args, loop=True)
        self.assertEqual(code, EXIT_REPAIR_REQUIRED)
        self.assertEqual(mocked.call_count, 3)
        self.assertEqual(slept, [3, 60], "429 retry-after, then the normal interval")
        status = json.loads((self.data / "state" / "heartbeat-status.json").read_text())
        self.assertEqual(status["status"], "repair-required")
        self.assertNotIn(FAKE_SECRET, json.dumps(status))

    def test_decide_usable_defaults_false(self):
        self.assertFalse(decide_usable(None))
        self.assertFalse(decide_usable(str(ROOT / "configs" / "mock.toml")),
                         "mock engine is never usable")
        self.assertFalse(decide_usable(str(ROOT / "configs" / "cpu.toml")),
                         "unverified real engine stays false without model+executable proof")

    def test_probe_hardware_conservative(self):
        hw = probe_hardware()
        for key in ("name", "kind", "cpu", "gpu", "capabilities"):
            self.assertIn(key, hw)
        self.assertEqual(hw["kind"], "local")
        self.assertEqual(hw["capabilities"], [], "no config, no claimed capabilities")
        hw_mock = probe_hardware(str(ROOT / "configs" / "mock.toml"))
        self.assertEqual(hw_mock["capabilities"], [], "mock contributes no capabilities")

    def test_status_and_unpair_are_secret_free(self):
        out, _, code = run_cli("status", argparse_namespace(
            {"api_base": self.base, "data_dir": str(self.data)}))
        self.assertEqual(code, EXIT_OK)
        self.assertIn("not paired", out)
        run_cli("pair", self.pair_args())
        out, _, _ = run_cli("status", argparse_namespace(
            {"api_base": self.base, "data_dir": str(self.data)}))
        self.assertIn("r_fake01", out)
        self.assertNotIn(FAKE_SECRET, out)
        out, _, _ = run_cli("unpair", argparse_namespace(
            {"api_base": self.base, "data_dir": str(self.data)}))
        self.assertIn("revoke the sender key", out, "honest server-side note")
        self.assertFalse((self.data / "pairing.json").exists())
        self.assertFalse((self.data / "heartbeat-key.txt").exists())
        self.assertFalse(list(self.data.glob("heartbeat-key.*.txt")))


class Round2Tests(unittest.TestCase):
    """Codex re-review regressions: store protection, fresh usability,
    transient backoff, per-model capability filtering."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data = Path(self.tmp.name) / "data"
        self.state = FakeApiState()
        self.server, self.base = make_server(self.state)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def pair_args(self, **kw):
        args = {"api_base": self.base, "data_dir": str(self.data),
                "config": None, "name": None, "code": FAKE_CODE}
        args.update(kw)
        return argparse_namespace(args)

    @unittest.skipIf(os.name == "nt", "POSIX permission bits")
    def test_pairing_meta_is_private(self):
        run_cli("pair", self.pair_args())
        self.assertEqual(stat.S_IMODE((self.data / "pairing.json").stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.data.stat().st_mode), 0o700)

    @unittest.skipIf(os.name == "nt", "POSIX permission bits")
    def test_shared_store_is_refused(self):
        run_cli("pair", self.pair_args())
        os.chmod(self.data, 0o777)
        with self.assertRaises(PairingError) as cm:
            load_pairing(self.data)
        self.assertEqual(cm.exception.code, "BAD_PAIRING_STORE")
        os.chmod(self.data, 0o700)
        os.chmod(self.data / "pairing.json", 0o666)
        with self.assertRaises(PairingError):
            load_pairing(self.data)
        os.chmod(self.data / "pairing.json", 0o600)
        meta = load_pairing(self.data)
        self.assertEqual(meta["resource_id"], "r_fake01")

    def test_usable_recomputed_per_beat(self):
        run_cli("pair", self.pair_args())
        args = argparse_namespace({"api_base": self.base, "data_dir": str(self.data),
                                   "config": None, "interval": 60})
        with patch.object(pairing, "decide_usable", side_effect=[False, True, True]) as decided, \
                patch.object(pairing, "send_heartbeat", side_effect=[
                    {"heartbeatAt": "t1"}, {"heartbeatAt": "t2"},
                    RePairRequired(401, "KEY_REVOKED", "dead")]) as sent, \
                patch.object(pairing.time, "sleep"):
            code = cmd_heartbeat(args, loop=True)
        self.assertEqual(code, EXIT_REPAIR_REQUIRED)
        self.assertEqual(decided.call_count, 3, "usability re-evaluated every beat")
        self.assertEqual([c.args[3] for c in sent.call_args_list[:2]], [False, True])

    def test_5xx_backs_off_then_recovers(self):
        run_cli("pair", self.pair_args())
        args = argparse_namespace({"api_base": self.base, "data_dir": str(self.data),
                                   "config": None, "interval": 60})
        slept = []
        with patch.object(pairing, "send_heartbeat", side_effect=[
                PairingError(503, "UPSTREAM", "blip"),
                {"heartbeatAt": "2026-10-29T00:00:01.000Z"},
                RePairRequired(401, "KEY_REVOKED", "dead")]), \
                patch.object(pairing.time, "sleep", side_effect=lambda s: slept.append(s)):
            code = cmd_heartbeat(args, loop=True)
        self.assertEqual(code, EXIT_REPAIR_REQUIRED)
        self.assertEqual(slept, [2, 60], "transient backoff, then the normal interval")

    def test_mixed_config_excludes_mock_and_unknown_caps(self):
        import types
        hw_mod = types.ModuleType("dendrite.hardware")
        hw_mod.discover_hardware = lambda: {"cpu": "stub-cpu", "gpus": []}
        cfg_mod = types.ModuleType("dendrite.config")

        def fake_load(path):
            ns = types.SimpleNamespace
            return ns(runtimes=[ns(id="m", kind="mock"), ns(id="l", kind="llama")],
                      models=[ns(id="mock-summary", runtime="m", capabilities=["summarize"]),
                              ns(id="real-7b", runtime="l", capabilities=["chat"]),
                              ns(id="ghost", runtime="nope", capabilities=["evil"])])
        cfg_mod.load_config = fake_load
        with patch.dict(sys.modules, {"dendrite.hardware": hw_mod, "dendrite.config": cfg_mod}):
            hw = probe_hardware("stub.toml")
        self.assertEqual(hw["capabilities"], ["chat"])
        self.assertEqual(hw["cpu"], "stub-cpu")


    @unittest.skipIf(os.name == "nt", "POSIX permission bits")
    def test_fresh_pair_under_loose_umask_stays_private(self):
        old = os.umask(0o002)
        try:
            out, err, code = run_cli("pair", self.pair_args())
        finally:
            os.umask(old)
        self.assertEqual(code, EXIT_OK, err)
        self.assertEqual(stat.S_IMODE(self.data.stat().st_mode), 0o700)
        meta = load_pairing(self.data)
        self.assertEqual(meta["resource_id"], "r_fake01")


class Round4Tests(unittest.TestCase):
    """Codex round-4 regressions: redirect blocking, truncated reads."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data = Path(self.tmp.name) / "data"

    def test_redirect_is_blocked_and_credential_never_forwarded(self):
        evil_hits = []

        class EvilHandler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                evil_hits.append(self.headers.get("Authorization"))
                self.send_response(200)
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"{}")

        evil = ThreadingHTTPServer(("127.0.0.1", 0), EvilHandler)
        evil_thread = threading.Thread(target=evil.serve_forever, daemon=True)
        evil_thread.start()
        self.addCleanup(evil.server_close)
        self.addCleanup(evil.shutdown)
        evil_base = f"http://127.0.0.1:{evil.server_port}"

        class RedirectHandler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                self.rfile.read(length)
                self.send_response(302)
                self.send_header("Location", evil_base + "/collect")
                self.send_header("Content-Length", "0")
                self.end_headers()

        main = ThreadingHTTPServer(("127.0.0.1", 0), RedirectHandler)
        main_thread = threading.Thread(target=main.serve_forever, daemon=True)
        main_thread.start()
        self.addCleanup(main.server_close)
        self.addCleanup(main.shutdown)
        with self.assertRaises(PairingError) as cm:
            pairing.post_json(f"http://127.0.0.1:{main.server_port}/x", {}, FAKE_SECRET)
        self.assertEqual(cm.exception.code, "REDIRECT_BLOCKED")
        self.assertEqual(evil_hits, [], "sender key never reaches the redirect target")

    def test_truncated_response_is_a_retryable_network_fault(self):
        class TruncHandler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                self.rfile.read(length)
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", "100")
                self.end_headers()
                self.wfile.write(b'{"ok":true,"heartbeatAt":"x"}')
                self.wfile.flush()
                self.close_connection = True

        server = ThreadingHTTPServer(("127.0.0.1", 0), TruncHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        with self.assertRaises(PairingError) as cm:
            pairing.post_json(f"http://127.0.0.1:{server.server_port}/hb", {"usable": False}, FAKE_SECRET)
        self.assertEqual(cm.exception.code, "NETWORK")
        self.assertIsNone(cm.exception.status, "transport fault, owned by the backoff")

    def test_sender_identifies_with_product_user_agent(self):
        seen = {}

        class UaHandler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                self.rfile.read(length)
                seen["ua"] = self.headers.get("User-Agent")
                body = b'{"ok":true}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        server = ThreadingHTTPServer(("127.0.0.1", 0), UaHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        status, _, _ = pairing.post_json(f"http://127.0.0.1:{server.server_port}/x", {}, FAKE_SECRET)
        self.assertEqual(status, 200)
        self.assertEqual(seen.get("ua"), pairing.USER_AGENT)
        self.assertFalse((seen.get("ua") or "").startswith("Python-urllib"), "edge denies default scripting UAs")


class Round5Tests(unittest.TestCase):
    """Codex round-5 regressions: fail-closed protection, key fingerprint."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data = Path(self.tmp.name) / "data"
        self.state = FakeApiState()
        self.server, self.base = make_server(self.state)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def pair_args(self, **kw):
        args = {"api_base": self.base, "data_dir": str(self.data),
                "config": None, "name": None, "code": FAKE_CODE}
        args.update(kw)
        return argparse_namespace(args)

    def test_failed_protection_aborts_before_any_secret_or_claim(self):
        with patch.object(pairing, "restrict_file", return_value=False):
            out, err, code = run_cli("pair", self.pair_args())
        self.assertEqual(code, pairing.EXIT_USAGE, err)
        self.assertIn("PRIVATE_STORAGE", err)
        self.assertEqual(self.state.claims, [], "no claim attempted")
        self.assertFalse((self.data / "pairing.json").exists())
        self.assertFalse((self.data / "heartbeat-key.txt").exists())
        leftovers = [p for p in self.data.rglob("*") if p.is_file()]
        self.assertEqual(leftovers, [], "no state or temp fragments written")

    def test_mismatched_generation_is_refused(self):
        import hashlib
        out, err, code = run_cli("pair", self.pair_args())
        self.assertEqual(code, EXIT_OK, err)
        meta = json.loads((self.data / "pairing.json").read_text())
        key_file = self.data / meta["key_file"]
        secret = key_file.read_text().strip()
        self.assertEqual(meta["key_sha256"], hashlib.sha256(secret.encode()).hexdigest())
        # Simulate an interrupted re-pair, both orders: new metadata with
        # the old key, and old metadata with a new key. Either mix is
        # refused instead of sending a stale key to a new endpoint.
        meta["api_base"] = "https://pairing.example"
        meta["resource_id"] = "r_other"
        meta["key_sha256"] = hashlib.sha256(b"some-other-key").hexdigest()
        (self.data / "pairing.json").write_text(json.dumps(meta))
        with self.assertRaises(PairingError) as cm:
            load_pairing(self.data)
        self.assertEqual(cm.exception.code, "BAD_PAIRING_STORE")
        (self.data / "pairing.json").write_text(json.dumps(
            {**meta, "key_sha256": hashlib.sha256(secret.encode()).hexdigest()}))
        key_file.write_text("some-other-key\n")
        with self.assertRaises(PairingError) as cm:
            load_pairing(self.data)
        self.assertEqual(cm.exception.code, "BAD_PAIRING_STORE")
        hb_out, hb_err = io.StringIO(), io.StringIO()
        with redirect_stdout(hb_out), redirect_stderr(hb_err):
            code = pairing.cmd_heartbeat(argparse_namespace(
                {"api_base": self.base, "data_dir": str(self.data),
                 "config": None, "interval": 60}), loop=False)
        self.assertNotEqual(code, EXIT_OK)
        self.assertEqual(self.state.beats, [], "refused store sends nothing")


class ConcurrencyAndLoopTests(unittest.TestCase):
    """Ported from Muse W3 rounds 9/11/12: exclusive node id, loop reload."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data = Path(self.tmp.name) / "data"
        self.state = FakeApiState()
        self.server, self.base = make_server(self.state)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def pair_args(self, **kw):
        args = {"api_base": self.base, "data_dir": str(self.data),
                "config": None, "name": None, "code": FAKE_CODE}
        args.update(kw)
        return argparse_namespace(args)

    def test_concurrent_first_pairs_converge_on_one_node_id(self):
        state = self.data / "state"
        gate = threading.Barrier(8)
        results, errors = [], []

        def run_one():
            try:
                gate.wait(timeout=30)
                results.append(load_or_create_node_id(state))
            except Exception as exc:
                errors.append(exc)

        threads = [threading.Thread(target=run_one) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=60)
        # Report the native cause (reason + owner/default/user SIDs) so a
        # failure on the elevated runner names the exact transient state.
        self.assertEqual(errors, [], [
            (exc, getattr(exc.__cause__, "reason", None), getattr(exc.__cause__, "owner_sid", None),
             getattr(exc.__cause__, "default_owner_sid", None), getattr(exc.__cause__, "user_sid", None),
             repr(exc.__cause__)) for exc in errors])
        self.assertEqual(len(results), 8)
        self.assertEqual(len(set(results)), 1,
                         "all racers share the winning identity")
        self.assertRegex(results[0], r"^n_[0-9a-f]{32}$")
        self.assertEqual((state / "node-id").read_text().strip(), results[0])

    def test_loop_stops_after_unpair(self):
        run_cli("pair", self.pair_args())
        args = argparse_namespace({"api_base": self.base, "data_dir": str(self.data),
                                   "config": None, "interval": 60})
        real_send = pairing.send_heartbeat
        calls = []

        def beat_then_unpair(*a, **k):
            out = real_send(*a, **k)
            calls.append(out)
            if len(calls) == 1:
                run_cli("unpair", argparse_namespace(
                    {"api_base": self.base, "data_dir": str(self.data)}))
            if len(calls) >= 5:
                raise RePairRequired(401, "KEY_REVOKED", "test cap: loop never noticed unpair")
            return out

        with patch.object(pairing, "send_heartbeat", side_effect=beat_then_unpair), \
                patch.object(pairing.time, "sleep", side_effect=lambda s: None):
            code = cmd_heartbeat(args, loop=True)
        self.assertEqual(code, EXIT_REPAIR_REQUIRED)
        self.assertEqual(len(calls), 1, "no beat after unpair")
        status = json.loads((self.data / "state" / "heartbeat-status.json").read_text())
        self.assertEqual(status["status"], "unpaired")

    def test_loop_retries_when_repair_lands_mid_beat(self):
        minted = []

        def hook(body):
            i = len(minted)
            key = f"synthetic-key-{i:02d}-0123456789abcdef"
            minted.append(key)
            return {"resourceId": "r_fake01", "heartbeatKey": key,
                    "keyId": f"k_fake{i:02d}", "keyPrefix": f"aip_live_k_fake{i:02d}_x",
                    "heartbeatUrl": "/api/resources/r_fake01/heartbeat", "created": True}

        self.state.claim_hook = hook
        run_cli("pair", self.pair_args())
        self.state.live_keys = {minted[0]}
        args = argparse_namespace({"api_base": self.base, "data_dir": str(self.data),
                                   "config": None, "interval": 60})
        real_send = pairing.send_heartbeat
        calls = []

        def flaky_beat(api_base, resource_id, secret, usable):
            calls.append(secret)
            if len(calls) == 1:
                # Re-pair lands after our reload but before the beat
                # reaches the server: new key installed, old revoked.
                run_cli("pair", self.pair_args(code="pair-99999999-AAAA-BBBB-CCCC"[:27]))
                self.state.live_keys = {minted[-1]}
            if len(calls) >= 3:
                raise RePairRequired(401, "KEY_REVOKED", "test cap: genuine terminal revocation")
            return real_send(api_base, resource_id, secret, usable)

        with patch.object(pairing, "send_heartbeat", side_effect=flaky_beat), \
                patch.object(pairing.time, "sleep", side_effect=lambda s: None):
            code = cmd_heartbeat(args, loop=True)
        self.assertEqual(code, EXIT_REPAIR_REQUIRED)
        self.assertEqual(calls, [minted[0], minted[1], minted[1]],
                         "revoked beat retried once with the rotated key, then a genuine revocation exits")


class PairMutexTests(unittest.TestCase):
    """Muse W3 rounds 11/12/13: pair mutex, locked unpair, locked reads.

    Adapted to the chain's generation store: the manifest selects the
    key, so assertions go through load_pairing instead of the flat
    heartbeat-key.txt layout. The chain's scandir unpair, atomic
    manifest commit, and generation retention are kept as-is.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data = Path(self.tmp.name) / "data"
        self.state = FakeApiState()
        self.server, self.base = make_server(self.state)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def pair_args(self, **kw):
        args = {"api_base": self.base, "data_dir": str(self.data),
                "config": None, "name": None, "code": FAKE_CODE}
        args.update(kw)
        return argparse_namespace(args)

    def test_concurrent_pairs_install_the_live_credential(self):
        # Pre-create the private store single-threaded: concurrent
        # directory creation races the fail-closed ownership check on
        # slow/elevated runners (see a3e1dfc). This test races the claim
        # plus credential writes, not store creation.
        pairing.private_dir(self.data)
        node_id = load_or_create_node_id(self.data / "state")
        minted, minted_lock = [], threading.Lock()

        def hook(body):
            with minted_lock:
                i = len(minted)
                key = f"synthetic-key-{i:02d}-0123456789abcdef"
                minted.append((key, threading.get_ident()))
            return {"resourceId": "r_fake01", "heartbeatKey": key,
                    "keyId": f"k_fake{i:02d}", "keyPrefix": f"aip_live_k_fake{i:02d}_x",
                    "heartbeatUrl": "/api/resources/r_fake01/heartbeat", "created": True}

        self.state.claim_hook = hook
        real_claim = pairing.claim
        other_done = threading.Event()

        def gated_claim(*args, **kwargs):
            out = real_claim(*args, **kwargs)
            with minted_lock:
                idx = next(i for i, (k, _) in enumerate(minted)
                           if k == out["heartbeatKey"])
            if idx == 0:
                # First-minted waits for the rival to finish, forcing the
                # exact overwrite order the mutex must prevent. With the
                # mutex the rival is lock-blocked, so this always waits
                # out the timeout (documented ~5s cost); without it the
                # rival finishes in milliseconds and the overwrite lands.
                other_done.wait(timeout=5)
            return out

        results, errors = {}, []

        def run_one(tag, code):
            try:
                results[tag] = run_cli("pair", self.pair_args(code=code))
            except Exception as exc:
                errors.append(exc)
            finally:
                other_done.set()

        threads = [threading.Thread(target=run_one, args=("a", FAKE_CODE)),
                   threading.Thread(target=run_one, args=("b", "pair-99999999-AAAA-BBBB-CCCC"[:27]))]
        with patch.object(pairing, "claim", side_effect=gated_claim):
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=60)
        self.assertEqual(errors, [])
        self.assertEqual(results["a"][2], EXIT_OK)
        self.assertEqual(results["b"][2], EXIT_OK, "both report success even in the race")
        live = minted[-1][0]
        loaded = load_pairing(self.data)
        self.assertEqual(loaded["node_id"], node_id, "both pairs shared the pre-created identity")
        self.assertEqual(loaded["heartbeat_key"], live, "manifest selects the live generation")
        self.state.live_keys = {live}
        beat = send_heartbeat(self.base, loaded["resource_id"], live, False)
        self.assertTrue(beat.get("ok"), "installed credential actually beats")

    def test_unpair_during_pair_writes_fails_cleanly(self):
        real_write = pairing.write_private
        nested = {}

        def gated_write(path, content):
            out = real_write(path, content)
            if Path(path).name.startswith("heartbeat-key.") and "code" not in nested:
                nout, nerr, ncode = run_cli("unpair", argparse_namespace(
                    {"api_base": self.base, "data_dir": str(self.data)}))
                nested.update(code=ncode, out=nout, err=nerr)
            return out

        # Short mutex wait: with the lock the nested unpair must time out
        # cleanly; without it the deletion slips through instantly and the
        # manifest lands pointing at a deleted generation.
        with patch.object(pairing, "write_private", side_effect=gated_write), \
                patch.object(pairing, "PAIR_LOCK_TIMEOUT_SEC", 5, create=True):
            out, err, code = run_cli("pair", self.pair_args())
        self.assertEqual(code, EXIT_OK, out + err)
        self.assertEqual(nested["code"], EXIT_USAGE, "locked-out unpair fails cleanly, not silently")
        self.assertIn("another pair", nested["err"])
        loaded = load_pairing(self.data)
        self.assertTrue(loaded["heartbeat_key"], "store intact and consistent")

    def test_mutual_exclusion_under_threads(self):
        counter = [0]

        def bump():
            for _ in range(50):
                with pairing.pair_lock(self.data):
                    counter[0] += 1

        threads = [threading.Thread(target=bump) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(60)
        self.assertFalse(any(thread.is_alive() for thread in threads), "worker hung")
        self.assertEqual(counter[0], 400)

    def test_lock_released_when_holder_dies(self):
        data = str(self.data)
        ready = self.data / "ready"
        child = subprocess.Popen(
            [sys.executable, "-c",
             "import pairing, time; from pathlib import Path; "
             f"d = {data!r}; "
             "mgr = pairing.pair_lock(d); mgr.__enter__(); "
             f"Path({str(ready)!r}).write_text('held'); time.sleep(30)"],
            cwd=Path(pairing.__file__).parent,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(lambda: (child.kill(), child.wait()))
        for _ in range(200):
            if ready.exists():
                break
            time.sleep(0.05)
        self.assertTrue(ready.exists(), "child never acquired the lock")
        with patch.object(pairing, "PAIR_LOCK_TIMEOUT_SEC", 2):
            with self.assertRaises(pairing.PairingError, msg="child holds the lock"):
                with pairing.pair_lock(self.data):
                    pass
            child.kill()
            child.wait(timeout=30)
            with pairing.pair_lock(self.data):
                pass  # OS-released: immediate re-acquire, no stale wait

    def test_stale_decision_never_deletes_a_live_lock(self):
        lock = self.data / "pair.lock"
        errors = []

        def contend():
            try:
                with pairing.pair_lock(self.data):
                    errors.append("entered while held")
            except pairing.PairingError as exc:
                errors.append(exc.code)

        with pairing.pair_lock(self.data):
            with patch.object(pairing, "PAIR_LOCK_TIMEOUT_SEC", 2):
                b = threading.Thread(target=contend)
                b.start()
                b.join(30)
                self.assertFalse(b.is_alive(), "contender hung")
            self.assertEqual(errors, ["PAIR_IN_PROGRESS"])
        # Read after release (a held Windows range lock denies even reads):
        # the OS-held mutex never deletes the lock file.
        self.assertEqual(lock.read_bytes(), b"", "live lock file untouched")
        with pairing.pair_lock(self.data):
            pass  # the held lock still releases and re-acquires normally

    def test_sender_start_during_pair_writes_waits_for_consistent_store(self):
        minted = []

        def hook(body):
            i = len(minted)
            key = f"synthetic-key-{i:02d}-0123456789abcdef"
            minted.append(key)
            return {"resourceId": "r_fake01", "heartbeatKey": key,
                    "keyId": f"k_fake{i:02d}", "keyPrefix": f"aip_live_k_fake{i:02d}_x",
                    "heartbeatUrl": "/api/resources/r_fake01/heartbeat", "created": True}

        self.state.claim_hook = hook
        _, _, code = run_cli("pair", self.pair_args())
        self.assertEqual(code, EXIT_OK)
        self.state.live_keys = {minted[0]}
        key_written = threading.Event()
        release = threading.Event()
        real_write = pairing.write_private

        def gated_write(path, content):
            out = real_write(path, content)
            if Path(path).name.startswith("heartbeat-key.") and not key_written.is_set():
                key_written.set()
                release.wait(timeout=10)
            return out

        results = {}

        def run_pair():
            with patch.object(pairing, "write_private", side_effect=gated_write):
                results["pair"] = run_cli(
                    "pair", self.pair_args(code="pair-99999999-AAAA-BBBB-CCCC"[:27]))

        a = threading.Thread(target=run_pair)
        a.start()
        self.assertTrue(key_written.wait(timeout=30), "re-pair reached its key write")
        # The claim revoked the old key server-side: only the new one beats.
        self.state.live_keys = {minted[1]}

        def run_beat():
            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                beat_code = cmd_heartbeat(argparse_namespace(
                    {"api_base": self.base, "data_dir": str(self.data),
                     "config": None, "interval": 60}), loop=False)
            results["beat"] = (out.getvalue(), err.getvalue(), beat_code)

        b = threading.Thread(target=run_beat)
        b.start()
        b.join(timeout=8)  # unlocked the old-key beat exits fast; locked it waits
        release.set()
        a.join(30)
        b.join(30)
        self.assertFalse(a.is_alive() or b.is_alive(), "pair/beat hung")
        self.assertEqual(results["pair"][2], EXIT_OK, results["pair"][1])
        _, err, beat_code = results["beat"]
        self.assertEqual(beat_code, EXIT_OK, err)
        self.assertFalse(any(beat["key"] == minted[0] for beat in self.state.beats),
                         "sender start never beats the revoked pre-pair key")
        self.assertEqual(self.state.beats[-1]["key"], minted[1], "beat uses the repaired key")


def argparse_namespace(values):
    ns = type("Args", (), {})()
    for key, value in values.items():
        setattr(ns, key, value)
    return ns


def run_cli(command, args):
    func = {"pair": pairing.cmd_pair, "status": pairing.cmd_status,
            "unpair": pairing.cmd_unpair}[command]
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = func(args)
    return out.getvalue(), err.getvalue(), code


if __name__ == "__main__":
    unittest.main()

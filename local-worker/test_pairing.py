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
import sys
import tempfile
import threading
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
                     EXIT_OK, EXIT_REPAIR_REQUIRED)

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
        key_file = self.data / "heartbeat-key.txt"
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

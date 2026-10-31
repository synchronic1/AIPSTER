"""Sender single-instance lock tests. Stdlib only; no venv needed.

A fake in-thread HTTP server stands in for the AIPSTER API; two REAL
pairing.py subprocesses contend for one data dir, so the lock is proven
across processes, not just threads. All codes/keys are synthetic
fixtures. Never touches a real data dir or network host.
"""
import json
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stdout, redirect_stderr
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import StringIO
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import pairing
from pairing import (_hold_sender_lock, cmd_pair, sender_lock_held,
                     EXIT_OK, EXIT_SENDER_RUNNING)

FAKE_CODE = "pair-01234567-89AB-CDEF-GHJKMNPQ"[:27]
FAKE_SECRET = "synthetic-heartbeat-key-0123456789abcdef"
CLI = [sys.executable, str(ROOT / "pairing.py")]


class FakeApiState:
    def __init__(self):
        self.claims = []
        self.beats = []
        self.live_keys = {FAKE_SECRET}


def make_server(state):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, status, body):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
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
                self._send(201, {"resourceId": "r_fake01",
                                 "heartbeatKey": FAKE_SECRET,
                                 "keyId": "k_fake01",
                                 "keyPrefix": "aip_live_k_fake01_synthe",
                                 "heartbeatUrl": "/api/resources/r_fake01/heartbeat",
                                 "created": True})
            elif self.path.endswith("/heartbeat"):
                secret = (self.headers.get("Authorization") or "").replace("Bearer ", "")
                state.beats.append({"usable": body.get("usable"), "key": secret})
                if secret not in state.live_keys:
                    self._send(401, {"error": "revoked", "code": "KEY_REVOKED"})
                else:
                    self._send(200, {"ok": True,
                                     "heartbeatAt": "2026-10-31T00:00:00.000Z",
                                     "online": True, "usable": body.get("usable")})
            else:
                self._send(404, {"error": "no", "code": "NOT_FOUND"})

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, f"http://127.0.0.1:{server.server_port}"


class SenderLockTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data = Path(self.tmp.name) / "data"
        self.state = FakeApiState()
        self.server, self.base = make_server(self.state)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.procs = []
        self.addCleanup(self._kill_procs)
        self._pair()

    def _kill_procs(self):
        for proc in self.procs:
            try:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait(timeout=15)
            except Exception:
                pass
            finally:
                for pipe in (proc.stdout, proc.stderr):
                    try:
                        if pipe:
                            pipe.close()
                    except Exception:
                        pass

    def _pair(self):
        args = type("Args", (), {})()
        args.api_base = self.base
        args.data_dir = str(self.data)
        args.config = None
        args.name = None
        args.code = FAKE_CODE
        out, err = StringIO(), StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = cmd_pair(args)
        self.assertEqual(code, pairing.EXIT_OK)

    def _start_loop(self):
        proc = subprocess.Popen(
            CLI + ["--data-dir", str(self.data), "heartbeat-loop"],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        self.procs.append(proc)
        return proc

    def _wait_beats(self, count=1, timeout=30):
        deadline = time.time() + timeout
        while len(self.state.beats) < count:
            self.assertLess(time.time(), deadline, "no heartbeat arrived")
            time.sleep(0.1)

    def test_second_loop_exits_sender_running(self):
        first = self._start_loop()
        self._wait_beats(1)
        second = subprocess.run(
            CLI + ["--data-dir", str(self.data), "heartbeat-loop"],
            capture_output=True, text=True, timeout=60)
        self.assertEqual(second.returncode, EXIT_SENDER_RUNNING)
        self.assertIn("SENDER_RUNNING", second.stderr)
        self.assertIsNone(first.poll(), "first sender died during the test")
        self.assertGreaterEqual(len(self.state.beats), 1)

    def test_once_ignores_sender_lock(self):
        guard = _hold_sender_lock(self.data)
        self.assertIsNotNone(guard)
        self.addCleanup(guard.release)
        beats_before = len(self.state.beats)
        once = subprocess.run(
            CLI + ["--data-dir", str(self.data), "heartbeat-once"],
            capture_output=True, text=True, timeout=60)
        self.assertEqual(once.returncode, EXIT_OK)
        self.assertEqual(len(self.state.beats), beats_before + 1)

    def test_crash_releases_lock(self):
        proc = self._start_loop()
        self._wait_beats(1)
        self.assertTrue(sender_lock_held(self.data), "running loop holds the lock")
        proc.kill()
        proc.wait(timeout=15)
        # Windows frees the byte-range lock just after the process
        # becomes reaped: poll for the release instead of asserting it
        # is instant. The contract is "never wedged", not "instant".
        deadline = time.time() + 10
        while sender_lock_held(self.data):
            self.assertLess(time.time(), deadline, "lock never released after kill")
            time.sleep(0.1)
        self.assertTrue((self.data / "sender.lock").exists(), "stale marker remains")
        guard = _hold_sender_lock(self.data)
        self.assertIsNotNone(guard, "stale marker must not wedge the next start")
        guard.release()

    def test_probe_never_true_from_stale_file(self):
        (self.data / "sender.lock").write_bytes(b"")
        self.assertFalse(sender_lock_held(self.data))
        guard = _hold_sender_lock(self.data)
        self.assertIsNotNone(guard)
        self.assertTrue(sender_lock_held(self.data))
        guard.release()
        self.assertFalse(sender_lock_held(self.data))


if __name__ == "__main__":
    unittest.main()

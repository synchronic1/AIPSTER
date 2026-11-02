"""Regression tests for the one-entrypoint worker onboarding orchestrator.

Stdlib only; no venv, no PyPI, no real AIPSTER host, no live worker. All
credentials and pairing codes are synthetic fixtures. Fake HTTP servers bind
loopback only and are shut down with the test.
"""
import io
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import pairing
import setup_worker as sw

FAKE_CODE = "pair-01234567-89AB-CDEF-GHJKMNPQ"
FAKE_CODE2 = "pair-aaaaaaaa-bbbb-cccc-ddddeeee"
FAKE_SECRET = "synthetic-heartbeat-key-0123456789abcdef"
FAKE_TOKEN = "synthetic-daemon-token-0123456789abcdef"


class FakeResult:
    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


class FakeRunner:
    def __init__(self, uv="uv 0.12.12\n", install_rc=0, on_install=None):
        self.uv = uv
        self.install_rc = install_rc
        self.on_install = on_install
        self.calls = []
        self.install_calls = []

    def __call__(self, argv, *, cwd=None, env=None, timeout=None, capture=False):
        self.calls.append({"argv": list(argv), "cwd": cwd, "env": env,
                           "timeout": timeout, "capture": capture})
        if capture:
            return FakeResult(0, self.uv, "")
        self.install_calls.append({"argv": list(argv), "cwd": cwd, "env": env,
                                   "timeout": timeout})
        if self.on_install:
            self.on_install()
        return FakeResult(self.install_rc, "", "")


class FakeHandle:
    next_pid = 4100

    def __init__(self, poll_sequence=None):
        FakeHandle.next_pid += 1
        self.pid = FakeHandle.next_pid
        self.poll_sequence = list(poll_sequence or [])
        self.terminated = False
        self.waited = False

    def poll(self):
        return self.poll_sequence.pop(0) if self.poll_sequence else None

    def terminate(self):
        self.terminated = True

    def wait(self, timeout=5.0):
        self.waited = True


class FakeSpawner:
    def __init__(self, handles=None):
        self.calls = []
        self.handles = list(handles or [])

    def __call__(self, argv, *, cwd, env, log_path):
        handle = self.handles.pop(0) if self.handles else FakeHandle()
        self.calls.append({"argv": list(argv), "cwd": cwd, "env": dict(env),
                           "log_path": log_path, "handle": handle})
        return handle


class FakeHttp:
    def __init__(self, health=None, node=None, execute=None):
        self.health = health if health is not None else (None, {}, "not running")
        self.node = node if node is not None else (None, {}, "not running")
        self.execute = execute if execute is not None else (None, {}, "not running")
        self.calls = []

    @staticmethod
    def _next(value):
        if isinstance(value, list):
            return value.pop(0) if len(value) > 1 else value[0]
        return value

    def request(self, method, url, token=None, payload=None, timeout=2.0):
        self.calls.append({"method": method, "url": url, "token": token,
                           "payload": payload, "timeout": timeout})
        if url.endswith("/healthz"):
            return self._next(self.health)
        if url.endswith("/v1/node"):
            return self._next(self.node)
        if url.endswith("/v1/execute"):
            return self._next(self.execute)
        return 404, {}, "unknown route"

    def count(self, suffix):
        return sum(1 for call in self.calls if call["url"].endswith(suffix))


def make_root(tmp):
    """A fixture worker checkout. Paths include spaces to catch shell quoting."""
    root = Path(tmp) / "worker root"
    (root / "configs").mkdir(parents=True)
    (root / "install.py").write_text("# fixture installer\n", encoding="utf-8")
    (root / "pairing.py").write_text("# fixture marker; real pairing lives in setup_root\n",
                                    encoding="utf-8")
    shutil.copy(ROOT / "configs" / "mock.toml", root / "configs" / "mock.toml")
    return root


def make_venv(root):
    bindir = root / ".venv" / ("Scripts" if os.name == "nt" else "bin")
    bindir.mkdir(parents=True)
    for name in (("python.exe", "dendrite.exe") if os.name == "nt" else ("python", "dendrite")):
        path = bindir / name
        path.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        path.chmod(0o755)
    return bindir


def make_config(root, host="127.0.0.1", port=8090):
    path = root / "configs" / "mock.toml"
    text = path.read_text(encoding="utf-8")
    text = text.replace('host = "127.0.0.1"', 'host = "%s"' % host)
    text = text.replace("port = 8090", "port = %d" % port)
    path.write_text(text, encoding="utf-8")
    return path


def clock_sequence(step=1.0):
    value = [0.0]

    def clock():
        current = value[0]
        value[0] += step
        return current
    return clock


def make_setup(tmp, *, root=None, data=None, config=None, runner=None, spawner=None,
               http=None, pairer=None, token=FAKE_TOKEN, allow=True,
               platform_name="posix", machine="arm64", retry_pair=False,
               verify_inference=False, sender_lock=False, port_open=False,
               start_timeout=0.0, heartbeat_wait=0.0, uv_present=True):
    root = Path(root or make_root(tmp))
    data = Path(data or (Path(tmp) / "data dir"))
    config = Path(config or (root / "configs" / "mock.toml"))
    runner = runner or FakeRunner()
    spawner = spawner or FakeSpawner()
    http = http or FakeHttp()
    out, err = [], []
    session = sw.Setup(
        root=root, data_dir=data, config=config, api_base="http://127.0.0.1:9",
        allow_unqualified=allow, retry_pair=retry_pair, verify_inference=verify_inference,
        runner=runner, spawner=spawner, http=http, pairer=pairer,
        token_provider=lambda create=True: token,
        sender_lock_probe=lambda _data: sender_lock,
        which=(lambda _name: "/fixture/uv") if uv_present else (lambda _name: None),
        port_open=lambda _host, _port: port_open,
        platform_name=platform_name, machine=machine,
        clock=clock_sequence(), sleep=lambda _seconds: None,
        out=out.append, err=err.append,
        start_timeout=start_timeout, heartbeat_wait=heartbeat_wait)
    return session, runner, spawner, http, out, err


class FakeApiState:
    def __init__(self):
        self.claims = []
        self.beats = []
        self.claim_status = 201
        self.claim_body = None

    def claim_hook(self, body):
        self.claims.append(body)
        payload = dict(self.claim_body or {})
        payload.setdefault("resourceId", "r_setup_fixture")
        payload.setdefault("heartbeatKey", FAKE_SECRET)
        payload.setdefault("keyId", "k_setup_fixture")
        payload.setdefault("keyPrefix", "aip_live_k_setup_fixture_syn")
        payload.setdefault("heartbeatUrl", "/api/resources/r_setup_fixture/heartbeat")
        payload.setdefault("created", True)
        return payload


def make_api_server(state):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
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
                if state.claim_status >= 400:
                    self._send(state.claim_status, state.claim_body or {})
                else:
                    self._send(state.claim_status, state.claim_hook(body))
            elif self.path.endswith("/heartbeat"):
                secret = (self.headers.get("Authorization") or "").replace("Bearer ", "")
                state.beats.append({"usable": body.get("usable"), "key": secret})
                self._send(200, {"ok": True, "heartbeatAt": "2026-11-01T00:00:00.000Z",
                                 "online": True, "usable": body.get("usable")})
            else:
                self._send(404, {"error": "no", "code": "NOT_FOUND"})

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, "http://127.0.0.1:%d" % server.server_port


class ApiFixture:
    def __init__(self, testcase):
        self.state = FakeApiState()
        self.server, self.base = make_api_server(self.state)
        testcase.addCleanup(self.server.server_close)
        testcase.addCleanup(self.server.shutdown)


def pair_real(tmp, base, *, code=FAKE_CODE, data=None):
    """Create a real private pairing store through pairing.cmd_pair."""
    data = Path(data or (Path(tmp) / "paired data"))
    args = SimpleNamespace(api_base=base, data_dir=str(data), config=None,
                           name=None, code=code)
    output = io.StringIO()
    errors = io.StringIO()
    with redirect_stdout(output), redirect_stderr(errors):
        returncode = pairing.cmd_pair(args)
    return returncode, data, output.getvalue(), errors.getvalue()


def write_fresh_beat(data, usable=False):
    meta = pairing.load_pairing(data)
    pairing.write_status(data, {"at": time.time(), "ok": True, "usable": usable,
                                "heartbeatAt": "2026-11-01T00:00:00.000Z"}, meta)


def node_body(models=None):
    return {"node_id": "standalone-demo", "models": models or [
        {"id": "mock-summary", "runtime": "mock", "simulated": True,
         "capabilities": ["summarize"], "available": True}]}


class PacketAndPrivateCodeTests(unittest.TestCase):
    def test_extract_exact_code_and_reject_ambiguity(self):
        packet = "AIPSTER agent setup packet v2.\n\n  PAIRING CODE: %s\n\nrun stuff\n" % FAKE_CODE
        self.assertEqual(sw.extract_pairing_code(packet), FAKE_CODE)
        with self.assertRaises(sw.SetupError) as cm:
            sw.extract_pairing_code("nothing here")
        self.assertEqual(cm.exception.code, "NO_PAIRING_CODE")
        with self.assertRaises(sw.SetupError) as cm:
            sw.extract_pairing_code("PAIRING CODE: %s\nPAIRING CODE: %s\n" % (FAKE_CODE, FAKE_CODE2))
        self.assertEqual(cm.exception.code, "AMBIGUOUS_PAIRING_CODE")

    def test_code_shape_rejects_shell_and_control_syntax(self):
        for bad in ("", "short", "pair code with spaces", "pair-01234567;rm -rf /",
                    "pair-01234567$(whoami)", "pair-01234567`id`", "pair-01234567\n",
                    "pair-01234567\x00", "é" * 12):
            with self.subTest(bad=repr(bad)), self.assertRaises(sw.SetupError):
                sw.validate_pairing_code(bad)
        self.assertEqual(sw.validate_pairing_code(FAKE_CODE), FAKE_CODE)

    def test_private_sources_do_not_echo(self):
        packet = "header\nPAIRING CODE: %s\nfooter\n" % FAKE_CODE
        output = io.StringIO()
        with redirect_stdout(output), redirect_stderr(output):
            self.assertEqual(
                sw.read_private_code(SimpleNamespace(packet_stdin=True, code_stdin=False,
                                                     code_fd=None),
                                     stdin=io.StringIO(packet)),
                FAKE_CODE)
            self.assertEqual(output.getvalue(), "")
            self.assertEqual(
                sw.read_private_code(SimpleNamespace(packet_stdin=False, code_stdin=True,
                                                     code_fd=None),
                                     stdin=io.StringIO(FAKE_CODE + "\n")),
                FAKE_CODE)
            self.assertEqual(output.getvalue(), "")
            self.assertEqual(
                sw.read_private_code(SimpleNamespace(packet_stdin=False, code_stdin=True,
                                                     code_fd=None),
                                     stdin=SimpleNamespace(isatty=lambda: True),
                                     getpass_fn=lambda _prompt: FAKE_CODE),
                FAKE_CODE)
            self.assertEqual(output.getvalue(), "")

    def test_inherited_fd_source(self):
        read_fd, write_fd = os.pipe()
        try:
            os.write(write_fd, (FAKE_CODE + "\n").encode())
        finally:
            os.close(write_fd)
        try:
            value = sw.read_private_code(
                SimpleNamespace(packet_stdin=False, code_stdin=False, code_fd=read_fd),
                stdin=SimpleNamespace(isatty=lambda: False))
        finally:
            os.close(read_fd)
        self.assertEqual(value, FAKE_CODE)

    def test_no_source_on_non_tty_is_not_a_silent_read(self):
        value = sw.read_private_code(
            SimpleNamespace(packet_stdin=False, code_stdin=False, code_fd=None),
            stdin=SimpleNamespace(isatty=lambda: False))
        self.assertIsNone(value)

    def test_sources_are_mutually_exclusive(self):
        with self.assertRaises(sw.SetupError) as cm:
            sw.read_private_code(SimpleNamespace(packet_stdin=True, code_stdin=True,
                                                 code_fd=None),
                                 stdin=io.StringIO(""))
        self.assertEqual(cm.exception.code, "CODE_SOURCE_CONFLICT")

    def test_parser_has_no_argv_code_option(self):
        with self.assertRaises(SystemExit):
            sw.build_parser().parse_args(["pair", "--code", FAKE_CODE])
        help_text = sw.build_parser().format_help()
        self.assertNotIn("--code ", help_text)
        self.assertIn("--packet-stdin", help_text)
        self.assertIn("--code-fd", help_text)


class CheckAndInstallTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = make_root(self.tmp.name)

    def test_unqualified_platform_fails_closed_without_override(self):
        session, _runner, _spawner, _http, _out, _err = make_setup(
            self.tmp.name, root=self.root, allow=False)
        report = session.check()
        self.assertIn("UNQUALIFIED_PLATFORM", [item["code"] for item in report["blocked"]])
        self.assertEqual(session.install(report), sw.EXIT_PREREQ)

    def test_explicit_platform_override_is_reported(self):
        make_venv(self.root)
        session, _runner, _spawner, _http, _out, _err = make_setup(
            self.tmp.name, root=self.root, allow=True)
        report = session.check()
        self.assertTrue(report["allow_unqualified"])
        self.assertNotIn("UNQUALIFIED_PLATFORM", [item["code"] for item in report["blocked"]])

    def test_uv_exact_guard_blocks_install_without_running_it(self):
        runner = FakeRunner(uv="uv 0.10.3\n")
        session, runner, _spawner, _http, _out, err = make_setup(
            self.tmp.name, root=self.root, runner=runner)
        report = session.check()
        self.assertIn("UV_VERSION", [item["code"] for item in report["blocked"]])
        self.assertEqual(session.install(report), sw.EXIT_PREREQ)
        self.assertEqual(runner.install_calls, [])
        self.assertIn("0.12.12", "\n".join(err))

    def test_uv_012_12_installs_once_and_resume_skips(self):
        runner = FakeRunner(on_install=lambda: make_venv(self.root))
        session, runner, _spawner, _http, _out, err = make_setup(
            self.tmp.name, root=self.root, runner=runner)
        self.assertEqual(session.install(), sw.EXIT_OK, err)
        self.assertEqual(len(runner.install_calls), 1)
        call = runner.install_calls[0]
        self.assertEqual(call["argv"], [sys.executable, str(session.root / "install.py")])
        self.assertEqual(Path(call["cwd"]), session.root)
        self.assertNotIn("shell", call)
        self.assertEqual(session.install(), sw.EXIT_OK)
        self.assertEqual(len(runner.install_calls), 1, "resume must not rerun install.py")
        self.assertEqual(session.state["phases"]["install"]["state"], "skipped")

    def test_partial_venv_fails_closed_without_touching_it(self):
        (self.root / ".venv").mkdir()
        runner = FakeRunner(on_install=lambda: make_venv(self.root))
        session, runner, _spawner, _http, _out, err = make_setup(
            self.tmp.name, root=self.root, runner=runner)
        report = session.check()
        self.assertIn("PARTIAL_INSTALL", [item["code"] for item in report["blocked"]])
        self.assertEqual(session.install(report), sw.EXIT_PREREQ)
        self.assertEqual(runner.install_calls, [])
        self.assertTrue((self.root / ".venv").exists())

    def test_install_failure_is_reported_and_not_marked_complete(self):
        runner = FakeRunner(install_rc=1)
        session, runner, _spawner, _http, _out, err = make_setup(
            self.tmp.name, root=self.root, runner=runner)
        self.assertEqual(session.install(), sw.EXIT_PREREQ)
        self.assertEqual(session.state["phases"]["install"]["state"], "failed")
        self.assertFalse(session._install_state()["installed"])
        self.assertIn("FAILED", "\n".join(err))

    def test_non_loopback_config_is_refused(self):
        make_venv(self.root)
        config = make_config(self.root, host="0.0.0.0")
        session, _runner, _spawner, _http, _out, _err = make_setup(
            self.tmp.name, root=self.root, config=config)
        report = session.check()
        self.assertIn("NON_LOOPBACK_CONFIG", [item["code"] for item in report["blocked"]])

    def test_bad_port_and_token_env_are_refused(self):
        make_venv(self.root)
        config = make_config(self.root)
        text = config.read_text(encoding="utf-8")
        text = text.replace("[node]", '[node]\ntoken_env = "BAD-NAME"', 1)
        config.write_text(text, encoding="utf-8")
        session, _runner, _spawner, _http, _out, _err = make_setup(
            self.tmp.name, root=self.root, config=config)
        self.assertIn("BAD_CONFIG", [item["code"] for item in session.check()["blocked"]])


class PairingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.api = ApiFixture(self)

    def test_pair_uses_private_code_stores_private_and_never_prints_it(self):
        session, _runner, _spawner, _http, out, err = make_setup(
            self.tmp.name, root=ROOT, config=ROOT / "configs" / "mock.toml",
            pairer=None, data=Path(self.tmp.name) / "data")
        session.api_base = self.api.base
        self.assertEqual(session.pair(FAKE_CODE), sw.EXIT_OK, err)
        self.assertEqual(len(self.api.state.claims), 1)
        text = "\n".join(out + err)
        self.assertNotIn(FAKE_CODE, text)
        self.assertNotIn(FAKE_SECRET, text)
        self.assertIn("r_setup_fixture", text)
        meta = pairing.load_pairing(session.data_dir)
        self.assertEqual(meta["resource_id"], "r_setup_fixture")
        key_file = session.data_dir / meta["key_file"]
        self.assertEqual(stat.S_IMODE(key_file.stat().st_mode), 0o600)
        state_text = session.state_path.read_text(encoding="utf-8")
        self.assertNotIn(FAKE_CODE, state_text)
        self.assertNotIn(FAKE_SECRET, state_text)
        log_text = "".join(p.read_text(encoding="utf-8", errors="replace")
                           for p in session.data_dir.rglob("*.log") if p.is_file()) \
            if (session.data_dir / "logs").exists() else ""
        self.assertNotIn(FAKE_CODE, log_text)
        self.assertNotIn(FAKE_SECRET, log_text)

    def test_second_pair_preserves_store_and_does_not_consume_code(self):
        called = []

        def pairer(code):
            called.append(code)
            return 0

        session, _runner, _spawner, _http, out, err = make_setup(
            self.tmp.name, root=ROOT, config=ROOT / "configs" / "mock.toml",
            pairer=pairer, data=Path(self.tmp.name) / "data")
        session.api_base = self.api.base
        # Create the real store first, then prove a second run never calls the pairer.
        self.assertEqual(pair_real(self.tmp.name, self.api.base, data=session.data_dir)[0], 0)
        self.assertEqual(session.pair(FAKE_CODE2), sw.EXIT_OK, err)
        self.assertEqual(called, [])
        self.assertEqual(len(self.api.state.claims), 1)
        self.assertIn("code not consumed", "\n".join(out))

    def test_network_uncertainty_requires_explicit_retry(self):
        calls = []

        def pairer(_code):
            calls.append(1)
            return 5

        session, _runner, _spawner, _http, _out, err = make_setup(
            self.tmp.name, root=ROOT, config=ROOT / "configs" / "mock.toml",
            pairer=pairer, data=Path(self.tmp.name) / "data")
        self.assertEqual(session.pair(FAKE_CODE), 5, err)
        self.assertEqual(session.state["phases"]["pair"]["state"], "uncertain")
        self.assertEqual(session.pair(FAKE_CODE2), sw.EXIT_PAIRING)
        self.assertEqual(len(calls), 1, "uncertain state must not burn another code")
        session.retry_pair = True
        self.assertEqual(session.pair(FAKE_CODE2), 5)
        self.assertEqual(len(calls), 2)

    def test_interrupted_pair_requires_explicit_retry(self):
        calls = []

        def pairer(_code):
            calls.append(1)
            raise KeyboardInterrupt

        session, _runner, _spawner, _http, _out, _err = make_setup(
            self.tmp.name, root=ROOT, config=ROOT / "configs" / "mock.toml",
            pairer=pairer, data=Path(self.tmp.name) / "data")
        with self.assertRaises(KeyboardInterrupt):
            session.pair(FAKE_CODE)
        self.assertEqual(session.state["phases"]["pair"]["state"], "in_progress")
        self.assertEqual(session.pair(FAKE_CODE2), sw.EXIT_PAIRING)
        self.assertEqual(len(calls), 1)

    def test_rejected_pair_can_retry_with_a_new_code(self):
        codes = []

        def pairer(code):
            codes.append(code)
            return 3

        session, _runner, _spawner, _http, _out, err = make_setup(
            self.tmp.name, root=ROOT, config=ROOT / "configs" / "mock.toml",
            pairer=pairer, data=Path(self.tmp.name) / "data")
        self.assertEqual(session.pair(FAKE_CODE), sw.EXIT_PAIRING, err)
        self.assertEqual(session.state["phases"]["pair"]["state"], "failed")
        self.assertEqual(session.pair(FAKE_CODE2), sw.EXIT_PAIRING)
        self.assertEqual(codes, [FAKE_CODE, FAKE_CODE2])

    def test_no_code_is_blocked_without_reading_or_claiming(self):
        session, _runner, _spawner, _http, _out, err = make_setup(
            self.tmp.name, root=ROOT, config=ROOT / "configs" / "mock.toml",
            pairer=lambda _code: self.fail("pairer must not run"),
            data=Path(self.tmp.name) / "data")
        self.assertEqual(session.pair(None), sw.EXIT_PAIRING)
        self.assertEqual(self.api.state.claims, [])
        self.assertIn("--packet-stdin", "\n".join(err))


class StartTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = make_root(self.tmp.name)
        make_venv(self.root)

    def test_start_spawns_one_daemon_without_printing_token_and_is_idempotent(self):
        http = FakeHttp(health=[(None, {}, "refused"), (200, {"status": "ok"}, "")],
                        node=(200, node_body(), ""))
        session, _runner, spawner, http, out, err = make_setup(
            self.tmp.name, root=self.root, http=http)
        self.assertEqual(session.start(), sw.EXIT_OK, err)
        self.assertEqual(len(spawner.calls), 1)
        call = spawner.calls[0]
        self.assertEqual(call["argv"], [str(session.root / ".venv/bin/dendrite"), "serve",
                                        "--config", str(session.config)])
        self.assertEqual(call["env"]["DENDRITE_API_TOKEN"], FAKE_TOKEN)
        self.assertNotIn(FAKE_TOKEN, "\n".join(out + err))
        self.assertNotIn(FAKE_TOKEN, session.state_path.read_text(encoding="utf-8"))
        self.assertEqual(http.count("/healthz") >= 1, True)
        self.assertEqual(session.state["phases"]["start"]["state"], "partial")
        self.assertEqual(session.start(), sw.EXIT_OK, err)
        self.assertEqual(len(spawner.calls), 1, "healthy daemon must not be started twice")

    def test_foreign_listener_on_the_configured_port_is_refused(self):
        http = FakeHttp(health=(None, {}, "refused"))
        session, _runner, spawner, _http, _out, err = make_setup(
            self.tmp.name, root=self.root, http=http, port_open=True)
        self.assertEqual(session.start(), sw.EXIT_PREREQ)
        self.assertEqual(spawner.calls, [])
        self.assertIn("already in use", "\n".join(err))

    def test_daemon_that_never_becomes_healthy_is_terminated(self):
        handle = FakeHandle()
        spawner = FakeSpawner([handle])
        http = FakeHttp(health=(None, {}, "refused"))
        session, _runner, spawner, _http, _out, err = make_setup(
            self.tmp.name, root=self.root, http=http, spawner=spawner,
            start_timeout=0.0)
        self.assertEqual(session.start(), sw.EXIT_NETWORK)
        self.assertTrue(handle.terminated)
        self.assertTrue(handle.waited)
        self.assertEqual(session.state["phases"]["start"]["state"], "failed")
        self.assertIn("did not become healthy", "\n".join(err))

    def test_sender_argv_quotes_spaces_and_is_not_shell_text(self):
        self.api = ApiFixture(self)
        data = Path(self.tmp.name) / "paired data with spaces"
        self.assertEqual(pair_real(self.tmp.name, self.api.base, data=data)[0], 0)
        write_fresh_beat(data)
        http = FakeHttp(health=(200, {"status": "ok"}, ""),
                        node=(200, node_body(), ""))
        session, _runner, spawner, _http, out, err = make_setup(
            self.tmp.name, root=self.root, http=http, data=data)
        self.assertEqual(session.start(), sw.EXIT_OK, err)
        self.assertEqual(len(spawner.calls), 1)
        argv = spawner.calls[0]["argv"]
        self.assertEqual(argv, [str(session.root / ".venv/bin/python"),
                                str(ROOT / "pairing.py"), "--data-dir", str(session.data_dir),
                                "heartbeat-loop", "--config", str(session.config)])
        self.assertIsInstance(argv, list)
        self.assertIn(str(data), argv)
        self.assertNotIn(FAKE_SECRET, "\n".join(out + err))

    def test_sender_is_not_duplicated_when_lock_is_held(self):
        self.api = ApiFixture(self)
        data = Path(self.tmp.name) / "paired data"
        self.assertEqual(pair_real(self.tmp.name, self.api.base, data=data)[0], 0)
        write_fresh_beat(data)
        http = FakeHttp(health=(200, {"status": "ok"}, ""),
                        node=(200, node_body(), ""))
        session, _runner, spawner, _http, out, err = make_setup(
            self.tmp.name, root=self.root, http=http, data=data, sender_lock=True)
        self.assertEqual(session.start(), sw.EXIT_OK, err)
        self.assertEqual(spawner.calls, [])
        self.assertIn("already running", "\n".join(out))

    def test_sender_exit_6_is_reported_as_already_running(self):
        self.api = ApiFixture(self)
        data = Path(self.tmp.name) / "paired data"
        self.assertEqual(pair_real(self.tmp.name, self.api.base, data=data)[0], 0)
        http = FakeHttp(health=(200, {"status": "ok"}, ""),
                        node=(200, node_body(), ""))
        spawner = FakeSpawner([FakeHandle([6])])
        session, _runner, spawner, _http, out, _err = make_setup(
            self.tmp.name, root=self.root, http=http, data=data, spawner=spawner)
        self.assertEqual(session.start(), sw.EXIT_OK)
        self.assertIn("another sender", "\n".join(out))

    def test_start_without_pairing_skips_sender(self):
        http = FakeHttp(health=[(None, {}, "refused"), (200, {"status": "ok"}, "")],
                        node=(200, node_body(), ""))
        session, _runner, spawner, _http, out, err = make_setup(
            self.tmp.name, root=self.root, http=http)
        self.assertEqual(session.start(), sw.EXIT_OK, err)
        self.assertEqual(len(spawner.calls), 1)
        self.assertIn("not paired", "\n".join(out))


class VerifyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = make_root(self.tmp.name)
        make_venv(self.root)
        self.api = ApiFixture(self)
        self.data = Path(self.tmp.name) / "paired data"
        self.assertEqual(pair_real(self.tmp.name, self.api.base, data=self.data)[0], 0)

    def session(self, **kw):
        http = kw.pop("http", FakeHttp(health=(200, {"status": "ok"}, ""),
                                       node=(200, node_body(), "")))
        return make_setup(self.tmp.name, root=self.root, data=self.data, http=http, **kw)

    def test_default_verify_never_runs_inference_and_reports_heartbeat_pending(self):
        session, _runner, _spawner, http, out, _err = self.session()
        self.assertEqual(session.verify(), sw.EXIT_NETWORK)
        self.assertEqual(http.count("/v1/execute"), 0)
        text = "\n".join(out)
        self.assertIn("inference=NOT EXERCISED", text)
        self.assertIn("heartbeat=awaiting", text)
        self.assertNotIn("inference-ready", text)

    def test_fresh_heartbeat_is_reachability_only(self):
        write_fresh_beat(self.data, usable=False)
        session, _runner, _spawner, http, out, _err = self.session()
        self.assertEqual(session.verify(), sw.EXIT_OK)
        self.assertEqual(http.count("/v1/execute"), 0)
        text = "\n".join(out)
        self.assertIn("reachability only", text)
        self.assertIn("inference=NOT EXERCISED", text)
        self.assertIn("usable=false", text)

    def test_mock_execute_is_reported_as_simulated(self):
        write_fresh_beat(self.data)
        http = FakeHttp(health=(200, {"status": "ok"}, ""),
                        node=(200, node_body(), ""),
                        execute=(200, {"simulated": True, "model_id": "mock-summary"}, ""))
        session, _runner, _spawner, http, out, _err = self.session(
            http=http, verify_inference=True)
        self.assertEqual(session.verify(), sw.EXIT_OK)
        self.assertEqual(http.count("/v1/execute"), 1)
        self.assertIn("inference=mock-simulated", "\n".join(out))

    def test_real_execute_is_reported_as_real_not_ready(self):
        write_fresh_beat(self.data)
        http = FakeHttp(health=(200, {"status": "ok"}, ""),
                        node=(200, node_body([{"id": "real", "simulated": False}]), ""),
                        execute=(200, {"simulated": False, "model_id": "real"}, ""))
        session, _runner, _spawner, http, out, _err = self.session(
            http=http, verify_inference=True)
        self.assertEqual(session.verify(), sw.EXIT_OK)
        text = "\n".join(out)
        self.assertIn("real-inference-exercised", text)
        self.assertIn("never inference-ready", text)
        self.assertNotIn("inference=READY", text)

    def test_unpaired_verify_is_incomplete(self):
        empty = Path(self.tmp.name) / "unpaired data"
        http = FakeHttp(health=(200, {"status": "ok"}, ""),
                        node=(200, node_body(), ""))
        session, _runner, _spawner, _http, out, _err = make_setup(
            self.tmp.name, root=self.root, data=empty, http=http)
        self.assertEqual(session.verify(), sw.EXIT_PAIRING)
        self.assertIn("NOT PAIRED", "\n".join(out))

    def test_missing_token_blocks_without_creation(self):
        session, _runner, _spawner, _http, _out, err = self.session(token=None)
        self.assertEqual(session.verify(), sw.EXIT_PREREQ)
        self.assertIn("token is missing", "\n".join(err))
        self.assertFalse((self.data / "api-token.txt").exists())

    def test_status_output_contains_no_secret_or_code(self):
        write_fresh_beat(self.data)
        session, _runner, _spawner, _http, out, err = self.session()
        self.assertEqual(session.status(), sw.EXIT_OK)
        text = "\n".join(out + err)
        self.assertNotIn(FAKE_SECRET, text)
        self.assertNotIn(FAKE_CODE, text)
        self.assertIn("paired", text)


class RedactionTests(unittest.TestCase):
    """Credentials handled in memory must not reappear in any diagnostic path."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = make_root(self.tmp.name)
        make_venv(self.root)
        self.data = Path(self.tmp.name) / "redaction data"

    def assert_no_secrets(self, text, state=None):
        self.assertNotIn(FAKE_CODE, text)
        self.assertNotIn(FAKE_TOKEN, text)
        self.assertNotIn(FAKE_SECRET, text)
        if state is not None:
            self.assertNotIn(FAKE_CODE, state)
            self.assertNotIn(FAKE_TOKEN, state)
            self.assertNotIn(FAKE_SECRET, state)

    def test_unexpected_pairing_error_redacts_code_and_known_token(self):
        sw.register_secret(FAKE_TOKEN)

        def explode(_code):
            raise RuntimeError("claim failed code=%s token=%s" % (FAKE_CODE, FAKE_TOKEN))

        session, _runner, _spawner, _http, _out, err = make_setup(
            self.tmp.name, root=self.root, data=self.data, pairer=explode)
        self.assertEqual(session.pair(FAKE_CODE), sw.EXIT_NETWORK)
        self.assert_no_secrets("\n".join(err),
                               session.state_path.read_text(encoding="utf-8"))

    def test_install_runner_failure_redacts_known_credentials(self):
        sw.register_secret(FAKE_CODE)
        sw.register_secret(FAKE_TOKEN)
        shutil.rmtree(self.root / ".venv")

        class RaisingRunner(FakeRunner):
            def __call__(self, argv, **kwargs):
                raise OSError("installer exploded with %s / %s" % (FAKE_CODE, FAKE_TOKEN))

        session, _runner, _spawner, _http, _out, err = make_setup(
            self.tmp.name, root=self.root, data=self.data, runner=RaisingRunner())
        self.assertEqual(session.install(), sw.EXIT_PREREQ)
        self.assert_no_secrets("\n".join(err),
                               session.state_path.read_text(encoding="utf-8"))

    def test_spawner_failure_redacts_token_registered_by_token_provider(self):
        class RaisingSpawner(FakeSpawner):
            def __call__(self, argv, *, cwd, env, log_path):
                raise OSError("daemon spawn failed with token=%s" % env["DENDRITE_API_TOKEN"])

        session, _runner, _spawner, _http, _out, err = make_setup(
            self.tmp.name, root=self.root, data=self.data,
            http=FakeHttp(health=(None, {}, "refused")), spawner=RaisingSpawner())
        self.assertEqual(session.start(), sw.EXIT_PREREQ)
        self.assert_no_secrets("\n".join(err),
                               session.state_path.read_text(encoding="utf-8"))

    def test_debug_traceback_never_prints_the_exception_text(self):
        sw.register_secret(FAKE_TOKEN)
        packet = "PAIRING CODE: %s\n" % FAKE_CODE

        def explode(_self, _code):
            raise RuntimeError("raw failure code=%s token=%s" % (FAKE_CODE, FAKE_TOKEN))

        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(sys, "stdin", io.StringIO(packet)), \
                patch.object(sw.Setup, "run", explode), \
                redirect_stdout(stdout), redirect_stderr(stderr):
            code = sw.main(["run", "--data-dir", str(self.data), "--packet-stdin",
                            "--debug", "--allow-unqualified-platform"])
        text = stdout.getvalue() + stderr.getvalue()
        self.assertEqual(code, sw.EXIT_USAGE)
        self.assert_no_secrets(text)
        self.assertIn("Traceback (most recent call last):", text)
        self.assertIn("RuntimeError", text)

    def test_sender_log_tail_redacts_inherited_heartbeat_key(self):
        api = ApiFixture(self)
        data = Path(self.tmp.name) / "paired log data"
        self.assertEqual(pair_real(self.tmp.name, api.base, data=data)[0], 0)

        class LoggingSpawner(FakeSpawner):
            def __call__(self, argv, *, cwd, env, log_path):
                Path(log_path).parent.mkdir(parents=True, exist_ok=True)
                Path(log_path).write_text(
                    "sender starting; key=%s\n" % FAKE_SECRET, encoding="utf-8")
                return super().__call__(argv, cwd=cwd, env=env, log_path=log_path)

        http = FakeHttp(health=(200, {"status": "ok"}, ""), node=(200, node_body(), ""))
        spawner = LoggingSpawner([FakeHandle([1])])
        session, _runner, spawner, _http, _out, err = make_setup(
            self.tmp.name, root=self.root, data=data, http=http, spawner=spawner)
        self.assertEqual(session.start(), sw.EXIT_NETWORK)
        text = "\n".join(err)
        self.assertIn("sender exited", text)
        self.assert_no_secrets(text)
        # Owner-only storage is necessary but does not make child-written logs
        # secret-free; this asserts only the path the orchestrator displays.
        self.assertIn(FAKE_SECRET, Path(spawner.calls[0]["log_path"]).read_text(encoding="utf-8"))


class WrapperTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.bin = Path(self.tmp.name) / "fake bin"
        self.bin.mkdir()
        self.record = Path(self.tmp.name) / "uv-args.txt"

    def make_uv(self, version, name="uv"):
        uv = self.bin / name
        uv.write_text(
            "#!/bin/sh\n"
            "if [ \"$1\" = \"--version\" ]; then echo \"uv %s\"; exit 0; fi\n"
            "printf '%%s\\n' \"$@\" > \"%s\"\n"
            "exit 0\n" % (version, self.record), encoding="utf-8")
        uv.chmod(0o755)
        return uv

    def make_bootstrap_python(self, uv_path, exit_code=0):
        record = Path(self.tmp.name) / "bootstrap-args.txt"
        script = self.bin / "python3"
        script.write_text(
            "#!/bin/sh\n"
            "printf '%%s\\n' \"$@\" >> \"%s\"\n"
            "if [ \"$1\" = \"-c\" ]; then exit 0; fi\n"
            "if [ \"%d\" -ne 0 ]; then exit %d; fi\n"
            "printf '%%s\\n' \"%s\"\n"
            % (record, exit_code, exit_code, uv_path), encoding="utf-8")
        script.chmod(0o755)
        return record

    def make_boot_uv(self, uv_path):
        args = Path(self.tmp.name) / "boot-uv-args.txt"
        envs = Path(self.tmp.name) / "boot-uv-env.txt"
        uv_path.write_text(
            "#!/bin/sh\n"
            "printf '%%s\\n' \"$@\" > \"%s\"\n"
            "printf '%%s\\n' \"$AIPSTER_UV\" > \"%s\"\n"
            "printf '%%s\\n' \"$PATH\" > \"%s.path\"\n"
            "exit 0\n" % (args, envs, envs), encoding="utf-8")
        uv_path.chmod(0o755)
        return args, envs

    def run_shell(self, *args, env_overrides=None):
        env = dict(os.environ)
        env["AIPSTER_UV"] = str(self.bin / "uv")
        env["PATH"] = str(self.bin) + ":" + env.get("PATH", "")
        env.pop("AIPSTER_PYTHON", None)
        if env_overrides:
            env.update(env_overrides)
        return subprocess.run(["sh", str(ROOT / "setup-worker.sh"), *args],
                              cwd=ROOT, env=env, text=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def test_shell_wrapper_runs_pinned_python_and_passes_arguments_as_argv(self):
        self.make_uv("0.12.12")
        result = self.run_shell("status", "--data-dir", str(Path(self.tmp.name) / "a b"))
        self.assertEqual(result.returncode, 0, result.stderr)
        recorded = self.record.read_text(encoding="utf-8").splitlines()
        self.assertEqual(recorded[:6], ["run", "--no-project", "--python", "3.12.14",
                                        "python", str(ROOT / "setup_worker.py")])
        self.assertEqual(recorded[-3:], ["status", "--data-dir",
                                         str(Path(self.tmp.name) / "a b")])

    def test_correct_global_uv_is_reused_without_bootstrap(self):
        self.make_uv("0.12.12")
        bootstrap_record = self.make_bootstrap_python(str(self.bin / "unused-uv"))
        result = self.run_shell("check")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(bootstrap_record.exists(), "a matching uv must not be bootstrapped")

    def test_wrong_global_uv_is_preserved_and_private_uv_is_used_for_child(self):
        wrong = self.make_uv("0.10.3")
        boot_dir = Path(self.tmp.name) / "private uv dir"
        boot_dir.mkdir()
        boot_uv = boot_dir / "uv"
        boot_args, boot_envs = self.make_boot_uv(boot_uv)
        bootstrap_record = self.make_bootstrap_python(boot_uv)
        result = self.run_shell("status", "--data-dir", str(Path(self.tmp.name) / "a b"),
                                env_overrides={"AIPSTER_UV": str(wrong)})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("not the pinned 0.12.12", result.stderr)
        self.assertEqual(wrong.read_text(encoding="utf-8").splitlines()[1],
                         "if [ \"$1\" = \"--version\" ]; then echo \"uv 0.10.3\"; exit 0; fi")
        self.assertIn(str(ROOT / "uv_bootstrap.py"), bootstrap_record.read_text(encoding="utf-8"))
        recorded = boot_args.read_text(encoding="utf-8").splitlines()
        self.assertEqual(recorded[:6], ["run", "--no-project", "--python", "3.12.14",
                                        "python", str(ROOT / "setup_worker.py")])
        self.assertEqual(recorded[-3:], ["status", "--data-dir",
                                         str(Path(self.tmp.name) / "a b")])
        self.assertEqual(boot_envs.read_text(encoding="utf-8").strip(), str(boot_uv))
        path = Path(str(boot_envs) + ".path").read_text(encoding="utf-8").split(":")[0]
        self.assertEqual(path, str(boot_dir))

    def test_missing_uv_bootstraps_into_a_private_path_for_the_child(self):
        boot_uv = self.bin / "boot uv"
        boot_args, boot_envs = self.make_boot_uv(boot_uv)
        self.make_bootstrap_python(boot_uv)
        env = dict(os.environ)
        env.pop("AIPSTER_UV", None)
        env["PATH"] = str(self.bin) + ":/usr/bin:/bin"
        result = subprocess.run(["sh", str(ROOT / "setup-worker.sh"), "check"],
                                cwd=ROOT, env=env, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(boot_args.read_text(encoding="utf-8").splitlines()[:6],
                         ["run", "--no-project", "--python", "3.12.14",
                          "python", str(ROOT / "setup_worker.py")])
        self.assertEqual(boot_envs.read_text(encoding="utf-8").strip(), str(boot_uv))

    def test_bootstrap_failure_propagates_and_does_not_run_the_orchestrator(self):
        self.make_uv("0.10.3")
        self.make_bootstrap_python(self.bin / "unused-uv", exit_code=7)
        result = self.run_shell("check")
        self.assertEqual(result.returncode, 7)
        self.assertIn("private pinned uv bootstrap failed", result.stderr)
        self.assertFalse(self.record.exists())

    def test_powershell_wrapper_is_pinned_and_has_no_argv_code_path(self):
        script = (ROOT / "setup-worker.ps1").read_text(encoding="utf-8")
        self.assertIn('"0.12.12"', script)
        self.assertIn("--python 3.12.14", script)
        self.assertIn("setup_worker.py", script)
        self.assertIn("uv_bootstrap.py", script)
        self.assertIn("AIPSTER_UV", script)
        self.assertNotIn("--code ", script)
        self.assertNotIn("--code=", script)
        if not shutil.which("pwsh"):
            self.skipTest("pwsh is not installed; static contract checked only")



class CliAndLockTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data = Path(self.tmp.name) / "cli data"
        self.api = ApiFixture(self)

    def test_cli_packet_stdin_pairs_without_code_in_argv_or_output(self):
        packet = "AIPSTER agent setup packet v2.\nPAIRING CODE: %s\nRUN: rm -rf /\n" % FAKE_CODE
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(sys, "stdin", io.StringIO(packet)), \
                redirect_stdout(stdout), redirect_stderr(stderr):
            code = sw.main(["pair", "--data-dir", str(self.data),
                            "--api-base", self.api.base,
                            "--config", str(ROOT / "configs" / "mock.toml"),
                            "--packet-stdin", "--allow-unqualified-platform"])
        text = stdout.getvalue() + stderr.getvalue()
        self.assertEqual(code, sw.EXIT_OK, text)
        self.assertNotIn(FAKE_CODE, text)
        self.assertNotIn(FAKE_SECRET, text)
        self.assertEqual(len(self.api.state.claims), 1)
        self.assertEqual(pairing.load_pairing(self.data)["resource_id"], "r_setup_fixture")

    def test_cli_rejects_argv_code(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            code = sw.main(["pair", "--data-dir", str(self.data),
                            "--code", FAKE_CODE])
        self.assertEqual(code, 2)
        self.assertEqual(self.api.state.claims, [])

    def test_cli_busy_lock_returns_75_without_installing(self):
        lock_path = self.data / "setup.lock"
        script = (
            "import sys, time\n"
            "from pathlib import Path\n"
            "sys.path.insert(0, sys.argv[1])\n"
            "import setup_worker\n"
            "lock = setup_worker.SetupLock(Path(sys.argv[2]))\n"
            "print('LOCKED' if lock.acquire() else 'BUSY', flush=True)\n"
            "time.sleep(3)\n")
        child = subprocess.Popen([sys.executable, "-c", script, str(ROOT), str(lock_path)],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), "LOCKED")
            root = make_root(self.tmp.name)
            runner = FakeRunner()
            session, runner, _spawner, _http, _out, _err = make_setup(
                self.tmp.name, root=root, runner=runner)
            stdout, stderr = io.StringIO(), io.StringIO()
            with redirect_stdout(stdout), redirect_stderr(stderr):
                # The CLI constructs its own session, so prove the lock gate directly:
                # a second setup session cannot take the same lock.
                second = sw.SetupLock(lock_path)
                acquired = second.acquire()
            self.assertFalse(acquired)
            self.assertEqual(runner.install_calls, [])
        finally:
            child.terminate()
            child.wait(timeout=5)
            for pipe in (child.stdout, child.stderr):
                if pipe is not None:
                    pipe.close()


class RunResumeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = make_root(self.tmp.name)
        self.api = ApiFixture(self)

    def test_interrupted_run_resumes_without_duplicate_install_claim_or_sender(self):
        runner = FakeRunner(on_install=lambda: make_venv(self.root))
        http = FakeHttp(health=[(None, {}, "refused"), (200, {"status": "ok"}, "")],
                        node=(200, node_body(), ""))
        spawner = FakeSpawner()
        session, runner, spawner, http, out, err = make_setup(
            self.tmp.name, root=self.root, runner=runner, http=http,
            spawner=spawner, data=Path(self.tmp.name) / "resume data")
        session.api_base = self.api.base
        calls = []

        def flaky(code):
            calls.append(code)
            if len(calls) == 1:
                raise KeyboardInterrupt
            returncode = session._default_pairer(code)
            write_fresh_beat(session.data_dir)
            return returncode

        session.pairer = flaky
        with self.assertRaises(KeyboardInterrupt):
            session.run(FAKE_CODE)
        self.assertEqual(session.state["phases"]["install"]["state"], "passed")
        self.assertEqual(session.state["phases"]["pair"]["state"], "in_progress")
        self.assertEqual(len(runner.install_calls), 1)

        resumed, runner, spawner, http, out, err = make_setup(
            self.tmp.name, root=self.root, runner=runner, http=http,
            spawner=spawner, data=session.data_dir, retry_pair=False)
        resumed.api_base = self.api.base
        resumed.pairer = flaky
        self.assertEqual(resumed.run(FAKE_CODE2), sw.EXIT_PAIRING)
        self.assertEqual(len(calls), 1, "uncertain resume must not consume another code")
        self.assertEqual(len(runner.install_calls), 1, "resume must not rerun install.py")
        self.assertEqual(len(self.api.state.claims), 0)

        retried, runner, spawner, http, out, err = make_setup(
            self.tmp.name, root=self.root, runner=runner, http=http,
            spawner=spawner, data=session.data_dir, retry_pair=True)
        retried.api_base = self.api.base
        retried.pairer = flaky
        self.assertEqual(retried.run(FAKE_CODE2), sw.EXIT_OK, "\n".join(out + err))
        self.assertEqual(len(calls), 2)
        self.assertEqual(len(self.api.state.claims), 1)
        self.assertEqual(len(runner.install_calls), 1)
        daemon_starts = [c for c in spawner.calls if "serve" in c["argv"]]
        sender_starts = [c for c in spawner.calls if "heartbeat-loop" in c["argv"]]
        self.assertEqual(len(daemon_starts), 1)
        self.assertEqual(len(sender_starts), 1)
        self.assertEqual(retried.state["phases"]["verify"]["state"], "passed")
        self.assertNotIn(FAKE_SECRET, retried.state_path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""Runnable synthetic harness driver for local-worker/setup_worker.py.

This driver is for genuine Codex/Muse harness qualification. It exercises the
real orchestrator (Setup.run/pair/start/verify) against:

  * a temporary fixture worker checkout and fake .venv executables;
  * a loopback-only fake AIPSTER claim API (real pairing.cmd_pair/storage);
  * injected fake runner/spawner/HTTP objects from Setup's public DI hooks.

It never installs anything, launches a worker/sender, reads a real credential,
uses a real AIPSTER account, contacts a live service, or runs inference. All
codes/keys/tokens are synthetic. Output is JSON with an explicit transcript
and a secret-absence check.

Two modes:

* ``--scenario`` (default): generated synthetic codes, per-scenario reports.
* ``--packet-stdin``: reads the documented synthetic packet from stdin with the
  real ``read_private_code`` parser, accepts only the published fixture code,
  then runs the real ``Setup.run`` engine with fakes. Emits one sanitized
  structured report. Create the 0600 input with ``--write-fixture-packet``.
"""
from __future__ import annotations

import argparse
import hmac
import json
import os
import shutil
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import pairing  # noqa: E402
import setup_worker as sw  # noqa: E402

FAKE_CODE = "pair-01234567-89AB-CDEF-GHJKMNPQ"
FAKE_CODE2 = "pair-aaaaaaaa-bbbb-cccc-ddddeeee"
FAKE_SECRET = "synthetic-heartbeat-key-0123456789abcdef"
FAKE_TOKEN = "synthetic-daemon-token-0123456789abcdef"
FIXTURE_SCHEMA = "aipster-setup-worker-harness/1"
FIXTURE_PACKET_SCHEMA = "aipster-setup-worker-harness-packet/1"

READINESS_FACTS = ("installed", "paired", "reachable", "usable", "inference_qualified")


def build_fixture_packet() -> str:
    """The exact, documented synthetic packet accepted by --packet-stdin.

    It follows the v2 setup-packet shape (one ``PAIRING CODE:`` data line) but
    carries only the published fixture code. The fixture driver refuses every
    other value, so this file can never pair a real node.
    """
    return (
        "AIPSTER agent setup packet v2.\n"
        "\n"
        "SYNTHETIC FIXTURE - NOT A REAL PAIRING CODE\n"
        "\n"
        "  PAIRING CODE: %s\n"
        "\n"
        "This packet belongs to local-worker/setup_worker_fixture.py. It only\n"
        "drives the synthetic harness: the fixture driver rejects every code\n"
        "except the one above, pairs against a loopback claim API, and never\n"
        "installs, enrolls, spawns a worker, or runs inference on this machine.\n"
    ) % FAKE_CODE


def write_fixture_packet(path: Path) -> Path:
    """Create the private fixture packet with mode 0600; never overwrite."""
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(str(path), flags, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(build_fixture_packet())
    except BaseException:
        try:
            os.unlink(str(path))
        except OSError:
            pass
        raise
    os.chmod(str(path), 0o600)  # umask can only remove bits; make it exact
    return path


def require_fixture_code(code: Optional[str]) -> str:
    """Accept only the documented synthetic code; never echo the input."""
    if not isinstance(code, str) or not hmac.compare_digest(code, FAKE_CODE):
        raise FixtureFailure("input is not the documented synthetic fixture code")
    return code


class FixtureFailure(RuntimeError):
    pass


def check(condition: bool, label: str, checks: List[Dict[str, Any]]) -> None:
    checks.append({"check": label, "passed": bool(condition)})
    if not condition:
        raise FixtureFailure(label)


class FakeResult:
    def __init__(self, returncode: int = 0, stdout: str = ""):
        self.returncode = returncode
        self.stdout = stdout


class FakeRunner:
    def __init__(self, root: Path):
        self.root = root
        self.install_calls = []

    def __call__(self, argv, *, cwd=None, env=None, timeout=None, capture=False):
        if capture:
            return FakeResult(0, "uv 0.12.12\n")
        self.install_calls.append(list(argv))
        bindir = self.root / ".venv" / ("Scripts" if os.name == "nt" else "bin")
        bindir.mkdir(parents=True, exist_ok=True)
        for name in (("python.exe", "dendrite.exe") if os.name == "nt" else ("python", "dendrite")):
            path = bindir / name
            path.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            path.chmod(0o755)
        return FakeResult(0)


class FakeHandle:
    next_pid = 7000

    def __init__(self, poll_sequence: Optional[Sequence[int]] = None):
        FakeHandle.next_pid += 1
        self.pid = FakeHandle.next_pid
        self.poll_sequence = list(poll_sequence or [])
        self.terminated = False

    def poll(self):
        return self.poll_sequence.pop(0) if self.poll_sequence else None

    def terminate(self):
        self.terminated = True

    def wait(self, timeout=5.0):
        return None


class FakeSpawner:
    def __init__(self):
        self.calls = []

    def __call__(self, argv, *, cwd, env, log_path):
        self.calls.append({"argv": list(argv), "cwd": str(cwd), "env": dict(env),
                           "log_path": str(log_path)})
        return FakeHandle()

    def count(self, marker: str) -> int:
        return sum(1 for call in self.calls if marker in call["argv"])


class FakeHttp:
    def __init__(self):
        self.calls = []
        self.health_responses = [(None, {}, "refused"), (200, {"status": "ok"}, "")]
        self.node = (200, {"node_id": "standalone-demo", "models": [
            {"id": "mock-summary", "runtime": "mock", "simulated": True,
             "capabilities": ["summarize"], "available": True}]}, "")
        self.execute = (200, {"simulated": True, "model_id": "mock-summary"}, "")

    @staticmethod
    def _next(value):
        if isinstance(value, list):
            return value.pop(0) if len(value) > 1 else value[0]
        return value

    def request(self, method, url, token=None, payload=None, timeout=2.0):
        self.calls.append({"method": method, "url": url, "token": token,
                           "payload": payload, "timeout": timeout})
        if url.endswith("/healthz"):
            if isinstance(self.health_responses, list):
                return self.health_responses.pop(0) if len(self.health_responses) > 1 \
                    else self.health_responses[0]
            return self.health_responses
        if url.endswith("/v1/node"):
            return self.node
        if url.endswith("/v1/execute"):
            return self.execute
        return 404, {}, "unknown route"

    def count(self, suffix):
        return sum(1 for call in self.calls if call["url"].endswith(suffix))


class FakeApiState:
    def __init__(self):
        self.claims = []


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
            if self.path == "/api/pairing/claim":
                try:
                    state.claims.append(json.loads(raw.decode()))
                except ValueError:
                    state.claims.append({})
                self._send(201, {
                    "resourceId": "r_setup_fixture", "heartbeatKey": FAKE_SECRET,
                    "keyId": "k_setup_fixture", "keyPrefix": "aip_live_k_setup_fixture_syn",
                    "heartbeatUrl": "/api/resources/r_setup_fixture/heartbeat", "created": True})
            else:
                self._send(404, {"error": "no", "code": "NOT_FOUND"})

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, "http://127.0.0.1:%d" % server.server_port


def make_fixture_root(tmp: Path) -> Path:
    root = tmp / "worker root"
    (root / "configs").mkdir(parents=True)
    (root / "install.py").write_text("# synthetic installer fixture\n", encoding="utf-8")
    (root / "pairing.py").write_text("# synthetic marker\n", encoding="utf-8")
    shutil.copy(ROOT / "configs" / "mock.toml", root / "configs" / "mock.toml")
    return root


def make_venv(root: Path) -> None:
    bindir = root / ".venv" / ("Scripts" if os.name == "nt" else "bin")
    bindir.mkdir(parents=True, exist_ok=True)
    for name in (("python.exe", "dendrite.exe") if os.name == "nt" else ("python", "dendrite")):
        path = bindir / name
        path.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        path.chmod(0o755)


def make_session(tmp: Path, root: Path, data: Path, base: str, *,
                 retry_pair: bool = False, verify_inference: bool = False,
                 sender_lock: bool = False, http: Optional[FakeHttp] = None,
                 hostname: str = "fixture-host", expect_target: Optional[str] = None):
    out: List[str] = []
    err: List[str] = []
    runner = FakeRunner(root)
    spawner = FakeSpawner()
    http = http or FakeHttp()
    session = sw.Setup(
        root=root, data_dir=data, config=root / "configs" / "mock.toml",
        api_base=base, allow_unqualified=True, retry_pair=retry_pair,
        verify_inference=verify_inference, runner=runner, spawner=spawner,
        http=http, token_provider=lambda create=True: FAKE_TOKEN,
        sender_lock_probe=lambda _data: sender_lock,
        which=lambda _name: "/synthetic/uv",
        port_open=lambda _host, _port: False,
        platform_name="posix", machine="arm64",
        hostname=lambda: hostname, expect_target=expect_target,
        clock=(lambda: time.monotonic()), sleep=lambda _seconds: None,
        out=out.append, err=err.append, start_timeout=0.0, heartbeat_wait=0.0)
    return session, runner, spawner, http, out, err


def write_fresh_beat(data: Path) -> None:
    meta = pairing.load_pairing(data)
    pairing.write_status(data, {"at": time.time(), "ok": True, "usable": False,
                                "heartbeatAt": "2026-11-01T00:00:00.000Z"}, meta)


def paired_setup(tmp: Path, base: str) -> Tuple[Path, Path]:
    root = make_fixture_root(tmp)
    data = tmp / "paired data with spaces"
    args = argparse.Namespace(api_base=base, data_dir=str(data), config=None,
                              name=None, code=FAKE_CODE)
    if pairing.cmd_pair(args) != 0:
        raise FixtureFailure("synthetic pairing failed")
    return root, data


def assert_absent(*texts: str) -> None:
    joined = "\n".join(texts)
    for secret in (FAKE_CODE, FAKE_CODE2, FAKE_SECRET, FAKE_TOKEN):
        if secret in joined:
            raise FixtureFailure("a synthetic secret appeared in output/state")


def scenario_happy(tmp: Path, base: str) -> Dict[str, Any]:
    root = make_fixture_root(tmp)
    session, runner, spawner, http, out, err = make_session(
        tmp, root, tmp / "data", base, verify_inference=True)

    def pairer(code):
        returncode = session._default_pairer(code)
        write_fresh_beat(session.data_dir)
        return returncode

    session.pairer = pairer
    rc = session.run(lambda: FAKE_CODE)  # deferred: read after install, before pairing
    checks: List[Dict[str, Any]] = []
    check(rc == 0, "run exits 0", checks)
    check(len(runner.install_calls) == 1, "install.py invoked once", checks)
    check(spawner.count("serve") == 1, "one daemon spawn", checks)
    check(spawner.count("heartbeat-loop") == 1, "one sender spawn", checks)
    check("inference=mock-simulated" in "\n".join(out),
          "mock inference labeled simulated", checks)
    check(http.count("/v1/execute") == 1, "explicit inference opt-in sent one request", checks)
    check(session.state["phases"]["verify"]["state"] == "passed", "verify passed", checks)
    text = "\n".join(out + err)
    state_text = session.state_path.read_text(encoding="utf-8")
    assert_absent(text, state_text)
    checks.append({"check": "no synthetic secret in output/state", "passed": True})
    return {"checks": checks, "transcript": out + err,
            "facts": {"claims": 1, "install_calls": 1, "daemon_spawns": 1,
                      "sender_spawns": 1, "inference": "mock-simulated"}}


def scenario_resume(tmp: Path, base: str) -> Dict[str, Any]:
    root = make_fixture_root(tmp)
    session, runner, spawner, http, out, err = make_session(
        tmp, root, tmp / "resume data", base)
    calls: List[str] = []

    def flaky(code):
        calls.append(code)
        if len(calls) == 1:
            raise KeyboardInterrupt
        returncode = session._default_pairer(code)
        write_fresh_beat(session.data_dir)
        return returncode

    session.pairer = flaky
    interrupted = False
    try:
        session.run(FAKE_CODE)
    except KeyboardInterrupt:
        interrupted = True
    checks: List[Dict[str, Any]] = []
    check(interrupted, "first run interrupted during pairing", checks)
    check(session.state["phases"]["install"]["state"] == "passed", "install persisted", checks)
    check(session.state["phases"]["pair"]["state"] == "in_progress",
          "pair attempt persisted as in_progress", checks)

    resumed, runner2, spawner2, http2, out2, err2 = make_session(
        tmp, root, session.data_dir, base, retry_pair=False)
    resumed.pairer = flaky
    check(resumed.run(FAKE_CODE2) == sw.EXIT_PAIRING,
          "resume without --retry-pair refuses to burn another code", checks)
    check(len(calls) == 1, "no second pairing dispatch", checks)
    check(len(runner.install_calls) + len(runner2.install_calls) == 1,
          "resume did not rerun install", checks)

    retried, runner3, spawner3, http3, out3, err3 = make_session(
        tmp, root, session.data_dir, base, retry_pair=True)
    retried.pairer = flaky
    check(retried.run(FAKE_CODE2) == 0, "explicit retry completes", checks)
    check(len(calls) == 2, "exactly one new pairing dispatch", checks)
    install_calls = len(runner.install_calls) + len(runner2.install_calls) + len(runner3.install_calls)
    check(install_calls == 1, "install still ran only once", checks)
    check(spawner3.count("serve") == 1, "one daemon spawn across resume", checks)
    check(spawner3.count("heartbeat-loop") == 1, "one sender spawn across resume", checks)
    text = "\n".join(out + err + out2 + err2 + out3 + err3)
    state_text = retried.state_path.read_text(encoding="utf-8")
    assert_absent(text, state_text)
    checks.append({"check": "no synthetic secret in output/state", "passed": True})
    return {"checks": checks, "transcript": out + err + out2 + err2 + out3 + err3,
            "facts": {"pair_dispatch": 2, "install_calls": 1, "daemon_spawns": 1,
                      "sender_spawns": 1, "retry_required": True}}


def scenario_duplicate_sender(tmp: Path, base: str) -> Dict[str, Any]:
    root, data = paired_setup(tmp, base)
    make_venv(root)
    write_fresh_beat(data)
    http = FakeHttp()
    http.health_responses = (200, {"status": "ok"}, "")
    session, _runner, spawner, http, out, err = make_session(
        tmp, root, data, base, sender_lock=True, http=http)
    rc = session.start()
    checks: List[Dict[str, Any]] = []
    check(rc == 0, "start exits 0", checks)
    check(spawner.calls == [], "no daemon/sender spawn when both already exist", checks)
    check("already running" in "\n".join(out), "existing sender reuse reported", checks)
    check(session.state["phases"]["start"]["state"] == "passed", "start state passed", checks)
    text = "\n".join(out + err)
    state_text = session.state_path.read_text(encoding="utf-8")
    assert_absent(text, state_text)
    checks.append({"check": "no synthetic secret in output/state", "passed": True})
    return {"checks": checks, "transcript": out + err,
            "facts": {"daemon_spawns": 0, "sender_spawns": 0,
                      "existing_instance_reused": True}}


def scenario_verify_honesty(tmp: Path, base: str) -> Dict[str, Any]:
    root, data = paired_setup(tmp, base)
    http = FakeHttp()
    http.health_responses = (200, {"status": "ok"}, "")
    session, _runner, _spawner, http, out, err = make_session(
        tmp, root, data, base, http=http)
    rc = session.verify()
    checks: List[Dict[str, Any]] = []
    text = "\n".join(out + err)
    check(rc == sw.EXIT_NETWORK, "missing heartbeat is not a pass", checks)
    check("inference=NOT EXERCISED" in text, "inference explicitly not exercised", checks)
    check("heartbeat=awaiting" in text, "heartbeat pending reported", checks)
    check(http.count("/v1/execute") == 0, "default verify made no execute request", checks)

    write_fresh_beat(data)
    out2: List[str] = []
    session.out = out2.append
    rc2 = session.verify()
    text2 = "\n".join(out2)
    check(rc2 == 0, "fresh heartbeat verifies reachability", checks)
    check("reachability only" in text2, "reachability is not called inference readiness", checks)
    check("inference=NOT EXERCISED" in text2, "still no inference claim", checks)
    assert_absent(text, text2)
    checks.append({"check": "no synthetic secret in output", "passed": True})
    return {"checks": checks, "transcript": out + err + out2,
            "facts": {"heartbeat_pending_exit_before": sw.EXIT_NETWORK,
                      "heartbeat_pending_exit_after": 0,
                      "execute_requests": 0, "inference": "not-exercised"}}


def scenario_target_mismatch(tmp: Path, base: str) -> Dict[str, Any]:
    """ONB 04: an assistant must not mutate a machine it was not asked to pair."""
    root = make_fixture_root(tmp)
    data = tmp / "target data"
    session, runner, spawner, _http, out, err = make_session(
        tmp, root, data, base, hostname="assistant-sandbox", expect_target="0" * 16)
    rc = session.run(FAKE_CODE)
    checks: List[Dict[str, Any]] = []
    text = "\n".join(out + err)
    check(rc == sw.EXIT_USAGE, "mismatched target exits 2", checks)
    check("TARGET_MISMATCH" in text, "the refused target is named", checks)
    check(runner.install_calls == [], "install.py never ran", checks)
    check(spawner.calls == [], "no daemon or sender spawned", checks)
    check(not session.state_path.exists(), "no checkpoint written for a refused machine", checks)
    check(not (data / "pairing.json").exists(), "no pairing store written", checks)
    return {"checks": checks, "transcript": out + err,
            "facts": {"exit": rc, "install_calls": 0, "spawns": 0,
                      "mutation_before_refusal": False}}

def scenario_stale_heartbeat(tmp: Path, base: str) -> Dict[str, Any]:
    """ONB 29 (engine side): a copied or stale beat never becomes reachable."""
    root, data = paired_setup(tmp, base)
    http = FakeHttp()
    http.health_responses = (200, {"status": "ok"}, "")
    meta = pairing.load_pairing(data)
    pairing.write_status(data, {"at": time.time() - pairing.STATUS_STALE_SEC - 5,
                                "ok": True, "usable": True,
                                "heartbeatAt": "2026-11-01T00:00:00.000Z"}, meta)
    session, _runner, _spawner, http, out, err = make_session(
        tmp, root, data, base, http=http)
    rc = session.verify()
    checks: List[Dict[str, Any]] = []
    text = "\n".join(out + err)
    check(rc == sw.EXIT_NETWORK, "stale heartbeat is not a pass", checks)
    check("heartbeat=stale" in text, "staleness reported explicitly", checks)
    check("fact usable=unknown" in text, "stale usable=true is not reported as usable", checks)
    check("fact reachable=no" in text, "stale beat is not reachable", checks)
    check("usable=true" not in text, "no stale usable claim leaks into output", checks)
    check(http.count("/v1/execute") == 0, "no inference request", checks)
    assert_absent(text)
    return {"checks": checks, "transcript": out + err,
            "facts": {"exit": rc, "stale_after_sec": pairing.STATUS_STALE_SEC,
                      "execute_requests": 0}}


def scenario_structured_status(tmp: Path, base: str) -> Dict[str, Any]:
    """ONB 10: the machine result agrees with the facts and the exit code."""
    root, data = paired_setup(tmp, base)
    make_venv(root)
    write_fresh_beat(data)
    http = FakeHttp()
    http.health_responses = (200, {"status": "ok"}, "")
    session, _runner, _spawner, http, out, err = make_session(
        tmp, root, data, base, http=http)
    rc = session.verify()
    document = session.status_document("verify", rc)
    text = json.dumps(document, sort_keys=True)
    checks: List[Dict[str, Any]] = []
    check(rc == 0, "verify exits 0", checks)
    check(document["schema"] == sw.STATUS_SCHEMA, "versioned status schema", checks)
    check(document["outcome"] == "complete", "outcome agrees with exit 0", checks)
    check(document["exit_code"] == rc, "exit_code echoed", checks)
    check(document["target"] == "connection", "declared target is connection", checks)
    check(document["next_action"] is None, "complete setup has no next action", checks)
    check(document["facts"]["usable"]["value"] == "false",
          "usable=false while connection completes", checks)
    check(document["facts"]["usable"]["authoritative"] is False,
          "usable is not presented as authoritative", checks)
    check(len(document["facts"]) == 5, "five readiness facts", checks)
    assert_absent(text)
    checks.append({"check": "no synthetic secret in the JSON result", "passed": True})
    return {"checks": checks, "transcript": out + err + [text],
            "facts": {"outcome": document["outcome"], "exit": rc,
                      "facts": sorted(document["facts"])}}


def scenario_checkpoint_corrupt(tmp: Path, base: str) -> Dict[str, Any]:
    """ONB 05/06: a damaged checkpoint fails closed without guessing a restart."""
    root, data = paired_setup(tmp, base)
    make_venv(root)
    state = data / "setup-state.json"
    state.write_text(json.dumps({"schema": sw.STATE_SCHEMA,
                                 "phases": {"pair": {"state": "in_progress"}},
                                 "processes": {}}) + "\ntrailing", encoding="utf-8")
    before = state.read_bytes()
    runner = FakeRunner(root)
    spawner = FakeSpawner()
    error = None
    try:
        sw.Setup(root=root, data_dir=data, config=root / "configs" / "mock.toml",
                 api_base=base, allow_unqualified=True, runner=runner, spawner=spawner,
                 http=FakeHttp(), token_provider=lambda create=True: FAKE_TOKEN,
                 sender_lock_probe=lambda _data: False, which=lambda _name: "/synthetic/uv",
                 port_open=lambda _host, _port: False, platform_name="posix",
                 machine="arm64", hostname=lambda: "fixture-host",
                 out=lambda _line: None, err=lambda _line: None)
    except sw.SetupError as exc:
        error = exc
    checks: List[Dict[str, Any]] = []
    check(error is not None, "construction fails instead of starting fresh", checks)
    check(error is not None and error.code == "STATE_UNREADABLE",
          "checkpoint is diagnosed as unreadable", checks)
    check(state.read_bytes() == before, "checkpoint bytes are preserved", checks)
    check(b'"state": "in_progress"' in before, "pending pairing intent remains legible", checks)
    check(pairing.pairing_files(data)["meta"].exists(), "enrollment is preserved", checks)
    check(runner.install_calls == [], "no installer ran", checks)
    check(spawner.calls == [], "no process was spawned", checks)
    return {"checks": checks, "transcript": [str(error) if error else "no error"],
            "facts": {"error": error.code if error else None,
                      "checkpoint_preserved": True, "install_calls": 0, "spawns": 0}}


def _readiness(document: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    facts = (document or {}).get("facts") or {}
    result = {}
    for name in READINESS_FACTS:
        fact = facts.get(name) or {}
        result[name] = {"value": fact.get("value", "unknown"),
                        "source": fact.get("source", "not observed")}
    if isinstance(facts.get("usable"), dict):
        result["usable"]["authoritative"] = bool(facts["usable"].get("authoritative"))
    return result


def _packet_report(*, accepted: bool, rc: int, document: Dict[str, Any],
                   checks: List[Dict[str, Any]], events: List[str],
                   verify_inference: bool, passed: bool) -> Dict[str, Any]:
    """One sanitized report: five facts, one status document, no transcript."""
    return {
        "schema": FIXTURE_SCHEMA,
        "mode": "packet-stdin",
        "provider": "synthetic-fixture",
        "synthetic_only": True,
        "private_input": {
            "channel": "stdin",
            "documented_schema": FIXTURE_PACKET_SCHEMA,
            "accepted": accepted,
            "code_shape_accepted": "documented-synthetic-fixture-code-only",
        },
        "live_network": False,
        "live_credentials": False,
        "live_services": False,
        "live_inference": False,
        "engine": {
            "command": "run",
            "real_parse_engine_run": True,
            "code_read_events": list(events),
            "deferred_read_after_install": events == ["code-read-after-install"],
            "verify_inference": bool(verify_inference),
        },
        "readiness": _readiness(document),
        "status": document,
        "checks": checks,
        "passed": bool(passed),
    }


def run_packet_stdin(base: str, stdin: Any = None,
                     verify_inference: bool = False) -> Dict[str, Any]:
    """Drive the real private-stdin parser and the real Setup engine.

    The packet is read with ``setup_worker.read_private_code`` (the production
    parser), and only the documented synthetic code is allowed through. The
    engine then runs against temp roots with FakeRunner/FakeSpawner/FakeHttp
    and a loopback claim API. Nothing on this machine is installed, enrolled,
    spawned, or sent to a live endpoint.
    """
    stdin = stdin if stdin is not None else sys.stdin
    args = argparse.Namespace(packet_stdin=True, code_stdin=False, code_fd=None)
    checks: List[Dict[str, Any]] = []
    events: List[str] = []
    with tempfile.TemporaryDirectory(prefix="aipster-setup-packet-") as temp:
        tmp = Path(temp)
        try:
            code = require_fixture_code(sw.read_private_code(args, stdin=stdin))
        except sw.SetupError as exc:
            document = sw.standalone_status_document(
                "run", exc.exit_code, {"code": exc.code, "detail": str(exc)})
            checks.append({"check": "private input refused by the real parser",
                           "passed": False, "code": exc.code})
            return _packet_report(accepted=False, rc=exc.exit_code, document=document,
                                  checks=checks, events=events,
                                  verify_inference=verify_inference, passed=False)
        except FixtureFailure as exc:
            document = sw.standalone_status_document(
                "run", sw.EXIT_USAGE, {"code": "FIXTURE_INPUT_REFUSED",
                                       "detail": str(exc)})
            checks.append({"check": "only the documented synthetic code is accepted",
                           "passed": False, "code": "FIXTURE_INPUT_REFUSED"})
            return _packet_report(accepted=False, rc=sw.EXIT_USAGE, document=document,
                                  checks=checks, events=events,
                                  verify_inference=verify_inference, passed=False)
        checks.append({"check": "stdin packet parsed by the real private parser",
                       "passed": True})
        checks.append({"check": "only the documented synthetic code was accepted",
                       "passed": True})

        root = make_fixture_root(tmp)
        try:
            session, runner, spawner, http, out, err = make_session(
                tmp, root, tmp / "packet data", base,
                verify_inference=verify_inference)
        except sw.SetupError as exc:
            document = sw.standalone_status_document(
                "run", exc.exit_code, {"code": exc.code, "detail": str(exc)})
            checks.append({"check": "engine construction reported a sanitized block",
                           "passed": True, "code": exc.code})
            return _packet_report(accepted=True, rc=exc.exit_code, document=document,
                                  checks=checks, events=events,
                                  verify_inference=verify_inference, passed=False)

        def pairer(value):
            returncode = session._default_pairer(value)
            write_fresh_beat(session.data_dir)
            return returncode

        session.pairer = pairer

        def code_source():
            events.append("code-read-after-install" if runner.install_calls
                          else "code-read-before-install")
            return code

        rc = session.run(code_source)
        document = session.status_document("run", rc)

        check(rc == 0, "real Setup.run exits 0", checks)
        check(len(runner.install_calls) == 1, "install ran once against the temp root", checks)
        check(spawner.count("serve") == 1, "one synthetic daemon spawn", checks)
        check(spawner.count("heartbeat-loop") == 1, "one synthetic sender spawn", checks)
        check(events == ["code-read-after-install"],
              "engine consumed the private input after install", checks)
        check(document["schema"] == sw.STATUS_SCHEMA, "versioned status document", checks)
        check(document["exit_code"] == rc, "status exit code agrees with the engine", checks)
        check(document["outcome"] == "complete", "connection target completed", checks)
        check(sorted(document["facts"]) == sorted(READINESS_FACTS),
              "five readiness facts are separate", checks)
        check(document["facts"]["paired"]["value"] == "yes", "pairing completed", checks)
        check(document["facts"]["usable"]["value"] == "false",
              "connection completes while usable is false", checks)
        check(document["facts"]["usable"]["authoritative"] is False,
              "usable is not presented as authoritative", checks)
        check(document["facts"]["inference_qualified"]["value"].startswith("no"),
              "inference is not claimed as qualified", checks)
        check(http.count("/v1/execute") == (1 if verify_inference else 0),
              "inference ran only when explicitly requested", checks)
        return _packet_report(accepted=True, rc=rc, document=document, checks=checks,
                              events=events, verify_inference=verify_inference,
                              passed=rc == 0)


SCENARIOS = {
    "happy": scenario_happy,
    "resume": scenario_resume,
    "duplicate-sender": scenario_duplicate_sender,
    "verify-honesty": scenario_verify_honesty,
    "target-mismatch": scenario_target_mismatch,
    "stale-heartbeat": scenario_stale_heartbeat,
    "structured-status": scenario_structured_status,
    "checkpoint-corrupt": scenario_checkpoint_corrupt,
}


def run_scenario(name: str, base: str) -> Dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="aipster-setup-fixture-") as temp:
        report = SCENARIOS[name](Path(temp), base)
    report.update(schema=FIXTURE_SCHEMA, scenario=name, passed=True,
                  live_network=False, live_credentials=False, live_services=False,
                  live_inference=False, provider="synthetic-fixture")
    return report


def _secret_echoed(text: str) -> bool:
    return any(secret in text for secret in (FAKE_CODE, FAKE_CODE2, FAKE_SECRET, FAKE_TOKEN))


def _emit(report: Dict[str, Any], json_out: Optional[str]) -> int:
    text = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if _secret_echoed(text):
        # Never echo a code or token, even a synthetic one. Replace the whole
        # report rather than trying to edit it.
        text = json.dumps({
            "schema": FIXTURE_SCHEMA, "mode": "packet-stdin", "passed": False,
            "synthetic_only": True, "error": "report suppressed: credential echo detected",
            "live_network": False, "live_credentials": False,
            "live_services": False, "live_inference": False}, indent=2, sort_keys=True) + "\n"
        report = json.loads(text)
    if json_out:
        Path(json_out).write_text(text, encoding="utf-8")
    sys.stdout.write(text)
    return 0 if report.get("passed") else 1


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scenario", action="append", choices=sorted(SCENARIOS),
                        help="scenario to run (repeatable; default: all)")
    parser.add_argument("--packet-stdin", action="store_true",
                        help="read the documented synthetic packet from stdin with the "
                             "real private parser, then run the real Setup engine with fakes")
    parser.add_argument("--write-fixture-packet", default=None, metavar="PATH",
                        help="create the private (0600) synthetic fixture packet at PATH")
    parser.add_argument("--verify-inference", action="store_true",
                        help="with --packet-stdin, send one request to the fake loopback node")
    parser.add_argument("--json-out", default=None,
                        help="also write the JSON report to this path")
    args = parser.parse_args(argv)
    if args.write_fixture_packet and (args.packet_stdin or args.scenario):
        parser.error("--write-fixture-packet cannot be combined with --packet-stdin or --scenario")
    if args.packet_stdin and args.scenario:
        parser.error("choose one mode: --packet-stdin or --scenario")

    if args.write_fixture_packet:
        try:
            path = write_fixture_packet(Path(args.write_fixture_packet))
        except OSError as exc:
            print(json.dumps({"schema": FIXTURE_PACKET_SCHEMA, "written": False,
                              "error": type(exc).__name__}, sort_keys=True))
            return 1
        print(json.dumps({"schema": FIXTURE_PACKET_SCHEMA, "written": True,
                          "path": str(path), "mode": "0600",
                          "content": "documented synthetic fixture packet (not a real code)"},
                         sort_keys=True))
        return 0

    if args.packet_stdin:
        state = FakeApiState()
        server, base = make_api_server(state)
        try:
            report = run_packet_stdin(base, verify_inference=args.verify_inference)
        finally:
            server.shutdown()
            server.server_close()
        return _emit(report, args.json_out)

    names = args.scenario or list(SCENARIOS)
    state = FakeApiState()
    server, base = make_api_server(state)
    reports = []
    failed = False
    try:
        for name in names:
            try:
                reports.append(run_scenario(name, base))
            except Exception as exc:  # noqa: BLE001 - report fixture failure as data
                failed = True
                reports.append({"schema": FIXTURE_SCHEMA, "scenario": name,
                                "passed": False, "error": "%s: %s" % (type(exc).__name__, exc),
                                "live_network": False, "live_credentials": False,
                                "live_services": False, "live_inference": False})
    finally:
        server.shutdown()
        server.server_close()
    report = {"schema": FIXTURE_SCHEMA, "provider": "synthetic-fixture",
              "passed": not failed, "scenarios": reports,
              "live_network": False, "live_credentials": False,
              "live_services": False, "live_inference": False}
    return _emit(report, args.json_out)


if __name__ == "__main__":
    raise SystemExit(main())

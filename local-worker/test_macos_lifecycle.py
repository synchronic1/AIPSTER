"""macOS/POSIX lifecycle regressions. Stdlib only; no venv needed.

LOCAL WORKER qualification lane for the eventual fabric -> worker ->
Ganglion inference test. Fake runtimes and temporary profiles first;
heartbeat success is not inference proof.

Temporary ports/stores only; verified PIDs before any signal. Never the
real data dir, real worker ports, or the running sender. No live model
requests.

Interfaces (reconciled 2026-11-01 on origin/main f6e45f5; vendor from 0763d87):
- pairing.py: pair, heartbeat-once/loop, status, unpair, private_dir,
  write_private, load_or_create_node_id, load_pairing, managed_key_files,
  pair_lock, plus shipped R4 sender-lock API: _hold_sender_lock,
  sender_lock_held, EXIT_SENDER_RUNNING=6 (msvcrt/flock, OS-released,
  stale file never counts; heartbeat-once never locks). PR62's divergent
  sender_lock contextmanager (exit 2) is NOT retained.
- pairing.py private_dir: verify-don't-repair (5d91c1f); existing POSIX
  dirs are verified user-only, owner-only modes untouched, shared modes
  fail PRIVATE_STORAGE. No silent 0o300->0o700 repair.
- packaging/aipster_tray/child.py: WorkerChild, SenderChild, sender_argv,
  _stop_own_process (verified POSIX group termination; Windows unchanged)
- packaging/aipster_tray/controller.py: Controller.start_sender,
  Controller.launch_pair (shlex/list2cmdline display quoting) plus R4
  external-sender recognition (probe, exit-6 poll, overlay)
"""
import argparse
import contextlib
import io
import json
import os
import shlex
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.request import urlopen, Request
from urllib.error import URLError

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "packaging"))

import pairing

FAKE_SECRET = "synthetic-macos-lifecycle-key-0123456789abcd"


def find_free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    assert port not in (8081, 8090), f"ephemeral collision: {port}"
    return port


def wait_for_port(port, timeout=10):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                return True
        except OSError:
            time.sleep(0.05)
    return False


def wait_for_port_free(port, timeout=10):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                time.sleep(0.05)
                continue
        except OSError:
            return True
    return False


def is_pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except (OSError, ProcessLookupError):
        return False


def pid_cmdline(pid):
    try:
        out = subprocess.run(
            ["ps", "-p", str(pid), "-o", "args="],
            capture_output=True, text=True, timeout=5,
        )
        if out.returncode != 0:
            return ""
        return (out.stdout or "").strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def assert_pid_is_ours(testcase, pid, marker):
    testcase.assertTrue(is_pid_alive(pid), f"PID {pid} not alive for {marker!r}")
    cmdline = pid_cmdline(pid)
    testcase.assertIn(
        marker, cmdline,
        f"PID {pid} cmdline {cmdline!r} lacks marker {marker!r}; refusing to signal",
    )
    return cmdline


FAKE_RUNTIME_SCRIPT = r'''
import http.server
import json
import os
import socketserver
import subprocess
import sys
import time

port = int(sys.argv[1])
pidfile = sys.argv[2]
countfile = sys.argv[3]
spawn_grandchild = "--grandchild" in sys.argv

grandchild = None
if spawn_grandchild:
    grandchild = subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(300)"],
    )

with open(pidfile, "w") as handle:
    json.dump({"pid": os.getpid(), "grandchild": grandchild.pid if grandchild else None}, handle)

executions = 0

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path == "/health":
            body = json.dumps({"status": "ok"}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == "/v1/models":
            body = json.dumps({"data": [{"id": "fake-model"}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        global executions
        if self.path != "/completion":
            self.send_response(404)
            self.end_headers()
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self.rfile.read(length)
        executions += 1
        with open(countfile, "w") as handle:
            handle.write(str(executions))
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        try:
            for i in range(5):
                self.wfile.write(f"data: chunk{i}\n\n".encode())
                self.wfile.flush()
                time.sleep(0.4)
        except (BrokenPipeError, ConnectionResetError):
            with open(countfile + ".outcome", "w") as handle:
                handle.write("unknown")
            return
        with open(countfile + ".outcome", "w") as handle:
            handle.write("complete")

class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

with Server(("127.0.0.1", port), Handler) as httpd:
    httpd.serve_forever()
'''


@unittest.skipIf(os.name == "nt", "POSIX process groups and signals")
class OwnedSubprocessLifecycleTests(unittest.TestCase):
    """Item 1: owned streaming runtime, verified descendant cleanup."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="macos-lifecycle-")
        self.addCleanup(self.tmp.cleanup)
        self.work = Path(self.tmp.name)
        self.runtime_script = self.work / "fake_runtime.py"
        self.runtime_script.write_text(FAKE_RUNTIME_SCRIPT)
        self.pidfile = self.work / "runtime.json"
        self.countfile = self.work / "executions.txt"
        self.port = find_free_port()
        self.proc = None
        self.sentinel = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(300)"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL, start_new_session=True)
        self.addCleanup(self._cleanup_sentinel)

    def _cleanup_sentinel(self):
        if self.sentinel is not None and self.sentinel.poll() is None:
            try:
                assert_pid_is_ours(self, self.sentinel.pid, "time.sleep(300)")
            except AssertionError:
                return
            self.sentinel.terminate()
            try:
                self.sentinel.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.sentinel.kill()
                self.sentinel.wait(timeout=5)

    def _start_runtime(self, with_grandchild=True):
        argv = [sys.executable, str(self.runtime_script), str(self.port),
               str(self.pidfile), str(self.countfile)]
        if with_grandchild:
            argv.append("--grandchild")
        self.proc = subprocess.Popen(
            argv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL, start_new_session=True)
        self.assertTrue(wait_for_port(self.port, timeout=10))
        assert_pid_is_ours(self, self.proc.pid, str(self.runtime_script))
        info = json.loads(self.pidfile.read_text())
        self.assertEqual(info["pid"], self.proc.pid)
        return info

    def _verified_group_cleanup(self, info):
        pid = self.proc.pid
        assert_pid_is_ours(self, pid, str(self.runtime_script))
        pgid = os.getpgid(pid)
        grandchild = info.get("grandchild")
        if grandchild is not None:
            self.assertTrue(is_pid_alive(grandchild))
        try:
            os.killpg(pgid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if self.proc.poll() is not None:
                break
            time.sleep(0.05)
        if self.proc.poll() is None:
            try:
                os.killpg(pgid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            self.proc.wait(timeout=5)
        else:
            self.proc.wait(timeout=5)
        self.assertTrue(wait_for_port_free(self.port, timeout=10))
        if grandchild is not None:
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and is_pid_alive(grandchild):
                if "time.sleep(300)" not in pid_cmdline(grandchild):
                    break
                time.sleep(0.05)
            if is_pid_alive(grandchild) and "time.sleep(300)" in pid_cmdline(grandchild):
                self.fail(f"orphan grandchild {grandchild}")
        self.assertIsNone(self.sentinel.poll())

    def tearDown(self):
        if self.proc is not None and self.proc.poll() is None:
            try:
                info = json.loads(self.pidfile.read_text()) if self.pidfile.exists() else {}
            except (OSError, ValueError):
                info = {}
            try:
                self._verified_group_cleanup(info)
            except Exception:
                try:
                    assert_pid_is_ours(self, self.proc.pid, str(self.runtime_script))
                except AssertionError:
                    return
                self.proc.terminate()
                try:
                    self.proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
                    self.proc.wait(timeout=5)

    def test_cancellation_closes_only_verified_descendants(self):
        info = self._start_runtime(with_grandchild=True)
        result = {}

        def fetch():
            try:
                req = Request(f"http://127.0.0.1:{self.port}/completion",
                              data=json.dumps({"prompt": "synthetic"}).encode(),
                              headers={"Content-Type": "application/json"}, method="POST")
                with urlopen(req, timeout=10) as resp:
                    result["body"] = resp.read()
            except Exception as exc:  # noqa: BLE001
                result["error"] = exc

        thread = threading.Thread(target=fetch, daemon=True)
        thread.start()
        time.sleep(0.6)
        self._verified_group_cleanup(info)
        thread.join(timeout=10)
        self.assertTrue(wait_for_port_free(self.port, timeout=5))

    def test_deadline_bounded_shutdown_no_orphan_listener(self):
        info = self._start_runtime(with_grandchild=False)
        start = time.monotonic()
        with self.assertRaises((URLError, TimeoutError, OSError)):
            req = Request(f"http://127.0.0.1:{self.port}/completion",
                          data=json.dumps({"prompt": "synthetic"}).encode(),
                          headers={"Content-Type": "application/json"}, method="POST")
            with urlopen(req, timeout=0.2) as resp:
                resp.read()
        self.assertLess(time.monotonic() - start, 5)
        self._verified_group_cleanup(info)
        self.assertTrue(wait_for_port_free(self.port, timeout=5))


@unittest.skipIf(os.name == "nt", "POSIX process groups and signals")
class DisconnectOutcomeTests(unittest.TestCase):
    """Item 2: disconnect before/after response starts."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="macos-disconnect-")
        self.addCleanup(self.tmp.cleanup)
        self.work = Path(self.tmp.name)
        self.runtime_script = self.work / "fake_runtime.py"
        self.runtime_script.write_text(FAKE_RUNTIME_SCRIPT)
        self.pidfile = self.work / "runtime.json"
        self.countfile = self.work / "executions.txt"
        self.port = find_free_port()
        self.proc = subprocess.Popen(
            [sys.executable, str(self.runtime_script), str(self.port),
             str(self.pidfile), str(self.countfile)],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL, start_new_session=True)
        self.assertTrue(wait_for_port(self.port, timeout=10))
        assert_pid_is_ours(self, self.proc.pid, str(self.runtime_script))

    def tearDown(self):
        if self.proc.poll() is None:
            try:
                assert_pid_is_ours(self, self.proc.pid, str(self.runtime_script))
            except AssertionError:
                return
            try:
                os.killpg(os.getpgid(self.proc.pid), signal.SIGTERM)
            except (OSError, ProcessLookupError):
                self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(os.getpgid(self.proc.pid), signal.SIGKILL)
                except (OSError, ProcessLookupError):
                    pass
                self.proc.wait(timeout=5)
        self.assertTrue(wait_for_port_free(self.port, timeout=10))

    def _execution_count(self):
        try:
            return int(self.countfile.read_text().strip())
        except (OSError, ValueError):
            return 0

    def _read_outcome(self):
        try:
            return (self.work / "executions.txt.outcome").read_text().strip()
        except OSError:
            return ""

    def test_disconnect_after_response_starts_unknown_no_replay(self):
        req = Request(f"http://127.0.0.1:{self.port}/completion",
                      data=json.dumps({"prompt": "synthetic"}).encode(),
                      headers={"Content-Type": "application/json"}, method="POST")
        with contextlib.closing(urlopen(req, timeout=10)) as resp:
            self.assertTrue(resp.read(16))
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and not self._read_outcome():
            time.sleep(0.05)
        self.assertEqual(self._execution_count(), 1)
        self.assertEqual(self._read_outcome(), "unknown")

    def test_disconnect_before_response_starts_single_dispatch(self):
        sock = socket.create_connection(("127.0.0.1", self.port), timeout=5)
        try:
            sock.sendall(b"POST /completion HTTP/1.0\r\nContent-Length: 100\r\n\r\npartial")
        finally:
            sock.close()
        time.sleep(1.0)
        self.assertLessEqual(self._execution_count(), 1)
        with urlopen(f"http://127.0.0.1:{self.port}/health", timeout=5) as resp:
            self.assertEqual(json.loads(resp.read().decode()).get("status"), "ok")


class RestartPreservesIdentityTests(unittest.TestCase):
    """Item 3: restart with a temporary store."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="macos-restart-")
        self.addCleanup(self.tmp.cleanup)
        self.data = Path(self.tmp.name) / "synthetic-data"
        self.args = argparse.Namespace(
            data_dir=str(self.data), api_base="https://synthetic.invalid",
            name=None, config=None, code="synthetic-code", interval=30)

    def _pair(self, resource="synthetic-a", key="synthetic-key-a"):
        with patch.object(pairing, "claim", return_value={
                "resourceId": resource, "heartbeatKey": key,
                "keyPrefix": "synthetic-prefix"}), \
             contextlib.redirect_stdout(io.StringIO()), \
             contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(pairing.cmd_pair(self.args), pairing.EXIT_OK)
        return pairing.load_pairing(self.data)

    def _beat_once(self, result):
        effect = {"return_value": result} if isinstance(result, dict) else {"side_effect": result}
        with patch.object(pairing, "send_heartbeat", **effect), \
             contextlib.redirect_stdout(io.StringIO()), \
             contextlib.redirect_stderr(io.StringIO()):
            return pairing.cmd_heartbeat(self.args, loop=False)

    def test_restart_preserves_node_id_and_status_without_repairing(self):
        meta = self._pair()
        node_id = pairing.load_or_create_node_id(self.data / "state")
        self.assertTrue(node_id)
        self.assertEqual(self._beat_once({"heartbeatAt": "RESTART-BEAT"}), pairing.EXIT_OK)
        reloaded = pairing.load_pairing(self.data)
        self.assertEqual(reloaded["resource_id"], meta["resource_id"])
        self.assertEqual(reloaded["heartbeat_key"], meta["heartbeat_key"])
        self.assertEqual(pairing.load_or_create_node_id(self.data / "state"), node_id)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(pairing.cmd_status(self.args), pairing.EXIT_OK)
        self.assertIn("RESTART-BEAT", out.getvalue())

    def test_restart_does_not_start_duplicate_sender_in_same_controller(self):
        from packaging.aipster_tray.child import SenderChild
        fake_bin = Path(self.tmp.name) / "fake-bundle"
        fake_bin.mkdir()
        fake_sender = fake_bin / ("aipster-worker.exe" if os.name == "nt" else "aipster-worker")
        fake_sender.write_text("#!%s\nimport time\ntime.sleep(300)\n" % sys.executable)
        fake_sender.chmod(0o700)
        self._pair()
        sender = SenderChild(str(fake_bin), str(Path(self.tmp.name) / "sender.log"), str(self.data))
        self.addCleanup(sender.stop)
        first_pid = sender.start()
        self.assertTrue(first_pid)
        assert_pid_is_ours(self, first_pid, str(fake_sender))
        self.assertEqual(sender.start(), first_pid)


@unittest.skipIf(os.name == "nt", "POSIX owner-only storage semantics")
class PrivateStorageAndPythonPathTests(unittest.TestCase):
    """Item 4: owner-only storage, unreadable dirs, Python/venv paths, quoting."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="macos-storage-")
        self.addCleanup(self.tmp.cleanup)
        self.work = Path(self.tmp.name)

    def test_owner_only_private_storage_on_macos(self):
        data = self.work / "synthetic-data"
        pairing.private_dir(data)
        st = data.stat()
        self.assertEqual(st.st_uid, os.getuid())
        self.assertEqual(oct(st.st_mode & 0o777), oct(0o700))
        secret = data / "heartbeat-key.synthetic.txt"
        pairing.write_private(secret, FAKE_SECRET + "\n")
        st = secret.stat()
        self.assertEqual(st.st_uid, os.getuid())
        self.assertEqual(oct(st.st_mode & 0o777), oct(0o600))

    def test_unreadable_directory_real_macos_behavior(self):
        if os.geteuid() == 0:
            self.skipTest("root bypasses POSIX read denial")
        data = self.work / "synthetic-data"
        pairing.private_dir(data)
        (data / "pairing.json").write_text("{}")
        data.chmod(0o300)
        try:
            with self.assertRaises(OSError, msg="0o300 unexpectedly listable"):
                with os.scandir(data):
                    pass
        finally:
            data.chmod(0o700)
        with os.scandir(data) as entries:
            self.assertIn("pairing.json", [e.name for e in entries])

    def test_python_executable_venv_path_with_spaces_argv_list(self):
        from packaging.aipster_tray.child import sender_argv
        spaced = self.work / "path with spaces" / ".venv" / "bin"
        spaced.mkdir(parents=True)
        (spaced / "python").write_text("#!%s\n" % sys.executable)
        (spaced / "python").chmod(0o700)
        bundle = self.work / "bundle with spaces"
        bundle.mkdir()
        fake_worker = bundle / "aipster-worker"
        fake_worker.write_text("#!%s\nimport sys\nsys.exit(0)\n" % sys.executable)
        fake_worker.chmod(0o700)
        data_dir = self.work / "data with spaces"
        data_dir.mkdir()
        argv = sender_argv(str(bundle), str(data_dir))
        self.assertIsInstance(argv, list)
        self.assertEqual(argv[0], str(fake_worker))
        self.assertIn(str(data_dir), argv)
        proc = subprocess.Popen(
            argv[:1] + ["--help"], stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, start_new_session=True)
        try:
            proc.wait(timeout=5)
        finally:
            if proc.poll() is None:
                try:
                    assert_pid_is_ours(self, proc.pid, str(fake_worker))
                except AssertionError:
                    pass
                else:
                    proc.terminate()
                    proc.wait(timeout=5)

    def test_shell_quoting_for_display_uses_shlex_quote(self):
        exe = "/path with spaces/aipster-worker"
        args = ["pair", "--data-dir", "/data with spaces"]
        quoted = " ".join(shlex.quote(p) for p in [exe, *args])
        self.assertIn("'/path with spaces/aipster-worker'", quoted)
        self.assertIn("'/data with spaces'", quoted)
        self.assertEqual(shlex.split(quoted), [exe, *args])
        from packaging.aipster_tray import controller as ctl_mod
        import inspect
        self.assertIn("shlex", inspect.getsource(ctl_mod.Controller.launch_pair))


@unittest.skipIf(os.name == "nt", "POSIX process groups and signals")
class WorkerChildDescendantCleanupTests(unittest.TestCase):
    """Item 1 product gap: WorkerChild.stop must not orphan descendants."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="macos-workerchild-")
        self.addCleanup(self.tmp.cleanup)
        self.work = Path(self.tmp.name)
        self.bundle = self.work / "bundle"
        self.bundle.mkdir()
        self.port = find_free_port()
        self.pidfile = self.work / "worker.json"
        fake = self.bundle / "dendrite"
        fake.write_text(
            "#!%s\nimport http.server, json, os, socketserver, subprocess, sys\n"
            "port = %d\npidfile = %r\n"
            "g = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(300)'])\n"
            "open(pidfile, 'w').write(json.dumps({'pid': os.getpid(), 'grandchild': g.pid}))\n"
            "class H(http.server.BaseHTTPRequestHandler):\n"
            "    def log_message(self, *a): pass\n"
            "    def do_GET(self):\n"
            "        b = b'{\"status\": \"ok\"}'\n"
            "        self.send_response(200)\n"
            "        self.send_header('Content-Length', str(len(b)))\n"
            "        self.end_headers()\n"
            "        self.wfile.write(b)\n"
            "with socketserver.TCPServer(('127.0.0.1', port), H) as httpd:\n"
            "    httpd.serve_forever()\n" % (sys.executable, self.port, str(self.pidfile)))
        fake.chmod(0o700)
        self.config = self.work / "config.toml"
        self.config.write_text("[node]\n")
        self.log_path = self.work / "worker.log"

    def test_workerchild_stop_kills_verified_descendants_no_orphans(self):
        from packaging.aipster_tray.child import WorkerChild
        child = WorkerChild(str(self.bundle), str(self.log_path))
        self.addCleanup(child.stop)
        pid = child.start(str(self.config), dict(os.environ))
        self.assertTrue(pid)
        self.assertTrue(wait_for_port(self.port, timeout=10))
        assert_pid_is_ours(self, pid, str(self.bundle / "dendrite"))
        grandchild = json.loads(self.pidfile.read_text()).get("grandchild")
        self.assertTrue(grandchild and is_pid_alive(grandchild))
        child.stop(timeout=5)
        self.assertTrue(wait_for_port_free(self.port, timeout=10))
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and is_pid_alive(grandchild):
            if "time.sleep(300)" not in pid_cmdline(grandchild):
                break
            time.sleep(0.05)
        if is_pid_alive(grandchild) and "time.sleep(300)" in pid_cmdline(grandchild):
            try:
                os.kill(grandchild, signal.SIGTERM)
            except OSError:
                pass
            self.fail(f"WorkerChild.stop orphaned grandchild {grandchild}")


class CrossProcessSenderExclusionTests(unittest.TestCase):
    """Item 3 product gap: two heartbeat senders must not both hold the lock.

    Retained API is shipped R4 (origin/main): _hold_sender_lock /
    sender_lock_held / EXIT_SENDER_RUNNING=6. Isolated subprocesses only;
    temp data dir, verified PIDs, no live sender.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="macos-senderlock-")
        self.addCleanup(self.tmp.cleanup)
        self.data = Path(self.tmp.name) / "synthetic-data"
        pairing.private_dir(self.data)

    def test_second_sender_exits_without_beating(self):
        holder_script = Path(self.tmp.name) / "hold_sender_lock.py"
        holder_script.write_text(
            "import sys, time\nsys.path.insert(0, %r)\n"
            "from pairing import _hold_sender_lock\nfrom pathlib import Path\n"
            "guard = _hold_sender_lock(Path(%r))\n"
            "import sys as _s\n"
            "_s.exit(99) if guard is None else (time.sleep(30), guard.release())\n"
            % (str(ROOT), str(self.data)))
        holder = subprocess.Popen(
            [sys.executable, str(holder_script)], stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, start_new_session=True)
        self.addCleanup(lambda: holder.terminate() if holder.poll() is None else None)
        time.sleep(1.0)
        self.assertIsNone(holder.poll())
        assert_pid_is_ours(self, holder.pid, str(holder_script))
        self.assertTrue(pairing.sender_lock_held(self.data),
                        "live holder must be visible to the probe")
        prover_script = Path(self.tmp.name) / "prove_sender_lock.py"
        prover_script.write_text(
            "import sys\nsys.path.insert(0, %r)\n"
            "from pairing import _hold_sender_lock, sender_lock_held\n"
            "from pathlib import Path\n"
            "data = Path(%r)\n"
            "held = sender_lock_held(data)\n"
            "guard = _hold_sender_lock(data)\n"
            "import sys as _s\n"
            "ok = held and guard is None\n"
            "(_s.exit(42) if ok else _s.exit(1))\n"
            % (str(ROOT), str(self.data)))
        result = subprocess.run([sys.executable, str(prover_script)],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 42,
                         f"second sender did not fail fast (rc={result.returncode}) "
                         f"out={result.stdout!r} err={result.stderr!r}")
        holder.terminate()
        holder.wait(timeout=5)
        deadline = time.monotonic() + 10
        while pairing.sender_lock_held(self.data):
            self.assertLess(time.monotonic(), deadline, "lock never released after holder exit")
            time.sleep(0.1)
        self.assertTrue((self.data / "sender.lock").exists(), "stale marker remains")
        guard = pairing._hold_sender_lock(self.data)
        self.assertIsNotNone(guard, "stale marker must not wedge the next start")
        guard.release()


if __name__ == "__main__":
    unittest.main()

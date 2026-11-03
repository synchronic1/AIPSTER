"""Source-level tests for qualify.py preflight helpers (no frozen bundle).

Covers the allowlist gate, the exit/marker/traceback verdict, and the
scrubbed preflight env, plus one in-process source-launcher delivery-check
run proving the source modules import and behave without provisioning.
No frozen exe, daemon, tray, server, install, or network is touched; the
frozen-exe matrix itself runs only inside qualify.py profiles on CI.
"""
import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from types import SimpleNamespace

WINDOWS = Path(__file__).resolve().parent
ROOT = WINDOWS.parent.parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / 'vendor/eif'))
sys.path.insert(0, str(WINDOWS.parent))
sys.path.insert(0, str(WINDOWS))
sys.path.insert(0, str(ROOT))

spec = importlib.util.spec_from_file_location('preflight_qualify', WINDOWS / 'qualify.py')
qualify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qualify)

launcher_spec = importlib.util.spec_from_file_location('preflight_launcher', WINDOWS / 'launcher.py')
launcher = importlib.util.module_from_spec(launcher_spec)
launcher_spec.loader.exec_module(launcher)

READY_CONFIG = """[node]
id = "preflight-real"
host = "127.0.0.1"
port = 8090
state_dir = "state"

[[runtimes]]
id = "cpu"
kind = "ik_llama"
mode = "managed"
executable = "llama-server"
threads = 2
gpu_layers = 0

[[models]]
id = "m"
runtime = "cpu"
capabilities = ["summarize"]
path = "MODELFILE"
"""


def fake_proc(returncode=0, stdout="", stderr=""):
    return SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr)


def run_launcher(argv):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        try:
            code = launcher.main(argv)
        except SystemExit as exc:
            code = exc.code
    return code, out.getvalue(), err.getvalue()


class PreflightArgvTests(unittest.TestCase):
    def test_allowlisted_commands_build_exact_argv(self):
        exe = str(Path("C:/synthetic/app/aipster-worker.exe"))
        self.assertEqual(
            qualify.preflight_argv(exe, "delivery-check",
                                   ["--app-dir", "a", "--data-dir", "d"]),
            [exe, "delivery-check", "--app-dir", "a", "--data-dir", "d"])
        self.assertEqual(
            qualify.preflight_argv(exe, "runtime-plan", ["--config", "c"]),
            [exe, "runtime-plan", "--config", "c"])

    def test_daemon_and_tray_commands_are_refused(self):
        exe = "C:/synthetic/app/aipster-worker.exe"
        for command in ("run", "inspect", "tray", "pair", "sender", "status",
                        "start", "stop", "quit", "--version", "", "DELIVERY-CHECK"):
            with self.subTest(command=command):
                with self.assertRaises(SystemExit):
                    qualify.preflight_argv(exe, command, [])


class PreflightVerdictTests(unittest.TestCase):
    def test_good_result_passes(self):
        ok, detail = qualify.preflight_verdict(
            fake_proc(0, "delivery-check: ready: all good\n"),
            expect_exit=0, markers=("delivery-check: ready",), label="t")
        self.assertTrue(ok, detail)

    def test_wrong_exit_fails_with_codes(self):
        ok, detail = qualify.preflight_verdict(
            fake_proc(1, "config-error\n"), expect_exit=0,
            markers=("delivery-check: ready",), label="t")
        self.assertFalse(ok)
        self.assertIn("exit 1, want 0", detail)

    def test_missing_marker_fails(self):
        ok, detail = qualify.preflight_verdict(
            fake_proc(0, "delivery-check: blocked: something\n"),
            expect_exit=0, markers=("delivery-check: ready",), label="t")
        self.assertFalse(ok)
        self.assertIn("missing output markers", detail)

    def test_traceback_fails_even_on_expected_exit(self):
        ok, detail = qualify.preflight_verdict(
            fake_proc(1, "Traceback (most recent call last):\nModuleNotFoundError: x\n"),
            expect_exit=1, markers=(), label="t")
        self.assertFalse(ok)
        self.assertIn("traceback", detail)

    def test_timeout_is_a_failure_not_a_crash(self):
        ok, detail = qualify.preflight_verdict(
            None, expect_exit=0, markers=("ready",), label="t")
        self.assertFalse(ok)
        self.assertIn("timed out", detail)


class PreflightEnvTests(unittest.TestCase):
    def test_env_isolates_data_dir_and_scrubs_secrets(self):
        with tempfile.TemporaryDirectory(prefix="aipster-preflight-") as tmp:
            work = Path(tmp)
            env, data = qualify.preflight_env(work, "case1")
            self.assertEqual(Path(env["AIPSTER_WORKER_DATA"]), data)
            self.assertTrue(str(data).startswith(str(work)))
            self.assertTrue(data.is_dir())
            self.assertNotIn("DENDRITE_API_TOKEN", env)
            self.assertNotIn("LOCALAPPDATA", env)
            for key in ("SYSTEMROOT", "WINDIR", "COMSPEC"):
                self.assertIn(key, env)

    def test_extra_path_is_prepended(self):
        with tempfile.TemporaryDirectory(prefix="aipster-preflight-") as tmp:
            work = Path(tmp)
            extra = work / "bin"
            extra.mkdir()
            env, _ = qualify.preflight_env(work, "case2", extra_path=extra)
            self.assertTrue(env["PATH"].startswith(
                str(extra) + os.pathsep))


class SourceLauncherPreflightTests(unittest.TestCase):
    """In-process source launcher run: bundled modules import and behave."""

    def test_delivery_check_ready_exits_0_without_provisioning(self):
        with tempfile.TemporaryDirectory(prefix="aipster-preflight-") as tmp:
            base = Path(tmp)
            app = base / "app"
            app.mkdir()
            for name in ("aipster-tray.exe", "aipster-worker.exe",
                         "dendrite.exe", "BUILD.json", "default.toml"):
                (app / name).write_bytes(b"synthetic-" + name.encode())
            (app / "BUILD.json").write_text(json.dumps({
                "worker_name": "ganglion-dendrite",
                "worker_version": "9.9.9-test",
                "installer_build": "1",
                "source_sha": "a163ae6",
            }), encoding="utf-8")
            model = base / "m.gguf"
            model.write_bytes(b"GGUF" + b"\x00" * 64)
            data = base / "data"
            data.mkdir()
            (data / "config.toml").write_text(
                READY_CONFIG.replace("MODELFILE", model.as_posix()),
                encoding="utf-8")
            before = sorted(p.name for p in data.iterdir())
            code, out, err = run_launcher(
                ["delivery-check", "--app-dir", str(app),
                 "--data-dir", str(data)])
            self.assertEqual(code, 0, out + err)
            self.assertIn("delivery-check: ready", out)
            self.assertNotIn("Traceback", out + err)
            self.assertEqual(sorted(p.name for p in data.iterdir()), before)
            self.assertFalse((data / "sender.lock").exists())


if __name__ == "__main__":
    unittest.main()

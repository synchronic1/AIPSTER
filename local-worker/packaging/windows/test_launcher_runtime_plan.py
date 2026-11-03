"""Launcher runtime-plan integration tests (integration-branch owned).

`runtime-plan` delegates to the reviewed runtime planner BEFORE any
setup/token/provisioning path: missing/malformed configs must yield stable
human/JSON errors with zero provisioning side effects, the default mock
stays explicitly unqualified, and ready verdicts keep their preflight-only
scope. Synthetic fixtures in isolated temp dirs only; no installs, engines,
services, credentials, or network. Existing commands/defaults preserved.
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
from unittest.mock import patch

WINDOWS = Path(__file__).resolve().parent
ROOT = WINDOWS.parent.parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / 'vendor/eif'))
sys.path.insert(0, str(WINDOWS.parent))
sys.path.insert(0, str(WINDOWS))
sys.path.insert(0, str(ROOT))

spec = importlib.util.spec_from_file_location('launcher', WINDOWS / 'launcher.py')
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)

MOCK_CONFIG = """[node]
id = "standalone-demo"
host = "127.0.0.1"
port = 8090
state_dir = "state"

[[runtimes]]
id = "mock"
kind = "mock"

[[models]]
id = "mock-summary"
runtime = "mock"
capabilities = ["summarize"]
"""

REAL_CONFIG = """[node]
id = "standalone-real"
host = "127.0.0.1"
port = 8090
state_dir = "state"

[[runtimes]]
id = "cpu"
kind = "ik_llama"
mode = "managed"
executable = "llama-server"
port = 8081
threads = 2
gpu_layers = 0

[[models]]
id = "m"
runtime = "cpu"
capabilities = ["summarize"]
path = "m.gguf"
"""


def run_launcher(argv):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        try:
            code = launcher.main(argv)
        except SystemExit as exc:
            code = exc.code
    return code, out.getvalue(), err.getvalue()


class RuntimePlanCommandTests(unittest.TestCase):
    def test_missing_config_human_no_provisioning(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = str(Path(tmp) / "nope.toml")
            ghost_data = str(Path(tmp) / "ghost-data")
            code, out, err = run_launcher(
                ["runtime-plan", "--config", missing, "--data-dir", ghost_data])
        self.assertEqual(code, 1)
        self.assertIn("config-error", out)
        self.assertNotIn("Traceback", out + err)
        self.assertFalse(Path(ghost_data).exists(),
                         "runtime-plan must not provision the data dir")

    def test_malformed_config_json_no_provisioning(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = Path(tmp) / "bad.toml"
            cfg.write_text("[[runtimes\nbroken = = =", encoding="utf-8")
            ghost_data = str(Path(tmp) / "ghost-data")
            code, out, err = run_launcher(
                ["runtime-plan", "--config", str(cfg), "--json",
                 "--data-dir", ghost_data])
        self.assertEqual(code, 1)
        plan = json.loads(out)
        self.assertEqual(plan["status"], "config-error")
        self.assertFalse(Path(ghost_data).exists(),
                         "runtime-plan must not provision the data dir")

    def test_config_required_before_anything(self):
        with tempfile.TemporaryDirectory() as tmp:
            ghost_data = str(Path(tmp) / "ghost-data")
            code, out, err = run_launcher(
                ["runtime-plan", "--data-dir", ghost_data])
        self.assertEqual(code, 2)
        self.assertIn("--config is required", err)
        self.assertFalse(Path(ghost_data).exists())

    def test_default_mock_explicitly_unqualified(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = Path(tmp) / "mock.toml"
            cfg.write_text(MOCK_CONFIG, encoding="utf-8")
            code, out, err = run_launcher(
                ["runtime-plan", "--config", str(cfg)])
        self.assertEqual(code, 2)
        self.assertIn("setup-required", out)
        self.assertIn("test/demo option only", out)

    def test_ready_keeps_preflight_scope(self):
        # Real-looking fixture (PATH engine + GGUF magic) reaches ready,
        # but the verdict must keep its limited preflight-only meaning.
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "llama-server.exe").write_bytes(b"not-an-engine")
            (Path(tmp) / "m.gguf").write_bytes(b"GGUF" + b"\x00" * 64)
            cfg = Path(tmp) / "real.toml"
            cfg.write_text(REAL_CONFIG, encoding="utf-8")
            env = dict(os.environ, PATH=tmp + os.pathsep + os.environ.get("PATH", ""))
            with patch.dict(os.environ, {"PATH": env["PATH"]}):
                code, out, err = run_launcher(
                    ["runtime-plan", "--config", str(cfg)])
        self.assertEqual(code, 0)
        self.assertIn("status: ready", out)
        self.assertIn("preflight", out)
        self.assertIn("not verified (not run)", out)
        self.assertIn("inference qualification", out)

    def test_consent_passthrough_recorded_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = Path(tmp) / "mock.toml"
            cfg.write_text(MOCK_CONFIG, encoding="utf-8")
            code, out, err = run_launcher(
                ["runtime-plan", "--config", str(cfg), "--json",
                 "--consent", "yes"])
            after = sorted(p.name for p in Path(tmp).iterdir())
        plan = json.loads(out)
        self.assertEqual(code, 2)
        self.assertTrue(plan["consent"]["granted"])
        # Consent granted yet nothing written beside the input config.
        self.assertEqual(after, ["mock.toml"])

    def test_existing_commands_preserved(self):
        code, out, err = run_launcher(["--help"])
        self.assertEqual(code, 0)
        for command in ("run", "inspect", "tray", "pair", "sender",
                        "delivery-check", "runtime-plan"):
            self.assertIn(command, out)


if __name__ == "__main__":
    unittest.main()

"""Focused delivery validation tests. Synthetic fixtures only; read-only checks."""
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

WINDOWS = Path(__file__).resolve().parent
ROOT = WINDOWS.parent.parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / 'vendor/eif'))
sys.path.insert(0, str(WINDOWS.parent))
sys.path.insert(0, str(WINDOWS))
sys.path.insert(0, str(ROOT))
import pairing

spec = importlib.util.spec_from_file_location('delivery_check', WINDOWS / 'delivery_check.py')
delivery_check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(delivery_check)

REAL_CONFIG = """[node]
id = "standalone-real"
host = "127.0.0.1"
port = 8090
state_dir = "state"

[[runtimes]]
id = "local"
kind = "ik_llama"

[[models]]
id = "real-model"
runtime = "local"
path = "MODELFILE"
"""

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
"""


def make_app(path, *, with_tray=True, build=True):
    path.mkdir(parents=True, exist_ok=True)
    names = ["aipster-worker.exe", "dendrite.exe", "BUILD.json", "default.toml"]
    if with_tray:
        names = ["aipster-tray.exe"] + names
    for name in names:
        (path / name).write_bytes(b"synthetic-" + name.encode())
    if build:
        (path / "BUILD.json").write_text(json.dumps({
            "worker_name": "ganglion-dendrite",
            "worker_version": "9.9.9-test",
            "installer_build": "1",
            "source_sha": "a33898f",
        }), encoding="utf-8")
    (path / "default.toml").write_text("# synthetic default\n", encoding="utf-8")
    return path


def make_data(path, *, config=None, pairing_json=True, token=True):
    path.mkdir(parents=True, exist_ok=True)
    if config is not None:
        (path / "config.toml").write_text(config, encoding="utf-8")
    if pairing_json:
        (path / "pairing.json").write_text('{"resource_id": "r_synth01"}\n', encoding="utf-8")
    if token:
        (path / "api-token.txt").write_text("synthetic-token-" + "x" * 40 + "\n", encoding="utf-8")
    return path


class DeliveryCheckTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="aipster-delivery-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)

    def test_missing_tray_executable_blocks(self):
        app = make_app(self.base / "app", with_tray=False)
        data = make_data(self.base / "data", config=REAL_CONFIG)
        (data / "model.gguf").write_bytes(b"GGUF-synthetic")
        result = delivery_check.check_delivery(app, data)
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["exit_code"], 2)
        self.assertIn("tray", result["reason"])

    def test_missing_package_blocks(self):
        data = make_data(self.base / "data", config=MOCK_CONFIG)
        result = delivery_check.check_delivery(self.base / "no-such-app", data)
        self.assertEqual(result["status"], "blocked")
        self.assertIn("absent", result["reason"])

    def test_missing_runtime_blocks(self):
        app = make_app(self.base / "app")
        data = make_data(self.base / "data", config=None)
        result = delivery_check.check_delivery(app, data)
        self.assertEqual(result["status"], "blocked")
        self.assertIn("config.toml", result["reason"])

    def test_mock_only_runtime_is_setup_required(self):
        app = make_app(self.base / "app")
        data = make_data(self.base / "data", config=MOCK_CONFIG)
        result = delivery_check.check_delivery(app, data)
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["runtime"].get("status"), "setup-required")
        self.assertTrue(result["runtime"].get("mock_only"))
        self.assertIn("mock", result["reason"])

    def test_ready_runtime_passes(self):
        app = make_app(self.base / "app")
        model = self.base / "model.gguf"
        model.write_bytes(b"GGUF-synthetic")
        data = make_data(self.base / "data",
                         config=REAL_CONFIG.replace("MODELFILE", model.as_posix()))
        result = delivery_check.check_delivery(app, data)
        self.assertEqual(result["status"], "ready", result)
        self.assertEqual(result["exit_code"], 0)
        self.assertEqual(result["build"]["worker_version"], "9.9.9-test")
        self.assertIn("roll back", result["rollback"].lower())

    def test_store_and_identity_preserved(self):
        app = make_app(self.base / "app")
        model = self.base / "model.gguf"
        model.write_bytes(b"GGUF-synthetic")
        data = make_data(self.base / "data",
                         config=REAL_CONFIG.replace("MODELFILE", model.as_posix()))
        before_pair = (data / "pairing.json").read_bytes()
        before_token = (data / "api-token.txt").read_bytes()
        result = delivery_check.check_delivery(app, data)
        self.assertEqual(result["status"], "ready", result)
        self.assertEqual((data / "pairing.json").read_bytes(), before_pair)
        self.assertEqual((data / "api-token.txt").read_bytes(), before_token)
        self.assertTrue(result["enrollment"]["pairing.json"]["present"])
        self.assertTrue(result["enrollment"]["api-token.txt"]["present"])

    def test_duplicate_sender_rejects_upgrade(self):
        app = make_app(self.base / "app")
        model = self.base / "model.gguf"
        model.write_bytes(b"GGUF-synthetic")
        data = make_data(self.base / "data",
                         config=REAL_CONFIG.replace("MODELFILE", model.as_posix()))
        guard = pairing._hold_sender_lock(data)
        self.assertIsNotNone(guard)
        self.addCleanup(guard.release)
        self.assertTrue(pairing.sender_lock_held(data))
        before_pair = (data / "pairing.json").read_bytes()
        result = delivery_check.check_delivery(app, data)
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["exit_code"], 6)
        self.assertIn("sender", result["reason"])
        self.assertEqual((data / "pairing.json").read_bytes(), before_pair)

    def test_failed_check_changes_nothing(self):
        app = make_app(self.base / "app", with_tray=False)
        data = make_data(self.base / "data", config=MOCK_CONFIG)
        before = sorted(p.name for p in data.iterdir())
        before_bytes = {p.name: p.read_bytes() for p in data.iterdir() if p.is_file()}
        result = delivery_check.check_delivery(app, data)
        self.assertEqual(result["status"], "blocked")
        self.assertIn("changed nothing", result["rollback"])
        self.assertEqual(sorted(p.name for p in data.iterdir()), before)
        for name, content in before_bytes.items():
            self.assertEqual((data / name).read_bytes(), content)

    def test_launcher_delivery_check_reports_missing_tray(self):
        app = make_app(self.base / "app", with_tray=False)
        data = make_data(self.base / "data", config=MOCK_CONFIG)
        launcher_spec = importlib.util.spec_from_file_location(
            "installed_launcher_probe", WINDOWS / "launcher.py")
        launcher = importlib.util.module_from_spec(launcher_spec)
        launcher_spec.loader.exec_module(launcher)
        rc = launcher.main(["delivery-check", "--app-dir", str(app),
                            "--data-dir", str(data)])
        self.assertEqual(rc, 2)


if __name__ == "__main__":
    unittest.main()

"""Focused delivery validation tests. Synthetic fixtures only; read-only checks."""
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

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


def listing(path):
    return sorted(p.name for p in Path(path).iterdir())


class DeliveryCheckTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="aipster-delivery-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)

    def ready_pair(self, name="app", data="data"):
        app = make_app(self.base / name)
        model = self.base / "model.gguf"
        model.write_bytes(b"GGUF-synthetic")
        data_path = make_data(self.base / data,
                              config=REAL_CONFIG.replace("MODELFILE", model.as_posix()))
        return app, data_path

    def test_missing_tray_executable_blocks(self):
        app = make_app(self.base / "app", with_tray=False)
        data = make_data(self.base / "data", config=REAL_CONFIG)
        result = delivery_check.check_delivery(app, data)
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["exit_code"], 2)
        self.assertIn("tray", result["reason"])

    def test_missing_package_blocks(self):
        data = make_data(self.base / "data", config=MOCK_CONFIG)
        result = delivery_check.check_delivery(self.base / "no-such-app", data)
        self.assertEqual(result["status"], "blocked")
        self.assertIn("absent", result["reason"])

    def test_missing_runtime_config_blocks(self):
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

    def test_malformed_config_is_unknown_not_ready(self):
        app = make_app(self.base / "app")
        data = make_data(self.base / "data", config="[[[not toml\n")
        before = listing(data)
        result = delivery_check.check_delivery(app, data)
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["exit_code"], 2)
        self.assertEqual(result["runtime"].get("status"), "unknown")
        self.assertIn("parseable", result["reason"])
        self.assertEqual(listing(data), before)

    def test_ready_is_bundle_config_validation_only(self):
        app, data = self.ready_pair()
        result = delivery_check.check_delivery(app, data)
        self.assertEqual(result["status"], "ready", result)
        self.assertEqual(result["exit_code"], 0)
        self.assertEqual(result["build"]["worker_version"], "9.9.9-test")
        scope = result["reason"] + result.get("guidance", "")
        self.assertIn("live-runtime", scope)
        self.assertIn("qualified-artifact", scope)
        self.assertIn("roll back", result["rollback"].lower())

    def test_store_and_identity_preserved_by_metadata(self):
        app, data = self.ready_pair()
        before_files = listing(data)
        before_meta = {n: delivery_check._describe_enrollment(data / n)
                       for n in ("pairing.json", "api-token.txt")}
        result = delivery_check.check_delivery(app, data)
        self.assertEqual(result["status"], "ready", result)
        self.assertEqual(listing(data), before_files)
        for name, meta in before_meta.items():
            self.assertTrue(meta["present"])
            self.assertNotIn("sha", "".join(
                k for k in result["enrollment"][name]))
            self.assertEqual(result["enrollment"][name], meta)

    def test_checker_reads_no_file_contents(self):
        app, data = self.ready_pair()
        with patch.object(Path, "read_bytes",
                          side_effect=AssertionError("secret content read")):
            result = delivery_check.check_delivery(app, data)
        self.assertEqual(result["status"], "ready", result)

    def test_absent_lock_creates_nothing_with_helper(self):
        app, data = self.ready_pair()
        before = listing(data)
        self.assertNotIn("sender.lock", before)
        result = delivery_check.check_delivery(app, data)
        self.assertEqual(result["status"], "ready", result)
        after = listing(data)
        self.assertEqual(after, before)
        self.assertNotIn("sender.lock", after)

    def test_absent_lock_creates_nothing_when_pairing_unavailable(self):
        app, data = self.ready_pair()
        before = listing(data)
        with patch.dict(sys.modules, {"pairing": None}):
            result = delivery_check.check_delivery(app, data)
        # Unverifiable sender state must block, never report ready ...
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["exit_code"], 2)
        self.assertIn("unknown", result["reason"])
        # ... and the probe must not have created any state.
        after = listing(data)
        self.assertEqual(after, before)
        self.assertNotIn("sender.lock", after)

    def test_present_lock_with_unavailable_pairing_blocks(self):
        app, data = self.ready_pair()
        (data / "sender.lock").write_bytes(b"synthetic-lock")
        before = listing(data)
        with patch.dict(sys.modules, {"pairing": None}):
            result = delivery_check.check_delivery(app, data)
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["exit_code"], 2)
        self.assertIn("unknown", result["reason"])
        self.assertEqual(listing(data), before)

    def test_swallowed_open_error_blocks_unknown(self):
        # P5 residual: the protected helper swallows os.open failures
        # into "free". The lane-local no-create open must see the same
        # failure first and report unknown, never ready.
        app, data = self.ready_pair()
        (data / "sender.lock").write_bytes(b"synthetic-lock")
        before = listing(data)
        before_pair = (data / "pairing.json").read_bytes()
        before_token = (data / "api-token.txt").read_bytes()
        real_open = os.open

        def fail_sender_open(path, *args, **kwargs):
            if str(path).endswith("sender.lock"):
                raise OSError("synthetic EACCES on sender.lock")
            return real_open(path, *args, **kwargs)

        with patch.object(os, "open", side_effect=fail_sender_open):
            result = delivery_check.check_delivery(app, data)
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["exit_code"], 2)
        self.assertIn("unknown", result["reason"])
        self.assertEqual(listing(data), before)
        self.assertEqual((data / "pairing.json").read_bytes(), before_pair)
        self.assertEqual((data / "api-token.txt").read_bytes(), before_token)

    def test_raced_exists_check_creates_nothing(self):
        # P6 residual: no exists-check-then-create shape remains. Even
        # if the existence answer is raced True for an absent lock, the
        # no-create open answers ENOENT and the helper is never reached.
        app, data = self.ready_pair()
        before = listing(data)
        self.assertNotIn("sender.lock", before)
        real_exists = Path.exists

        def raced_exists(self):
            if self.name == "sender.lock":
                return True
            return real_exists(self)

        with patch.object(Path, "exists", autospec=True,
                          side_effect=raced_exists):
            result = delivery_check.check_delivery(app, data)
            created = os.path.exists(
                os.fspath(data / "sender.lock"))
        self.assertFalse(created, "checker must never create sender.lock")
        self.assertEqual(result["status"], "ready", result)
        self.assertEqual(result["exit_code"], 0)
        self.assertEqual(listing(data), before)

    def test_probe_error_blocks_instead_of_ready(self):
        app, data = self.ready_pair()
        (data / "sender.lock").write_bytes(b"synthetic-lock")
        before = listing(data)
        with patch.object(pairing, "sender_lock_held",
                          side_effect=OSError("synthetic probe failure")):
            result = delivery_check.check_delivery(app, data)
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["exit_code"], 2)
        self.assertIn("unknown", result["reason"])
        self.assertEqual(listing(data), before)

    def test_duplicate_sender_rejects_upgrade(self):
        app, data = self.ready_pair()
        guard = pairing._hold_sender_lock(data)
        self.assertIsNotNone(guard)
        self.addCleanup(guard.release)
        self.assertTrue(pairing.sender_lock_held(data))
        before = listing(data)
        result = delivery_check.check_delivery(app, data)
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["exit_code"], 6)
        self.assertIn("sender", result["reason"])
        self.assertEqual(listing(data), before)

    def test_failed_check_changes_nothing(self):
        app = make_app(self.base / "app", with_tray=False)
        data = make_data(self.base / "data", config=MOCK_CONFIG)
        before = listing(data)
        result = delivery_check.check_delivery(app, data)
        self.assertEqual(result["status"], "blocked")
        self.assertIn("changed nothing", result["rollback"])
        self.assertEqual(listing(data), before)
        self.assertNotIn("sender.lock", listing(data))

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

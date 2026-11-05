"""Focused delivery validation tests. Synthetic fixtures only; read-only checks."""
import importlib.util
import errno
import json
import os
import stat
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
from dendrite.config import load_config

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
capabilities = ["completion"]
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
capabilities = ["completion"]
"""

ATTACH_NO_URL = """[node]
id = "standalone-attach"
host = "127.0.0.1"
port = 8090
state_dir = "state"

[[runtimes]]
id = "attached"
kind = "ik_llama"
mode = "attach"

[[models]]
id = "attached-model"
runtime = "attached"
capabilities = ["completion"]
upstream_model = "qwen3-8b"
"""

ATTACH_NON_LOOPBACK = """[node]
id = "standalone-attach"
host = "127.0.0.1"
port = 8090
state_dir = "state"

[[runtimes]]
id = "attached"
kind = "ik_llama"
mode = "attach"
base_url = "http://example.com:8080"

[[models]]
id = "attached-model"
runtime = "attached"
capabilities = ["completion"]
upstream_model = "qwen3-8b"
"""

ATTACH_LOOPBACK = """[node]
id = "standalone-attach"
host = "127.0.0.1"
port = 8090
state_dir = "state"

[[runtimes]]
id = "attached"
kind = "ik_llama"
mode = "attach"
base_url = "http://127.0.0.1:8080"

[[models]]
id = "attached-model"
runtime = "attached"
capabilities = ["completion"]
upstream_model = "qwen3-8b"
"""

DUPE_RUNTIME_IDS = """[node]
id = "standalone-dupe"
host = "127.0.0.1"
port = 8090
state_dir = "state"

[[runtimes]]
id = "local"
kind = "ik_llama"

[[runtimes]]
id = "local"
kind = "llama_cpp"
port = 8082

[[models]]
id = "real-model"
runtime = "local"
capabilities = ["completion"]
path = "MODELFILE"
"""

UNKNOWN_RUNTIME_REF = REAL_CONFIG.replace('runtime = "local"',
                                          'runtime = "ghost"')

MANAGED_WITH_BASE_URL = REAL_CONFIG.replace(
    'kind = "ik_llama"',
    'kind = "ik_llama"\nbase_url = "http://127.0.0.1:8080"')

MOCK_ATTACH_WITH_VALID_MANAGED = """[node]
id = "standalone-mixed"
host = "127.0.0.1"
port = 8090
state_dir = "state"

[[runtimes]]
id = "local"
kind = "ik_llama"

[[runtimes]]
id = "attached-mock"
kind = "mock"
mode = "attach"
base_url = "http://127.0.0.1:8080"

[[models]]
id = "real-model"
runtime = "local"
capabilities = ["completion"]
path = "MODELFILE"

[[models]]
id = "attached-model"
runtime = "attached-mock"
capabilities = ["completion"]
upstream_model = "qwen3-8b"
"""

LIST_RUNTIME_ID = """[node]
id = "standalone-badid"
host = "127.0.0.1"
port = 8090
state_dir = "state"

[[runtimes]]
id = ["not", "hashable"]
kind = "ik_llama"

[[models]]
id = "real-model"
runtime = "local"
capabilities = ["completion"]
path = "MODELFILE"
"""

MISSING_RUNTIME_ID = """[node]
id = "standalone-noid"
host = "127.0.0.1"
port = 8090
state_dir = "state"

[[runtimes]]
kind = "ik_llama"

[[models]]
id = "real-model"
runtime = "local"
capabilities = ["completion"]
path = "MODELFILE"
"""

DUPE_MODEL_IDS = """[node]
id = "standalone-dupemodel"
host = "127.0.0.1"
port = 8090
state_dir = "state"

[[runtimes]]
id = "local"
kind = "ik_llama"

[[models]]
id = "same-model"
runtime = "local"
capabilities = ["completion"]
path = "MODELFILE"

[[models]]
id = "same-model"
runtime = "local"
capabilities = ["completion"]
path = "MODELFILE"
"""

PORT_COLLISION_MANAGED = """[node]
id = "standalone-portclash"
host = "127.0.0.1"
port = 8090
state_dir = "state"

[[runtimes]]
id = "first"
kind = "ik_llama"
port = 8081

[[runtimes]]
id = "second"
kind = "llama_cpp"
port = 8081

[[models]]
id = "real-model"
runtime = "first"
capabilities = ["completion"]
path = "MODELFILE"
"""

NODE_PORT_COLLISION = """[node]
id = "standalone-nodeclash"
host = "127.0.0.1"
port = 8090
state_dir = "state"

[[runtimes]]
id = "local"
kind = "ik_llama"
port = 8090

[[models]]
id = "real-model"
runtime = "local"
capabilities = ["completion"]
path = "MODELFILE"
"""

UNSUPPORTED_KIND_MIXED = """[node]
id = "standalone-badkind"
host = "127.0.0.1"
port = 8090
state_dir = "state"

[[runtimes]]
id = "local"
kind = "ik_llama"

[[runtimes]]
id = "strange"
kind = "remote_engine"

[[models]]
id = "real-model"
runtime = "local"
capabilities = ["completion"]
path = "MODELFILE"
"""

MISSING_KIND_MIXED = """[node]
id = "standalone-nokind"
host = "127.0.0.1"
port = 8090
state_dir = "state"

[[runtimes]]
id = "local"
kind = "ik_llama"

[[runtimes]]
id = "kindless"

[[models]]
id = "real-model"
runtime = "local"
capabilities = ["completion"]
path = "MODELFILE"
"""

MISSING_CAPABILITIES = """[node]
id = "standalone-nocaps"
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

EMPTY_CAPABILITIES = MISSING_CAPABILITIES.replace(
    'runtime = "local"',
    'runtime = "local"\ncapabilities = []')

INVALID_MODE = """[node]
id = "standalone-badmode"
host = "127.0.0.1"
port = 8090
state_dir = "state"

[[runtimes]]
id = "local"
kind = "ik_llama"
mode = "remote"

[[models]]
id = "real-model"
runtime = "local"
capabilities = ["completion"]
path = "MODELFILE"
"""

BAD_PORT_HI = """[node]
id = "standalone-badport"
host = "127.0.0.1"
port = 8090
state_dir = "state"

[[runtimes]]
id = "local"
kind = "ik_llama"
port = 99999

[[models]]
id = "real-model"
runtime = "local"
capabilities = ["completion"]
path = "MODELFILE"
"""

BAD_PORT_ZERO = BAD_PORT_HI.replace("port = 99999", "port = 0")


def make_app(path, *, with_tray=True, build=True):
    path.mkdir(parents=True, exist_ok=True)
    # The checker's own platform-specific payload names (.exe on Windows,
    # extensionless aipster-* on Linux), so this fixture never drifts from it.
    names = [n for n in delivery_check.REQUIRED_APP_FILES if n != delivery_check.TRAY_EXE]
    if with_tray:
        names = [delivery_check.TRAY_EXE] + names
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


def _loader_provenance():
    """Where the authoritative modules resolve from (candidate proof)."""
    import dendrite.config as candidate_config
    import pydantic
    return {
        "dendrite.config": str(Path(candidate_config.__file__).resolve()),
        "pydantic": (f"{Path(pydantic.__file__).resolve()}"
                     f"@{pydantic.VERSION}"),
    }


class _BlockImports:
    """Meta-path blocker: the named modules become unavailable for real."""

    def __init__(self, *prefixes, provenance=""):
        self.prefixes = prefixes
        self.provenance = provenance

    def find_spec(self, name, path=None, target=None):
        if name in self.prefixes or any(
                name.startswith(p + ".") for p in self.prefixes):
            raise ImportError(
                f"unavailable for honesty test [{self.provenance}]: {name}")
        return None


class _BreakImports(_BlockImports):
    """Meta-path breaker: the named modules raise a non-ImportError."""

    def find_spec(self, name, path=None, target=None):
        if name in self.prefixes or any(
                name.startswith(p + ".") for p in self.prefixes):
            raise RuntimeError(
                f"broken worker loader [{self.provenance}]: {name}")
        return None


def _evict_modules(*prefixes):
    """Pop prefixed modules from sys.modules; returns them for restore."""
    return {m: sys.modules.pop(m) for m in
            [m for m in sys.modules
             if m in prefixes or any(m.startswith(p + ".")
                                     for p in prefixes)]}


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

    def test_lock_mechanics_error_blocks_unknown(self):
        # Replaces the obsolete helper-raise test: the checker never
        # calls pairing.sender_lock_held, so a failure inside the
        # lane-local lock call itself must fail closed to unknown.
        app, data = self.ready_pair()
        (data / "sender.lock").write_bytes(b"synthetic-lock")
        before = listing(data)
        if os.name == "nt":
            import msvcrt as mech
            patcher = patch.object(mech, "locking", side_effect=ValueError(
                "synthetic mechanics bug (not a lock conflict)"))
        else:
            import fcntl as mech
            patcher = patch.object(mech, "flock", side_effect=ValueError(
                "synthetic mechanics bug (not a lock conflict)"))
        with patcher:
            result = delivery_check.check_delivery(app, data)
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["exit_code"], 2)
        self.assertIn("unknown", result["reason"])
        self.assertEqual(listing(data), before)

    def test_flag_split_denial_blocks_unknown(self):
        # Qa1 shape: O_RDONLY allowed but O_RDWR denied. The old
        # preflight-then-helper shape reported ready here because the
        # helper swallowed the reopen failure; the single-descriptor
        # probe must see the same denial first and block.
        app, data = self.ready_pair()
        (data / "sender.lock").write_bytes(b"synthetic-lock")
        before = listing(data)
        real_open = os.open

        def rdonly_ok_rdwr_denied(path, flags, *args, **kwargs):
            if str(path).endswith("sender.lock") and (flags & (os.O_RDWR | os.O_CREAT)):
                raise OSError(errno.EACCES, "synthetic EACCES on reopen")
            return real_open(path, flags, *args, **kwargs)

        with patch.object(os, "open", side_effect=rdonly_ok_rdwr_denied):
            result = delivery_check.check_delivery(app, data)
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["exit_code"], 2)
        self.assertIn("unknown", result["reason"])
        self.assertEqual(listing(data), before)

    def test_real_readonly_lock_file_blocks_unknown(self):
        # Qa2 shape, no mocks: a genuinely read-only lock file cannot
        # be opened O_RDWR, so no exclusive probe is possible and the
        # state is unknown -- never "verified free".
        app, data = self.ready_pair()
        lock = data / "sender.lock"
        lock.write_bytes(b"synthetic-lock")
        os.chmod(lock, stat.S_IREAD)
        self.addCleanup(os.chmod, lock, stat.S_IWRITE)
        try:
            probe = os.open(os.fspath(lock), os.O_RDWR)
        except OSError:
            pass
        else:
            os.close(probe)
            self.skipTest("platform allows O_RDWR on read-only files")
        before = listing(data)
        result = delivery_check.check_delivery(app, data)
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["exit_code"], 2)
        self.assertIn("unknown", result["reason"])
        self.assertEqual(listing(data), before)

    def test_midprobe_delete_cannot_recreate_lock(self):
        # Deletion raced into the probe window must fail safe and must
        # never recreate sender.lock: single descriptor, no O_CREAT,
        # no reopen. On Windows the open descriptor additionally
        # refuses the delete (no delete sharing), pinning the file for
        # the probe; where the delete goes through, nothing recreates
        # the file afterwards.
        app, data = self.ready_pair()
        (data / "sender.lock").write_bytes(b"synthetic-lock")
        before_pair = (data / "pairing.json").read_bytes()
        before_token = (data / "api-token.txt").read_bytes()
        outcomes = {}
        if os.name == "nt":
            import msvcrt as mech
            real_call = mech.locking

            def delete_then_call(fd, *args):
                try:
                    (data / "sender.lock").unlink()
                    outcomes["deleted"] = True
                except OSError as exc:
                    outcomes["deleted"] = False
                    outcomes["errno"] = exc.errno
                return real_call(fd, *args)

            patcher = patch.object(mech, "locking", side_effect=delete_then_call)
        else:
            import fcntl as mech
            real_call = mech.flock

            def delete_then_call(fd, *args):
                try:
                    (data / "sender.lock").unlink()
                    outcomes["deleted"] = True
                except OSError as exc:
                    outcomes["deleted"] = False
                    outcomes["errno"] = exc.errno
                return real_call(fd, *args)

            patcher = patch.object(mech, "flock", side_effect=delete_then_call)
        with patcher:
            result = delivery_check.check_delivery(app, data)
        # Freedom was positively verified on a real descriptor, so the
        # verdict is ready either way; the file state differs by platform.
        self.assertEqual(result["status"], "ready", result)
        self.assertEqual((data / "pairing.json").read_bytes(), before_pair)
        self.assertEqual((data / "api-token.txt").read_bytes(), before_token)
        if outcomes.get("deleted"):
            self.assertFalse(os.path.exists(os.fspath(data / "sender.lock")),
                             "checker must never recreate sender.lock")
        else:
            self.assertTrue((data / "sender.lock").is_file())
            self.assertIn("errno", outcomes)

    def test_missing_lock_implementation_fails_closed(self):
        # A platform without the lock API cannot verify anything.
        app, data = self.ready_pair()
        (data / "sender.lock").write_bytes(b"synthetic-lock")
        before = listing(data)
        module = "msvcrt" if os.name == "nt" else "fcntl"
        with patch.dict(sys.modules, {module: None}):
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

    def test_worker_rejected_shapes_never_ready(self):
        # F1 parity table: every shape the vendored worker loader
        # (config.py RuntimeConfig.local_endpoint / Config.references)
        # rejects must not yield ready from check_delivery.
        model = self.base / "model.gguf"
        model.write_bytes(b"GGUF-synthetic")
        shapes = {
            "attach-no-base_url": ATTACH_NO_URL,
            "attach-non-loopback": ATTACH_NON_LOOPBACK,
            "duplicate-runtime-ids": DUPE_RUNTIME_IDS.replace(
                "MODELFILE", "model.gguf"),
            "unknown-runtime-ref": UNKNOWN_RUNTIME_REF.replace(
                "MODELFILE", model.as_posix()),
            "managed-with-base_url": MANAGED_WITH_BASE_URL.replace(
                "MODELFILE", model.as_posix()),
            "mock-attach-with-valid-managed":
                MOCK_ATTACH_WITH_VALID_MANAGED.replace(
                    "MODELFILE", model.as_posix()),
        }
        for name, config in shapes.items():
            with self.subTest(shape=name):
                app = make_app(self.base / f"app-{name}")
                data = make_data(self.base / f"data-{name}", config=config)
                if "MODELFILE" in (data / "config.toml").read_text():
                    self.fail(f"fixture {name} left MODELFILE unsubstituted")
                (data / "model.gguf").write_bytes(b"GGUF-synthetic")
                result = delivery_check.check_delivery(app, data)
                self.assertEqual(result["status"], "blocked", result)
                self.assertEqual(result["exit_code"], 2, result)
                self.assertNotEqual(
                    result["runtime"].get("status"), "ready", result)

    def test_duplicate_runtime_ids_named(self):
        app = make_app(self.base / "app")
        data = make_data(
            self.base / "data",
            config=DUPE_RUNTIME_IDS.replace("MODELFILE", "model.gguf"))
        (data / "model.gguf").write_bytes(b"GGUF-synthetic")
        result = delivery_check.check_delivery(app, data)
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["exit_code"], 2)
        self.assertIn("unique",
                      result["reason"] + result["runtime"]["reason"])

    def test_unknown_runtime_reference_named(self):
        model = self.base / "model.gguf"
        model.write_bytes(b"GGUF-synthetic")
        app = make_app(self.base / "app")
        data = make_data(
            self.base / "data",
            config=UNKNOWN_RUNTIME_REF.replace("MODELFILE", model.as_posix()))
        result = delivery_check.check_delivery(app, data)
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["exit_code"], 2)
        self.assertIn("ghost", result["reason"] + result["runtime"]["reason"])

    def test_valid_attach_loopback_is_ready(self):
        # Valid case preserved: attach with http loopback base_url stays ready.
        app = make_app(self.base / "app")
        data = make_data(self.base / "data", config=ATTACH_LOOPBACK)
        result = delivery_check.check_delivery(app, data)
        self.assertEqual(result["status"], "ready", result)
        self.assertEqual(result["exit_code"], 0)

    def test_model_path_cwd_only_is_not_ready(self):
        # F2: a model filename present only in the process CWD must not
        # count; the worker resolves it against the config parent.
        work = self.base / "work"
        work.mkdir(parents=True, exist_ok=True)
        (work / "cwd-only-model.gguf").write_bytes(b"GGUF-synthetic")
        old_cwd = os.getcwd()
        os.chdir(work)
        self.addCleanup(os.chdir, old_cwd)
        app = make_app(self.base / "app")
        data = make_data(
            self.base / "data",
            config=REAL_CONFIG.replace("MODELFILE", "cwd-only-model.gguf"))
        self.assertFalse((data / "cwd-only-model.gguf").exists())
        result = delivery_check.check_delivery(app, data)
        self.assertEqual(result["status"], "blocked", result)
        self.assertEqual(result["exit_code"], 2)

    def test_model_path_beside_config_is_ready(self):
        # F2 valid cases preserved: config-parent-relative and absolute
        # paths still count.
        app = make_app(self.base / "app")
        data = make_data(
            self.base / "data",
            config=REAL_CONFIG.replace("MODELFILE", "model.gguf"))
        (data / "model.gguf").write_bytes(b"GGUF-synthetic")
        result = delivery_check.check_delivery(app, data)
        self.assertEqual(result["status"], "ready", result)
        self.assertEqual(result["exit_code"], 0)

    def test_non_string_runtime_id_is_unknown_not_crash(self):
        # F3: unhashable runtime ids must yield unknown, never raise.
        for name, config in (("list-id", LIST_RUNTIME_ID),
                             ("missing-id", MISSING_RUNTIME_ID)):
            with self.subTest(shape=name):
                app = make_app(self.base / f"app-{name}")
                data = make_data(self.base / f"data-{name}", config=config)
                result = delivery_check.check_delivery(app, data)
                self.assertEqual(result["status"], "blocked", result)
                self.assertEqual(result["exit_code"], 2)
                self.assertEqual(result["runtime"].get("status"), "unknown")

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

    def test_launcher_delivery_check_rejects_bad_attach(self):
        # F1 CLI contract: worker-rejected attach shape prints a reason
        # and exits non-zero, never ready.
        app = make_app(self.base / "app")
        data = make_data(self.base / "data", config=ATTACH_NO_URL)
        launcher_spec = importlib.util.spec_from_file_location(
            "installed_launcher_probe", WINDOWS / "launcher.py")
        launcher = importlib.util.module_from_spec(launcher_spec)
        launcher_spec.loader.exec_module(launcher)
        rc = launcher.main(["delivery-check", "--app-dir", str(app),
                            "--data-dir", str(data)])
        self.assertEqual(rc, 2)

    def test_launcher_delivery_check_bad_id_no_traceback(self):
        # F3 CLI contract: malformed runtime id prints a reason and exits
        # non-zero instead of escaping as a traceback.
        app = make_app(self.base / "app")
        data = make_data(self.base / "data", config=LIST_RUNTIME_ID)
        launcher_spec = importlib.util.spec_from_file_location(
            "installed_launcher_probe", WINDOWS / "launcher.py")
        launcher = importlib.util.module_from_spec(launcher_spec)
        launcher_spec.loader.exec_module(launcher)
        rc = launcher.main(["delivery-check", "--app-dir", str(app),
                            "--data-dir", str(data)])
        self.assertEqual(rc, 2)

    def test_imports_resolve_current_candidate(self):
        # The parity assertions below are only meaningful against the
        # candidate lane's own modules, not another checkout or install.
        import dendrite.config as candidate_config
        self.assertEqual(
            Path(delivery_check.__file__).resolve().parent, WINDOWS)
        self.assertTrue(
            str(Path(candidate_config.__file__).resolve()).startswith(
                str(ROOT)),
            candidate_config.__file__)

    def test_reviewer_schema_shapes_never_ready(self):
        # Independent-review parity table: every shape the vendored
        # worker loader rejects must not yield ready, and the loader
        # itself must reject the written file (authoritative oracle).
        shapes = {
            "duplicate-model-ids": DUPE_MODEL_IDS,
            "managed-port-collision": PORT_COLLISION_MANAGED,
            "node-port-collision": NODE_PORT_COLLISION,
            "unsupported-kind-mixed": UNSUPPORTED_KIND_MIXED,
            "missing-kind-mixed": MISSING_KIND_MIXED,
            "missing-capabilities": MISSING_CAPABILITIES,
            "empty-capabilities": EMPTY_CAPABILITIES,
            "invalid-mode": INVALID_MODE,
            "port-out-of-range-hi": BAD_PORT_HI,
            "port-out-of-range-zero": BAD_PORT_ZERO,
        }
        for name, config in shapes.items():
            with self.subTest(shape=name):
                app = make_app(self.base / f"app-{name}")
                data = make_data(self.base / f"data-{name}", config=config)
                if "MODELFILE" in config:
                    (data / "model.gguf").write_bytes(b"GGUF-synthetic")
                    (data / "config.toml").write_text(
                        config.replace("MODELFILE", "model.gguf"),
                        encoding="utf-8")
                with self.assertRaises(Exception,
                                       msg=f"loader accepts {name}"):
                    load_config(data / "config.toml")
                result = delivery_check.check_delivery(app, data)
                self.assertEqual(result["status"], "blocked", result)
                self.assertEqual(result["exit_code"], 2, result)
                self.assertNotEqual(
                    result["runtime"].get("status"), "ready", result)

    def test_every_ready_fixture_is_loader_accepted(self):
        # A preflight ready must imply a worker-acceptable config: every
        # fixture the suite calls ready is executed through the actual
        # vendored loader, which must accept it.
        managed = self.base / "model.gguf"
        managed.write_bytes(b"GGUF-synthetic")
        ready_shapes = {
            # (config, model file the worker must resolve to)
            "managed-absolute": (
                REAL_CONFIG.replace("MODELFILE", managed.as_posix()),
                managed),
            "attach-loopback": (ATTACH_LOOPBACK, None),
        }
        for name, (config, model_file) in ready_shapes.items():
            with self.subTest(shape=name):
                app = make_app(self.base / f"app-{name}")
                data = make_data(self.base / f"data-{name}", config=config)
                loaded = load_config(data / "config.toml")
                result = delivery_check.check_delivery(app, data)
                self.assertEqual(result["status"], "ready", result)
                self.assertEqual(result["exit_code"], 0, result)
                if model_file is not None:
                    resolved = [m.path for m in loaded.models
                                if m.path is not None]
                    self.assertTrue(
                        any(Path(p).exists() for p in resolved),
                        f"worker resolves no existing model for {name}")
        # Config-parent-relative valid case (F2 guard): the worker
        # resolves the relative path against the config parent.
        app = make_app(self.base / "app-rel")
        data = make_data(
            self.base / "data-rel",
            config=REAL_CONFIG.replace("MODELFILE", "model.gguf"))
        (data / "model.gguf").write_bytes(b"GGUF-synthetic")
        loaded = load_config(data / "config.toml")
        result = delivery_check.check_delivery(app, data)
        self.assertEqual(result["status"], "ready", result)
        self.assertEqual(result["exit_code"], 0, result)
        self.assertTrue(
            any(m.path is not None and Path(m.path).exists()
                for m in loaded.models))

    def test_loader_unavailable_is_unknown_never_ready(self):
        # Honesty fix: without the authoritative loader, no config may be
        # reported ready OR verified-blocked; every shape is unknown.
        provenance = _loader_provenance()
        self.assertTrue(provenance["dendrite.config"].startswith(str(ROOT)),
                        provenance)
        tag = "; ".join(f"{k}={v}" for k, v in provenance.items())
        shapes = {
            "valid-managed": REAL_CONFIG.replace("MODELFILE", "model.gguf"),
            "attach-no-base-url": ATTACH_NO_URL,
            "duplicate-model-ids": DUPE_MODEL_IDS,
            "invalid-mode": INVALID_MODE,
            "port-out-of-range": BAD_PORT_HI,
        }
        for phase, blocked in (("no-loader-stack", ("dendrite", "pydantic")),
                               ("no-pydantic", ("pydantic",))):
            with self.subTest(phase=phase):
                evicted = _evict_modules("dendrite", "pydantic")
                blocker = _BlockImports(*blocked, provenance=tag)
                sys.meta_path.insert(0, blocker)
                try:
                    with self.assertRaises(ImportError):
                        importlib.import_module("dendrite.config")
                    for name, config in shapes.items():
                        with self.subTest(shape=name):
                            app = make_app(self.base / f"app-{phase}-{name}")
                            data = make_data(
                                self.base / f"data-{phase}-{name}",
                                config=config)
                            if "MODELFILE" in config:
                                (data / "model.gguf").write_bytes(
                                    b"GGUF-synthetic")
                                (data / "config.toml").write_text(
                                    config.replace("MODELFILE", "model.gguf"),
                                    encoding="utf-8")
                            result = delivery_check.check_delivery(app, data)
                            self.assertEqual(result["status"], "blocked",
                                             result)
                            self.assertEqual(result["exit_code"], 2, result)
                            self.assertEqual(
                                result["runtime"].get("status"), "unknown",
                                result)
                            self.assertIn(
                                "unavailable",
                                result["runtime"]["reason"] + result["reason"],
                                result)
                finally:
                    sys.meta_path.remove(blocker)
                    sys.modules.update(evicted)

    def test_broken_loader_import_is_unknown(self):
        # A worker loader that raises outside ImportError is still just
        # unavailable: unknown, no traceback.
        provenance = _loader_provenance()
        tag = "; ".join(f"{k}={v}" for k, v in provenance.items())
        evicted = _evict_modules("dendrite", "pydantic")
        breaker = _BreakImports("dendrite", provenance=tag)
        sys.meta_path.insert(0, breaker)
        try:
            with self.assertRaises(RuntimeError):
                importlib.import_module("dendrite.config")
            app = make_app(self.base / "app")
            data = make_data(
                self.base / "data",
                config=REAL_CONFIG.replace("MODELFILE", "model.gguf"))
            (data / "model.gguf").write_bytes(b"GGUF-synthetic")
            result = delivery_check.check_delivery(app, data)
            self.assertEqual(result["status"], "blocked", result)
            self.assertEqual(result["exit_code"], 2, result)
            self.assertEqual(result["runtime"].get("status"), "unknown",
                             result)
            self.assertIn("unavailable", result["reason"], result)
        finally:
            sys.meta_path.remove(breaker)
            sys.modules.update(evicted)

    def test_launcher_loader_unavailable_is_blocked(self):
        # CLI contract under an unavailable loader: exit 2 with a reason,
        # never ready and never a traceback.
        provenance = _loader_provenance()
        tag = "; ".join(f"{k}={v}" for k, v in provenance.items())
        evicted = _evict_modules("dendrite", "pydantic")
        blocker = _BlockImports("dendrite", "pydantic", provenance=tag)
        sys.meta_path.insert(0, blocker)
        try:
            app = make_app(self.base / "app")
            data = make_data(
                self.base / "data",
                config=REAL_CONFIG.replace("MODELFILE", "model.gguf"))
            (data / "model.gguf").write_bytes(b"GGUF-synthetic")
            launcher_spec = importlib.util.spec_from_file_location(
                "installed_launcher_probe", WINDOWS / "launcher.py")
            launcher = importlib.util.module_from_spec(launcher_spec)
            launcher_spec.loader.exec_module(launcher)
            rc = launcher.main(["delivery-check", "--app-dir", str(app),
                                "--data-dir", str(data)])
            self.assertEqual(rc, 2)
        finally:
            sys.meta_path.remove(blocker)
            sys.modules.update(evicted)


if __name__ == "__main__":
    unittest.main()

"""Focused planner tests: missing engine, spaced paths, malformed config,
incompatible placement, mock-only, deny/consent states.

Deterministic and offline: injected PATH/GGUF/hardware probes, real files
only in isolated temp dirs. Stdlib unittest only (no third-party deps).
Covers both the vendored and stdlib-fallback config sources; the fallback
is forced where noted so results hold with or without installed deps.
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT))

import runtime_setup
from runtime_setup import plan_setup
from runtime_discovery import (
    assess_placement,
    check_gguf_magic,
    discover_engines,
    summarize_config_models,
)


def no_engines(name):
    return None


def only_ollama(name):
    return "/usr/bin/ollama" if name == "ollama" else None


def fake_hardware(**over):
    hw = {"os": "Windows", "arch": "AMD64", "logical_cpus": 8,
          "memory_total_bytes": 16 * 1024**3, "gpus": []}
    hw.update(over)
    return hw


def managed_config(tmp, *, kind="ik_llama", exe="llama-server",
                   model_path="model.gguf", extra_model=None,
                   threads=2, gpu_layers=0, mode="managed",
                   upstream=None):
    path = Path(tmp) / model_path if model_path else None
    runtime = SimpleNamespace(id="cpu", kind=kind, mode=mode,
                              executable=exe, port=8081, base_url=None,
                              threads=threads, gpu_layers=gpu_layers)
    model = SimpleNamespace(id="m", runtime="cpu", capabilities=["summarize"],
                            path=str(path) if path else None,
                            upstream_model=upstream)
    return SimpleNamespace(runtimes=[runtime], models=[model])


def write_config(tmp, text, name="config.toml"):
    cfg = Path(tmp) / name
    cfg.write_text(text, encoding="utf-8")
    return str(cfg)


CPU_TOML = """\
[node]
id = "t"
host = "127.0.0.1"
port = 8090

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
path = "{model}"
"""


class DiscoveryTests(unittest.TestCase):
    def test_missing_engine_all_unobserved(self):
        engines = discover_engines(which=no_engines)
        by_name = {e.name: e for e in engines}
        self.assertFalse(by_name["llama-server"].observed)
        self.assertFalse(by_name["llama-server"].selectable)
        self.assertFalse(by_name["ik_llama-server"].observed)
        self.assertIn("install", by_name["llama-server"].note)

    def test_ollama_observed_but_never_selectable(self):
        engines = discover_engines(which=only_ollama)
        ollama = next(e for e in engines if e.name == "ollama")
        self.assertTrue(ollama.observed)
        self.assertFalse(ollama.selectable)

    def test_gguf_magic_boundaries(self):
        with tempfile.TemporaryDirectory() as tmp:
            good = Path(tmp) / "a.gguf"
            good.write_bytes(b"GGUF" + b"\x00" * 100)
            bad = Path(tmp) / "b.gguf"
            bad.write_bytes(b"NOTG")
            self.assertEqual(check_gguf_magic(str(good)), "gguf")
            self.assertEqual(check_gguf_magic(str(bad)), "not-gguf")
            self.assertEqual(check_gguf_magic(str(Path(tmp) / "missing.gguf")),
                             "unreadable")

    def test_incompatible_gpu_placement(self):
        cfg = managed_config("x", gpu_layers=4)
        assessed = assess_placement(cfg, fake_hardware(gpus=[]))
        self.assertEqual(len(assessed), 1)
        self.assertFalse(assessed[0].compatible)
        self.assertTrue(any("gpu_layers" in n for n in assessed[0].notes))

    def test_fail_closed_gpu_request_without_hardware(self):
        cfg = managed_config("x", gpu_layers=1)
        assessed = assess_placement(cfg, None)
        self.assertFalse(assessed[0].compatible)

    def test_thread_oversubscription_is_advisory_only(self):
        cfg = managed_config("x", threads=64)
        assessed = assess_placement(cfg, fake_hardware())
        self.assertTrue(assessed[0].compatible)
        self.assertTrue(any("advisory" in n for n in assessed[0].notes))


class PlanTests(unittest.TestCase):
    def _plan(self, config_text=None, *, loaded=None, model_file=None,
              which=no_engines, hardware=None, consent=False, gguf=None):
        with tempfile.TemporaryDirectory() as tmp:
            if loaded is not None:
                with patch.object(runtime_setup, "load_config_adapter",
                                  return_value=("fallback", loaded)):
                    return plan_setup("fixture.toml", consent=consent,
                                      which=which, hardware=hardware,
                                      gguf_check=gguf)
            if model_file is not None:
                name, content = model_file
                (Path(tmp) / name).write_bytes(content)
            cfg_path = write_config(tmp, config_text)
            with patch.object(runtime_setup, "_vendored_config_loader",
                              return_value=None):
                return plan_setup(cfg_path, consent=consent, which=which,
                                  hardware=hardware, gguf_check=gguf)

    def test_missing_engine_is_setup_required(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "m.gguf").write_bytes(b"GGUFxx")
            plan = self._plan(CPU_TOML.format(model="m.gguf"),
                              which=no_engines, hardware=fake_hardware())
            self.assertEqual(plan["status"], "setup-required")
            self.assertTrue(plan["consent"]["required"])
            self.assertFalse(plan["consent"]["granted"])
            self.assertTrue(any("llama-server" in a and "install" in a
                                for a in plan["unqualified"]))

    def test_ready_only_with_engine_and_gguf_evidence(self):
        def which(name):
            return "C:\\tools\\llama-server.exe" if name == "llama-server" else None

        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "m.gguf").write_bytes(b"GGUFxx")
            cfg_path = write_config(tmp, CPU_TOML.format(model="m.gguf"))
            with patch.object(runtime_setup, "_vendored_config_loader",
                              return_value=None):
                plan = plan_setup(cfg_path, which=which,
                                  hardware=fake_hardware())
        self.assertEqual(plan["status"], "ready")
        self.assertFalse(plan["consent"]["required"])
        self.assertTrue(any("GGUF magic verified" in e for e in plan["evidence"]))

    def test_non_gguf_file_downgrades_claimed_ready(self):
        def which(name):
            return "/bin/llama-server" if name == "llama-server" else None

        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "m.gguf").write_bytes(b"FAKE")
            cfg_path = write_config(tmp, CPU_TOML.format(model="m.gguf"))
            with patch.object(runtime_setup, "_vendored_config_loader",
                              return_value=None):
                plan = plan_setup(cfg_path, which=which,
                                  hardware=fake_hardware())
        self.assertEqual(plan["status"], "setup-required")
        self.assertTrue(any("not a GGUF" in u for u in plan["unqualified"]))

    def test_paths_with_spaces(self):
        def which(name):
            return "/bin/llama-server" if name == "llama-server" else None

        with tempfile.TemporaryDirectory(prefix="dir with space ") as tmp:
            (Path(tmp) / "my model.gguf").write_bytes(b"GGUFxx")
            cfg_path = write_config(tmp, CPU_TOML.format(model="my model.gguf"))
            with patch.object(runtime_setup, "_vendored_config_loader",
                              return_value=None):
                plan = plan_setup(cfg_path, which=which,
                                  hardware=fake_hardware())
        self.assertEqual(plan["status"], "ready")

    def test_malformed_config_is_error_not_setup(self):
        plan = self._plan("[[runtimes\nbroken = = =",
                          which=no_engines, hardware=fake_hardware())
        self.assertEqual(plan["status"], "config-error")
        self.assertFalse(plan["consent"]["required"])
        self.assertTrue(any("Nothing was installed" in a for a in plan["actions"]))

    def test_incompatible_placement_blocks_ready(self):
        def which(name):
            return "/bin/llama-server" if name == "llama-server" else None

        toml = CPU_TOML.format(model="m.gguf").replace("gpu_layers = 0",
                                                      "gpu_layers = 8")
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "m.gguf").write_bytes(b"GGUFxx")
            cfg_path = write_config(tmp, toml)
            with patch.object(runtime_setup, "_vendored_config_loader",
                              return_value=None):
                plan = plan_setup(cfg_path, which=which,
                                  hardware=fake_hardware())
        self.assertEqual(plan["status"], "setup-required")
        self.assertTrue(any("gpu_layers" in u for u in plan["unqualified"]))

    def test_mock_only_lists_demo_election(self):
        mock_toml = CPU_TOML.replace('kind = "ik_llama"', 'kind = "mock"')
        mock_toml = mock_toml.replace('executable = "llama-server"\n', "")
        plan = self._plan(mock_toml, which=no_engines,
                          hardware=fake_hardware())
        self.assertEqual(plan["status"], "setup-required")
        self.assertTrue(plan["mock_only"])
        self.assertTrue(any(runtime_setup.MOCK_DEMO_ENV in a
                            for a in plan["actions"]))

    def test_consent_denied_by_default_granted_when_explicit(self):
        denied = self._plan(CPU_TOML.format(model="m.gguf"),
                            which=no_engines, hardware=fake_hardware())
        self.assertTrue(denied["consent"]["required"])
        self.assertFalse(denied["consent"]["granted"])
        granted = self._plan(CPU_TOML.format(model="m.gguf"),
                             which=no_engines, hardware=fake_hardware(),
                             consent=True)
        self.assertTrue(granted["consent"]["granted"])
        # Consent is recorded only: the planner itself changes nothing.
        self.assertIn("never downloads", " ".join(granted["actions"]))

    def test_ollama_presence_never_counts_as_runtime(self):
        plan = self._plan(CPU_TOML.format(model="m.gguf"),
                          which=only_ollama, hardware=fake_hardware(),
                          model_file=("m.gguf", b"GGUFxx"))
        self.assertEqual(plan["status"], "setup-required")
        # Ollama is honestly recorded as observed, but never selectable:
        # readiness still hinges on the configured llama-server engine.
        self.assertIn("ollama", plan.get("engines_observed", []))
        self.assertTrue(any("llama-server" in u for u in plan["unqualified"]))

    def test_duck_typed_fixture_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "model.gguf").write_bytes(b"GGUFxx")
            cfg = managed_config(tmp)
            obs = summarize_config_models(cfg)
            self.assertEqual(obs[0].gguf, "gguf")
            self.assertEqual(obs[0].size_bytes, 6)
        self.assertEqual(plan_setup("x", which=no_engines,
                                    hardware=fake_hardware())["status"],
                         "config-error")


class CliTests(unittest.TestCase):
    def test_cli_exit_codes_and_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "m.gguf").write_bytes(b"GGUFxx")
            cfg_path = write_config(tmp, CPU_TOML.format(model="m.gguf"))
            with patch.object(runtime_setup, "_vendored_config_loader",
                              return_value=None), \
                 patch.object(runtime_setup.shutil, "which",
                              return_value=None):
                code = runtime_setup.main(["--config", cfg_path])
                self.assertEqual(code, 2)
                code = runtime_setup.main(["--config", cfg_path, "--json",
                                           "--consent", "yes"])
                self.assertEqual(code, 2)

    def test_cli_json_shape(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg_path = write_config(tmp, "not toml [[ [")
            with patch.object(runtime_setup, "_vendored_config_loader",
                              return_value=None):
                import io
                from contextlib import redirect_stdout

                buf = io.StringIO()
                with redirect_stdout(buf):
                    code = runtime_setup.main(["--config", cfg_path, "--json"])
                self.assertEqual(code, 1)
                plan = json.loads(buf.getvalue())
                self.assertEqual(plan["status"], "config-error")

    def _run_main(self, args):
        import io
        from contextlib import redirect_stderr, redirect_stdout

        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = runtime_setup.main(args)
        return code, out.getvalue(), err.getvalue()

    def test_missing_config_human_no_traceback(self):
        # REVIEW-RUNTIME-1 HOLD: default human output crashed with
        # KeyError: 'classifier' on config-error plans.
        with tempfile.TemporaryDirectory() as tmp:
            missing = str(Path(tmp) / "nope.toml")
            with patch.object(runtime_setup, "_vendored_config_loader",
                              return_value=None):
                code, out, err = self._run_main(["--config", missing])
        self.assertEqual(code, 1)
        self.assertIn("config-error", out)
        self.assertNotIn("Traceback", out + err)
        self.assertNotIn("KeyError", out + err)

    def test_malformed_config_human_no_traceback(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg_path = write_config(tmp, "[[runtimes\nbroken = = =")
            with patch.object(runtime_setup, "_vendored_config_loader",
                              return_value=None):
                code, out, err = self._run_main(["--config", cfg_path])
        self.assertEqual(code, 1)
        self.assertIn("config-error", out)
        self.assertNotIn("Traceback", out + err)
        self.assertNotIn("KeyError", out + err)

    def test_missing_config_json_shape(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = str(Path(tmp) / "nope.toml")
            with patch.object(runtime_setup, "_vendored_config_loader",
                              return_value=None):
                import io
                from contextlib import redirect_stdout

                buf = io.StringIO()
                with redirect_stdout(buf):
                    code = runtime_setup.main(["--config", missing, "--json"])
                self.assertEqual(code, 1)
                plan = json.loads(buf.getvalue())
                self.assertEqual(plan["status"], "config-error")
                self.assertIn("classifier", plan)

    def test_ready_plan_states_preflight_scope(self):
        # "ready" is setup/preflight readiness only; the unqualified
        # remainder (usability, residency, identity, inference) stays marked.
        import io
        from contextlib import redirect_stdout

        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "m.gguf").write_bytes(b"GGUFxx")
            cfg_path = write_config(tmp, CPU_TOML.format(model="m.gguf"))
            with patch.object(runtime_setup, "_vendored_config_loader",
                              return_value=None), \
                 patch.object(runtime_setup.shutil, "which",
                              return_value="/bin/llama-server"):
                code, out, err = self._run_main(["--config", cfg_path])
                json_buf = io.StringIO()
                with redirect_stdout(json_buf):
                    json_code = runtime_setup.main(
                        ["--config", cfg_path, "--json"])
                plan = plan_setup(cfg_path,
                                  which=lambda n: "/bin/llama-server",
                                  hardware=fake_hardware())
        self.assertEqual(code, 0)
        self.assertEqual(json_code, 0)
        self.assertEqual(plan["status"], "ready")
        self.assertIn("preflight", plan["readiness_scope"])
        for marker in ("executable usability", "residency",
                       "identity attestation", "inference qualification"):
            self.assertTrue(any(marker in item for item in plan["not_verified"]),
                            marker)
        self.assertIn("preflight", out)
        self.assertIn("not verified (not run)", out)
        self.assertEqual(json.loads(json_buf.getvalue())["status"], "ready")


if __name__ == "__main__":
    unittest.main()

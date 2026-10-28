"""Synthetic installation acceptance. Never starts a native engine or downloads models."""
import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import URLError
from urllib.request import urlopen, Request

from dendrite.api import create_app
from dendrite.config import load_config, ModelConfig, NodeConfig, RuntimeConfig
from dendrite.runtimes.base import RuntimeFailure
from dendrite.runtimes.llama import LlamaRuntime
from dendrite.schemas import ExecuteRequest

ROOT = Path(__file__).resolve().parent


class InstallationTests(unittest.TestCase):
    def test_vendor_integrity(self):
        subprocess.run([sys.executable, str(ROOT / "verify_vendor.py")], check=True)

    def test_installed_cli(self):
        cli = Path(sys.executable).parent / ("dendrite.exe" if os.name == "nt" else "dendrite")
        result = subprocess.run([str(cli), "--help"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("serve", result.stdout)

    def test_inspect_mock(self):
        result = subprocess.run([sys.executable, "-m", "dendrite.cli", "inspect", "--config",
                                 str(ROOT / "configs/mock.toml")], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        self.assertEqual(data["execution_scope"], "local")
        self.assertTrue(data["models"][0]["simulated"])

    def test_bad_config_cli(self):
        for content in ("[node\n", (ROOT / "configs/mock.toml").read_text() + "\nunknown = true\n"):
            with self.subTest(content=content[:20]), tempfile.TemporaryDirectory() as temp:
                config = Path(temp) / "bad.toml"
                config.write_text(content)
                result = subprocess.run([sys.executable, "-m", "dendrite.cli", "inspect", "--config",
                                         str(config)], capture_output=True, text=True)
                self.assertEqual(result.returncode, 2)
                self.assertIn("dendrite:", result.stderr)

    def test_cpu_configuration(self):
        config = load_config(ROOT / "configs/cpu.toml")
        self.assertEqual(config.node.host, "127.0.0.1")
        self.assertIsNone(config.node.fabric_url)
        self.assertIsNone(config.node.control_plane_url)
        runtime = LlamaRuntime(config.runtimes[0], config.node)
        try:
            command = runtime.command(config.models[0])
            self.assertEqual(command[command.index("--n-gpu-layers") + 1], "0")
            self.assertEqual(config.runtimes[0].mode, "managed")
        finally:
            asyncio.run(runtime.client.aclose())

    def test_network_bind_requires_token(self):
        config = load_config(ROOT / "configs/mock.toml")
        config.node.host = "0.0.0.0"
        with patch.dict(os.environ, {}, clear=True), self.assertRaisesRegex(ValueError, "token|TOKEN"):
            create_app(config)

    def test_missing_model_and_engine_never_spawn(self):
        async def exercise():
            with tempfile.TemporaryDirectory() as temp:
                config = RuntimeConfig(id="cpu", kind="ik_llama", executable="absent-aipster-engine-7431")
                runtime = LlamaRuntime(config, NodeConfig(state_dir=Path(temp)))
                model = ModelConfig(id="fake", runtime="cpu", capabilities=["summarize"],
                                    path=Path(temp) / "fixture.gguf")
                try:
                    with patch("asyncio.create_subprocess_exec", side_effect=AssertionError("must not spawn")):
                        with self.assertRaisesRegex(RuntimeFailure, "readable local GGUF"):
                            await runtime.ensure_loaded(model)
                        model.path.write_bytes(b"GGUF-fixture-not-a-model")
                        with self.assertRaisesRegex(RuntimeFailure, "binary not found"):
                            await runtime.ensure_loaded(model)
                finally:
                    await runtime.client.aclose()
        asyncio.run(exercise())

    def test_mock_daemon_health_and_execution(self):
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        with tempfile.TemporaryDirectory() as temp:
            config = Path(temp) / "mock.toml"
            config.write_text((ROOT / "configs/mock.toml").read_text().replace("port = 8090", f"port = {port}")
                              .replace('state_dir = "../.state"', 'state_dir = "state"'))
            env = {k: v for k, v in os.environ.items() if k.upper() in {
                "PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "COMSPEC"}}
            process = subprocess.Popen([sys.executable, "-m", "dendrite.cli", "serve", "--config", str(config)],
                                       env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            base = f"http://127.0.0.1:{port}"
            try:
                deadline = time.monotonic() + 20
                while True:
                    try:
                        with urlopen(base + "/healthz", timeout=1) as response:
                            self.assertEqual(json.load(response)["status"], "ok")
                        break
                    except URLError:
                        if process.poll() is not None or time.monotonic() > deadline:
                            self.fail("Mock daemon failed startup")
                        time.sleep(.1)
                payload = json.dumps({"capability": "summarize", "model_id": "mock-summary",
                                      "prompt": "SYNTHETIC INSTALL FIXTURE", "max_tokens": 16}).encode()
                with urlopen(Request(base + "/v1/execute", data=payload,
                                     headers={"Content-Type": "application/json"}), timeout=5) as response:
                    result = json.load(response)
                self.assertTrue(result["simulated"])
                self.assertEqual(result["model_id"], "mock-summary")
                self.assertEqual(result["node_id"], "standalone-demo")
            finally:
                process.terminate()
                process.wait(timeout=10)

    def test_fake_native_adapter(self):
        calls = []
        class Fixture(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass
            def send(self, value):
                data = json.dumps(value).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            def do_GET(self):
                self.send({"status": "ok"} if self.path == "/health" else {"data": [{"id": "fixture"}]})
            def do_POST(self):
                calls.append((self.path, json.loads(self.rfile.read(int(self.headers["Content-Length"])))))
                self.send({"content": "FAKE NATIVE FIXTURE", "tokens_evaluated": 3, "tokens_predicted": 2})
        server = ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        async def exercise():
            config = RuntimeConfig(id="fixture", kind="ik_llama", mode="attach",
                                   base_url=f"http://127.0.0.1:{server.server_port}")
            runtime = LlamaRuntime(config, NodeConfig())
            model = ModelConfig(id="test", runtime="fixture", capabilities=["summarize"], upstream_model="fixture")
            try:
                await runtime.ensure_loaded(model)
                result = await runtime.generate(ExecuteRequest(capability="summarize", prompt="fixture", max_tokens=16))
                self.assertEqual(result["content"], "FAKE NATIVE FIXTURE")
                self.assertEqual(calls, [("/completion", {"prompt": "fixture", "n_predict": 16,
                    "temperature": .2, "cache_prompt": True, "id_slot": 0, "stream": False})])
            finally:
                await runtime.client.aclose()
        try:
            asyncio.run(exercise())
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


if __name__ == "__main__":
    unittest.main(verbosity=2)

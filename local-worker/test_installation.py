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
from urllib.error import HTTPError, URLError
from urllib.request import urlopen, Request

from fastapi.testclient import TestClient
from pydantic import ValidationError

from dendrite.api import create_app
from dendrite.config import load_config, ModelConfig, NodeConfig, RuntimeConfig
from dendrite.runtimes.base import RuntimeFailure
from dendrite.runtimes.llama import LlamaRuntime
from dendrite.schemas import ExecuteRequest

ROOT = Path(__file__).resolve().parent
# Synthetic test-only value; never a real credential.
TOKEN = "synthetic-test-token-0123456789abcdef"
EXECUTE = {"capability": "summarize", "model_id": "mock-summary",
           "prompt": "SYNTHETIC INSTALL FIXTURE", "max_tokens": 16}


def mock_config(tmp, **node):
    config = load_config(ROOT / "configs/mock.toml")
    config.node.state_dir = Path(tmp)
    for key, value in node.items():
        setattr(config.node, key, value)
    return config


class InstallationTests(unittest.TestCase):
    def test_vendor_integrity(self):
        subprocess.run([sys.executable, str(ROOT / "verify_vendor.py"), "--check-patches"], check=True)

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

    def test_loopback_bind_requires_strong_token(self):
        config = load_config(ROOT / "configs/mock.toml")
        for value in (None, "", "short-token", " " + TOKEN, TOKEN + "\n"):
            env = {} if value is None else {"DENDRITE_API_TOKEN": value}
            with self.subTest(token=value), patch.dict(os.environ, env, clear=True):
                with self.assertRaisesRegex(ValueError, "DENDRITE_API_TOKEN.*loopback"):
                    create_app(config)

    def client(self, config, host="127.0.0.1:8090"):
        with patch.dict(os.environ, {"DENDRITE_API_TOKEN": TOKEN}, clear=True):
            app = create_app(config)
        return TestClient(app, base_url="http://" + host)

    def test_protected_routes_require_token_on_loopback(self):
        good = {"Authorization": "Bearer " + TOKEN}
        with tempfile.TemporaryDirectory() as temp, self.client(mock_config(temp)) as client:
            for headers in ({}, {"Authorization": "Bearer wrong-" + TOKEN},
                            {"Authorization": TOKEN}, {"Authorization": "Basic " + TOKEN},
                            {"Authorization": "Bearer " + TOKEN + "x"}, {"Authorization": b"Bearer \xe9"}):
                with self.subTest(headers=headers):
                    self.assertEqual(client.get("/v1/node", headers=headers).status_code, 401)
                    self.assertEqual(client.post("/v1/execute", json=EXECUTE, headers=headers).status_code, 401)
                    self.assertEqual(client.post("/v1/models/load", json={"model_id": "mock-summary"},
                                                 headers=headers).status_code, 401)
                    self.assertEqual(client.post("/v1/runtimes/mock/unload", headers=headers).status_code, 401)
            self.assertEqual(client.get("/v1/node", headers=good).json()["node_id"], "standalone-demo")
            self.assertTrue(client.post("/v1/execute", json=EXECUTE, headers=good).json()["simulated"])
            health = client.get("/healthz")
            self.assertEqual((health.status_code, health.json()), (200, {"status": "ok"}))
            for path in ("/docs", "/redoc", "/openapi.json"):
                self.assertEqual(client.get(path).status_code, 404, path)

    def test_host_validation_on_loopback(self):
        good = {"Authorization": "Bearer " + TOKEN}
        with tempfile.TemporaryDirectory() as temp:
            config = mock_config(temp)
            client = self.client(config)
            with client:
                for host in ("127.0.0.1:8090", "localhost:8090", "LOCALHOST:8090", "[::1]:8090"):
                    with self.subTest(host=host):
                        self.assertEqual(client.get("/v1/node", headers=good | {"Host": host}).status_code, 200)
            for host in ("attacker.example:8090", "attacker.example", "127.0.0.1", "localhost",
                         "127.0.0.1:8091", "127.0.0.1:80", "localhost.:8090", "127.0.0.2:8090",
                         "0.0.0.0:8090", "[::1]", "::1:8090", "[::1:8090", "[::ffff:127.0.0.1]:8090",
                         "127.0.0.1:8090@attacker.example", "attacker.example@127.0.0.1:8090",
                         "127.0.0.1:8090/x", "127.1:8090", "2130706433:8090", "127.0.0.1:08090"):
                with self.subTest(host=host), client:
                    for path in ("/healthz", "/v1/node"):
                        response = client.get(path, headers=good | {"Host": host})
                        self.assertEqual(response.status_code, 400, (path, response.text))
                        self.assertNotIn("standalone-demo", response.text)
                    # Rebinding-style: hostile name, matching Origin, no token.
                    response = client.post("/v1/execute", json=EXECUTE,
                                           headers={"Host": host, "Origin": "http://" + host})
                    self.assertEqual(response.status_code, 400)

    def test_origin_validation_is_separate_from_cors(self):
        good = {"Authorization": "Bearer " + TOKEN}
        with tempfile.TemporaryDirectory() as temp, self.client(mock_config(temp)) as client:
            for origin in ("http://127.0.0.1:8090", "http://localhost:8090"):
                with self.subTest(origin=origin):
                    self.assertEqual(client.get("/v1/node", headers=good | {"Origin": origin}).status_code, 200)
            for origin in ("http://attacker.example:8090", "null", "http://127.0.0.1:9999", "http://[::1",
                           "http://[::1]:8090:1",
                           "file://", "http://127.0.0.1:8090/path", "https://attacker.example"):
                with self.subTest(origin=origin):
                    response = client.get("/v1/node", headers=good | {"Origin": origin})
                    self.assertEqual(response.status_code, 403)
                    self.assertNotIn("access-control-allow-origin", response.headers)
            preflight = client.options("/v1/execute", headers={
                "Origin": "http://127.0.0.1:8090", "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "authorization"})
            self.assertNotIn("access-control-allow-origin", preflight.headers)
            self.assertNotEqual(preflight.status_code, 200)

    def test_remote_binding_hosts(self):
        good = {"Authorization": "Bearer " + TOKEN}
        with tempfile.TemporaryDirectory() as temp:
            with patch.dict(os.environ, {"DENDRITE_API_TOKEN": TOKEN}, clear=True):
                with self.assertRaisesRegex(ValueError, "allowed_hosts"):
                    create_app(mock_config(temp, host="0.0.0.0"))
            config = mock_config(temp, host="0.0.0.0", advertise_url="http://worker.lan:8090")
            self.assertEqual(config.node.effective_allowed_hosts(), {"worker.lan:8090"})
            with self.client(config, "worker.lan:8090") as client:
                self.assertEqual(client.get("/v1/node", headers=good).status_code, 200)
                self.assertEqual(client.get("/v1/node").status_code, 401)
            for host in ("127.0.0.1:8090", "attacker.example:8090", "worker.lan"):
                with self.subTest(host=host), self.client(config, host) as client:
                    self.assertEqual(client.get("/v1/node", headers=good).status_code, 400)
            port80 = mock_config(temp, port=80).node.effective_allowed_hosts()
            self.assertLessEqual({"127.0.0.1", "127.0.0.1:80", "localhost", "[::1]"}, port80)
            with self.client(mock_config(temp, port=80), "127.0.0.1") as client:
                for host in ("127.0.0.1", "127.0.0.1:80", "localhost"):
                    with self.subTest(port80_host=host):
                        self.assertEqual(client.get("/v1/node", headers=good | {
                            "Host": host, "Origin": "http://" + host}).status_code, 200)
                for host in ("127.0.0.1:8090", "attacker.example"):
                    with self.subTest(port80_hostile=host):
                        self.assertEqual(client.get("/v1/node", headers=good | {"Host": host}).status_code, 400)
            self.assertNotIn("127.0.0.1", mock_config(temp).node.effective_allowed_hosts())
            self.assertEqual(mock_config(temp, host="0.0.0.0", advertise_url="https://worker.example:443")
                             .node.effective_allowed_hosts(), {"worker.example", "worker.example:443"})
            self.assertEqual(mock_config(temp, host="0.0.0.0", advertise_url="http://worker.lan:80")
                             .node.effective_allowed_hosts(), {"worker.lan", "worker.lan:80"})
            self.assertEqual(mock_config(temp, host="192.168.50.10").node.effective_allowed_hosts(),
                             {"192.168.50.10:8090"})
            self.assertEqual(mock_config(temp, host="fd00::10").node.effective_allowed_hosts(),
                             {"[fd00::10]:8090"})
            proxied = mock_config(temp, host="0.0.0.0", advertise_url="https://worker.example",
                                  allowed_hosts=["Worker.Example", "10.0.0.5:8090"])
            self.assertEqual(proxied.node.effective_allowed_hosts(), {"worker.example", "10.0.0.5:8090"})
            with self.client(proxied, "worker.example") as client:
                self.assertEqual(client.get("/v1/node", headers=good | {
                    "Origin": "https://worker.example"}).status_code, 200)
            for entry in ("*.lan:8090", "worker.lan:notaport", "worker.lan/x", "user@worker.lan",
                          "::1:8090", "worker.lan:080", ""):
                with self.subTest(entry=entry), self.assertRaises(ValidationError):
                    NodeConfig(allowed_hosts=[entry])

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
            env["DENDRITE_API_TOKEN"] = TOKEN
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
                payload = json.dumps(EXECUTE).encode()
                with self.assertRaises(HTTPError) as unauthenticated:
                    urlopen(Request(base + "/v1/execute", data=payload,
                                    headers={"Content-Type": "application/json"}), timeout=5)
                self.assertEqual(unauthenticated.exception.code, 401)
                with urlopen(Request(base + "/v1/execute", data=payload,
                                     headers={"Content-Type": "application/json",
                                              "Authorization": "Bearer " + TOKEN}), timeout=5) as response:
                    result = json.load(response)
                self.assertTrue(result["simulated"])
                self.assertEqual(result["model_id"], "mock-summary")
                self.assertEqual(result["node_id"], "standalone-demo")
                # Raw requests through the real server: hostile, duplicate and missing Host.
                auth = "Authorization: Bearer " + TOKEN + "\r\n"
                for host_lines, expected in ((f"Host: 127.0.0.1:{port}\r\n", 200),
                                             (f"Host: attacker.example:{port}\r\n", 400),
                                             (f"Host: 127.0.0.1:{port}\r\nHost: attacker.example\r\n", 400),
                                             ("", 400)):
                    with self.subTest(host_lines=host_lines), socket.create_connection(
                            ("127.0.0.1", port), timeout=5) as conn:
                        conn.sendall(f"GET /v1/node HTTP/1.1\r\n{host_lines}{auth}Connection: close\r\n\r\n".encode())
                        reply = b""
                        while chunk := conn.recv(65536):
                            reply += chunk
                        self.assertEqual(int(reply.split()[1]), expected, reply[:200])
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

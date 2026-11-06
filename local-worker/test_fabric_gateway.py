"""Tests for fabric_gateway (lifecycle/control) and the proxy flat-error seam.

Uses only an in-process loopback fake fabric upstream: no live services,
keys, network or configuration changes.

Run:  python -m unittest test_fabric_gateway
"""

import http.client
import io
import json
import os
import socket
import sys
import threading
import unittest
from contextlib import redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import fabric_gateway as gw  # noqa: E402
import fabric_openai_proxy as proxy  # noqa: E402

KEY = "Bearer caller-fabric-key-123"


class FakeFabric(BaseHTTPRequestHandler):
    seen = []
    reply = (200, {"object": "list", "data": []})

    def log_message(self, *a):
        pass

    def _serve(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else b""
        type(self).seen.append((self.command, self.path, self.headers.get("Authorization"), body))
        status, obj = type(self).reply
        data = obj if isinstance(obj, bytes) else json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_GET = do_POST = _serve


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class GatewayBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.upstream = ThreadingHTTPServer(("127.0.0.1", 0), FakeFabric)
        threading.Thread(target=cls.upstream.serve_forever, daemon=True).start()
        cls.origin = "http://127.0.0.1:%d" % cls.upstream.server_port
        cls._log = proxy.FabricOpenAIProxyHandler.log_message
        proxy.FabricOpenAIProxyHandler.log_message = lambda *a: None

    @classmethod
    def tearDownClass(cls):
        cls.upstream.shutdown()
        cls.upstream.server_close()
        proxy.FabricOpenAIProxyHandler.log_message = cls._log

    def setUp(self):
        FakeFabric.seen = []
        FakeFabric.reply = (200, {"object": "list", "data": []})

    def gateway(self, **kw):
        cfg = dict(enabled=True, fabric_origin=self.origin, port=0)
        cfg.update(kw)
        g = gw.FabricGateway(gw.GatewayConfig(**cfg))
        self.addCleanup(g.stop)
        return g

    def call(self, port, method, path, body=None, auth=KEY, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        h = {"Host": "127.0.0.1:%d" % port}
        if auth:
            h["Authorization"] = auth
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            h["Content-Type"] = "application/json"
        h.update(headers or {})
        try:
            conn.request(method, path, body=data, headers=h)
            resp = conn.getresponse()
            return resp.status, json.loads(resp.read() or b"null")
        finally:
            conn.close()


class DefaultOffTests(GatewayBase):
    def test_env_unset_is_disabled_and_binds_nothing(self):
        cfg = gw.GatewayConfig.from_env({})
        self.assertFalse(cfg.enabled)
        self.assertEqual(cfg.port, gw.DEFAULT_PORT)
        g = gw.FabricGateway(cfg)
        with self.assertRaises(gw.GatewayDisabled):
            g.start()
        st = g.status()
        self.assertEqual((st["state"], st["listening"], st["base_url"]), ("disabled", False, None))

    def test_only_literal_one_enables(self):
        for value in ("true", "yes", "0", " 1", ""):
            self.assertFalse(gw.GatewayConfig.from_env({gw.ENABLED_ENV: value}).enabled, value)
        self.assertTrue(gw.GatewayConfig.from_env({gw.ENABLED_ENV: "1"}).enabled)
        self.assertFalse(gw.GatewayConfig(enabled="1").enabled)  # only the real boolean True

    def test_config_reads_existing_origin_env_reference(self):
        cfg = gw.GatewayConfig.from_env({gw.ENABLED_ENV: "1", proxy.FABRIC_ORIGIN_ENV: "https://fabric.example",
                                         gw.PORT_ENV: "9001"})
        self.assertEqual((cfg.fabric_origin, cfg.port), ("https://fabric.example", 9001))
        with self.assertRaises(gw.GatewayStartError):
            gw.GatewayConfig.from_env({gw.PORT_ENV: "80x"})
        with self.assertRaises(gw.GatewayStartError):
            gw.GatewayConfig(port=70000)

    def test_cli_status_default_off_and_serve_refuses(self):
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(gw.main(["status"], env={}), 0)
        self.assertEqual(json.loads(out.getvalue())["state"], "disabled")
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(gw.main(["serve"], env={}), 3)
        self.assertFalse(json.loads(out.getvalue())["listening"])


class LoopbackAndOriginTests(GatewayBase):
    def test_no_host_option_exists(self):
        self.assertNotIn("host", gw.GatewayConfig.__slots__)
        with self.assertRaises(TypeError):
            gw.GatewayConfig(enabled=True, host="0.0.0.0")
        with self.assertRaises(AttributeError):
            gw.GatewayConfig().port = 1

    def test_binds_loopback_only(self):
        g = self.gateway()
        st = g.start()
        self.assertEqual(st["bind_host"], "127.0.0.1")
        self.assertEqual(g._server.server_address[0], "127.0.0.1")
        self.assertEqual(st["base_url"], "http://127.0.0.1:%d/v1" % st["port"])

    def test_untrusted_origins_refused_and_not_listening(self):
        for bad in ("", "http://10.0.0.5:8787", "http://fabric.example", "ftp://127.0.0.1",
                    "https://user:secret@fabric.example", "https://fabric.example/?k=1"):
            g = self.gateway(fabric_origin=bad)
            with self.assertRaises(gw.GatewayStartError) as ctx:
                g.start()
            self.assertEqual(ctx.exception.code, "origin_refused")
            st = g.status()
            self.assertEqual((st["state"], st["listening"], st["last_error"]), ("failed", False, "origin_refused"))
            self.assertNotIn("secret", json.dumps(st))

    def test_port_in_use_is_reported_not_listening(self):
        holder = socket.socket()
        holder.bind(("127.0.0.1", 0))
        holder.listen(1)
        self.addCleanup(holder.close)
        g = self.gateway(port=holder.getsockname()[1])
        with self.assertRaises(gw.GatewayStartError) as ctx:
            g.start()
        self.assertEqual(ctx.exception.code, "port_in_use")
        st = g.status()
        self.assertEqual((st["state"], st["listening"], st["base_url"]), ("failed", False, None))


class LifecycleTests(GatewayBase):
    def test_start_status_stop_truthful(self):
        g = self.gateway(port=free_port())
        self.assertEqual(g.status()["state"], "stopped")
        st = g.start()
        self.assertEqual((st["state"], st["listening"]), ("listening", True))
        self.assertIs(g.start()["listening"], True)  # idempotent while listening
        port = st["port"]
        st = g.stop()
        self.assertEqual((st["state"], st["listening"], st["base_url"]), ("stopped", False, None))
        with self.assertRaises(OSError):
            socket.create_connection(("127.0.0.1", port), timeout=0.5).close()
        self.assertEqual(g.stop()["state"], "stopped")  # idempotent
        self.assertTrue(g.start()["listening"])  # restartable on the same port

    def test_stop_clears_failed_start_error(self):
        g = self.gateway(fabric_origin="http://fabric.example")
        with self.assertRaises(gw.GatewayStartError):
            g.start()
        self.assertEqual(g.status()["state"], "failed")
        st = g.stop()
        self.assertEqual((st["state"], st["last_error"], st["listening"]), ("stopped", None, False))

    def test_bad_timeout_is_a_typed_refusal(self):
        for bad in ("30", None, True, float("nan"), float("inf"), [], object()):
            with self.assertRaises(gw.GatewayStartError) as ctx:
                gw.GatewayConfig(timeout=bad)
            self.assertEqual(ctx.exception.code, "bad_timeout", bad)
        self.assertEqual(gw.GatewayConfig(timeout=0).timeout, 1.0)
        self.assertEqual(gw.GatewayConfig(timeout=600).timeout, 60.0)
        self.assertEqual(gw.GatewayConfig(timeout=5).timeout, 5.0)

    def test_status_never_carries_credentials(self):
        g = self.gateway()
        port = g.start()["port"]
        self.call(port, "GET", "/v1/models")
        blob = json.dumps(g.status())
        self.assertNotIn("caller-fabric-key", blob)
        self.assertEqual(g.status()["auth"], {"mode": "caller_bearer_per_request",
                                              "ambient_credential": False, "key_creation": False})

    def test_capabilities_are_honest(self):
        caps = self.gateway().status()["capabilities"]
        self.assertEqual((caps["backend"], caps["local_model_api"], caps["streaming"], caps["tools"]),
                         ("fabric_client_proxy", False, False, False))
        self.assertEqual(caps["max_tokens"]["max"], 4096)
        self.assertEqual(caps["chat_messages"], "exactly_one_user_text_message")

    def test_context_manager_stops(self):
        with self.gateway() as g:
            port = g.status()["port"]
            self.assertTrue(g.status()["listening"])
        self.assertFalse(g.status()["listening"])
        with self.assertRaises(OSError):
            socket.create_connection(("127.0.0.1", port), timeout=0.5).close()

    def test_instances_keep_separate_origins(self):
        other = ThreadingHTTPServer(("127.0.0.1", 0), FakeFabric)
        threading.Thread(target=other.serve_forever, daemon=True).start()
        self.addCleanup(other.server_close)
        self.addCleanup(other.shutdown)
        before = proxy.FabricOpenAIProxyHandler.fabric_origin
        a = self.gateway()
        b = self.gateway(fabric_origin="http://127.0.0.1:%d" % other.server_port)
        self.assertNotEqual(a.start()["fabric_origin"], b.start()["fabric_origin"])
        self.assertEqual(proxy.FabricOpenAIProxyHandler.fabric_origin, before)  # base class untouched


class EndpointContractTests(GatewayBase):
    def setUp(self):
        super().setUp()
        self.g = self.gateway()
        self.port = self.g.start()["port"]

    def test_unauthenticated_401_nothing_forwarded(self):
        status, body = self.call(self.port, "GET", "/v1/models", auth=None)
        self.assertEqual((status, body["error"]["code"]), (401, "auth_required"))
        self.assertEqual(FakeFabric.seen, [])

    def test_models_relayed_from_fabric_with_caller_bearer(self):
        FakeFabric.reply = (200, {"object": "list", "data": [{"id": "fab-m", "object": "model", "created": 0,
                                                              "owned_by": "fabric"}]})
        status, body = self.call(self.port, "GET", "/v1/models")
        self.assertEqual((status, [m["id"] for m in body["data"]]), (200, ["fab-m"]))
        self.assertEqual(FakeFabric.seen[0][1:3], ("/v1/models", KEY))

    def test_empty_inventory_stays_empty(self):
        self.assertEqual(self.call(self.port, "GET", "/v1/models")[1]["data"], [])

    def test_streaming_refused_before_forward(self):
        status, body = self.call(self.port, "POST", "/v1/chat/completions",
                                 {"stream": True, "messages": [{"role": "user", "content": "hi"}]})
        self.assertEqual((status, body["error"]["code"]), (400, "unsupported_stream"))
        self.assertEqual(FakeFabric.seen, [])

    def test_chat_forwarded_to_fabric(self):
        FakeFabric.reply = (200, {"id": "c1", "object": "chat.completion", "choices": []})
        status, _ = self.call(self.port, "POST", "/v1/chat/completions",
                              {"messages": [{"role": "user", "content": "hi"}]})
        self.assertEqual(status, 200)
        self.assertEqual(FakeFabric.seen[0][0:3], ("POST", "/v1/chat/completions", KEY))

    def test_worker_flat_denials_preserved_truthfully(self):
        # Exact worker.js shapes: flag-off, auth, key scope, CSRF, unknown route.
        cases = ((403, "INFERENCE_DISABLED", "inference_disabled"),
                 (401, "AUTH_REQUIRED", "auth_required"),
                 (401, "KEY_EXPIRED", "key_expired"),
                 (403, "KEY_SCOPE", "key_scope"),
                 (403, "CSRF_REQUIRED", "csrf_required"),
                 (404, "UNKNOWN_API_ROUTE", "unknown_api_route"))
        for up_status, code, expected in cases:
            FakeFabric.reply = (up_status, {"error": "Refused for %s." % code, "code": code})
            status, body = self.call(self.port, "GET", "/v1/models")
            self.assertEqual((status, body["error"]["code"]), (up_status, expected), code)
            self.assertEqual(body["error"]["type"], "invalid_request_error")
            self.assertEqual(set(body), {"error"})

    def test_flat_shape_outside_4xx_or_malformed_stays_502(self):
        for reply in ((500, {"error": "boom", "code": "INTERNAL"}),
                      (403, {"error": "x", "code": "lower_case"}),
                      (403, {"error": "", "code": "KEY_SCOPE"}),
                      (403, {"error": "x", "code": "K" * 65}),
                      (403, b"not json")):
            FakeFabric.reply = reply
            status, body = self.call(self.port, "GET", "/v1/models")
            self.assertEqual((status, body["error"]["code"]), (502, "fabric_bad_response"), reply)

    def test_openai_shaped_errors_still_take_precedence(self):
        FakeFabric.reply = (409, {"error": {"message": "m", "type": "invalid_request_error",
                                            "code": "operation_in_progress"},
                                  "status_route": "/v1/operations/abcd1234", "automatic_retry": False})
        status, body = self.call(self.port, "POST", "/v1/chat/completions",
                                 {"messages": [{"role": "user", "content": "hi"}]})
        self.assertEqual((status, body["error"]["code"], body["status_route"]),
                         (409, "operation_in_progress", "/v1/operations/abcd1234"))

    def test_after_stop_endpoint_is_gone(self):
        self.g.stop()
        with self.assertRaises(OSError):
            self.call(self.port, "GET", "/v1/models")


class FlatErrorUnitTests(unittest.TestCase):
    def test_flat_worker_error_bounds(self):
        out = proxy._flat_worker_error(json.dumps({"error": "x" * 900, "code": "KEY_SCOPE",
                                                   "extra": "dropped"}).encode(), 403)
        self.assertEqual(out["error"]["code"], "key_scope")
        self.assertEqual(len(out["error"]["message"]), 500)
        self.assertEqual(set(out), {"error"})
        self.assertIsNone(proxy._flat_worker_error(b'{"error":"x","code":"A"}', 302))
        self.assertIsNone(proxy._flat_worker_error(b'["x"]', 403))
        self.assertIsNone(proxy._flat_worker_error(b'\xff', 403))


if __name__ == "__main__":
    unittest.main()

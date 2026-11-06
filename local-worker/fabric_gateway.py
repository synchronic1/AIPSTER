"""Fabric gateway lifecycle/control for the loopback fabric OpenAI proxy.

This is the backend seam a native client (menu app / service client) drives
to offer an OpenAI-compatible endpoint on this machine. It is NOT a local
model API: every request is served by ``fabric_openai_proxy`` and forwarded,
with the caller's own Bearer key, to ONE trusted fabric origin. The central
fabric selects the machine/model; nothing here talks to a local runtime.

Contract (all enforced, all tested in test_fabric_gateway.py):

  * Default OFF. Nothing binds unless the gateway is explicitly enabled
    (``AIPSTER_FABRIC_GATEWAY_ENABLED=1`` or ``enabled=True``). A disabled
    gateway reports ``state: disabled`` and ``listening: false``.
  * Loopback only. The bind host is the constant 127.0.0.1; there is no
    host option, so no LAN/public bind is expressible. The fabric origin is
    gated by ``fabric_openai_proxy.resolve_fabric_origin`` (https, or
    loopback http) with no non-loopback override.
  * Secrets stay private. Configuration is referenced only through existing
    environment names (``AIPSTER_FABRIC_ORIGIN``); the gateway never creates,
    stores, reads, or reports a key. Callers bring their own Bearer per
    request; status carries no credential material.
  * Truthful status. ``listening`` is true only while the serving thread is
    alive AND a loopback connect to the bound port succeeds. Start failures
    are reported with a bounded code (``origin_refused``, ``port_in_use``,
    ``bind_failed``), never as listening.
  * Honest capabilities. Status states the real limits: non-streaming only,
    no tools, models come from the fabric inventory, and the fabric route
    serves exactly one user text message per chat request.

Standard library only.
"""

import argparse
import errno
import json
import math
import os
import signal
import socket
import sys
import threading
from http.server import ThreadingHTTPServer

import fabric_openai_proxy as proxy

GATEWAY_INTERFACE = "aipster-fabric-gateway/1"
ENABLED_ENV = "AIPSTER_FABRIC_GATEWAY_ENABLED"
PORT_ENV = "AIPSTER_FABRIC_GATEWAY_PORT"
BIND_HOST = "127.0.0.1"
DEFAULT_PORT = 8089
DEFAULT_TIMEOUT = 60.0
PROBE_TIMEOUT = 0.5

STATE_DISABLED = "disabled"
STATE_STOPPED = "stopped"
STATE_LISTENING = "listening"
STATE_FAILED = "failed"


class GatewayDisabled(RuntimeError):
    """The gateway is not enabled; nothing was bound."""


class GatewayStartError(RuntimeError):
    """The gateway refused to start. ``code`` is a bounded reason."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


class GatewayConfig(object):
    """Immutable gateway configuration. There is deliberately no host field."""

    __slots__ = ("enabled", "fabric_origin", "port", "timeout")

    def __init__(self, enabled=False, fabric_origin="", port=DEFAULT_PORT, timeout=DEFAULT_TIMEOUT):
        if not isinstance(port, int) or isinstance(port, bool) or not 0 <= port <= 65535:
            raise GatewayStartError("bad_port")
        object.__setattr__(self, "enabled", enabled is True)
        object.__setattr__(self, "fabric_origin", fabric_origin if isinstance(fabric_origin, str) else "")
        object.__setattr__(self, "port", port)
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) \
                or not math.isfinite(timeout):
            raise GatewayStartError("bad_timeout")
        object.__setattr__(self, "timeout", min(max(float(timeout), 1.0), 60.0))

    def __setattr__(self, name, value):
        raise AttributeError("GatewayConfig is immutable")

    @classmethod
    def from_env(cls, env=None):
        """Read ONLY existing/gateway env references. Unset means off."""
        env = os.environ if env is None else env
        raw_port = env.get(PORT_ENV, "")
        if raw_port:
            if not raw_port.isdigit():
                raise GatewayStartError("bad_port")
            port = int(raw_port)
        else:
            port = DEFAULT_PORT
        return cls(enabled=env.get(ENABLED_ENV, "") == "1",
                   fabric_origin=env.get(proxy.FABRIC_ORIGIN_ENV, ""),
                   port=port)


def _capabilities():
    return {
        "backend": "fabric_client_proxy",
        "local_model_api": False,
        "streaming": False,
        "tools": False,
        "models_source": "fabric_inventory",
        "chat_messages": "exactly_one_user_text_message",
        "max_tokens": {"min": 1, "max": proxy.MAX_TOKENS_CEILING, "default": proxy.DEFAULT_MAX_TOKENS},
        "request_body_max_bytes": proxy.BODY_MAX_BYTES,
        "response_body_max_bytes": proxy.RESPONSE_MAX_BYTES,
        "endpoints": ["GET /v1/models", "POST /v1/chat/completions", "GET /v1/operations/<key>"],
    }


class FabricGateway(object):
    """Start/stop/status for one loopback proxy instance."""

    def __init__(self, config):
        if not isinstance(config, GatewayConfig):
            raise TypeError("config must be a GatewayConfig")
        self._config = config
        self._lock = threading.Lock()
        self._server = None
        self._thread = None
        self._origin = None
        self._last_error = None

    # -- lifecycle ------------------------------------------------------------
    def start(self):
        """Bind 127.0.0.1 and serve. Returns status(). Idempotent while listening."""
        with self._lock:
            if self._server is not None:
                return self._status_locked()
            if not self._config.enabled:
                self._last_error = None
                raise GatewayDisabled("fabric gateway is disabled")
            try:
                origin = proxy.resolve_fabric_origin(self._config.fabric_origin, allow_non_loopback=False)
            except proxy.ProxyConfigError:
                self._last_error = "origin_refused"
                raise GatewayStartError("origin_refused")
            handler = type("GatewayProxyHandler", (proxy.FabricOpenAIProxyHandler,),
                           {"fabric_origin": origin, "timeout": self._config.timeout})
            try:
                server = ThreadingHTTPServer((BIND_HOST, self._config.port), handler)
            except OSError as exc:
                self._last_error = "port_in_use" if exc.errno == errno.EADDRINUSE else "bind_failed"
                raise GatewayStartError(self._last_error)
            if server.server_address[0] != BIND_HOST:  # defence in depth
                server.server_close()
                self._last_error = "bind_failed"
                raise GatewayStartError("bind_failed")
            server.daemon_threads = True
            thread = threading.Thread(target=server.serve_forever, name="fabric-gateway", daemon=True)
            thread.start()
            self._server, self._thread, self._origin, self._last_error = server, thread, origin, None
            return self._status_locked()

    def stop(self):
        """Stop serving and release the port. Returns status(). Idempotent."""
        with self._lock:
            server, thread = self._server, self._thread
            self._server = self._thread = None
            # An explicit stop is a fresh baseline: a previous failed start
            # must not keep reporting "failed" once the caller has stopped.
            self._last_error = None
            if server is not None:
                server.shutdown()
                server.server_close()
            if thread is not None:
                thread.join(5)
            return self._status_locked()

    def __enter__(self):
        self.start()
        return self

    def __exit__(self, *exc):
        self.stop()
        return False

    # -- status -----------------------------------------------------------------
    def status(self):
        with self._lock:
            return self._status_locked()

    def _probe(self, port):
        try:
            with socket.create_connection((BIND_HOST, port), timeout=PROBE_TIMEOUT):
                return True
        except OSError:
            return False

    def _status_locked(self):
        cfg = self._config
        port = self._server.server_address[1] if self._server is not None else cfg.port
        listening = bool(self._server is not None and self._thread is not None
                         and self._thread.is_alive() and self._probe(port))
        if not cfg.enabled:
            state = STATE_DISABLED
        elif listening:
            state = STATE_LISTENING
        elif self._last_error is not None or self._server is not None:
            state = STATE_FAILED
        else:
            state = STATE_STOPPED
        try:
            origin = self._origin or proxy.resolve_fabric_origin(cfg.fabric_origin)
        except proxy.ProxyConfigError:
            origin = None
        return {
            "interface": GATEWAY_INTERFACE,
            "proxy_interface": proxy.FABRIC_INTERFACE,
            "enabled": cfg.enabled,
            "state": state,
            "listening": listening,
            "bind_host": BIND_HOST,
            "port": port,
            "base_url": ("http://%s:%d/v1" % (BIND_HOST, port)) if listening else None,
            "fabric_origin": origin,
            "fabric_origin_env": proxy.FABRIC_ORIGIN_ENV,
            "auth": {"mode": "caller_bearer_per_request", "ambient_credential": False,
                     "key_creation": False},
            "last_error": self._last_error if state == STATE_FAILED else None,
            "capabilities": _capabilities(),
        }


# -- CLI --------------------------------------------------------------------
def build_parser():
    parser = argparse.ArgumentParser(description="Loopback fabric gateway control (default off).")
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("status", help="Print the configured gateway status as JSON (does not bind).")
    sub.add_parser("serve", help="Serve in the foreground if enabled; prints status JSON once listening.")
    return parser


def main(argv=None, env=None):
    args = build_parser().parse_args(argv)
    try:
        config = GatewayConfig.from_env(env)
    except GatewayStartError as exc:
        print(json.dumps({"interface": GATEWAY_INTERFACE, "state": STATE_FAILED, "last_error": exc.code}))
        return 2
    gateway = FabricGateway(config)
    if args.command != "serve":
        print(json.dumps(gateway.status(), sort_keys=True))
        return 0
    try:
        status = gateway.start()
    except GatewayDisabled:
        print(json.dumps(gateway.status(), sort_keys=True))
        return 3
    except GatewayStartError:
        print(json.dumps(gateway.status(), sort_keys=True))
        return 2
    print(json.dumps(status, sort_keys=True))
    sys.stdout.flush()
    done = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, lambda *_: done.set())
        except (ValueError, OSError):
            pass
    try:
        done.wait()
    finally:
        gateway.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

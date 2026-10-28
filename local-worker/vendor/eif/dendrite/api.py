# Modified by AIPSTER local patch 0001 (2026-10-28): the API token is required on every
# bind (including loopback), Host and Origin are checked against node.allowed_hosts, the
# unauthenticated health route no longer returns node identity, and generated API docs are
# disabled. Upstream base and hashes: local-worker/provenance.json.
import asyncio
import hmac
import logging
import os
import time
from contextlib import asynccontextmanager, suppress
from urllib.parse import urlsplit

import httpx
from fastapi import Depends, FastAPI, Header
from fastapi.responses import JSONResponse

from dendrite.config import LOOPBACK_BIND_HOSTS, Config, canonical_authority
from dendrite.fabric import run_fabric_bridge
from dendrite.node import Node
from dendrite.runtimes.base import RuntimeFailure
from dendrite.schemas import ExecuteRequest, ExecuteResponse, LoadRequest

logger = logging.getLogger(__name__)


async def publish_heartbeats(node: Node, token: str | None):
    headers = {"Authorization": "Bearer " + token} if token else {}
    async with httpx.AsyncClient(timeout=5, trust_env=False, headers=headers) as client:
        while True:
            try:
                await node.refresh_attached()
                # Proposed control-plane contract, documented for the next build phase.
                response = await client.post(
                    node.config.node.control_plane_url.rstrip("/") + "/v1/nodes/heartbeat",
                    json=node.snapshot(),
                )
                response.raise_for_status()
                node.heartbeat.update(last_success_at=time.time(), last_error=None)
            except httpx.HTTPError:
                node.heartbeat["last_error"] = "Control plane heartbeat failed"
                logger.warning("Control plane heartbeat failed; node continues serving locally")
            await asyncio.sleep(node.config.node.heartbeat_seconds)


MIN_TOKEN_LENGTH = 32


class HostOriginGuard:
    """Reject requests whose Host (or browser Origin) is not an exact allowed authority.

    Loopback binding is not an origin boundary: a DNS-rebound page reaches 127.0.0.1 with
    its own name in Host. This check is independent of bearer authentication and of CORS
    (the app sends no CORS headers, so cross-origin reads stay blocked by the browser).
    """

    def __init__(self, app, allowed: frozenset[str]):
        self.app = app
        self.allowed = allowed

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket"):
            hosts = [v for k, v in scope["headers"] if k == b"host"]
            origins = [v for k, v in scope["headers"] if k == b"origin"]
            error = None
            if len(hosts) != 1 or canonical_authority(hosts[0].decode("latin-1")) not in self.allowed:
                error = 400, "Host not allowed"
            elif origins:
                try:
                    origin = urlsplit(origins[0].decode("latin-1")) if len(origins) == 1 else None
                except ValueError:  # e.g. an unterminated IPv6 literal
                    origin = None
                if (
                    origin is None
                    or origin.scheme not in ("http", "https")
                    or origin.path
                    or canonical_authority(origin.netloc) not in self.allowed
                ):
                    error = 403, "Origin not allowed"
            if error:
                if scope["type"] == "websocket":
                    await send({"type": "websocket.close", "code": 1008})
                    return
                response = JSONResponse(status_code=error[0], content={"error": error[1]})
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)


def create_app(config: Config) -> FastAPI:
    token = os.environ.get(config.node.token_env)
    fabric_token = os.environ.get(config.node.fabric_token_env)
    if config.node.fabric_url and not fabric_token:
        raise ValueError(f"Set {config.node.fabric_token_env} before joining the cloud fabric")
    if not token or token != token.strip() or len(token) < MIN_TOKEN_LENGTH:
        where = "loopback" if config.node.host in LOOPBACK_BIND_HOSTS else "a network interface"
        raise ValueError(
            f"Set {config.node.token_env} (at least {MIN_TOKEN_LENGTH} characters, no surrounding "
            f"whitespace) before serving on {where}; loopback is not an authentication boundary"
        )
    allowed_hosts = config.node.effective_allowed_hosts()
    if not allowed_hosts:
        raise ValueError("Set node.allowed_hosts (or advertise_url) before binding to a network interface")
    if config.node.control_plane_url and not config.node.advertise_url:
        raise ValueError("advertise_url is required when publishing heartbeats")
    expected_authorization = ("Bearer " + token).encode()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        node = Node(config)
        app.state.node = node
        heartbeat = None
        fabric_bridge = None
        try:
            await node.start()
            if config.node.control_plane_url:
                heartbeat = asyncio.create_task(publish_heartbeats(node, token))
            if config.node.fabric_url:
                fabric_bridge = asyncio.create_task(run_fabric_bridge(node, fabric_token))
            yield
        finally:
            if fabric_bridge:
                fabric_bridge.cancel()
                with suppress(asyncio.CancelledError):
                    await fabric_bridge
            if heartbeat:
                heartbeat.cancel()
                with suppress(asyncio.CancelledError):
                    await heartbeat
            await node.close()

    app = FastAPI(
        title="Dendrite",
        version="0.1.0",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.add_middleware(HostOriginGuard, allowed=allowed_hosts)

    async def authorize(authorization: str | None = Header(default=None)):
        supplied = (authorization or "").encode("utf-8", "surrogateescape")
        if not hmac.compare_digest(supplied, expected_authorization):
            raise RuntimeFailure("Invalid or missing Dendrite token", 401)

    protected = [Depends(authorize)]

    @app.exception_handler(RuntimeFailure)
    async def runtime_error(_request, exc: RuntimeFailure):
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": exc.detail},
            headers={"Retry-After": "1"} if exc.status_code == 429 else None,
        )

    # Deliberately unauthenticated liveness probe; Host-checked and carries no node identity.
    @app.get("/healthz")
    async def health():
        return {"status": "ok"}

    @app.get("/v1/node", dependencies=protected)
    async def snapshot():
        await app.state.node.refresh_attached()
        return app.state.node.snapshot()

    @app.post("/v1/execute", response_model=ExecuteResponse, dependencies=protected)
    async def execute(request: ExecuteRequest):
        return await app.state.node.execute(request)

    @app.post("/v1/models/load", dependencies=protected)
    async def load(request: LoadRequest):
        return await app.state.node.load(request.model_id)

    @app.post("/v1/runtimes/{runtime_id}/unload", dependencies=protected)
    async def unload(runtime_id: str):
        runtime = app.state.node.runtimes.get(runtime_id)
        if not runtime:
            raise RuntimeFailure("Unknown runtime", 404)
        await runtime.unload()
        return runtime.snapshot()

    return app

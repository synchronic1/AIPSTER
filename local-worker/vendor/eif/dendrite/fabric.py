"""Opt-in outbound bridge to the Cloudflare fabric. Native inference remains local.

Modified by AIPSTER local patch 0002 (2026-11-01): fabric jobs bind their result
to the dispatch job_id, execute only an already-resident exact model (never
cold-start or switch), advertise only resident capacity to the scheduler, stop
instead of retrying a rejected/revoked/superseded credential, and keep
execution-failure logging free of prompts and transport secrets. Upstream base
and hashes: local-worker/provenance.json.
"""

import asyncio
import json
import logging
import random
import time
from urllib.parse import urlencode, urlsplit, urlunsplit

from pydantic import ValidationError
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus, WebSocketException

from dendrite.node import Node
from dendrite.runtimes.base import RuntimeFailure
from dendrite.schemas import ExecuteRequest

logger = logging.getLogger(__name__)

# A rejected upgrade or a policy close cannot be fixed by reconnecting: the node
# credential is dead, another connection owns this node id, or this worker sent a
# frame the fabric refuses. Retrying those would hide the fault or flap ownership.
PERMANENT_HANDSHAKE_STATUS = frozenset({400, 401, 403, 404, 426})
PERMANENT_CLOSE_CODES = frozenset({1007, 1008, 1009, 4001, 4003})


def connection_url(origin: str, node_id: str) -> str:
    url = urlsplit(origin)
    return urlunsplit(
        (
            "wss" if url.scheme == "https" else "ws",
            url.netloc,
            "/v1/nodes/connect",
            urlencode({"node_id": node_id}),
            "",
        )
    )


def cloud_snapshot(node: Node) -> dict:
    snapshot = node.snapshot()
    # The cloud needs capacities, not native binary paths, process IDs, or local errors.
    # Advertise resident-only execution: a model that is merely cached on disk would
    # be cold-started or switched in by this worker's local API, not by the fabric.
    hardware = {
        key: value for key, value in snapshot["hardware"].items() if key != "binaries"
    }
    # A single invalid field makes the fabric close the socket and fail every
    # in-flight job, so degrade an unavailable host identity instead of looping.
    hardware["logical_cpus"] = hardware.get("logical_cpus") or 0
    hardware["hostname"] = hardware.get("hostname") or "unknown"
    return {
        key: snapshot[key]
        for key in (
            "schema_version",
            "node_id",
            "observed_at",
            "uptime_seconds",
            "execution_scope",
            "active_requests",
            "performance",
            "load",
        )
    } | {
        "hardware": hardware,
        "runtimes": [
            {
                key: value
                for key, value in runtime.items()
                if key not in ("process_id", "last_error")
            }
            | {"supports_model_switch": False, "supports_chat": False}
            for runtime in snapshot["runtimes"]
        ],
        "models": [
            {**model, "available": bool(model["available"] and model["resident"])}
            for model in snapshot["models"]
        ],
    }


async def serve_connection(node: Node, ws):
    active: dict[str, asyncio.Task] = {}
    completed: set[str] = set()

    async def send(payload: dict):
        await ws.send(json.dumps(payload))

    async def heartbeats():
        while True:
            await node.refresh_attached()
            await send({"type": "heartbeat", "snapshot": cloud_snapshot(node)})
            node.fabric["last_heartbeat_at"] = time.time()
            await asyncio.sleep(min(node.config.node.heartbeat_seconds, 10))

    async def execute(message: dict):
        job_id = message["job_id"]
        try:
            request = ExecuteRequest.model_validate(message.get("request"))
            # The fabric dispatches an explicit model and expects local execution.
            # Bind the response to the job and refuse any load/switch side effect.
            result = await node.execute(request, execution_id=job_id, resident_only=True)
            await send({"type": "result", "job_id": job_id, "result": result.model_dump()})
        except ValidationError:
            await send(
                {
                    "type": "result",
                    "job_id": job_id,
                    "error": "Invalid node request",
                    "status_code": 422,
                }
            )
        except RuntimeFailure as exc:
            # Don't disclose executable paths or local errors to the cloud.
            await send(
                {
                    "type": "result",
                    "job_id": job_id,
                    "error": "Local runtime could not complete the task",
                    "status_code": exc.status_code,
                }
            )
        except WebSocketException:
            pass
        except Exception as exc:
            # Never log exception text: it can contain prompt or backend data.
            logger.error("Fabric execution failed (%s)", type(exc).__name__)
            await send(
                {
                    "type": "result",
                    "job_id": job_id,
                    "error": "Local execution failed",
                    "status_code": 500,
                }
            )
        finally:
            active.pop(job_id, None)
            completed.add(job_id)

    async def receive():
        async for raw in ws:
            try:
                message = json.loads(raw)
            except (ValueError, TypeError):
                continue
            if not isinstance(message, dict) or message.get("type") != "execute":
                continue
            job_id = message.get("job_id")
            if not isinstance(job_id, str) or not 1 <= len(job_id) <= 128:
                continue
            if job_id in active or job_id in completed:
                continue  # Never execute the same job twice in a connection.
            if len(completed) >= 1024:
                await ws.close(1000, "Rotate completed job history")
                return
            if len(active) >= len(node.runtimes):
                await send(
                    {
                        "type": "result",
                        "job_id": job_id,
                        "error": "Node has no available execution lane",
                        "status_code": 429,
                    }
                )
                continue
            active[job_id] = asyncio.create_task(execute(message))

    heartbeat = asyncio.create_task(heartbeats())
    receiver = asyncio.create_task(receive())
    try:
        # A failed sender or closed receiver ends this connection and triggers reconnect.
        done, _ = await asyncio.wait([heartbeat, receiver], return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
    finally:
        tasks = [heartbeat, receiver, *active.values()]
        for task in tasks:
            task.cancel()
        # Cancelling runtime execution clears its slot and stops only owned native processes.
        await asyncio.gather(*tasks, return_exceptions=True)


async def run_fabric_bridge(node: Node, token: str):
    url = connection_url(node.config.node.fabric_url, node.config.node.id)
    fabric = node.fabric
    delay = 1
    while True:
        fabric.update(state="connecting", connected_at=None, last_error=None, code=None)
        try:
            async with connect(
                url,
                additional_headers={"Authorization": "Bearer " + token},
                proxy=None,
                max_size=262144,
                max_queue=4,
                open_timeout=10,
                ping_interval=20,
                ping_timeout=20,
                close_timeout=3,
            ) as ws:
                delay = 1
                fabric.update(
                    state="connected", connected_at=time.time(), last_error=None, code=None
                )
                logger.info("Connected to fabric control plane")
                await serve_connection(node, ws)
        except InvalidStatus as exc:
            status = exc.response.status_code
            if status in PERMANENT_HANDSHAKE_STATUS:
                fabric.update(
                    state="rejected",
                    connected_at=None,
                    last_error="Fabric rejected the node connection",
                    code=status,
                )
                logger.error(
                    "Fabric rejected the node connection (HTTP %s); not retrying", status
                )
                return
        except ConnectionClosed as exc:
            code = exc.rcvd.code if exc.rcvd is not None else None
            if code in PERMANENT_CLOSE_CODES:
                # 4001 means another connection owns this node id. Reconnecting would
                # replace it back and flap ownership; 4003 is a revoked/expired token.
                state = "superseded" if code == 4001 else "rejected"
                fabric.update(
                    state=state,
                    connected_at=None,
                    last_error="Fabric closed the node connection",
                    code=code,
                )
                logger.error("Fabric closed the node connection (%s); not retrying", code)
                return
        except (OSError, TimeoutError, WebSocketException):
            logger.warning("Fabric connection lost; retrying while local API stays available")
        fabric.update(
            state="reconnecting",
            connected_at=None,
            last_error="Fabric connection lost",
            code=None,
        )
        await asyncio.sleep(delay + random.random())
        delay = min(delay * 2, 30)

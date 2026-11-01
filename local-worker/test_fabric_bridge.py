"""Fabric bridge integration tests against a local fake Ganglion-compatible upstream.

These tests never contact a real fabric, start a native engine or run inference.
They exercise the reviewed node-facing wire contract: authenticated outbound
WebSocket, immediate/periodic heartbeats, one execute -> one result frame, exact
resident-model admission, deadlines, cancellation, disconnect and duplicate
suppression.

Run with the worker's vendored package first on sys.path, e.g.:

    PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$PWD/vendor/eif" \
      python -m pytest test_fabric_bridge.py -q
"""

import asyncio
import json
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, patch

import dendrite
import httpx
from dendrite.config import Config, ModelConfig, NodeConfig, RuntimeConfig
from dendrite.fabric import cloud_snapshot, connection_url, run_fabric_bridge, serve_connection
from dendrite.hardware import file_identity
from dendrite.node import Node
from dendrite.runtimes.base import RuntimeFailure
from dendrite.runtimes.llama import LlamaRuntime
from dendrite.schemas import ExecuteRequest
from websockets.asyncio.client import connect
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

_VENDOR = (Path(__file__).resolve().parent / "vendor/eif/dendrite").resolve()
if not Path(dendrite.__file__).resolve().is_relative_to(_VENDOR):
    raise RuntimeError(
        "fabric tests must import local-worker/vendor/eif/dendrite; "
        "run with PYTHONPATH=$PWD/vendor/eif"
    )


class FakeFabric:
    """Local stand-in for the Ganglion fabric node socket.

    It records the opening handshake and every node frame, and can send execute
    frames or close the connection with a chosen code.
    """

    def __init__(self, *, reject_status=None, close_code=None):
        self.reject_status = reject_status
        self.close_code = close_code
        self.handshakes = []
        self.frames = []
        self.results = []
        self.connections = 0
        self.server = None
        self.port = None
        self._ready = asyncio.Queue()
        self._frames = asyncio.Queue()
        self._ws = None

    async def __aenter__(self):
        self.server = await serve(
            self._handler, "127.0.0.1", 0, process_request=self._process_request
        )
        self.port = self.server.sockets[0].getsockname()[1]
        return self

    async def __aexit__(self, *_):
        self.server.close()
        await self.server.wait_closed()

    @property
    def origin(self):
        return f"http://127.0.0.1:{self.port}"

    async def _handler(self, ws):
        self.connections += 1
        await self._ready.put(ws)
        if self.close_code is not None:
            await ws.close(self.close_code, "test close")
            return
        async for raw in ws:
            message = json.loads(raw)
            self.frames.append(message)
            if message.get("type") == "result":
                self.results.append(message)
            await self._frames.put(message)

    async def _process_request(self, connection, request):
        self.handshakes.append((request.path, request.headers.get("Authorization")))
        if self.reject_status is not None:
            return connection.respond(self.reject_status, "rejected")
        return None

    async def websocket(self, timeout=3):
        if self._ws is None:
            self._ws = await asyncio.wait_for(self._ready.get(), timeout)
        return self._ws

    async def send(self, payload):
        ws = await self.websocket()
        await ws.send(json.dumps(payload))

    async def send_raw(self, raw):
        ws = await self.websocket()
        await ws.send(raw)

    async def close(self):
        ws = await self.websocket()
        await ws.close(1000, "test close")

    async def next_frame(self, kind, timeout=3):
        async def wait():
            while True:
                message = await self._frames.get()
                if message.get("type") == kind:
                    return message

        return await asyncio.wait_for(wait(), timeout)

    def frames_of(self, kind):
        return [message for message in self.frames if message.get("type") == kind]


def make_node(tmp, *, models=None, timeout=2.0, heartbeat=10, fabric=None):
    return Node(
        Config(
            node=NodeConfig(
                id="test-node",
                state_dir=Path(tmp),
                request_timeout_seconds=timeout,
                heartbeat_seconds=heartbeat,
                fabric_url=fabric.origin if fabric is not None else None,
            ),
            runtimes=[RuntimeConfig(id="mock", kind="mock")],
            models=models
            or [
                ModelConfig(id="m1", runtime="mock", capabilities=["complete", "summarize"]),
                ModelConfig(id="m2", runtime="mock", capabilities=["complete"]),
            ],
        )
    )


async def preload(node, model_id):
    model = next(model for model in node.config.models if model.id == model_id)
    await node.runtimes[model.runtime].ensure_loaded(model)
    return model


def execute_frame(model_id="m1", capability="complete", prompt="hello", **extra):
    return {
        "type": "execute",
        "job_id": str(uuid.uuid4()),
        "request": {
            "capability": capability,
            "model_id": model_id,
            "prompt": prompt,
            "max_tokens": 16,
            **extra,
        },
    }


class FabricBridgeTests(unittest.IsolatedAsyncioTestCase):
    async def connected(self, fabric, node):
        ws = await connect(
            connection_url(fabric.origin, node.config.node.id),
            additional_headers={"Authorization": "Bearer synthetic-fabric-token"},
        )
        task = asyncio.create_task(serve_connection(node, ws))
        await fabric.websocket()
        return ws, task

    async def disconnect(self, ws, task):
        await ws.close()
        try:
            await asyncio.wait_for(task, 3)
        except (ConnectionClosed, asyncio.CancelledError):
            pass

    async def test_connection_url_uses_encoded_node_id(self):
        self.assertEqual(
            connection_url("https://fabric.test", "node 1"),
            "wss://fabric.test/v1/nodes/connect?node_id=node+1",
        )
        self.assertEqual(
            connection_url("http://127.0.0.1:8787", "n"),
            "ws://127.0.0.1:8787/v1/nodes/connect?node_id=n",
        )

    async def test_cloud_snapshot_advertises_resident_capacity_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            node = make_node(tmp)
            try:
                snapshot = cloud_snapshot(node)
                self.assertFalse(snapshot["models"][0]["available"])
                self.assertFalse(snapshot["models"][1]["available"])
                self.assertFalse(snapshot["runtimes"][0]["supports_model_switch"])
                self.assertFalse(snapshot["runtimes"][0]["supports_chat"])
                self.assertNotIn("binaries", snapshot["hardware"])
                self.assertNotIn("last_error", snapshot["runtimes"][0])
                self.assertNotIn("fabric", snapshot)
                await preload(node, "m1")
                snapshot = cloud_snapshot(node)
                self.assertTrue(snapshot["models"][0]["available"])
                self.assertFalse(snapshot["models"][1]["available"])
            finally:
                await node.close()

    async def test_cloud_snapshot_degrades_missing_host_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            node = make_node(tmp)
            node.hardware["logical_cpus"] = None
            node.hardware["hostname"] = ""
            try:
                hardware = cloud_snapshot(node)["hardware"]
                self.assertEqual(hardware["logical_cpus"], 0)
                self.assertEqual(hardware["hostname"], "unknown")
            finally:
                await node.close()

    async def test_success_binds_job_id_and_returns_one_result(self):
        with tempfile.TemporaryDirectory() as tmp:
            node = make_node(tmp)
            await preload(node, "m1")
            try:
                async with FakeFabric() as fabric:
                    ws, task = await self.connected(fabric, node)
                    heartbeat = await fabric.next_frame("heartbeat")
                    self.assertEqual(heartbeat["snapshot"]["node_id"], "test-node")
                    self.assertNotIn("binaries", heartbeat["snapshot"]["hardware"])
                    frame = execute_frame(prompt="job-bound prompt")
                    await fabric.send(frame)
                    result = await fabric.next_frame("result")
                    self.assertEqual(result["job_id"], frame["job_id"])
                    self.assertEqual(result["result"]["request_id"], frame["job_id"])
                    self.assertEqual(result["result"]["model_id"], "m1")
                    self.assertTrue(result["result"]["simulated"])
                    await asyncio.sleep(0.2)
                    self.assertEqual(fabric.frames_of("result"), [result])
                    await self.disconnect(ws, task)
            finally:
                await node.close()

    async def test_duplicate_job_executes_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            node = make_node(tmp)
            node.config.runtimes[0].mock_delay_seconds = 0.1
            await preload(node, "m1")
            try:
                async with FakeFabric() as fabric:
                    ws, task = await self.connected(fabric, node)
                    frame = execute_frame()
                    await fabric.send(frame)
                    await fabric.send(frame)
                    await fabric.send(frame)
                    await fabric.next_frame("result")
                    await asyncio.sleep(0.5)
                    self.assertEqual(len(fabric.frames_of("result")), 1)
                    self.assertFalse(node.runtimes["mock"].lock.locked())
                    # A re-delivery after completion is still not re-executed.
                    await fabric.send(frame)
                    await asyncio.sleep(0.3)
                    self.assertEqual(len(fabric.frames_of("result")), 1)
                    await self.disconnect(ws, task)
            finally:
                await node.close()

    async def test_unknown_model_and_capability_rejected_before_execution(self):
        with tempfile.TemporaryDirectory() as tmp:
            node = make_node(tmp)
            await preload(node, "m1")
            runtime = node.runtimes["mock"]
            try:
                async with FakeFabric() as fabric:
                    ws, task = await self.connected(fabric, node)
                    with patch.object(runtime, "ensure_loaded", AsyncMock()) as load, patch.object(
                        runtime, "generate", AsyncMock()
                    ) as generate:
                        await fabric.send(execute_frame(model_id="unknown"))
                        rejected = await fabric.next_frame("result")
                        self.assertEqual(rejected["status_code"], 404)
                        await fabric.send(execute_frame(capability="absent"))
                        rejected = await fabric.next_frame("result")
                        self.assertEqual(rejected["status_code"], 404)
                        load.assert_not_awaited()
                        generate.assert_not_awaited()
                    self.assertEqual(runtime.loaded_model.id, "m1")
                    self.assertEqual(runtime.state, "ready")
                    await self.disconnect(ws, task)
            finally:
                await node.close()

    async def test_non_resident_model_is_not_cold_started_or_switched(self):
        with tempfile.TemporaryDirectory() as tmp:
            node = make_node(tmp)
            runtime = node.runtimes["mock"]
            await preload(node, "m2")
            try:
                async with FakeFabric() as fabric:
                    ws, task = await self.connected(fabric, node)
                    with patch.object(runtime, "ensure_loaded", AsyncMock()) as load, patch.object(
                        runtime, "generate", AsyncMock()
                    ) as generate:
                        await fabric.send(execute_frame(model_id="m1"))
                        rejected = await fabric.next_frame("result")
                        self.assertEqual(rejected["status_code"], 409)
                        load.assert_not_awaited()
                        generate.assert_not_awaited()
                    self.assertEqual(runtime.loaded_model.id, "m2")
                    self.assertEqual(runtime.state, "ready")
                    await self.disconnect(ws, task)
            finally:
                await node.close()

    async def test_missing_model_and_unknown_fields_are_422(self):
        with tempfile.TemporaryDirectory() as tmp:
            node = make_node(tmp)
            await preload(node, "m1")
            try:
                async with FakeFabric() as fabric:
                    ws, task = await self.connected(fabric, node)
                    missing = execute_frame()
                    del missing["request"]["model_id"]
                    await fabric.send(missing)
                    self.assertEqual((await fabric.next_frame("result"))["status_code"], 422)
                    extra = execute_frame(allow_simulated=True)
                    await fabric.send(extra)
                    self.assertEqual((await fabric.next_frame("result"))["status_code"], 422)
                    chat = {
                        "type": "execute",
                        "job_id": str(uuid.uuid4()),
                        "request": {
                            "capability": "complete",
                            "model_id": "m1",
                            "messages": [{"role": "user", "content": "x"}],
                        },
                    }
                    await fabric.send(chat)
                    self.assertEqual((await fabric.next_frame("result"))["status_code"], 422)
                    await self.disconnect(ws, task)
            finally:
                await node.close()

    async def test_busy_runtime_returns_429(self):
        with tempfile.TemporaryDirectory() as tmp:
            node = make_node(tmp)
            runtime = node.runtimes["mock"]
            await preload(node, "m1")
            await runtime.lock.acquire()
            try:
                async with FakeFabric() as fabric:
                    ws, task = await self.connected(fabric, node)
                    await fabric.send(execute_frame())
                    rejected = await fabric.next_frame("result")
                    self.assertEqual(rejected["status_code"], 429)
                    await self.disconnect(ws, task)
            finally:
                runtime.lock.release()
                await node.close()

    async def test_timeout_returns_one_504_and_does_not_retry_locally(self):
        with tempfile.TemporaryDirectory() as tmp:
            node = make_node(tmp, timeout=0.15)
            node.config.runtimes[0].mock_delay_seconds = 1
            await preload(node, "m1")
            try:
                async with FakeFabric() as fabric:
                    ws, task = await self.connected(fabric, node)
                    await fabric.send(execute_frame())
                    failed = await fabric.next_frame("result")
                    self.assertEqual(failed["status_code"], 504)
                    self.assertEqual(failed["error"], "Local runtime could not complete the task")
                    await asyncio.sleep(0.2)
                    self.assertEqual(len(fabric.frames_of("result")), 1)
                    self.assertEqual(node.runtimes["mock"].state, "error")
                    # The runtime is no longer resident, so no silent retry or reload.
                    await fabric.send(execute_frame())
                    second = await fabric.next_frame("result")
                    self.assertEqual(second["status_code"], 409)
                    await self.disconnect(ws, task)
                    self.assertEqual(len(fabric.frames_of("result")), 2)
            finally:
                await node.close()

    async def test_disconnect_cancels_inflight_without_result(self):
        with tempfile.TemporaryDirectory() as tmp:
            node = make_node(tmp, timeout=5)
            node.config.runtimes[0].mock_delay_seconds = 5
            await preload(node, "m1")
            try:
                async with FakeFabric() as fabric:
                    ws, task = await self.connected(fabric, node)
                    await fabric.send(execute_frame())
                    for _ in range(200):
                        if node.runtimes["mock"].lock.locked():
                            break
                        await asyncio.sleep(0.01)
                    self.assertTrue(node.runtimes["mock"].lock.locked())
                    await fabric.close()
                    await asyncio.wait_for(task, 3)
                    await asyncio.sleep(0.2)
                    self.assertEqual(fabric.frames_of("result"), [])
                    self.assertFalse(node.runtimes["mock"].lock.locked())
                    self.assertEqual(node.runtimes["mock"].state, "error")
            finally:
                await node.close()

    async def test_malformed_frames_are_ignored_and_connection_survives(self):
        with tempfile.TemporaryDirectory() as tmp:
            node = make_node(tmp)
            await preload(node, "m1")
            try:
                async with FakeFabric() as fabric:
                    ws, task = await self.connected(fabric, node)
                    await fabric.send_raw("not json")
                    await fabric.send({"type": "unknown"})
                    await fabric.send({"type": "execute", "job_id": "", "request": {}})
                    await fabric.send(
                        {"type": "execute", "job_id": "x" * 200, "request": {}}
                    )
                    await asyncio.sleep(0.2)
                    self.assertEqual(fabric.frames_of("result"), [])
                    await fabric.send(execute_frame())
                    self.assertEqual(
                        (await fabric.next_frame("result"))["result"]["model_id"], "m1"
                    )
                    await self.disconnect(ws, task)
            finally:
                await node.close()

    async def test_single_sanitized_heartbeat_loop(self):
        with tempfile.TemporaryDirectory() as tmp:
            node = make_node(tmp, heartbeat=10)
            await preload(node, "m1")
            try:
                async with FakeFabric() as fabric:
                    ws, task = await self.connected(fabric, node)
                    await asyncio.sleep(0.4)
                    heartbeats = fabric.frames_of("heartbeat")
                    self.assertEqual(len(heartbeats), 1)
                    snapshot = heartbeats[0]["snapshot"]
                    self.assertNotIn("binaries", snapshot["hardware"])
                    self.assertNotIn("fabric", snapshot)
                    self.assertNotIn("process_id", snapshot["runtimes"][0])
                    await fabric.send(execute_frame())
                    await fabric.next_frame("result")
                    await asyncio.sleep(0.2)
                    self.assertEqual(len(fabric.frames_of("heartbeat")), 1)
                    await self.disconnect(ws, task)
            finally:
                await node.close()

    async def test_probe_chat_is_answered_by_a_heartbeat_not_a_result(self):
        with tempfile.TemporaryDirectory() as tmp:
            node = make_node(tmp, heartbeat=10)
            await preload(node, "m1")
            try:
                async with FakeFabric() as fabric:
                    ws, task = await self.connected(fabric, node)
                    await fabric.next_frame("heartbeat")
                    await fabric.send({"type": "probe_chat"})
                    await fabric.next_frame("heartbeat")
                    await asyncio.sleep(0.2)
                    self.assertEqual(len(fabric.frames_of("heartbeat")), 2)
                    self.assertEqual(fabric.frames_of("result"), [])
                    self.assertIsNotNone(node.fabric["last_heartbeat_at"])
                    await self.disconnect(ws, task)
            finally:
                await node.close()

    async def test_capacity_rejection_is_terminal_for_that_job(self):
        with tempfile.TemporaryDirectory() as tmp:
            node = make_node(tmp)
            node.config.runtimes[0].mock_delay_seconds = 0.3
            await preload(node, "m1")
            try:
                async with FakeFabric() as fabric:
                    ws, task = await self.connected(fabric, node)
                    first = execute_frame()
                    second = execute_frame()
                    await fabric.send(first)
                    for _ in range(200):
                        if node.runtimes["mock"].lock.locked():
                            break
                        await asyncio.sleep(0.01)
                    self.assertTrue(node.runtimes["mock"].lock.locked())
                    await fabric.send(second)
                    rejected = await fabric.next_frame("result")
                    self.assertEqual(rejected["job_id"], second["job_id"])
                    self.assertEqual(rejected["status_code"], 429)
                    await fabric.next_frame("result")  # first job completes
                    await fabric.send(second)
                    await asyncio.sleep(0.4)
                    frames = [
                        frame
                        for frame in fabric.frames_of("result")
                        if frame["job_id"] == second["job_id"]
                    ]
                    self.assertEqual(len(frames), 1)
                    self.assertEqual(frames[0]["status_code"], 429)
                    await self.disconnect(ws, task)
            finally:
                await node.close()

    async def test_execution_failure_log_has_no_prompt_or_token(self):
        prompt = "PROMPT-SENTINEL-abc123"
        token = "TOKEN-SENTINEL-xyz789"
        with tempfile.TemporaryDirectory() as tmp:
            node = make_node(tmp)
            runtime = node.runtimes["mock"]
            await preload(node, "m1")

            async def failing_generate(request):
                raise RuntimeError(f"backend echoed {prompt}")

            runtime.generate = failing_generate
            try:
                async with FakeFabric() as fabric:
                    ws = await connect(
                        connection_url(fabric.origin, node.config.node.id),
                        additional_headers={"Authorization": "Bearer " + token},
                    )
                    task = asyncio.create_task(serve_connection(node, ws))
                    await fabric.websocket()
                    with self.assertLogs("dendrite.fabric", level="DEBUG") as captured:
                        await fabric.send(execute_frame(prompt=prompt))
                        failed = await fabric.next_frame("result")
                    self.assertEqual(failed["status_code"], 500)
                    self.assertEqual(failed["error"], "Local execution failed")
                    logged = "\n".join(captured.output)
                    self.assertNotIn(prompt, logged)
                    self.assertNotIn(token, logged)
                    self.assertNotIn(prompt, json.dumps(fabric.frames))
                    snapshot = node.snapshot()
                    self.assertEqual(snapshot["runtimes"][0]["last_error"], "Fabric request failed")
                    self.assertNotIn(prompt, json.dumps(snapshot))
                    await self.disconnect(ws, task)
            finally:
                await node.close()

    async def test_handshake_rejection_stops_without_retrying(self):
        token = "TOKEN-SENTINEL-handshake"
        with tempfile.TemporaryDirectory() as tmp:
            async with FakeFabric(reject_status=401) as fabric:
                node = make_node(tmp, fabric=fabric)
                try:
                    with self.assertLogs("dendrite.fabric", level="DEBUG") as captured:
                        await asyncio.wait_for(run_fabric_bridge(node, token), 2)
                    self.assertEqual(len(fabric.handshakes), 1)
                    self.assertEqual(fabric.connections, 0)
                    self.assertEqual(node.fabric["state"], "rejected")
                    self.assertEqual(node.fabric["code"], 401)
                    self.assertNotIn(token, "\n".join(captured.output))
                    await asyncio.sleep(0.2)
                    self.assertEqual(len(fabric.handshakes), 1)
                finally:
                    await node.close()

    async def test_replaced_close_stops_instead_of_flapping(self):
        with tempfile.TemporaryDirectory() as tmp:
            async with FakeFabric(close_code=4001) as fabric:
                node = make_node(tmp, fabric=fabric)
                try:
                    await asyncio.wait_for(run_fabric_bridge(node, "synthetic"), 2)
                    self.assertEqual(node.fabric["state"], "superseded")
                    self.assertEqual(node.fabric["code"], 4001)
                    self.assertEqual(fabric.connections, 1)
                    await asyncio.sleep(0.2)
                    self.assertEqual(fabric.connections, 1)
                finally:
                    await node.close()

    async def test_revoked_close_stops_as_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            async with FakeFabric(close_code=4003) as fabric:
                node = make_node(tmp, fabric=fabric)
                try:
                    await asyncio.wait_for(run_fabric_bridge(node, "synthetic"), 2)
                    self.assertEqual(node.fabric["state"], "rejected")
                    self.assertEqual(node.fabric["code"], 4003)
                finally:
                    await node.close()

    async def test_runtime_resident_guard_precedes_load(self):
        with tempfile.TemporaryDirectory() as tmp:
            node = make_node(tmp)
            runtime = node.runtimes["mock"]
            model = node.config.models[0]
            try:
                with patch.object(runtime, "ensure_loaded", AsyncMock()) as load:
                    with self.assertRaises(RuntimeFailure) as raised:
                        await runtime.execute(
                            model,
                            ExecuteRequest(capability="complete", model_id="m1", prompt="x"),
                            require_resident=True,
                        )
                    self.assertEqual(raised.exception.status_code, 409)
                    load.assert_not_awaited()
                # Unrelated local API behavior still cold-loads as before.
                result = await runtime.execute(
                    model, ExecuteRequest(capability="complete", model_id="m1", prompt="x")
                )
                self.assertEqual(result["content"], "[SIMULATED m1] x")
            finally:
                await node.close()


    async def test_attached_quarantine_requires_an_unanswered_sent_request(self):
        runtime = LlamaRuntime(
            RuntimeConfig(
                id="attach", kind="ik_llama", mode="attach",
                base_url="http://127.0.0.1:1",
            ),
            NodeConfig(),
        )
        try:
            # Cancelled before dispatch: the attached model is untouched.
            await runtime.abort()
            self.assertFalse(runtime.quarantined)
            # A definite rejection is not an uncertain outcome.
            runtime._request_sent = True
            runtime._known_rejection = True
            await runtime.abort()
            self.assertFalse(runtime.quarantined)
            # A request that may have reached the server must be quarantined.
            runtime._request_sent = True
            runtime._known_rejection = False
            await runtime.abort()
            self.assertTrue(runtime.quarantined)
        finally:
            await runtime.client.aclose()

    async def test_attached_known_rejection_does_not_quarantine(self):
        runtime = LlamaRuntime(
            RuntimeConfig(
                id="attach", kind="ik_llama", mode="attach",
                base_url="http://127.0.0.1:1",
            ),
            NodeConfig(),
        )
        request = httpx.Request("POST", "http://127.0.0.1:1/completion")
        try:
            runtime.client.post = AsyncMock(
                return_value=httpx.Response(400, json={}, request=request)
            )
            with self.assertRaises(RuntimeFailure):
                await runtime.generate(
                    ExecuteRequest(capability="complete", model_id="m1", prompt="x")
                )
            self.assertTrue(runtime._request_sent)
            self.assertTrue(runtime._known_rejection)
            await runtime.abort()
            self.assertFalse(runtime.quarantined)

            runtime.client.post = AsyncMock(
                return_value=httpx.Response(200, json={"wrong": "shape"}, request=request)
            )
            with self.assertRaises(RuntimeFailure):
                await runtime.generate(
                    ExecuteRequest(capability="complete", model_id="m1", prompt="x")
                )
            self.assertTrue(runtime._request_sent)
            self.assertFalse(runtime._known_rejection)
            await runtime.abort()
            self.assertTrue(runtime.quarantined)
        finally:
            await runtime.client.aclose()


    async def test_connect_phase_failures_do_not_quarantine_an_attachment(self):
        def attached():
            return LlamaRuntime(
                RuntimeConfig(
                    id="attach", kind="ik_llama", mode="attach",
                    base_url="http://127.0.0.1:1",
                ),
                NodeConfig(),
            )

        request = ExecuteRequest(capability="complete", model_id="m1", prompt="x")
        for error in (
            httpx.ConnectError("refused"),
            httpx.ConnectTimeout("connect timeout"),
            httpx.PoolTimeout("pool timeout"),
        ):
            runtime = attached()
            try:
                runtime.client.post = AsyncMock(side_effect=error)
                with self.assertRaises(RuntimeFailure):
                    await runtime.generate(request)
                self.assertFalse(runtime._request_sent)
                await runtime.abort()
                self.assertFalse(runtime.quarantined)
            finally:
                await runtime.client.aclose()

        runtime = attached()
        try:
            runtime.client.post = AsyncMock(side_effect=httpx.ReadTimeout("read timeout"))
            with self.assertRaises(RuntimeFailure):
                await runtime.generate(request)
            self.assertTrue(runtime._request_sent)
            await runtime.abort()
            self.assertTrue(runtime.quarantined)
        finally:
            await runtime.client.aclose()

    async def test_managed_residency_requires_matching_fingerprint(self):
        class FakeProcess:
            def __init__(self):
                self.returncode = None
                self.pid = 12345

            def terminate(self):
                self.returncode = -15

            async def wait(self, timeout=None):
                return self.returncode

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "model.gguf"
            path.write_bytes(b"GGUF" + b"\0" * 64)
            model = ModelConfig(
                id="m1", runtime="managed", capabilities=["complete"], path=path
            )
            node = Node(
                Config(
                    node=NodeConfig(id="test-node", state_dir=Path(tmp)),
                    runtimes=[
                        RuntimeConfig(
                            id="managed", kind="ik_llama", mode="managed", executable="sh"
                        )
                    ],
                    models=[model],
                )
            )
            runtime = node.runtimes["managed"]
            runtime.loaded_model = model
            runtime.state = "ready"
            runtime.process = FakeProcess()
            try:
                runtime.fingerprint = "stale-fingerprint"
                self.assertFalse(runtime.is_resident(model))
                snapshot = cloud_snapshot(node)
                self.assertFalse(snapshot["models"][0]["resident"])
                self.assertFalse(snapshot["models"][0]["available"])

                runtime.fingerprint = file_identity(path)["fingerprint"]
                self.assertTrue(runtime.is_resident(model))
                snapshot = cloud_snapshot(node)
                self.assertTrue(snapshot["models"][0]["resident"])
                self.assertTrue(snapshot["models"][0]["available"])
            finally:
                await node.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)

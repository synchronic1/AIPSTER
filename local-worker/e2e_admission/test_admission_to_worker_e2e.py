"""Offline end-to-end fixture chain: AIPSTER codec -> fake fabric -> real worker.

Marker: MAC-E2E-SUCCESSOR-20261101.

WHAT THIS IS
=============
A bounded, synthetic E2E component harness. It wires four things over
127.0.0.1 only:

1. a fake AIPSTER admission step whose dispatch payload is the *actual* object
   ``encodeCpuTask`` produces (mirrored from the pinned reference source);
2. a loopback fake Ganglion transport with a bearer handshake;
3. the real vendored worker (``local-worker/vendor/eif/dendrite``) running
   ``run_fabric_bridge``/``serve_connection``;
4. the worker's real ``MockRuntime`` as the resident fake runtime.

WHAT THIS IS NOT
================
Not production E2E, not admission authority, not qualification evidence.

* AIPSTER main's ``POST /api/jobs`` is unconditionally 501
  (``website/src/worker.js`` at f6e45f5, lines 2793-2796) and no inference
  admission or dispatcher exists in accessible source.
* The fake admission/fabric below encode the *documented required contract* only
  as scaffolding; assertions that matter are anchored to real worker behavior
  (422/429/504 frames, result binding, per-connection dedupe) or to the pinned
  AIPSTER codec source.
* ``MockRuntime`` sets ``simulated: true`` and ``usage: {}``. AIPSTER's own
  decoder rejects simulated results, so this harness cannot produce accounting
  or qualification evidence for any of these paths.

No model is loaded, no native engine starts, no live daemon/credential is read,
and no request leaves the loopback interface.

Run (heavy fake suite, under the shared lock):

    cd local-worker
    PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$PWD/vendor/eif:$PWD" \\
      python -m pytest e2e_admission -q
"""

import asyncio
import hashlib
import json
import tempfile
import unittest
import uuid
from pathlib import Path

import dendrite
from dendrite.config import Config, ModelConfig, NodeConfig, RuntimeConfig
from dendrite.fabric import connection_url, run_fabric_bridge, serve_connection
from dendrite.node import Node
from dendrite.schemas import ExecuteRequest
from e2e_admission import aipster_contract
from websockets.asyncio.client import connect
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed, WebSocketException

_VENDOR = (Path(__file__).resolve().parents[1] / "vendor/eif/dendrite").resolve()
if not Path(dendrite.__file__).resolve().is_relative_to(_VENDOR):
    raise RuntimeError(
        "E2E fixtures must import this worktree's vendor/eif/dendrite; "
        "run with PYTHONPATH=$PWD/vendor/eif"
    )

SYNTHETIC_TOKEN = "synthetic-e2e-fabric-token-not-a-credential"
NODE_ID = "e2e-fixture-node"
MODEL_ID = "m1"


class FakeAipsterAdmission:
    """Fixture stand-in for the server-side admission step that does not exist.

    Accessible AIPSTER main has no inference admission; this object only models
    the documented *required* contract well enough to hand the real worker the
    exact codec payload AIPSTER would emit. It authorizes nothing.
    """

    def __init__(self, principal="synthetic-owner"):
        self.principal = principal

    def admit(self, *, prompt, max_tokens=8):
        if not self.principal:
            raise PermissionError("no authenticated principal")
        operation_key = "op-e2e-" + uuid.uuid4().hex[:12]
        return {
            "operation_key": operation_key,
            "dispatch_payload": aipster_contract.encode_cpu_task(
                model_id=MODEL_ID,
                prompt=prompt,
                max_tokens=max_tokens,
                operation_key=operation_key,
            ),
        }


class FakeGanglionTransport:
    """Loopback stand-in for the Ganglion node socket. No live fabric is used."""

    def __init__(self, token=SYNTHETIC_TOKEN):
        self.token = token
        self.handshakes = []
        self.frames = []
        self.results = []
        self.server = None
        self.port = None
        self._sockets = asyncio.Queue()
        self._frames = asyncio.Queue()

    async def __aenter__(self):
        self.server = await serve(
            self._handler, "127.0.0.1", 0, process_request=self._process_request
        )
        self.port = self.server.sockets[0].getsockname()[1]
        return self

    async def __aexit__(self, *_exc):
        self.server.close()
        await self.server.wait_closed()

    @property
    def origin(self):
        return f"http://127.0.0.1:{self.port}"

    def _process_request(self, connection, request):
        authorization = request.headers.get("Authorization")
        self.handshakes.append({"path": request.path, "authorization": authorization})
        if authorization != "Bearer " + self.token:
            return connection.respond(401, "unauthorized")
        return None

    async def _handler(self, ws):
        self._sockets.put_nowait(ws)
        try:
            async for raw in ws:
                message = json.loads(raw)
                self.frames.append(message)
                if message.get("type") == "result":
                    self.results.append(message)
                self._frames.put_nowait(message)
        except (ConnectionClosed, WebSocketException):
            pass
        finally:
            self._frames.put_nowait({"type": "__closed__"})

    async def next_socket(self, timeout=5):
        return await asyncio.wait_for(self._sockets.get(), timeout)

    async def next_result(self, timeout=5):
        async def wait():
            while True:
                message = await self._frames.get()
                # ``__closed__`` is informational: a reconnect in the same test
                # (worker restart) enqueues one before the next connection's
                # result. Keep waiting; the caller's timeout bounds the wait.
                if message.get("type") == "result":
                    return message

        return await asyncio.wait_for(wait(), timeout)


def make_node(tmp, *, fabric=None, timeout=2.0, mock_delay=0.0):
    return Node(
        Config(
            node=NodeConfig(
                id=NODE_ID,
                state_dir=Path(tmp),
                request_timeout_seconds=timeout,
                heartbeat_seconds=30,
                fabric_url=fabric.origin if fabric is not None else None,
            ),
            runtimes=[RuntimeConfig(id="mock", kind="mock", mock_delay_seconds=mock_delay)],
            models=[
                ModelConfig(id=MODEL_ID, runtime="mock", capabilities=["complete"]),
            ],
        )
    )


async def preload(node):
    model = node.config.models[0]
    await node.runtimes["mock"].ensure_loaded(model)
    return model


def translate_for_worker(cpu_task):
    """Drop the two codec fields the worker's strict request schema forbids."""
    return {key: value for key, value in cpu_task.items() if key in ExecuteRequest.model_fields}


async def stop_bridge(task):
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


class AdmissionToWorkerFixtureTests(unittest.IsolatedAsyncioTestCase):
    def test_reference_codec_fields_match_the_pinned_aipster_source(self):
        """The Python mirror must not drift from the pinned JS source."""
        self.assertEqual(
            hashlib.sha256(aipster_contract.REFERENCE.read_bytes()).hexdigest(),
            aipster_contract.REFERENCE_SHA256,
        )
        self.assertEqual(
            aipster_contract.declared_cpu_task_fields(), aipster_contract.CPU_TASK_FIELDS
        )
        self.assertEqual(
            aipster_contract.declared_placement_fields(),
            aipster_contract.PLACEMENT_FIELDS,
        )
        source = aipster_contract.reference_source()
        for anchor in (
            "export function encodeCpuTask",
            "export function decodeCpuTask",
            "export function classifyTransportOutcome",
            "allow_simulated: false",
            "idempotency_key: operationKey",
            "r.simulated !== false",
            "automaticRetry: false, remoteStopped: false",
        ):
            self.assertIn(anchor, source)

    async def test_aipster_dispatch_payload_is_rejected_by_worker_request_schema(self):
        """REAL FAILING EDGE: AIPSTER's own encoder output is a 422 at the worker.

        ``encodeCpuTask`` emits ``allow_simulated`` and ``idempotency_key`` inside
        the nested request; the worker's ``ExecuteRequest`` is ``extra="forbid"``.
        No translation layer exists in accessible AIPSTER source, so the two
        components do not connect end to end as written.
        """
        calls = {"n": 0}
        with tempfile.TemporaryDirectory() as tmp:
            async with FakeGanglionTransport() as fabric:
                node = make_node(tmp, fabric=fabric)
                await preload(node)
                original_generate = node.runtimes["mock"].generate

                async def counting_generate(request):
                    calls["n"] += 1
                    return await original_generate(request)

                node.runtimes["mock"].generate = counting_generate
                bridge = asyncio.create_task(run_fabric_bridge(node, SYNTHETIC_TOKEN))
                try:
                    ws = await fabric.next_socket()
                    admission = FakeAipsterAdmission()
                    operation = admission.admit(prompt="synthetic e2e prompt")
                    payload = operation["dispatch_payload"]
                    self.assertEqual(set(payload), set(aipster_contract.CPU_TASK_FIELDS))
                    self.assertEqual(ExecuteRequest.model_config["extra"], "forbid")
                    # Send each forbidden field alone, so one 422 cannot mask the
                    # other field being the actual cause.
                    allowed = {
                        key: value
                        for key, value in payload.items()
                        if key not in ("allow_simulated", "idempotency_key")
                    }
                    for field in ("allow_simulated", "idempotency_key"):
                        self.assertNotIn(field, ExecuteRequest.model_fields)
                        job_id = f"{operation['operation_key']}-{field}"
                        await ws.send(
                            json.dumps(
                                {
                                    "type": "execute",
                                    "job_id": job_id,
                                    "request": dict(allowed, **{field: payload[field]}),
                                }
                            )
                        )
                        frame = await fabric.next_result()
                        self.assertEqual(frame["job_id"], job_id)
                        self.assertEqual(frame["status_code"], 422)
                        self.assertEqual(frame["error"], "Invalid node request")
                finally:
                    await stop_bridge(bridge)
                    await node.close()

        self.assertEqual(calls["n"], 0)  # refused before any runtime call

    async def test_bound_placement_payload_is_also_rejected(self):
        """``encodeBoundCpuTask`` adds ``placement``; that is a 422 as well."""
        with tempfile.TemporaryDirectory() as tmp:
            async with FakeGanglionTransport() as fabric:
                node = make_node(tmp, fabric=fabric)
                await preload(node)
                bridge = asyncio.create_task(run_fabric_bridge(node, SYNTHETIC_TOKEN))
                try:
                    ws = await fabric.next_socket()
                    operation = FakeAipsterAdmission().admit(prompt="synthetic placement")
                    bound = aipster_contract.encode_bound_cpu_task(
                        operation["dispatch_payload"],
                        {"device": "cpu", "nodeId": NODE_ID, "runtimeId": "mock"},
                    )
                    self.assertEqual(
                        set(bound["placement"]), set(aipster_contract.PLACEMENT_FIELDS)
                    )
                    # Isolate ``placement``: every other codec-only field is removed.
                    request = dict(
                        translate_for_worker(operation["dispatch_payload"]),
                        placement=bound["placement"],
                    )
                    self.assertEqual(set(request) - set(ExecuteRequest.model_fields), {"placement"})
                    await ws.send(
                        json.dumps(
                            {
                                "type": "execute",
                                "job_id": operation["operation_key"],
                                "request": request,
                            }
                        )
                    )
                    frame = await fabric.next_result()
                finally:
                    await stop_bridge(bridge)
                    await node.close()

        self.assertEqual(frame["status_code"], 422)
        self.assertEqual(frame["error"], "Invalid node request")

    async def test_translated_dispatch_binds_result_but_mock_fails_aipster_decoder(self):
        """Response binding works; simulated results still cannot qualify.

        After dropping the two non-worker fields the worker executes and binds
        ``request_id``/``node_id``/``runtime_id`` to the dispatch identity. But
        the result carries ``simulated: true`` and ``usage: {}``, and AIPSTER's
        ``decodeCpuTask`` rejects simulated output. A non-vacuous control with
        ``simulated: false`` decodes, proving the mirror is not tautological.
        """
        with tempfile.TemporaryDirectory() as tmp:
            async with FakeGanglionTransport() as fabric:
                node = make_node(tmp, fabric=fabric)
                await preload(node)
                bridge = asyncio.create_task(run_fabric_bridge(node, SYNTHETIC_TOKEN))
                try:
                    ws = await fabric.next_socket()
                    operation = FakeAipsterAdmission().admit(prompt="synthetic translated")
                    payload = operation["dispatch_payload"]
                    request = translate_for_worker(payload)
                    self.assertEqual(
                        set(payload) - set(request),
                        {"allow_simulated", "idempotency_key"},
                    )
                    await ws.send(
                        json.dumps(
                            {
                                "type": "execute",
                                "job_id": operation["operation_key"],
                                "request": request,
                            }
                        )
                    )
                    frame = await fabric.next_result()
                finally:
                    await stop_bridge(bridge)
                    await node.close()

        result = frame["result"]
        self.assertEqual(result["request_id"], operation["operation_key"])
        self.assertEqual(result["node_id"], NODE_ID)
        self.assertEqual(result["runtime_id"], "mock")
        self.assertEqual(result["usage"], {})
        self.assertIs(result["simulated"], True)

        stored_job = {
            "id": operation["operation_key"],
            "node_id": NODE_ID,
            "runtime_id": "mock",
            "model_id": MODEL_ID,
            "status": "succeeded",
            "result": result,
        }
        expected = {
            "id": operation["operation_key"],
            "node_id": NODE_ID,
            "runtime_id": "mock",
            "model_id": MODEL_ID,
        }
        with self.assertRaises(aipster_contract.InvalidEifContract):
            aipster_contract.decode_cpu_task(stored_job, expected)

        # Control: the same envelope with a real, non-simulated result decodes.
        real_result = dict(result, simulated=False, content="real output", usage={"completion_tokens": 3})
        decoded = aipster_contract.decode_cpu_task(dict(stored_job, result=real_result), expected)
        self.assertEqual(decoded["status"], "succeeded")
        self.assertIs(decoded["provenance"]["simulated"], False)

    async def test_cancel_frame_is_silently_ignored(self):
        """REAL GAP: the execute socket has no cancel verb.

        ``serve_connection.receive`` handles only ``probe_chat`` and ``execute``.
        A peer that sends ``{"type": "cancel"}`` gets no acknowledgement and the
        job still runs to completion. Cancellation is disconnect-only.
        """
        with tempfile.TemporaryDirectory() as tmp:
            async with FakeGanglionTransport() as fabric:
                node = make_node(tmp, timeout=5.0, mock_delay=0.4)
                await preload(node)
                client = await connect(
                    connection_url(fabric.origin, NODE_ID),
                    additional_headers={"Authorization": "Bearer " + SYNTHETIC_TOKEN},
                )
                connection_task = asyncio.create_task(serve_connection(node, client))
                try:
                    ws = await fabric.next_socket()
                    operation = FakeAipsterAdmission().admit(prompt="synthetic cancel")
                    request = translate_for_worker(operation["dispatch_payload"])
                    await ws.send(
                        json.dumps(
                            {
                                "type": "execute",
                                "job_id": operation["operation_key"],
                                "request": request,
                            }
                        )
                    )
                    await ws.send(
                        json.dumps({"type": "cancel", "job_id": operation["operation_key"]})
                    )
                    frame = await fabric.next_result()
                finally:
                    await client.close()
                    await asyncio.gather(connection_task, return_exceptions=True)
                    await node.close()

        self.assertEqual(frame["job_id"], operation["operation_key"])
        self.assertIn("result", frame)
        self.assertGreaterEqual(frame["result"]["elapsed_ms"], 300)
        self.assertFalse(
            [m for m in fabric.frames if m.get("type") in ("cancel", "cancelled", "ack")]
        )

    async def test_deadline_is_worker_local_and_outcome_is_uncertain(self):
        """Deadline: the worker's local timeout is the only bound on the socket.

        The terminal frame is the bare 504 error envelope with no expiry
        metadata, and AIPSTER's own classifier calls a timeout ``uncertain``
        with no automatic retry and no proof remote work stopped. Durable
        operation binding, which that recovery would need, is absent from
        accessible main.
        """
        with tempfile.TemporaryDirectory() as tmp:
            async with FakeGanglionTransport() as fabric:
                node = make_node(tmp, fabric=fabric, timeout=0.15, mock_delay=1.0)
                await preload(node)
                bridge = asyncio.create_task(run_fabric_bridge(node, SYNTHETIC_TOKEN))
                try:
                    ws = await fabric.next_socket()
                    operation = FakeAipsterAdmission().admit(prompt="synthetic deadline")
                    request = translate_for_worker(operation["dispatch_payload"])
                    await ws.send(
                        json.dumps(
                            {
                                "type": "execute",
                                "job_id": operation["operation_key"],
                                "request": request,
                            }
                        )
                    )
                    frame = await fabric.next_result()
                finally:
                    await stop_bridge(bridge)
                    await node.close()

        self.assertEqual(frame["status_code"], 504)
        self.assertEqual(set(frame), {"type", "job_id", "error", "status_code"})
        self.assertEqual(
            aipster_contract.classify_transport_outcome("timeout"),
            {"status": "uncertain", "automaticRetry": False, "remoteStopped": False},
        )

    async def test_worker_restart_reexecutes_the_same_job_no_durable_no_replay(self):
        """Unknown outcome + restart: the worker cannot prove no-replay.

        The first worker starts the admitted job, then the connection and worker
        are torn down before a result; AIPSTER's classifier calls that uncertain
        and does not retry. A fresh ``Node`` instance receiving the same job id
        executes it again, because duplicate suppression lives only in a
        per-connection set. This is an instance restart inside one interpreter,
        not an OS process; that is equivalent here because this adapter persists
        no job state to ``state_dir`` (asserted below). The admission-side durable
        binding that would make replay safe is absent.
        """
        calls = {"n": 0}
        started = asyncio.Event()

        def instrument(node):
            original = node.runtimes["mock"].generate

            async def counting_generate(request):
                calls["n"] += 1
                started.set()
                return await original(request)

            node.runtimes["mock"].generate = counting_generate

        with tempfile.TemporaryDirectory() as tmp:
            operation = FakeAipsterAdmission().admit(prompt="synthetic restart")
            request = translate_for_worker(operation["dispatch_payload"])

            async with FakeGanglionTransport() as fabric:
                first = make_node(tmp, fabric=fabric, timeout=5.0, mock_delay=0.5)
                await preload(first)
                instrument(first)
                bridge = asyncio.create_task(run_fabric_bridge(first, SYNTHETIC_TOKEN))
                try:
                    ws = await fabric.next_socket()
                    await ws.send(
                        json.dumps(
                            {
                                "type": "execute",
                                "job_id": operation["operation_key"],
                                "request": request,
                            }
                        )
                    )
                    await asyncio.wait_for(started.wait(), 5)
                    await stop_bridge(bridge)
                    self.assertEqual(fabric.results, [])  # no terminal result
                finally:
                    await first.close()

                # The adapter wrote no durable job ledger, so a fresh instance
                # has no way to know the operation already ran.
                self.assertEqual(sorted(path.name for path in Path(tmp).iterdir()), [])

                second = make_node(tmp, fabric=fabric, timeout=5.0, mock_delay=0.0)
                await preload(second)
                instrument(second)
                bridge = asyncio.create_task(run_fabric_bridge(second, SYNTHETIC_TOKEN))
                try:
                    ws = await fabric.next_socket()
                    await ws.send(
                        json.dumps(
                            {
                                "type": "execute",
                                "job_id": operation["operation_key"],
                                "request": request,
                            }
                        )
                    )
                    replay = await fabric.next_result()
                finally:
                    await stop_bridge(bridge)
                    await second.close()

        self.assertEqual(replay["job_id"], operation["operation_key"])
        self.assertIn("result", replay)
        self.assertEqual(calls["n"], 2)  # executed again by the fresh instance
        self.assertEqual(
            aipster_contract.classify_transport_outcome("connection_lost"),
            {"status": "uncertain", "automaticRetry": False, "remoteStopped": False},
        )

    async def test_unauthorized_handshake_stops_at_the_transport_edge(self):
        """Auth admission: a wrong bearer is rejected at the socket, once."""
        with tempfile.TemporaryDirectory() as tmp:
            async with FakeGanglionTransport() as fabric:
                node = make_node(tmp, fabric=fabric)
                try:
                    bridge = asyncio.create_task(run_fabric_bridge(node, "wrong-token"))
                    await asyncio.wait_for(bridge, 5)
                finally:
                    await node.close()

        self.assertEqual(len(fabric.handshakes), 1)
        self.assertEqual(fabric.handshakes[0]["authorization"], "Bearer wrong-token")
        self.assertEqual(node.fabric["state"], "rejected")
        self.assertEqual(node.fabric["code"], 401)
        self.assertEqual(node.fabric["last_error"], "Fabric rejected the node connection")


if __name__ == "__main__":
    unittest.main()

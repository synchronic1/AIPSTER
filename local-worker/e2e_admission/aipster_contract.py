"""Python mirror of AIPSTER's EIF task codec (marker MAC-E2E-SUCCESSOR-20261101).

WHY THIS FILE EXISTS
====================
The offline end-to-end fixture chain is:

    fake AIPSTER admission -> loopback fake Ganglion transport -> real vendored
    worker (local-worker/vendor/eif) -> real MockRuntime (resident fake runtime)

The only AIPSTER-side interface reachable without Node/npm is a static copy of
``website/src/inference/eif-task-contract.mjs``. That module is a protocol codec
only. This file mirrors it so the fixture can feed the *real* worker the exact
bytes AIPSTER's own encoder would emit, and so the test can prove the mirror is
still faithful to the pinned source.

This is NOT admission authority. AIPSTER main has no inference admission and
``POST /api/jobs`` is unconditionally 501. Nothing here authenticates, reserves,
authorizes or dispatches anything.

Pinned reference:: ``reference/eif-task-contract.f6e45f5.mjs``
(commit f6e45f556a48dd5f75a8e8b90992e8d9cfa0393e, sha256 recorded in
``reference/PROVENANCE.md``).

NO JAVASCRIPT WAS EXECUTED. Every conformance statement here rests on two
static anchors only: the sha256 of the pinned file, and a field-name extraction
from its ``return`` object literals. The behavior of this module is a Python
transcription of the reference, not an observation of the running JS. A genuine
JS/Node conformance run needs Node 24 and is BLOCKED in this lane; nothing here
should be cited as proof that the two implementations agree at runtime.
"""

import hashlib
import json
import math
import re
from pathlib import Path

REFERENCE = Path(__file__).resolve().parent / "reference/eif-task-contract.f6e45f5.mjs"
REFERENCE_SHA256 = "db743c78e1102c37346d570f09748adbecc54a48d8939eb0ba36f362e1762541"

CPU_TASK_FIELDS = (
    "capability",
    "model_id",
    "prompt",
    "max_tokens",
    "temperature",
    "allow_simulated",
    "idempotency_key",
)
PLACEMENT_FIELDS = ("device", "node_id", "runtime_id")

# Known, deliberate mirror divergences: (1) prompt length is measured in Python
# code points, while JS ``prompt.length`` counts UTF-16 code units; they differ
# only for astral-plane characters near the 65536 limit. The same unit differs
# for ``_is_id`` (JS ``x.length``) and for the ``{7,127}`` operation-key regex.
# (2) The 1 MiB limit uses ``json.dumps(separators=(",", ":"))``, which is
# byte-identical to ``JSON.stringify`` only for the ASCII/simple values this
# codec admits. (3) JS ``Number.isInteger(2.0)`` is true, but Python ints and
# floats are distinct, so a JS caller could in principle pass ``maxTokens: 2.0``
# where this mirror rejects it. None of these is reachable from
# ``encodeCpuTask``'s own integer/string inputs, so the fixture is unaffected.
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_OPERATION_KEY = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$")


class InvalidEifContract(Exception):
    """Raised where ``eif-task-contract.mjs`` calls ``fail()``."""


def _is_id(value):
    return isinstance(value, str) and 1 <= len(value) <= 256


def encode_cpu_task(*, model_id, prompt, max_tokens, operation_key):
    """Mirror of ``encodeCpuTask`` (lines 7-16 of the pinned reference)."""
    if (
        not _is_id(model_id)
        or not isinstance(prompt, str)
        or not prompt.strip()
        or len(prompt) > 65536
        or not isinstance(max_tokens, int)
        or isinstance(max_tokens, bool)
        or not 1 <= max_tokens <= 4096
        or not isinstance(operation_key, str)
        or not _OPERATION_KEY.match(operation_key)
    ):
        raise InvalidEifContract()
    return {
        "capability": "complete",
        "model_id": model_id,
        "prompt": prompt,
        "max_tokens": max_tokens,
        "temperature": 0,
        "allow_simulated": False,
        "idempotency_key": operation_key,
    }


def encode_bound_cpu_task(task, target):
    """Mirror of ``encodeBoundCpuTask`` (lines 45-53 of the pinned reference)."""
    if (
        not isinstance(target, dict)
        or set(target) - {"device", "nodeId", "runtimeId"}
        or target.get("device") != "cpu"
        or not all(
            isinstance(target.get(key), str) and _ID.match(target[key])
            for key in ("nodeId", "runtimeId")
        )
    ):
        raise InvalidEifContract()
    return {
        **encode_cpu_task(
            model_id=task["model_id"],
            prompt=task["prompt"],
            max_tokens=task["max_tokens"],
            operation_key=task["idempotency_key"],
        ),
        "placement": {
            "device": "cpu",
            "node_id": target["nodeId"],
            "runtime_id": target["runtimeId"],
        },
    }


def decode_cpu_task(job, expected):
    """Mirror of ``decodeCpuTask`` (lines 18-34 of the pinned reference).

    ``expected`` is ``{id, node_id, runtime_id, model_id}``. Simulated results are
    rejected, exactly as the reference decoder rejects them.
    """
    if not isinstance(job, dict) or not isinstance(expected, dict):
        raise InvalidEifContract()
    if not all(_is_id(expected.get(k)) and job.get(k) == expected[k] for k in ("id", "node_id", "runtime_id", "model_id")):
        raise InvalidEifContract()
    if job.get("status") == "running":
        return {"status": "running"}
    if job.get("status") in ("failed", "expired"):
        return {"status": job["status"]}
    result = job.get("result")
    if job.get("status") != "succeeded" or not isinstance(result, dict):
        raise InvalidEifContract()
    if (
        result.get("request_id") != expected["id"]
        or not all(result.get(k) == expected[k] for k in ("node_id", "runtime_id", "model_id"))
        or result.get("simulated") is not False
        or result.get("truncated", False) is not False
        or not isinstance(result.get("content"), str)
        or not result["content"].strip()
        or not isinstance(result.get("elapsed_ms"), (int, float))
        or isinstance(result.get("elapsed_ms"), bool)
        or not math.isfinite(result["elapsed_ms"])
        or result["elapsed_ms"] < 0
        or not isinstance(result.get("usage"), dict)
        or not isinstance(result.get("cache"), dict)
        or len(
            json.dumps(job, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        )
        > 1024 * 1024
    ):
        raise InvalidEifContract()
    return {
        "status": "succeeded",
        "content": result["content"],
        "provenance": {
            "id": expected["id"],
            "node_id": expected["node_id"],
            "runtime_id": expected["runtime_id"],
            "model_id": expected["model_id"],
            "simulated": False,
        },
        "elapsedMs": result["elapsed_ms"],
    }


def classify_transport_outcome(outcome):
    """Mirror of ``classifyTransportOutcome`` (lines 38-41 of the reference)."""
    if outcome not in ("timeout", "cancelled", "connection_lost"):
        raise InvalidEifContract()
    return {"status": "uncertain", "automaticRetry": False, "remoteStopped": False}


def reference_source():
    """Read the pinned reference, refusing a copy whose digest does not match."""
    data = REFERENCE.read_bytes()
    if hashlib.sha256(data).hexdigest() != REFERENCE_SHA256:
        raise AssertionError("pinned reference source digest does not match PROVENANCE")
    return data.decode("utf-8")


def _return_object_fields(source, function_name):
    match = re.search(
        r"export function " + function_name + r"\([^)]*\)\s*\{(.*?)return \{(.*?)\};",
        source,
        re.S,
    )
    if match is None:
        raise AssertionError(f"{function_name} return object not found in reference")
    fields = []
    for part in match.group(2).split(","):
        name = part.split(":", 1)[0].strip()
        if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
            fields.append(name)
    return tuple(fields)


def declared_cpu_task_fields():
    """Fields of the object literal ``encodeCpuTask`` actually returns."""
    return _return_object_fields(reference_source(), "encodeCpuTask")


def declared_placement_fields():
    """Fields of the nested ``placement`` object in ``encodeBoundCpuTask``."""
    match = re.search(r"placement: \{(.*?)\}", reference_source(), re.S)
    if match is None:
        raise AssertionError("placement object not found in reference")
    fields = []
    for part in match.group(1).split(","):
        name = part.split(":", 1)[0].strip()
        if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
            fields.append(name)
    return tuple(fields)

# Modified by AIPSTER local patch 0002 (2026-11-01): adds an opt-in
# require_resident execution guard (checked under the runtime lane before any
# load) and the residency predicate it uses. Upstream base and hashes:
# local-worker/provenance.json.
import asyncio
import time
import uuid
from abc import ABC, abstractmethod
from contextlib import asynccontextmanager

from dendrite.cache import PrefixCache
from dendrite.config import ModelConfig, NodeConfig, RuntimeConfig
from dendrite.hardware import file_identity
from dendrite.schemas import ExecuteRequest


class RuntimeFailure(Exception):
    def __init__(self, detail: str, status_code: int = 503):
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code


class Runtime(ABC):
    def __init__(self, config: RuntimeConfig, node: NodeConfig):
        self.config = config
        self.node = node
        self.lock = asyncio.Lock()
        self.state = "unloaded"
        self.loaded_model: ModelConfig | None = None
        self.fingerprint: str | None = None
        self.instance = str(uuid.uuid4())
        self.cache = PrefixCache(node.cache_ttl_seconds)
        self.last_error: str | None = None
        self.closing = False

    @property
    def simulated(self) -> bool:
        return self.config.kind == "mock"

    def model_fingerprint(self, model: ModelConfig) -> str | None:
        if self.simulated:
            return "simulated:" + model.id
        return file_identity(model.path)["fingerprint"]

    def reset(self):
        self.loaded_model = None
        self.fingerprint = None
        self.instance = str(uuid.uuid4())
        self.cache.clear()
        self.state = "unloaded"

    @asynccontextmanager
    async def lane(self):
        if self.closing:
            raise RuntimeFailure(f"Runtime {self.config.id} is shutting down")
        # No await between the check and uncontended acquire: no hidden request queue.
        if self.lock.locked():
            raise RuntimeFailure(f"Runtime {self.config.id} is busy", 429)
        await self.lock.acquire()
        try:
            yield
        finally:
            self.lock.release()

    def is_resident(self, model: ModelConfig) -> bool:
        """True when this exact model is already serving here, with no load needed."""
        if self.loaded_model != model or self.state not in ("ready", "generating"):
            return False
        if getattr(self, "quarantined", False):
            return False
        if self.config.mode == "managed" and self.config.kind != "mock":
            process = getattr(self, "process", None)
            if process is None or process.returncode is not None:
                return False
            # ensure_loaded would restart on a changed file identity; refuse that
            # under fabric admission instead of performing a hidden cold start.
            identity = file_identity(model.path)
            return bool(identity["cached_on_disk"] and identity["fingerprint"] == self.fingerprint)
        return True

    async def execute(
        self, model: ModelConfig, request: ExecuteRequest, *, require_resident: bool = False
    ) -> dict:
        async with self.lane():
            self.validate_request(request)
            if require_resident and not self.is_resident(model):
                # Rechecked under the lane, immediately before any ensure_loaded:
                # fabric work never cold-starts, switches models or falls back.
                raise RuntimeFailure(
                    f"Model {model.id} is not resident on runtime {self.config.id}", 409
                )
            started = time.monotonic()
            try:
                async with asyncio.timeout(self.node.request_timeout_seconds):
                    await self.ensure_loaded(model)
                    self.state = "generating"
                    candidate = self.cache.matches(request.prefix, self.instance, self.fingerprint)
                    self.cache.clear()  # In-flight slot state must not be advertised as reusable.
                    result = await self.generate(request)
                    if self.config.mode == "managed" and not result.get("truncated", False):
                        self.cache.record(
                            request.prefix, self.instance, self.fingerprint, self.simulated
                        )
                    self.state = "ready"
                    self.last_error = None
                    return {
                        "content": result["content"],
                        "simulated": self.simulated,
                        "elapsed_ms": round((time.monotonic() - started) * 1000, 2),
                        "usage": result.get("usage", {}),
                        "cache": {
                            "candidate_before_request": candidate,
                            "reuse_attempted": True,
                            "reported_cached_tokens": result.get("cached_tokens"),
                            "portable": False,
                            "simulated": self.simulated,
                        },
                    }
            except BaseException as exc:
                # Cancellation/timeout may leave a native generation active. Managed adapters
                # stop the owned process; attached adapters quarantine themselves instead.
                await self.abort()
                if isinstance(exc, asyncio.CancelledError):
                    self.last_error = "Request cancelled"
                elif require_resident:
                    # Never retain prompt-bearing backend exception text for a
                    # fabric job: the local snapshot and control-plane heartbeat
                    # can re-expose last_error outside the fabric path.
                    self.last_error = "Fabric request failed"
                else:
                    self.last_error = str(exc)
                self.state = "error"
                if isinstance(exc, TimeoutError):
                    raise RuntimeFailure("Inference deadline exceeded", 504) from exc
                raise

    async def load(self, model: ModelConfig):
        async with self.lane():
            try:
                await self.ensure_loaded(model)
                self.last_error = None
            except BaseException:
                await self.abort()
                self.state = "error"
                raise

    async def unload(self):
        async with self.lane():
            if self.config.mode == "attach":
                raise RuntimeFailure("Cannot unload a runtime owned by another process", 409)
            await self.stop()

    def snapshot(self) -> dict:
        return {
            "id": self.config.id,
            "kind": self.config.kind,
            "mode": self.config.mode,
            "state": self.state,
            "busy": self.lock.locked(),
            "simulated": self.simulated,
            "loaded_model": self.loaded_model.id if self.loaded_model else None,
            "runtime_instance": self.instance,
            "model_fingerprint": self.fingerprint,
            "prefix_cache": self.cache.snapshot(),
            "last_error": self.last_error,
            "supports_model_switch": self.config.mode == "managed",
            "supports_cache_transfer": False,
        }

    @abstractmethod
    async def ensure_loaded(self, model: ModelConfig): ...

    def validate_request(self, request: ExecuteRequest):
        """Reject invalid work before loading or disturbing a resident model."""

    @abstractmethod
    async def generate(self, request: ExecuteRequest) -> dict: ...

    @abstractmethod
    async def stop(self): ...

    async def abort(self):
        await self.stop()

    async def close(self):
        self.closing = True
        # Drain the bounded active request before stopping; no late result can resurrect state.
        async with self.lock:
            await self.stop()

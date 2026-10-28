"""Operator-owned configuration; requests cannot supply paths or subprocess flags."""

# Modified by AIPSTER local patch 0001 (2026-10-28): adds node.allowed_hosts and
# Host/authority canonicalization. Upstream base and hashes: local-worker/provenance.json.

import ipaddress
import tomllib
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, model_validator


LOOPBACK_BIND_HOSTS = ("127.0.0.1", "::1", "localhost")


def canonical_authority(value: str) -> str | None:
    """Return a comparable host[:port] for a Host/Origin authority, or None if malformed."""
    if not value or any(c in value for c in "/?#@\\") or any(c.isspace() for c in value):
        return None
    try:
        parsed = urlsplit("//" + value)
        port = parsed.port
    except ValueError:
        return None
    host = parsed.hostname
    if not host or parsed.netloc != value:
        return None
    if ":" in host:
        if not value.startswith("["):
            return None
        try:
            ipaddress.IPv6Address(host)
        except ValueError:
            return None
        host = "[" + host + "]"
    authority = host if port is None else f"{host}:{port}"
    # Exact canonical form only (no leading-zero ports or other aliases of an allowed value).
    return authority if authority == value.lower() else None


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ModelConfig(StrictModel):
    id: str = Field(min_length=1)
    runtime: str
    capabilities: list[str] = Field(min_length=1)
    path: Path | None = None
    # Attach-only runtimes must match this exact identity in GET /v1/models.
    upstream_model: str | None = None


class RuntimeConfig(StrictModel):
    id: str = Field(min_length=1)
    kind: Literal["ik_llama", "llama_cpp", "mock"]
    mode: Literal["managed", "attach"] = "managed"
    executable: str = "llama-server"
    port: int = Field(default=8081, ge=1, le=65535)
    base_url: str | None = None
    context_size: int = Field(default=4096, ge=128)
    threads: int = Field(default=4, ge=1)
    gpu_layers: int = Field(default=0, ge=0)
    startup_timeout_seconds: float = Field(default=120, gt=0, le=600)
    mock_delay_seconds: float = Field(default=0, ge=0, le=30)

    @model_validator(mode="after")
    def local_endpoint(self):
        if self.mode == "attach":
            parsed = urlsplit(self.base_url or "")
            try:
                local = (
                    parsed.hostname == "localhost"
                    or ipaddress.ip_address(parsed.hostname or "").is_loopback
                )
            except ValueError:
                local = False
            if (
                not local
                or parsed.scheme != "http"
                or parsed.username
                or parsed.password
                or parsed.path not in ("", "/")
                or parsed.query
                or parsed.fragment
            ):
                raise ValueError("Attached runtime must use an http:// loopback origin")
            if self.kind == "mock":
                raise ValueError("Mock runtime does not attach to a real server")
        elif self.base_url:
            raise ValueError("base_url is only used by attach mode")
        return self


class NodeConfig(StrictModel):
    id: str = "dendrite-local"
    host: str = "127.0.0.1"
    port: int = Field(default=8090, ge=1, le=65535)
    token_env: str = "DENDRITE_API_TOKEN"
    state_dir: Path = Path(".dendrite")
    model_dirs: list[Path] = Field(default_factory=list)
    request_timeout_seconds: float = Field(default=180, gt=0, le=900)
    cache_ttl_seconds: float = Field(default=300, gt=0, le=3600)
    control_plane_url: str | None = None
    advertise_url: str | None = None
    heartbeat_seconds: float = Field(default=10, ge=1, le=300)
    fabric_url: str | None = None
    fabric_token_env: str = "GANGLION_FABRIC_TOKEN"
    # Exact Host header values (host[:port]) the API accepts. Empty derives a safe default.
    allowed_hosts: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_allowed_hosts(self):
        for entry in self.allowed_hosts:
            if canonical_authority(entry) is None or "*" in entry:
                raise ValueError(f"allowed_hosts entry {entry!r} must be an exact host[:port]")
        return self

    def _allowed_origins(self) -> set[tuple[str, str]]:
        """(scheme, authority) pairs: explicit allowed_hosts, else derived defaults."""
        if self.allowed_hosts:
            # A bare host[:port] cannot say which scheme a proxy terminates; allow both.
            return {(s, canonical_authority(h)) for h in self.allowed_hosts for s in ("http", "https")}
        origins = set()

        def add(scheme: str, host: str, port: int | None):
            # Clients omit a scheme-default port from Host/Origin, so accept both forms.
            default_port = 443 if scheme == "https" else 80
            origins.add((scheme, host if port is None else f"{host}:{port}"))
            if port in (None, default_port):
                origins.update({(scheme, host), (scheme, f"{host}:{default_port}")})

        if self.host in LOOPBACK_BIND_HOSTS:
            for name in ("127.0.0.1", "localhost", "[::1]"):
                add("http", name, self.port)  # the daemon itself serves plain HTTP
            return origins
        if self.advertise_url:
            url = urlsplit(self.advertise_url)
            authority = canonical_authority(url.netloc)
            if authority:
                add(url.scheme, authority if url.port is None else authority.rsplit(":", 1)[0], url.port)
        try:
            address = ipaddress.ip_address(self.host)
        except ValueError:
            address = None
        if address and not address.is_unspecified:
            add("http", f"[{address}]" if address.version == 6 else str(address), self.port)
        return origins

    def effective_allowed_hosts(self) -> frozenset[str]:
        """Exact Host header values the API accepts."""
        return frozenset(authority for _, authority in self._allowed_origins())

    def effective_allowed_origins(self) -> frozenset[str]:
        """Exact browser Origin values (scheme://authority) the API accepts."""
        return frozenset(f"{scheme}://{authority}" for scheme, authority in self._allowed_origins())

    @model_validator(mode="after")
    def validate_fabric_origin(self):
        if self.fabric_url:
            url = urlsplit(self.fabric_url)
            local = url.hostname in ("localhost", "127.0.0.1", "::1")
            if (
                url.scheme not in ("http", "https")
                or not url.hostname
                or url.username
                or url.password
                or url.query
                or url.fragment
                or url.path not in ("", "/")
                or (url.scheme == "http" and not local)
            ):
                raise ValueError("fabric_url requires an HTTPS origin (HTTP only on loopback)")
        return self


class Config(StrictModel):
    node: NodeConfig = Field(default_factory=NodeConfig)
    runtimes: list[RuntimeConfig] = Field(min_length=1)
    models: list[ModelConfig] = Field(min_length=1)

    @model_validator(mode="after")
    def references(self):
        runtime_ids = [r.id for r in self.runtimes]
        if len(set(runtime_ids)) != len(runtime_ids):
            raise ValueError("Runtime IDs must be unique")
        if len({m.id for m in self.models}) != len(self.models):
            raise ValueError("Model IDs must be unique")
        ports = [r.port for r in self.runtimes if r.mode == "managed" and r.kind != "mock"]
        if len(set(ports)) != len(ports) or self.node.port in ports:
            raise ValueError("Managed runtimes and daemon must use distinct ports")
        for model in self.models:
            if model.runtime not in runtime_ids:
                raise ValueError(f"Unknown runtime {model.runtime} for model {model.id}")
            runtime = next(r for r in self.runtimes if r.id == model.runtime)
            if runtime.kind != "mock" and runtime.mode == "managed" and not model.path:
                raise ValueError(f"Managed model {model.id} needs a GGUF path")
            if runtime.mode == "attach" and not model.upstream_model:
                raise ValueError(f"Attached model {model.id} needs upstream_model identity")
        return self


def load_config(path: Path) -> Config:
    path = path.resolve()
    config = Config.model_validate(tomllib.loads(path.read_text()))
    config.node.state_dir = (path.parent / config.node.state_dir).resolve()
    config.node.model_dirs = [(path.parent / p).resolve() for p in config.node.model_dirs]
    for model in config.models:
        if model.path:
            model.path = (path.parent / model.path).resolve()
    for runtime in config.runtimes:
        if "/" in runtime.executable:
            runtime.executable = str((path.parent / runtime.executable).resolve())
    return config

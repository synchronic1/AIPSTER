"""Shared first-run setup for the installed worker (console + tray entries).

Creates the per-user data directory (config, token, state, logs), generates a
strong API token on first run stored user-ACL-only, and injects it via the
configured env var. The token value is never printed or logged.
"""
import os
import secrets
import sys
import tempfile
from pathlib import Path

APP_NAME = "AIPSTER-Worker"
TOKEN_BYTES = 32  # token_urlsafe(32) -> 43 chars; worker requires >= 32 printable ASCII
MIN_TOKEN_LENGTH = 32

# First-run honesty (GOOSE-REAL-WORKER-DELIVERY-0811, packaging lane only).
# The default config selects the mock engine, which is an explicit
# test/demo option: fresh first-run stays setup-required/unqualified until
# a real configured runtime is selected. Classification is metadata-only
# (loaded runtimes/models); it never downloads models or binaries, never
# starts or stops a runtime, never copies credentials, and never changes
# enrollment. The native IK adapter (ik_llama) stays a supported choice.
SETUP_REQUIRED = "setup-required"
READY = "ready"
MOCK_KIND = "mock"
SUPPORTED_MANAGED_KINDS = ("ik_llama", "llama_cpp")
PLACEHOLDER_MODEL_MARKER = "replace-with-your-model"


def supported_configuration_guidance():
    """Explicit supported-configuration guidance (no automatic selection)."""
    return ("Supported configurations: native ik_llama managed runtime with a "
            "real GGUF model file (set the [[models]] path yourself), or "
            "llama_cpp managed with a real GGUF / attach with an "
            "upstream_model on a loopback server you run yourself. The mock "
            "runtime is a test/demo option only and never counts as "
            "operational. To select: edit config.toml yourself; this worker "
            "never downloads models, starts runtimes, copies credentials, "
            "or changes enrollment automatically.")


def classify_runtime_selection(loaded):
    """Classify a loaded worker config as ready or setup-required.

    Accepts the vendored dendrite Config or any fixture object exposing
    .runtimes (with .id/.kind, optional .mode) and .models (with .id/
    .runtime, optional .path/.upstream_model). Never raises: an
    unreadable selection is setup-required. Returns {"status", "mock_only",
    "reason", "guidance"}.
    """
    try:
        runtimes = list(getattr(loaded, "runtimes", None) or [])
        models = list(getattr(loaded, "models", None) or [])
    except TypeError:
        runtimes, models = [], []
    guidance = supported_configuration_guidance()
    if not runtimes or not models:
        return {"status": SETUP_REQUIRED, "mock_only": False,
                "reason": "no runtimes/models are configured",
                "guidance": guidance}
    by_id = {getattr(r, "id", None): r for r in runtimes}
    mock_only = all(getattr(r, "kind", None) == MOCK_KIND for r in runtimes)
    if mock_only:
        return {"status": SETUP_REQUIRED, "mock_only": True,
                "reason": ("mock runtime is a test/demo option only; "
                           "select a real configured runtime to operate"),
                "guidance": guidance}
    for model in models:
        runtime = by_id.get(getattr(model, "runtime", None))
        if runtime is None:
            continue
        kind = getattr(runtime, "kind", None)
        if kind == MOCK_KIND or kind not in SUPPORTED_MANAGED_KINDS:
            continue
        if getattr(runtime, "mode", "managed") == "attach":
            if getattr(model, "upstream_model", None):
                return {"status": READY, "mock_only": False,
                        "reason": (f"attached runtime "
                                   f"{getattr(runtime, 'id', '?')!r} serves model "
                                   f"{getattr(model, 'id', '?')!r}"),
                        "guidance": guidance}
            continue
        path = getattr(model, "path", None)
        if not path:
            continue
        if PLACEHOLDER_MODEL_MARKER in str(path):
            continue
        if Path(str(path)).exists():
            return {"status": READY, "mock_only": False,
                    "reason": (f"managed runtime "
                               f"{getattr(runtime, 'id', '?')!r} serves model "
                               f"{getattr(model, 'id', '?')!r}"),
                    "guidance": guidance}
    return {"status": SETUP_REQUIRED, "mock_only": False,
            "reason": ("no real model is configured; install a GGUF model "
                       "file yourself (never downloaded automatically) and "
                       "point a real runtime at it in config.toml"),
            "guidance": guidance}


def setup_detail(loaded):
    """Honest first-run detail: '' when ready, else a setup-required line."""
    result = classify_runtime_selection(loaded)
    if result["status"] == READY:
        return ""
    return f"setup required: {result['reason']}"


def first_run_ready(loaded):
    """True only when a real configured runtime is selected (else no auto-start)."""
    return classify_runtime_selection(loaded)["status"] == READY


MOCK_DEMO_ENV = "AIPSTER_WORKER_MOCK_DEMO"


def mock_demo_elected():
    """Operator-explicit test/demo election for the mock engine.

    Read live from the environment so lab/qualify harnesses elect it per
    launch. Silent auto-start never elects it: only an explicit =="1"
    counts, and it only ever applies to a mock-only selection.
    """
    return os.environ.get(MOCK_DEMO_ENV) == "1"


def explicit_demo_ready(loaded):
    """True only for an explicitly elected mock-demo selection (never silent)."""
    return bool(mock_demo_elected()
                and classify_runtime_selection(loaded)["mock_only"])


def runtime_note(loaded):
    """State detail for a loaded config: '' when ready, test/demo when the
    mock engine was explicitly elected, else the setup-required line."""
    result = classify_runtime_selection(loaded)
    if result["status"] == READY:
        return ""
    if result["mock_only"] and mock_demo_elected():
        return (f"test/demo: mock engine explicitly elected via "
                f"{MOCK_DEMO_ENV}=1 (not operational)")
    return f"setup required: {result['reason']}"


def bundle_dir():
    """Directory holding the frozen exes (or the source tree in dev)."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent / "windows"


def data_dir():
    override = os.environ.get("AIPSTER_WORKER_DATA")
    if override:
        return Path(override)
    local = os.environ.get("LOCALAPPDATA")
    if not local:
        raise SystemExit("aipster: LOCALAPPDATA is not set; cannot locate the data directory")
    return Path(local) / APP_NAME


def token_is_strong(value):
    return bool(value) and len(value) >= MIN_TOKEN_LENGTH and all("!" <= c <= "~" for c in value)


def _private_path(path, directory=False, verify=False, created=False):
    """Owned, unlinked storage; Windows ACLs use the process SID, never USERNAME."""
    path = Path(path)
    if path.is_symlink() or getattr(path, "is_junction", lambda: False)():
        raise OSError("linked worker storage is refused")
    if os.name != "nt":
        if path.stat().st_uid != os.getuid():
            raise OSError("worker storage belongs to another user")
        if verify:
            return not bool(path.stat().st_mode & 0o077)
        path.chmod(0o700 if directory else 0o600)
        return True
    if not getattr(sys, "frozen", False):
        # The canonical stdlib helper also serves the standalone worker.
        source_root = str(Path(__file__).resolve().parents[2])
        if source_root not in sys.path:
            sys.path.insert(0, source_root)
    from private_storage_win32 import protect_path
    return protect_path(path, directory=directory, verify=verify, new=created)



def restrict_file(path, *, created=False):
    return _private_path(path, created=created)


def private_directory(path):
    path = Path(path)
    try:
        path.mkdir(parents=True)  # Exclusive creation proves new-path ownership provenance.
        created = True
    except FileExistsError:
        created = False
    if not _private_path(path, directory=True, created=created):
        raise OSError("cannot establish private worker directory")


def private_child_directory(data, name):
    """Harden a child of a just-verified user-only data dir.

    Fresh children are created with proven-new provenance. A pre-existing
    child owned by the process's default owner (e.g. Administrators-owned
    state/logs left by builds that plain-mkdir'd them) is normalized to
    user-only: inside a just-verified user-only parent only this user (or
    an administrator, outside the threat boundary) could have created it,
    links are still refused, and any other owner still fails closed.
    """
    path = Path(data) / name
    try:
        path.mkdir()
    except FileExistsError:
        pass
    if not _private_path(path, directory=True, created=True):
        raise OSError("cannot establish private worker directory")


def private_token_acl(path):
    """Read-only verification for qualification: SID-based and locale-independent."""
    try:
        return _private_path(path, verify=True)
    except OSError:
        return False


def ensure_private_token(path):
    path = Path(path)
    try:
        private_directory(path.parent)
        return _ensure_private_token(path)
    except OSError as exc:
        raise SystemExit("aipster: cannot establish private token storage; no worker started") from exc


def _ensure_private_token(path):
    if path.exists():
        if not restrict_file(path):
            raise OSError("cannot establish private token ACL")
        value = path.read_text(encoding="utf-8").strip()
        if not token_is_strong(value):
            raise SystemExit(
                f"aipster: {path} does not hold a strong token (>= 32 printable "
                "ASCII characters). Delete it (or run `aipster-worker --rotate-token`) "
                "to generate a fresh one on next start.")
        return value, False
    value = secrets.token_urlsafe(TOKEN_BYTES)
    fd, temp = tempfile.mkstemp(prefix=".api-token-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            if not restrict_file(temp, created=True):
                raise OSError("cannot establish private token ACL")
            handle.write(value + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        try:
            # Publish without overwriting a concurrent first-run winner.
            os.link(temp, path)
        except FileExistsError:
            return _ensure_private_token(path)
        return value, True
    finally:
        Path(temp).unlink(missing_ok=True)


def ensure_setup(data):
    """Create data dirs + default config. Returns (config_path, fresh_config)."""
    private_directory(data)
    private_child_directory(data, "state")
    private_child_directory(data, "logs")
    config = data / "config.toml"
    fresh_config = False
    if not config.exists():
        template = bundle_dir() / "default.toml"
        config.write_text(template.read_text(encoding="utf-8"), encoding="utf-8")
        fresh_config = True
    return config, fresh_config


def build_info():
    try:
        import json
        info = json.loads((bundle_dir() / "BUILD.json").read_text(encoding="utf-8"))
        return f"{info.get('worker_name', 'ganglion-dendrite')} {info.get('worker_version', '?')}" \
            f" (installer build {info.get('installer_build', '?')}, {info.get('source_sha', '?')[:7]})"
    except (OSError, ValueError):
        return "AIPSTER Worker (development bundle)"

"""One-time worker pairing + heartbeat sender for AIPSTER onboarding.

Protocol: docs/pairing.md and docs/heartbeat-intake.md. Standard library
only, so the installed launcher can freeze this module without new
dependencies and source installs can run it with any Python >= 3.11.

Flow:
  1. `pairing.py pair` — the user types the one-time code shown in the
     signed-in dashboard; the worker exchanges it for a resource row plus
     a resource-bound heartbeat key. The code itself is the account-linking
     approval: it can only be minted in an authenticated browser session.
  2. Credentials land in the user-private data dir (0600 + Windows user ACL)
     and are never printed, logged, or placed in URLs.
  3. `pairing.py heartbeat-loop` posts bounded reachability heartbeats.
     A heartbeat proves reachability, never inference readiness.

This module never serves inbound traffic and never touches the daemon's
loopback port: pairing is an outbound client (HTTPS, or loopback HTTP for
local tests only).
"""

import argparse
import contextlib
import getpass
import hashlib
import hmac
import http.client
import json
import os
import platform
import re
import secrets
import shutil
import socket
import sys
import tempfile
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, build_opener, HTTPRedirectHandler

try:
    import msvcrt
except ImportError:  # POSIX: flock path below
    msvcrt = None
try:
    import fcntl
except ImportError:  # Windows: msvcrt path above
    fcntl = None

from private_storage_win32 import protect_path

DEFAULT_API_BASE = "https://aipster.net"
REQUEST_TIMEOUT_SEC = 15
# Product User-Agent (chain-release smoke, 2026-10-30): the API edge denies
# default scripting UAs (Cloudflare 1010), so every sender request identifies
# the worker explicitly. Verified live against /api/pairing/claim.
USER_AGENT = "AIPSTER-worker/1.0"
# Pair-mutex bound (Muse W3 round 11). A pair holds the lock across one
# claim (single bounded request) plus two local writes: seconds.
PAIR_LOCK_TIMEOUT_SEC = 180
HEARTBEAT_INTERVAL_SEC = 60
HEARTBEAT_MIN_INTERVAL_SEC = 30  # above the 25s server window + skew
MAX_ATTEMPTS_NETWORK = 5
STATUS_STALE_SEC = 5 * 60
PRIVATE_DIR_SETTLE_SEC = 2  # concurrent creator still normalizing its new directory

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_PAIRING_REJECTED = 3
EXIT_REPAIR_REQUIRED = 4
EXIT_NETWORK = 5
EXIT_SENDER_RUNNING = 6


class PairingError(Exception):
    """A failed pairing/heartbeat call. Never carries secret material."""

    def __init__(self, status, code, message, retry_after=None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.retry_after = retry_after


class RePairRequired(PairingError):
    """The stored sender key is revoked/expired: pair again with a new code."""


def check_api_base(raw):
    """Validate the API base. http is allowed for loopback test targets only."""
    try:
        parsed = urlparse(raw)
    except ValueError as exc:
        raise PairingError(None, "BAD_API_BASE", f"invalid API base: {exc}")
    if "@" in (parsed.netloc or ""):
        raise PairingError(None, "BAD_API_BASE", "credentials in the API base URL are refused")
    host = (parsed.hostname or "").lower()
    if parsed.scheme == "https" and host:
        return raw.rstrip("/")
    if parsed.scheme == "http" and host in ("127.0.0.1", "localhost", "::1"):
        return raw.rstrip("/")
    raise PairingError(None, "BAD_API_BASE",
                        "API base must be https, or http loopback for local tests")


def default_data_dir():
    override = os.environ.get("AIPSTER_WORKER_DATA")
    if override:
        return Path(override)
    if os.name == "nt":
        local = os.environ.get("LOCALAPPDATA")
        if not local:
            raise PairingError(None, "NO_DATA_DIR",
                               "LOCALAPPDATA is not set; cannot locate the data directory")
        return Path(local) / "AIPSTER-Worker"
    return Path.home() / ".local" / "share" / "aipster-worker"


def _restrict_path(path, directory=False, *, new=False):
    """Establish private access; only exclusive creation permits new ownership."""
    path = Path(path)
    try:
        if path.is_symlink() or getattr(path, "is_junction", lambda: False)():
            raise OSError("linked worker state")
        if path.is_dir() != directory:
            raise OSError("unexpected worker state type")
        if os.name == "nt":
            protect_path(path, directory=directory, new=new)
        else:
            if path.stat().st_uid != os.getuid():
                raise OSError("worker state belongs to another user")
            os.chmod(path, 0o700 if directory else 0o600)
        return True
    except OSError as exc:
        raise PairingError(None, "PRIVATE_STORAGE", "cannot establish user-only worker storage") from exc


def restrict_file(path, *, new=False):
    return _restrict_path(path, new=new)


def private_dir(path):
    path = Path(path)
    try:
        path.mkdir(mode=0o700)
        created = True
    except FileNotFoundError:
        private_dir(path.parent)
        return private_dir(path)
    except FileExistsError:
        created = False
    if created:
        if not _restrict_path(path, directory=True, new=True):
            raise PairingError(None, "PRIVATE_STORAGE", "cannot establish user-only worker storage")
        return path
    # Another process may have created the directory an instant ago and still
    # be replacing the token's default owner (e.g. Administrators on an
    # elevated token) with the user. Only that exact state is waited out,
    # briefly; any other owner fails on the first check, and the final check
    # is the same strict one, so nothing is adopted or loosened.
    deadline = time.monotonic() + PRIVATE_DIR_SETTLE_SEC
    while True:
        try:
            if _restrict_path(path, directory=True, new=False):
                return path
            raise PairingError(None, "PRIVATE_STORAGE", "cannot establish user-only worker storage")
        except PairingError as exc:
            if not _creator_still_settling(exc.__cause__) or time.monotonic() >= deadline:
                raise
            time.sleep(0.05)


def _creator_still_settling(cause):
    """True only while a new directory still carries this process's default owner."""
    default_owner = getattr(cause, "default_owner_sid", "unavailable")
    return (getattr(cause, "reason", None) == "owner-mismatch"
            and default_owner not in ("unavailable", getattr(cause, "user_sid", None))
            and getattr(cause, "owner_sid", None) == default_owner)


def write_private(path, text):
    """Atomic publication: protect an exclusively new empty file before bytes."""
    path = Path(path)
    private_dir(path.parent)
    if path.exists() and not restrict_file(path):
        raise PairingError(None, "PRIVATE_STORAGE", "cannot establish user-only worker storage")
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            if not restrict_file(tmp, new=True):
                raise PairingError(None, "PRIVATE_STORAGE", "cannot establish user-only worker storage")
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def ensure_private_dir(path):
    """Compatibility name for the fail-closed private directory writer."""
    return private_dir(path)


def check_private_store(data_dir, key_path=None):
    """Verify without repairing a credential-routing manifest or selected key."""
    data = Path(data_dir)
    paths = [path for path in [data, data / "pairing.json", key_path] if path is not None and path.exists()]
    try:
        for path in paths:
            if path.is_symlink() or getattr(path, "is_junction", lambda: False)():
                raise OSError("linked store")
            if os.name == "nt":
                protect_path(path, directory=path == data, verify=True)
            elif path.stat().st_uid != os.getuid() or path.stat().st_mode & 0o077:
                raise OSError("shared store")
    except OSError as exc:
        raise PairingError(None, "BAD_PAIRING_STORE", "worker storage is not user-private; fix permissions or re-pair") from exc


def load_or_create_node_id(state_dir):
    """Stable worker identity (1..64 id chars), created once and kept."""
    state_dir = Path(state_dir)
    private_dir(state_dir)
    node_file = state_dir / "node-id"
    if node_file.exists():
        if not restrict_file(node_file):
            raise PairingError(None, "PRIVATE_STORAGE", "cannot establish user-only worker storage")
        value = node_file.read_text(encoding="utf-8").strip()
        if value and len(value) <= 64 and all(c.isalnum() or c in "-_" for c in value):
            return value
        raise PairingError(None, "BAD_NODE_ID",
                           f"{node_file} does not hold a valid node id; "
                           "delete it to generate a fresh one on next pair")
    # First-pair creation is exclusive: the id is fully written to a private
    # temp file, then hard-linked into place, which fails if another racer
    # already published one. Losers read the winner's complete file, so
    # concurrent first pairs converge on one identity and never overwrite it.
    value = "n_" + secrets.token_hex(16)
    fd, tmp = tempfile.mkstemp(dir=str(state_dir), prefix="node-id.")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            if not restrict_file(tmp, new=True):
                raise PairingError(None, "PRIVATE_STORAGE", "cannot establish user-only worker storage")
            handle.write(value + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.link(tmp, node_file)
        except FileExistsError:
            return load_or_create_node_id(state_dir)
        except OSError as exc:
            # No hard links here: refuse rather than fall back to a
            # non-exclusive replace that could overwrite a racer's identity.
            raise PairingError(None, "PRIVATE_STORAGE",
                               "worker storage does not support exclusive node-id creation") from exc
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass
    return value


def probe_hardware(config_path=None):
    """Conservative capability discovery. Never claims what it cannot see.

    With the installed worker importable, hardware comes from dendrite's own
    discovery plus the configured models' capabilities. Otherwise (plain
    interpreter, tests) platform fallbacks apply and capabilities stay empty.
    GPU is reported only with positive evidence; mock engines contribute no
    capabilities because simulated execution is not real capacity.
    """
    snapshot = {
        "name": platform.node() or "worker",
        "kind": "local",
        "cpu": platform.processor() or "unknown",
        "gpu": "none recorded",
        "capabilities": [],
    }
    try:
        from dendrite.hardware import discover_hardware
    except ImportError:
        return snapshot
    try:
        hw = discover_hardware()
    except Exception:
        return snapshot
    gpus = hw.get("gpus") or []
    if gpus:
        first = gpus[0]
        snapshot["gpu"] = str(first.get("name") or "gpu")
    if hw.get("cpu"):
        snapshot["cpu"] = str(hw["cpu"])[:80]
    if config_path:
        try:
            from dendrite.config import load_config
            config = load_config(Path(config_path))
            kinds = {}
            for runtime in getattr(config, "runtimes", []) or []:
                kinds[getattr(runtime, "id", None)] = getattr(runtime, "kind", "")
            caps = []
            for model in getattr(config, "models", []) or []:
                # Per-model filtering (Codex P2): a mixed config must not
                # advertise mock-backed models as real capacity, and models
                # on unknown runtimes claim nothing.
                if kinds.get(getattr(model, "runtime", None), "mock") == "mock":
                    continue
                for cap in getattr(model, "capabilities", []) or []:
                    if cap not in caps:
                        caps.append(str(cap))
            snapshot["capabilities"] = caps[:20]
        except Exception:
            snapshot["capabilities"] = []
    return snapshot


def decide_usable(config_path=None):
    """Heartbeat usable-bit policy. False unless real capacity is verified.

    Mock/simulated engines always report usable=false: the worker is
    reachable but explicitly not acceptable for inference. A real engine
    reports true only when a configured non-mock runtime has a usable model
    (attached and ready, or GGUF magic on disk plus its executable on PATH).
    Anything uncertain — missing config, missing worker install, load
    failure — is false. Reachability is reported by the beat itself.
    """
    if not config_path:
        return False
    try:
        from dendrite.config import load_config
        from dendrite.hardware import file_identity
    except ImportError:
        return False
    try:
        config = load_config(Path(config_path))
    except Exception:
        return False
    runtimes = {r.id: r for r in getattr(config, "runtimes", []) or []}
    if not runtimes or all(getattr(r, "kind", "") == "mock" for r in runtimes.values()):
        return False
    for model in getattr(config, "models", []) or []:
        runtime = runtimes.get(getattr(model, "runtime", None))
        if runtime is None or getattr(runtime, "kind", "") == "mock":
            continue
        if getattr(runtime, "mode", "") == "attach":
            continue  # attach readiness needs a live daemon probe; stay false
        path = getattr(model, "path", None)
        executable = getattr(runtime, "executable", None)
        try:
            cached = bool(path and file_identity(path)["cached_on_disk"])
        except Exception:
            cached = False
        if cached and executable and shutil.which(str(executable)):
            return True
    return False


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        # Never forward the bearer or the pairing code, including on a TLS
        # downgrade or a same-origin redirect. Use the configured API directly.
        return None


def edge_block_marker(status, raw, content_type):
    """Sanitized diagnosis for a non-JSON HTTP error body. Never echoes bytes.

    An edge/CDN/proxy refusal (e.g. Cloudflare HTML on 403) carries no API
    payload; reporting only the status left users with a generic
    CLAIM_FAILED. The marker names the status plus a fixed content class
    derived from the Content-Type header and the first non-space byte, and
    hints at the pre-API block. Response bytes are never included.
    """
    claimed = (content_type or "").split(";")[0].strip().lower()
    first = raw.lstrip()[:1]
    if "html" in claimed or first == "<":
        kind = "HTML"
    elif "json" in claimed:
        kind = "unparseable JSON"
    elif "text" in claimed or (first and first.isprintable()):
        kind = "text"
    elif not raw.strip():
        kind = "empty"
    else:
        kind = "binary"
    return {
        "code": "EDGE_BLOCKED",
        "error": (f"API refused with a non-JSON {kind} error page "
                  f"(HTTP {status}); the request was blocked before reaching "
                  f"the API (edge or proxy). Update the worker and retry; "
                  f"no response content is shown."),
    }


def post_json(url, payload, secret=None, timeout=REQUEST_TIMEOUT_SEC):
    """POST JSON, returning (status, body-dict, retry-after)."""
    data = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json", "User-Agent": USER_AGENT}
    if secret is not None:
        headers["Authorization"] = "Bearer " + secret
    request = Request(url, data=data, headers=headers, method="POST")
    try:
        with build_opener(NoRedirects()).open(request, timeout=timeout) as response:
            status = response.status
            raw = response.read().decode("utf-8", "replace")
            retry_after = response.headers.get("Retry-After")
            content_type = response.headers.get("Content-Type")
    except HTTPError as exc:
        try:
            if 300 <= exc.code < 400:
                raise PairingError(None, "REDIRECT_BLOCKED", "API redirects are refused")
            raw = exc.read().decode("utf-8", "replace")
            status = exc.code
            retry_after = exc.headers.get("Retry-After") if exc.headers else None
            content_type = exc.headers.get("Content-Type") if exc.headers else None
        except (http.client.HTTPException, OSError) as fault:
            raise PairingError(None, "NETWORK", "incomplete API response") from fault
        finally:
            exc.close()
    except (URLError, TimeoutError, socket.timeout, OSError, http.client.HTTPException) as exc:
        # A truncated response belongs to the same bounded transport backoff.
        raise PairingError(None, "NETWORK", "API transport failed") from exc
    parsed = True
    try:
        body = json.loads(raw) if raw.strip() else {}
    except ValueError:
        body = {}
        parsed = False
    if not isinstance(body, dict):
        body = {}
        parsed = False
    if not parsed and status >= 400:
        # Error statuses without an API payload are edge/proxy refusals, not
        # API verdicts: surface the sanitized marker instead of a bare {} that
        # callers would render as a generic CLAIM_FAILED/HEARTBEAT_FAILED.
        body = edge_block_marker(status, raw, content_type)
    retry_sec = None
    for candidate in (body.get("retryAfterSec"), retry_after):
        try:
            retry_sec = max(1, int(candidate))
            break
        except (TypeError, ValueError):
            continue
    return status, body, retry_sec


def claim(api_base, code, node_id, hardware):
    """Exchange a one-time code for {resource_id, heartbeat key, ...}."""
    base = check_api_base(api_base)
    payload = {"code": code, "nodeId": node_id}
    for key in ("name", "kind", "cpu", "gpu", "capabilities"):
        if hardware.get(key) not in (None, "", []):
            payload[key] = hardware[key]
    status, body, retry_after = post_json(base + "/api/pairing/claim", payload)
    err = body.get("code") or "CLAIM_FAILED"
    msg = body.get("error") or f"claim failed (HTTP {status})"
    if status in (200, 201):
        if not body.get("resourceId") or not body.get("heartbeatKey"):
            raise PairingError(status, "BAD_CLAIM_RESPONSE", "claim response lacks resource or key")
        return body
    if status == 404:
        raise PairingError(status, err, msg)
    if status == 410:
        raise PairingError(status, err, msg)
    if status == 409:
        raise PairingError(status, err, msg)
    if status == 429:
        raise PairingError(status, err, msg, retry_after)
    raise PairingError(status, err, msg)


def send_heartbeat(api_base, resource_id, secret, usable):
    """Post one reachability beat. Returns the parsed response body."""
    base = check_api_base(api_base)
    status, body, retry_after = post_json(
        f"{base}/api/resources/{resource_id}/heartbeat", {"usable": bool(usable)}, secret)
    err = body.get("code") or "HEARTBEAT_FAILED"
    msg = body.get("error") or f"heartbeat failed (HTTP {status})"
    if status == 200:
        return body
    if status == 401 and err in ("KEY_REVOKED", "KEY_EXPIRED"):
        raise RePairRequired(status, err, msg)
    if status == 401:
        raise PairingError(status, err, msg)
    if status == 404:
        raise PairingError(status, err, "resource missing or key bound elsewhere; re-pair")
    if status == 429:
        raise PairingError(status, err, msg, retry_after)
    raise PairingError(status, err, msg)


def pairing_files(data_dir):
    data = Path(data_dir)
    return {
        "meta": data / "pairing.json",
        "key": data / "heartbeat-key.txt",
        "status": data / "state" / "heartbeat-status.json",
    }


def pairing_key_path(data_dir, meta):
    generation = meta.get("key_file")
    if generation is None:
        return pairing_files(data_dir)["key"]  # read-only legacy compatibility
    if not isinstance(generation, str) or not re.fullmatch(r"heartbeat-key\.[a-f0-9]{32}\.txt", generation):
        raise PairingError(None, "BAD_PAIRING_STORE", "invalid pairing key generation; pair again")
    return Path(data_dir) / generation


def managed_key_files(data_dir):
    data = Path(data_dir)
    legacy = data / "heartbeat-key.txt"
    found = [legacy] if legacy.exists() else []
    # os.scandir (unlike Path.glob) propagates directory access errors, so an
    # unreadable store fails loudly instead of silently keeping live keys.
    # Names are filtered exactly before any deletion is attempted.
    with os.scandir(data) as entries:
        for entry in entries:
            if re.fullmatch(r"heartbeat-key\.[a-f0-9]{32}\.txt", entry.name):
                found.append(data / entry.name)
    return found


def load_pairing(data_dir):
    """Load pairing metadata + secret. Raises PairingError when unpaired."""
    check_private_store(data_dir)
    files = pairing_files(data_dir)
    if not files["meta"].exists():
        raise PairingError(None, "NOT_PAIRED", "worker is not paired; run `pair` first")
    try:
        meta = json.loads(files["meta"].read_text(encoding="utf-8"))
        if not isinstance(meta, dict):
            raise ValueError("invalid metadata")
        # Select the key from this one manifest snapshot, never a second read.
        key_file = pairing_key_path(data_dir, meta)
        check_private_store(data_dir, key_file)
        secret = key_file.read_text(encoding="utf-8").strip()
    except (OSError, ValueError) as exc:
        raise PairingError(None, "BAD_PAIRING_STORE", f"pairing store unreadable: {exc}")
    if not meta.get("resource_id") or not meta.get("api_base") or not secret:
        raise PairingError(None, "BAD_PAIRING_STORE", "pairing store is incomplete; pair again")
    fingerprint = meta.get("key_sha256")
    if fingerprint is not None and (not isinstance(fingerprint, str)
            or not re.fullmatch(r"[a-f0-9]{64}", fingerprint)
            or not hmac.compare_digest(fingerprint, hashlib.sha256(secret.encode("utf-8")).hexdigest())):
        raise PairingError(None, "BAD_PAIRING_STORE", "credential files disagree; pair again")
    meta["heartbeat_key"] = secret
    return meta


def pairing_status_binding(meta):
    # Bind legacy flat keys as well as immutable generations. No bearer is
    # persisted in status; its digest also detects a same-resource key rotation.
    selected = {"api_base": meta["api_base"], "resource_id": meta["resource_id"],
                "key_file": meta.get("key_file"),
                "key_sha256": hashlib.sha256(meta["heartbeat_key"].encode("utf-8")).hexdigest()}
    return hashlib.sha256(json.dumps(selected, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()


def write_status(data_dir, payload, meta=None):
    # Heartbeat callers supply the snapshot they actually sent with. Reading
    # the latest manifest here would mislabel an old in-flight response after
    # re-pairing. Two-argument callers bind their current private snapshot.
    selected = load_pairing(data_dir) if meta is None else meta
    files = pairing_files(data_dir)
    record = {**payload, "pairing_generation": pairing_status_binding(selected)}
    write_private(files["status"], json.dumps(record, indent=2) + "\n")


class _SenderLock:
    """Held-open handle on data-dir `sender.lock` for one heartbeat loop.

    The OS releases the handle at process death (including kill -9 /
    Taskkill / crash), so a dead sender never wedges the next start.
    Visibility settles within about a second: a probe immediately after
    a kill may still see the dying holder. The
    file is a marker only: it carries no PID, no credential, and no path,
    and readers must never infer liveness from its mere existence.
    """

    def __init__(self, handle, path):
        self.handle = handle
        self.path = path

    def release(self):
        handle, self.handle = self.handle, None
        if handle is not None:
            try:
                handle.close()
            except OSError:
                pass


def _hold_sender_lock(data_dir):
    """Open (creating) `sender.lock` and take it non-blocking, or None.

    Windows: the open always succeeds and msvcrt.locking on byte 0
    decides, so a stale file from a dead sender is reusable. POSIX: the
    open always succeeds and LOCK_EX|LOCK_NB on the descriptor decides.
    Either way only a live conflicting holder refuses us.
    """
    path = Path(data_dir) / "sender.lock"
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
    except OSError:
        return None
    if os.name == "nt":
        try:
            # Function-level: msvcrt exists on Windows only, and this
            # module imports on every platform.
            import msvcrt
            handle = os.open(str(path), os.O_CREAT | os.O_RDWR, 0o600)
        except (OSError, ImportError):
            return None
        try:
            msvcrt.locking(handle, msvcrt.LK_NBLCK, 1)
        except (OSError, ImportError):
            os.close(handle)
            return None
        try:
            stream = os.fdopen(handle, "r")
        except OSError:
            os.close(handle)
            return None
        return _SenderLock(stream, path)
    try:
        # Function-level: fcntl exists on POSIX only, and this module
        # imports on every platform.
        import fcntl
        handle = open(path, "a+b")
    except (OSError, ImportError):
        return None
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (OSError, ImportError):
        handle.close()
        return None
    return _SenderLock(handle, path)


def sender_lock_held(data_dir):
    """True when another live process currently holds `sender.lock`.

    Never raises on lock mechanics: any uncertainty answers False and the
    caller spawns; the child then reports exit 6 itself, which is the same
    outcome with one extra short-lived process. Never True from a stale
    file: only a live conflicting holder counts.
    """
    path = Path(data_dir) / "sender.lock"
    if os.name == "nt":
        try:
            import msvcrt
            probe = os.open(str(path), os.O_CREAT | os.O_RDWR, 0o600)
        except (OSError, ImportError):
            return False
        try:
            msvcrt.locking(probe, msvcrt.LK_NBLCK, 1)
        except (OSError, ImportError):
            os.close(probe)
            return True
        try:
            msvcrt.locking(probe, msvcrt.LK_UNLCK, 1)
        except OSError:
            pass
        os.close(probe)
        return False
    try:
        import fcntl
        probe = open(path, "a+b")
    except (OSError, ImportError):
        return False
    try:
        fcntl.flock(probe.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (OSError, ImportError):
        probe.close()
        return True
    try:
        fcntl.flock(probe.fileno(), fcntl.LOCK_UN)
    except OSError:
        pass
    probe.close()
    return False

@contextlib.contextmanager
def pair_lock(data_dir):
    """Per-data-directory pair mutex (Muse W3 rounds 11/13).

    Serializes the claim plus the generation and manifest writes so
    concurrent pairs cannot install an already-revoked credential:
    without it, a slow responder's manifest overwrites the winner's
    with its dead key. The lock is OS-held (an msvcrt byte-range lock
    on Windows, a flock elsewhere) on an open descriptor, never
    existence-based: a dead holder's lock is released by the OS on
    process death, so there is no stale-lock deletion path and no
    deletion race. Acquisition waits up to PAIR_LOCK_TIMEOUT_SEC and
    then fails cleanly with PAIR_IN_PROGRESS, never by deleting.
    """
    # The mutex may be the first thing to touch the data directory (unpair or
    # heartbeat before any pair). Provision it privately, not with a bare
    # mkdir that would leave an inherited ACL or the token's default owner
    # that no later creator ever repairs.
    private_dir(data_dir)
    lock = Path(data_dir) / "pair.lock"
    fd = os.open(lock, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        deadline = time.monotonic() + PAIR_LOCK_TIMEOUT_SEC
        while True:
            try:
                _fd_lock_exclusive(fd)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise PairingError(None, "PAIR_IN_PROGRESS",
                                       f"another pair is using {data_dir}; "
                                       "wait for it to finish and retry")
                time.sleep(0.05)
        try:
            yield
        finally:
            _fd_unlock(fd)
    finally:
        os.close(fd)


def _fd_lock_exclusive(fd):
    """Take a non-blocking exclusive lock on fd. Raises OSError when held."""
    if os.name == "nt":
        os.lseek(fd, 0, os.SEEK_SET)  # msvcrt locks from the file position
        msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
    else:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)


def _fd_unlock(fd):
    """Release the lock taken by _fd_lock_exclusive. Never raises."""
    try:
        if os.name == "nt":
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
        else:
            fcntl.flock(fd, fcntl.LOCK_UN)
    except OSError:
        pass


def cmd_pair(args):
    try:
        data_dir = Path(args.data_dir) if args.data_dir else default_data_dir()
        private_dir(data_dir)
        # Retained keys may still authenticate to a previous API origin or be
        # held by an older reader. Keep them, but establish privacy before a
        # claim or success message, not just for the newly published generation.
        for key_file in managed_key_files(data_dir):
            if not restrict_file(key_file):
                raise PairingError(None, "PRIVATE_STORAGE", "cannot establish user-only worker storage")
        if (data_dir / "pairing.json").exists() and not restrict_file(data_dir / "pairing.json"):
            raise PairingError(None, "PRIVATE_STORAGE", "cannot establish user-only worker storage")
        node_id = load_or_create_node_id(data_dir / "state")
        hardware = probe_hardware(args.config)
        if args.name:
            hardware["name"] = args.name[:80]
        code = args.code or getpass.getpass("Pairing code from the AIPSTER dashboard: ").strip()
        if not code:
            print("pairing: no code entered", file=sys.stderr)
            return EXIT_USAGE
        # The claim plus both writes hold the pair mutex (Muse W3 round
        # 11): without it a slow responder's manifest overwrites the
        # winner's with an already-revoked key. The mutex spans the claim
        # plus both credential writes only -- never the human prompt above
        # and never the success prints below.
        with pair_lock(data_dir):
            result = claim(args.api_base, code, node_id, hardware)
            files = pairing_files(data_dir)
            generation = "heartbeat-key." + secrets.token_hex(16) + ".txt"
            secret = result["heartbeatKey"].strip()
            meta = {
                "api_base": check_api_base(args.api_base),
                "resource_id": result["resourceId"],
                "node_id": node_id,
                "key_id": result.get("keyId"),
                "key_prefix": result.get("keyPrefix"),
                "heartbeat_url": result.get("heartbeatUrl"),
                "created": result.get("created"),
                "claimed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "key_file": generation,
                "key_sha256": hashlib.sha256(secret.encode("utf-8")).hexdigest(),
            }
            key_file = data_dir / generation
            # The manifest is the commit point. A failed/interrupted write leaves
            # either the old tuple or the complete new tuple, never mixed origins.
            # Retain old/unpublished private generations until unpair: an in-flight
            # reader may still hold an older manifest snapshot.
            write_private(key_file, secret + "\n")
            write_private(files["meta"], json.dumps(meta, indent=2) + "\n")
    except PairingError as exc:
        print(f"pairing failed [{exc.code}]: {exc}", file=sys.stderr)
        if exc.code == "NETWORK":
            return EXIT_NETWORK
        if exc.status is None:
            return EXIT_USAGE
        return EXIT_PAIRING_REJECTED
    except OSError:
        print("pairing failed [PRIVATE_STORAGE]: worker state could not be committed; pair again", file=sys.stderr)
        return EXIT_USAGE
    print(f"paired: resource {meta['resource_id']} (key {meta['key_prefix']})")
    print(f"stored: {files['meta']} + {key_file} (user-only access)")
    print("heartbeat proves reachability only; it never means inference-ready")
    return EXIT_OK


def cmd_heartbeat(args, loop):
    try:
        data_dir = Path(args.data_dir) if args.data_dir else default_data_dir()
        # Atomic with pair's writes (Muse W3 round 13): an unlocked
        # initial read racing pair's generation-then-manifest writes can
        # observe a deleted generation and mis-exit BAD_PAIRING_STORE,
        # leaving the sender stopped after a successful pair. The lock is
        # held for the read only, never across the loop.
        with pair_lock(data_dir):
            meta = load_pairing(data_dir)
    except PairingError as exc:
        print(f"heartbeat: [{exc.code}] {exc}", file=sys.stderr)
        return EXIT_USAGE if exc.status is None else EXIT_NETWORK
    interval = max(args.interval, HEARTBEAT_MIN_INTERVAL_SEC)
    sender_guard = None
    if loop:
        # One sender per data dir: a second loop exits SENDER_RUNNING
        # instead of doubling heartbeats. The try/finally below releases
        # promptly at return, and the OS drops the handle at process
        # death, so a crash never wedges the next start. --once never
        # takes the lock.
        sender_guard = _hold_sender_lock(data_dir)
        if sender_guard is None:
            print("heartbeat: [SENDER_RUNNING] another sender is already "
                  "running for this data dir; not starting a second",
                  file=sys.stderr)
            return EXIT_SENDER_RUNNING
    failures = 0
    first_beat = True
    if loop and hasattr(sys.stdout, "reconfigure"):
        # Supervised senders pipe stdout to the tray log: line-buffer so
        # each beat lands promptly instead of sitting in the block buffer.
        try:
            sys.stdout.reconfigure(line_buffering=True)
        except (OSError, ValueError):
            pass
    try:
        while True:
            if not first_beat:
                # Reload every beat: unpair stops the sender instead of beating on
                # a cached credential, and a re-pair switches it to the new key.
                # Under the mutex (Muse W3 round 11): the reload must not
                # race a concurrent pair's writes. A contested lock just
                # delays one beat; it never stops the sender.
                try:
                    with pair_lock(data_dir):
                        meta = load_pairing(data_dir)
                except PairingError as exc:
                    if exc.code == "PAIR_IN_PROGRESS":
                        print("heartbeat: pair in progress; rechecking after the interval",
                              file=sys.stderr)
                        time.sleep(interval)
                        continue
                    if exc.code != "NOT_PAIRED":
                        print(f"heartbeat: [{exc.code}] {exc}", file=sys.stderr)
                        return EXIT_USAGE
                    write_status(data_dir, {"at": time.time(), "ok": False, "status": "unpaired",
                                            "code": exc.code}, meta)
                    print("heartbeat: worker was unpaired; sender stopping", file=sys.stderr)
                    return EXIT_REPAIR_REQUIRED
            first_beat = False
            # Recomputed per beat (Codex P2): installed/removed models and
            # engines change readiness, and a stale true would misreport ready.
            usable = decide_usable(args.config)
            try:
                result = send_heartbeat(meta["api_base"], meta["resource_id"],
                                        meta["heartbeat_key"], usable)
            except RePairRequired as exc:
                # A re-pair can land between the reload and the beat: the old key
                # is revoked but a newer credential is already installed. The
                # sender loop retries with it instead of reporting the fresh
                # pairing as dead; a one-shot beat reports and exits.
                # Under the mutex (Muse W3 round 12): compare against a
                # store snapshot no concurrent pair is mid-write on.
                try:
                    with pair_lock(data_dir):
                        latest = load_pairing(data_dir)
                except PairingError:
                    latest = None
                if loop and latest is not None and latest["heartbeat_key"] != meta["heartbeat_key"]:
                    meta = latest
                    first_beat = True
                    continue
                write_status(data_dir, {"at": time.time(), "ok": False,
                                        "status": "repair-required", "code": exc.code}, meta)
                print(f"heartbeat: [{exc.code}] sender key is dead; pair again with a new code",
                      file=sys.stderr)
                return EXIT_REPAIR_REQUIRED
            except PairingError as exc:
                state = "rate-limited" if exc.status == 429 else "network-error" if exc.status is None else "failed"
                write_status(data_dir, {"at": time.time(), "ok": False, "status": state,
                                        "code": exc.code, "retryAfterSec": exc.retry_after}, meta)
                if exc.status == 429:
                    wait = exc.retry_after or interval
                    print(f"heartbeat: rate limited; retrying in {wait}s", file=sys.stderr)
                    if not loop:
                        return EXIT_NETWORK
                    time.sleep(wait)
                    continue
                if exc.status is None or (isinstance(exc.status, int) and exc.status >= 500):
                    # Transport faults AND transient server failures share the
                    # bounded backoff (Codex P2): a 5xx must not terminate the
                    # sender while the service recovers.
                    failures += 1
                    if failures > MAX_ATTEMPTS_NETWORK:
                        print(f"heartbeat: giving up after {MAX_ATTEMPTS_NETWORK} tries: [{exc.code}] {exc}",
                              file=sys.stderr)
                        return EXIT_NETWORK
                    wait = min(2 ** failures, 60)
                    print(f"heartbeat: [{exc.code}] {exc}; retry {failures}/{MAX_ATTEMPTS_NETWORK} in {wait}s",
                          file=sys.stderr)
                    if not loop:
                        return EXIT_NETWORK
                    time.sleep(wait)
                    continue
                print(f"heartbeat failed [{exc.code}]: {exc}", file=sys.stderr)
                return EXIT_PAIRING_REJECTED
            failures = 0
            write_status(data_dir, {"at": time.time(), "ok": True, "usable": usable,
                                    "heartbeatAt": result.get("heartbeatAt"),
                                    "note": "reachability only; not inference-ready"}, meta)
            print(f"heartbeat ok: usable={usable} at={result.get('heartbeatAt')}")
            if not loop:
                return EXIT_OK
            time.sleep(interval)
    finally:
        # Explicit release: a traceback cycle through a
        # mocked beat can outlive this frame past temp-dir
        # cleanup, so prompt GC timing must not matter.
        if sender_guard is not None:
            sender_guard.release()


def cmd_status(args):
    data_dir = Path(args.data_dir) if args.data_dir else default_data_dir()
    files = pairing_files(data_dir)
    if not files["meta"].exists():
        print("status: not paired")
        return EXIT_OK
    try:
        meta = load_pairing(data_dir)
    except (PairingError, OSError, ValueError):
        print("status: pairing store unreadable; pair again")
        return EXIT_USAGE
    print(f"status: paired resource={meta.get('resource_id')} key={meta.get('key_prefix')}")
    if files["status"].exists():
        try:
            st = json.loads(files["status"].read_text(encoding="utf-8"))
            if not isinstance(st, dict) or st.get("pairing_generation") != pairing_status_binding(meta):
                print("status: awaiting heartbeat for current pairing")
                return EXIT_OK
            if st.get("ok") is True and time.time() - float(st.get("at", 0)) > STATUS_STALE_SEC:
                print(f"status: stale; last successful beat at={st.get('heartbeatAt')}")
            elif st.get("ok") is not True:
                print(f"status: {st.get('status', 'failed')} code={st.get('code')}")
            else:
                print(f"status: last beat ok=True at={st.get('heartbeatAt')}")
        except (OSError, ValueError, TypeError):
            pass
    return EXIT_OK


def cmd_unpair(args):
    # Local forget only: the server-side sender key stays live until revoked
    # in the dashboard Keys panel, and the resource row is untouched.
    data_dir = Path(args.data_dir) if args.data_dir else default_data_dir()
    files = pairing_files(data_dir)
    removed, failed = [], 0
    # Under the same mutex as pair (Muse W3 round 12): an unlocked
    # deletion racing pair's writes could remove the new generation
    # before the new manifest lands, leaving a success-reported
    # NOT_PAIRED store. The scandir-based deletion below is unchanged.
    try:
        with pair_lock(data_dir):
            try:
                paths = [files["meta"], *managed_key_files(data_dir)]
            except FileNotFoundError:
                paths = [files["meta"]]
            except OSError:
                paths, failed = [], 1
            for path in paths:
                try:
                    path.unlink()
                    removed.append(str(path))
                except FileNotFoundError:
                    pass
                except OSError:
                    failed += 1
    except PairingError as exc:
        print(f"unpair failed [{exc.code}]: {exc}", file=sys.stderr)
        return EXIT_USAGE
    if failed:
        print("unpair failed [PRIVATE_STORAGE]: some pairing files could not be removed; stop the sender and retry", file=sys.stderr)
        if removed:
            print(f"removed {len(removed)} local pairing file(s); cleanup is incomplete", file=sys.stderr)
        print("note: revoke the sender key in the dashboard Keys panel; it stays live until then", file=sys.stderr)
        return EXIT_USAGE
    if removed:
        print("unpaired locally: " + ", ".join(removed))
        print("note: revoke the sender key in the dashboard Keys panel; it stays live until then")
    else:
        print("status: not paired")
    return EXIT_OK


def build_parser():
    parser = argparse.ArgumentParser(description="AIPSTER worker pairing + heartbeat sender")
    parser.add_argument("--api-base", default=DEFAULT_API_BASE,
                        help="AIPSTER API base (https, or http loopback for tests)")
    parser.add_argument("--data-dir", default=None,
                        help="worker data dir (default: installed location)")
    sub = parser.add_subparsers(dest="command", required=True)
    pair = sub.add_parser("pair", help="exchange a dashboard code for a sender key")
    pair.add_argument("--code", default=None, help="one-time code (else prompted, not echoed)")
    pair.add_argument("--config", default=None, help="worker config for hardware discovery")
    pair.add_argument("--name", default=None, help="display-name hint (default: hostname)")
    beat = sub.add_parser("heartbeat-once", help="post a single heartbeat")
    beat.add_argument("--config", default=None, help="worker config for the usable-bit policy")
    beat.add_argument("--interval", type=int, default=HEARTBEAT_INTERVAL_SEC)
    loop = sub.add_parser("heartbeat-loop", help="post heartbeats until stopped (one sender per data dir; a second loop exits SENDER_RUNNING)")
    loop.add_argument("--config", default=None, help="worker config for the usable-bit policy")
    loop.add_argument("--interval", type=int, default=HEARTBEAT_INTERVAL_SEC)
    sub.add_parser("status", help="show pairing state (never secrets)")
    sub.add_parser("unpair", help="forget local pairing (server key untouched)")
    return parser


def main(argv=None):
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
    except KeyboardInterrupt:
        print("interrupted", file=sys.stderr)
        return 130
    try:
        if args.command == "pair":
            return cmd_pair(args)
        if args.command == "heartbeat-once":
            return cmd_heartbeat(args, loop=False)
        if args.command == "heartbeat-loop":
            return cmd_heartbeat(args, loop=True)
        if args.command == "status":
            return cmd_status(args)
        if args.command == "unpair":
            return cmd_unpair(args)
    except KeyboardInterrupt:
        # Ctrl+C stops the sender cleanly: no traceback, no partial claim
        # (pair's manifest commit is atomic under the pair mutex).
        print("interrupted", file=sys.stderr)
        return 130
    parser.print_help()
    return EXIT_USAGE


if __name__ == "__main__":
    raise SystemExit(main())

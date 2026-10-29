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
import secrets
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener, urlopen

DEFAULT_API_BASE = "https://aipster.net"
REQUEST_TIMEOUT_SEC = 15
# Pair-mutex bounds (Codex P2 round 11). A pair holds the lock across one
# claim (single bounded request above) plus two local writes: seconds.
PAIR_LOCK_TIMEOUT_SEC = 180
PAIR_LOCK_STALE_AFTER_SEC = 300
HEARTBEAT_INTERVAL_SEC = 60
HEARTBEAT_MIN_INTERVAL_SEC = 30  # above the 25s server window + skew
MAX_ATTEMPTS_NETWORK = 5

# Patchable platform flag (tests force the Windows branch anywhere).
_IS_NT = (os.name == "nt")

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_PAIRING_REJECTED = 3
EXIT_REPAIR_REQUIRED = 4
EXIT_NETWORK = 5


class PairingError(Exception):
    """A failed pairing/heartbeat call. Never carries secret material."""

    def __init__(self, status, code, message, retry_after=None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.retry_after = retry_after


class RePairRequired(PairingError):
    """The stored sender key is revoked/expired: pair again with a new code."""


class _RedirectBlocked(Exception):
    """A redirect was refused: credentials never follow one."""


class _NoRedirect(HTTPRedirectHandler):
    """Fail closed on any redirect (Codex P2 round 4).

    The default handler would re-send the heartbeat Authorization header
    to wherever a 302 points — including a cross-origin or downgraded
    target — while check_api_base only validated the original URL. The
    AIPSTER API does not redirect, so every redirect is treated as a
    transport failure instead of followed.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise _RedirectBlocked(f"refusing {code} redirect to {newurl.split('?')[0][:80]}")


_OPENER = build_opener(_NoRedirect())


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


def restrict_file(path):
    """User-only access: POSIX mode 0600 plus a Windows user-ACL attempt."""
    try:
        os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
    except OSError:
        pass
    if os.name != "nt":
        return True
    user = os.environ.get("USERNAME")
    if not user:
        try:
            user = subprocess.check_output(["whoami"], text=True).strip()
        except (OSError, subprocess.CalledProcessError):
            user = None
    if not user:
        print(f"warning: could not determine the user; {path} keeps inherited ACLs",
              file=sys.stderr)
        return False
    result = subprocess.run(["icacls", str(path), "/inheritance:r", "/grant:r", f"{user}:F"],
                            capture_output=True, text=True, check=False)
    if result.returncode != 0:
        print(f"warning: icacls failed on {path}; it keeps inherited ACLs", file=sys.stderr)
        return False
    return True


def write_private(path, text):
    """Atomically write a secret file with protection established FIRST.

    On Windows the temp file is ACL-restricted BEFORE any secret byte is
    written (Codex P1 round 5): mkstemp inherits the directory ACLs and
    chmod cannot narrow them, so post-write restriction leaves a readable
    window. Any protection failure aborts without writing. The restriction
    travels with the file across os.replace; if the final verify fails the
    file is removed rather than left exposed.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".")
    try:
        if _IS_NT and not restrict_file(tmp):
            raise PairingError(None, "STORE_UNPROTECTED",
                               f"cannot protect {path}; refusing to write secrets")
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
        fd = None
        os.chmod(tmp, stat.S_IRUSR | stat.S_IWUSR)
        os.replace(tmp, path)
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass
        try:
            os.unlink(tmp)
        except OSError:
            pass
    if _IS_NT and not restrict_file(path):
        try:
            os.unlink(path)
        except OSError:
            pass
        raise PairingError(None, "STORE_UNPROTECTED",
                           f"cannot protect {path}; refusing to leave secrets exposed")


def ensure_private_dir(path):
    """Create a directory user-private; refuse to trust a shared one.

    Directories we create get 0700 (POSIX) so pairing metadata cannot be
    swapped under us. Pre-existing directories are left alone but POSIX
    callers must pass check_private_store before credentials route
    through them (Codex P2: api_base in pairing.json chooses where the
    heartbeat Bearer [REDACTED] On Windows the per-user data dir plus file
    ACLs are the control; see load_pairing."""
    path = Path(path)
    if not path.exists():
        path.mkdir(parents=True, exist_ok=True)
        if os.name != "nt":
            try:
                os.chmod(path, 0o700)
            except OSError:
                pass
    return path


def check_private_store(data_dir):
    """Refuse credential routing through a shared-writable store (POSIX).

    pairing.json controls where the heartbeat key is sent, so metadata
    gets the same protection as the key file. No-op on Windows, where
    the user-ACL file control plus the per-user data dir apply."""
    if os.name == "nt":
        return
    data = Path(data_dir)
    problems = []
    try:
        if data.stat().st_mode & (stat.S_IWGRP | stat.S_IWOTH):
            problems.append(str(data))
    except OSError:
        pass
    for name in ("pairing.json", "heartbeat-key.txt"):
        try:
            if (data / name).exists() and (data / name).stat().st_mode & (stat.S_IWGRP | stat.S_IWOTH):
                problems.append(str(data / name))
        except OSError:
            pass
    if problems:
        raise PairingError(None, "BAD_PAIRING_STORE",
                           "pairing store is shared-writable: " + ", ".join(problems) +
                           "; fix permissions or re-pair into a private dir")


def _read_settled_node_id(node_file, tries=50, delay=0.1):
    """Read back a raced node-id, waiting for the winner's write to land.

    O_EXCL creation and content write are two steps: a loser arriving
    between them sees an empty file. Poll briefly instead of failing —
    the winner writes within milliseconds. Returns None only if the
    file vanishes (deleted under us).
    """
    for _ in range(tries):
        try:
            found = node_file.read_text(encoding="utf-8").strip()
        except FileNotFoundError:
            return None
        if found:
            return found
        time.sleep(delay)
    return ""


def load_or_create_node_id(state_dir):
    """Stable worker identity (1..64 id chars), created once and kept.

    Concurrent first pairs converge on one identity (Codex P2 round 9):
    creation is exclusive (O_EXCL), so exactly one caller generates and
    every loser reads back the winner after its write settles — nobody
    overwrites, so no duplicate resources and no lost reclaim identity.
    """
    state_dir = Path(state_dir)
    state_dir.mkdir(parents=True, exist_ok=True)
    node_file = state_dir / "node-id"
    for _ in range(2):
        value = "n_" + secrets.token_hex(16)
        try:
            # 0600 at creation on POSIX; the mode is ignored on Windows,
            # where node-id (an identifier, not a secret) keeps the
            # per-user data dir's default ACLs.
            fd = os.open(node_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            found = _read_settled_node_id(node_file)
            if found is None:
                continue  # deleted under us; recreate on the next pass
            break
        try:
            if _IS_NT and not restrict_file(node_file):
                raise PairingError(None, "STORE_UNPROTECTED",
                                   f"cannot protect {node_file}; refusing to write state")
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(value + "\n")
        except BaseException:
            # Whatever failed (restriction, write, close, interrupt):
            # leave no leftovers behind, then re-raise. The next pair
            # recreates cleanly.
            try:
                os.close(fd)
            except OSError:
                pass
            try:
                os.unlink(node_file)
            except OSError:
                pass
            raise
        return value
    else:
        # Vanished twice in a row: genuinely odd; surface it plainly.
        raise PairingError(None, "BAD_NODE_ID",
                           f"{node_file} vanished twice; delete it to generate a fresh one on next pair")
    if found and len(found) <= 64 and all(c.isalnum() or c in "-_" for c in found):
        return found
    raise PairingError(None, "BAD_NODE_ID",
                       f"{node_file} does not hold a valid node id; "
                       "delete it to generate a fresh one on next pair")


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


def post_json(url, payload, secret=None, timeout=REQUEST_TIMEOUT_SEC):
    """POST JSON, returning (status, body-dict, retry-after)."""
    data = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if secret is not None:
        headers["Authorization"] = "Bearer " + secret
    request = Request(url, data=data, headers=headers, method="POST")
    try:
        with _OPENER.open(request, timeout=timeout) as response:
            status = response.status
            raw = response.read().decode("utf-8", "replace")
            retry_after = response.headers.get("Retry-After")
    except HTTPError as exc:
        try:
            raw = exc.read().decode("utf-8", "replace")
        except Exception:
            raw = ""
        status = exc.code
        retry_after = exc.headers.get("Retry-After") if exc.headers else None
    except _RedirectBlocked as exc:
        raise PairingError(None, "REDIRECT_BLOCKED", str(exc))
    except (URLError, TimeoutError, socket.timeout, OSError,
            http.client.IncompleteRead, http.client.RemoteDisconnected,
            http.client.BadStatusLine) as exc:
        # Truncated/mangled HTTP responses are transport failures, not
        # sender-fatal errors (Codex P2 round 4): the bounded backoff owns
        # them, exactly like a dropped connection.
        raise PairingError(None, "NETWORK", f"request failed: {exc}")
    try:
        body = json.loads(raw) if raw.strip() else {}
    except ValueError:
        body = {}
    if not isinstance(body, dict):
        body = {}
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


def load_pairing(data_dir):
    """Load pairing metadata + secret. Raises PairingError when unpaired."""
    check_private_store(data_dir)
    files = pairing_files(data_dir)
    if not files["meta"].exists() or not files["key"].exists():
        raise PairingError(None, "NOT_PAIRED", "worker is not paired; run `pair` first")
    try:
        meta = json.loads(files["meta"].read_text(encoding="utf-8"))
        secret = files["key"].read_text(encoding="utf-8").strip()
    except (OSError, ValueError) as exc:
        raise PairingError(None, "BAD_PAIRING_STORE", f"pairing store unreadable: {exc}")
    if not meta.get("resource_id") or not meta.get("api_base") or not secret:
        raise PairingError(None, "BAD_PAIRING_STORE", "pairing store is incomplete; pair again")
    expect = meta.get("key_sha256") or ""
    actual = hashlib.sha256(secret.encode("utf-8")).hexdigest()
    if not hmac.compare_digest(expect, actual):
        raise PairingError(None, "BAD_PAIRING_STORE",
                           "credential files disagree (interrupted re-pair?); pair again")
    meta["heartbeat_key"] = secret
    return meta


def write_status(data_dir, payload):
    files = pairing_files(data_dir)
    files["status"].parent.mkdir(parents=True, exist_ok=True)
    files["status"].write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


@contextlib.contextmanager
def pair_lock(data_dir):
    """Per-data-directory pair mutex (Codex P2 round 11).

    Serializes the claim plus both credential writes so concurrent pairs
    cannot install an already-revoked credential: without it, a slow
    responder overwrites the winner's files with its dead key, and the
    fingerprint check accepts the internally consistent but obsolete
    pair. Portable O_EXCL file mutex (fcntl/msvcrt differ per platform);
    deleted on release so steady state carries no lock footprint.
    Crash recovery is age-based: a lock older than STALE_AFTER (far
    beyond any bounded pair) is treated as orphaned and recycled. Clock
    jumps fail safe — worst case is the old concurrent behavior or a
    bounded wait ending in a clean retryable error, never corruption.
    """
    lock = Path(data_dir) / "pair.lock"
    deadline = time.monotonic() + PAIR_LOCK_TIMEOUT_SEC
    while True:
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            if _pair_lock_is_stale(lock):
                try:
                    os.unlink(lock)
                except OSError:
                    pass
                time.sleep(0.05)
                continue
            if time.monotonic() >= deadline:
                raise PairingError(None, "PAIR_IN_PROGRESS",
                                   f"another pair is using {data_dir}; "
                                   "wait for it to finish and retry")
            time.sleep(0.2)
            continue
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(json.dumps({"pid": os.getpid(), "started": time.time()}) + "\n")
        except OSError:
            try:
                os.unlink(lock)
            except OSError:
                pass
            raise
        break
    try:
        yield
    finally:
        try:
            os.unlink(lock)
        except OSError:
            pass


def _pair_lock_is_stale(lock):
    """True when the lock holder is certainly gone (age-based)."""
    try:
        raw = lock.read_text(encoding="utf-8")
    except OSError:
        return False  # vanished; the next O_EXCL will likely win
    try:
        started = json.loads(raw).get("started")
    except ValueError:
        started = None
    if not isinstance(started, (int, float)):
        try:
            started = lock.stat().st_mtime  # torn write: fall back to mtime
        except OSError:
            return False
    return (time.time() - started) > PAIR_LOCK_STALE_AFTER_SEC


def cmd_pair(args):
    try:
        data_dir = Path(args.data_dir) if args.data_dir else default_data_dir()
        # First, before node state or any claim: the private store must exist
        # with safe permissions. Creating node state first would mkdir the
        # data dir under the process umask and strand every later heartbeat
        # on BAD_PAIRING_STORE (Codex P2 round 3).
        ensure_private_dir(data_dir)
        check_private_store(data_dir)
        node_id = load_or_create_node_id(data_dir / "state")
        hardware = probe_hardware(args.config)
        if args.name:
            hardware["name"] = args.name[:80]
        code = args.code or getpass.getpass("Pairing code from the AIPSTER dashboard: ").strip()
        if not code:
            print("pairing: no code entered", file=sys.stderr)
            return EXIT_USAGE
        # The mutex spans the claim plus both credential writes (Codex P2
        # round 11) — and nothing else: node-id creation is already
        # race-safe, and the human code prompt must never hold the lock.
        # Moving the writes inside the try is behavior-neutral (the claim
        # already validated api_base; nothing here raises PairingError).
        with pair_lock(data_dir):
            result = claim(args.api_base, code, node_id, hardware)
            # Key first, then metadata; either order is safe because
            # load_pairing verifies the fingerprint below (Codex P2
            # round 5): a crash between the two writes can only produce a
            # refused mismatch, never a mixed generation that sends an old
            # key to a new endpoint.
            secret = result["heartbeatKey"].strip()
            fingerprint = hashlib.sha256(secret.encode("utf-8")).hexdigest()
            files = pairing_files(data_dir)
            write_private(files["key"], secret + "\n")
            meta = {
                "api_base": check_api_base(args.api_base),
                "resource_id": result["resourceId"],
                "node_id": node_id,
                "key_id": result.get("keyId"),
                "key_prefix": result.get("keyPrefix"),
                "key_sha256": fingerprint,
                "heartbeat_url": result.get("heartbeatUrl"),
                "created": result.get("created"),
                "claimed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
            # Metadata is private too: api_base routes the credential (Codex P2).
            write_private(files["meta"], json.dumps(meta, indent=2) + "\n")
            print(f"paired: resource {meta['resource_id']} (key {meta['key_prefix']})")
            print(f"stored: {files['meta']} + {files['key']} (user-only access)")
            print("heartbeat proves reachability only; it never means inference-ready")
            return EXIT_OK
    except PairingError as exc:
        print(f"pairing failed [{exc.code}]: {exc}", file=sys.stderr)
        if exc.code == "NETWORK":
            return EXIT_NETWORK
        if exc.status is None:
            return EXIT_USAGE
        return EXIT_PAIRING_REJECTED


def cmd_heartbeat(args, loop):
    try:
        data_dir = Path(args.data_dir) if args.data_dir else default_data_dir()
        meta = load_pairing(data_dir)
    except PairingError as exc:
        print(f"heartbeat: [{exc.code}] {exc}", file=sys.stderr)
        return EXIT_USAGE if exc.status is None else EXIT_NETWORK
    interval = max(args.interval, HEARTBEAT_MIN_INTERVAL_SEC)
    failures = 0
    while True:
        # Recomputed per beat (Codex P2): installed/removed models and
        # engines change readiness, and a stale true would misreport ready.
        usable = decide_usable(args.config)
        if loop:
            # Reload pairing every iteration (Codex P2 round 11): an
            # unpair during the loop must stop the sender instead of
            # beating forever on a cached credential. The lock keeps the
            # reload from racing a concurrent pair's writes (torn reads
            # would false-exit); a contested lock just delays one beat.
            try:
                with pair_lock(data_dir):
                    meta = load_pairing(data_dir)
            except PairingError as exc:
                if exc.code == "PAIR_IN_PROGRESS":
                    print("heartbeat: pair in progress; rechecking after the interval",
                          file=sys.stderr)
                    time.sleep(interval)
                    continue
                write_status(data_dir, {"at": time.time(), "ok": False,
                                        "status": "unpaired", "code": exc.code})
                print(f"heartbeat: [{exc.code}] local pairing gone; sender stopping "
                      "(pair again to resume)", file=sys.stderr)
                return EXIT_REPAIR_REQUIRED
        try:
            result = send_heartbeat(meta["api_base"], meta["resource_id"],
                                    meta["heartbeat_key"], usable)
        except RePairRequired as exc:
            write_status(data_dir, {"at": time.time(), "ok": False,
                                    "status": "repair-required", "code": exc.code})
            print(f"heartbeat: [{exc.code}] sender key is dead; pair again with a new code",
                  file=sys.stderr)
            return EXIT_REPAIR_REQUIRED
        except PairingError as exc:
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
                                "note": "reachability only; not inference-ready"})
        print(f"heartbeat ok: usable={usable} at={result.get('heartbeatAt')}")
        if not loop:
            return EXIT_OK
        time.sleep(interval)


def cmd_status(args):
    data_dir = Path(args.data_dir) if args.data_dir else default_data_dir()
    files = pairing_files(data_dir)
    if not files["meta"].exists():
        print("status: not paired")
        return EXIT_OK
    try:
        meta = json.loads(files["meta"].read_text(encoding="utf-8"))
    except (OSError, ValueError):
        print("status: pairing store unreadable; pair again")
        return EXIT_USAGE
    print(f"status: paired resource={meta.get('resource_id')} key={meta.get('key_prefix')}")
    if files["status"].exists():
        try:
            st = json.loads(files["status"].read_text(encoding="utf-8"))
            print(f"status: last beat ok={st.get('ok')} at={st.get('heartbeatAt')}")
        except ValueError:
            pass
    return EXIT_OK


def cmd_unpair(args):
    # Local forget only: the server-side sender key stays live until revoked
    # in the dashboard Keys panel, and the resource row is untouched.
    data_dir = Path(args.data_dir) if args.data_dir else default_data_dir()
    files = pairing_files(data_dir)
    removed = []
    failed = []
    for key in ("meta", "key"):
        try:
            files[key].unlink()
            removed.append(str(files[key]))
        except FileNotFoundError:
            pass
        except OSError as exc:
            # Anything else (permissions, Windows file lock, I/O error)
            # leaves a usable credential behind: report it (Codex P2
            # round 9), never a false "not paired". Paths only, no secrets.
            failed.append(f"{files[key]}: {exc.strerror or exc}")
    if failed:
        print("error: could not remove " + "; ".join(failed), file=sys.stderr)
        print("note: existing credentials may still be usable; fix permissions and retry unpair",
              file=sys.stderr)
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
    loop = sub.add_parser("heartbeat-loop", help="post heartbeats until stopped")
    loop.add_argument("--config", default=None, help="worker config for the usable-bit policy")
    loop.add_argument("--interval", type=int, default=HEARTBEAT_INTERVAL_SEC)
    sub.add_parser("status", help="show pairing state (never secrets)")
    sub.add_parser("unpair", help="forget local pairing (server key untouched)")
    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
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
    parser.print_help()
    return EXIT_USAGE


if __name__ == "__main__":
    raise SystemExit(main())

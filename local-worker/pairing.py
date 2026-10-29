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

from private_storage_win32 import protect_path

DEFAULT_API_BASE = "https://aipster.net"
REQUEST_TIMEOUT_SEC = 15
HEARTBEAT_INTERVAL_SEC = 60
HEARTBEAT_MIN_INTERVAL_SEC = 30  # above the 25s server window + skew
MAX_ATTEMPTS_NETWORK = 5
STATUS_STALE_SEC = 5 * 60

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
    if not _restrict_path(path, directory=True, new=created):
        raise PairingError(None, "PRIVATE_STORAGE", "cannot establish user-only worker storage")
    return path


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
    value = "n_" + secrets.token_hex(16)
    write_private(node_file, value + "\n")
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


def post_json(url, payload, secret=None, timeout=REQUEST_TIMEOUT_SEC):
    """POST JSON, returning (status, body-dict, retry-after)."""
    data = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if secret is not None:
        headers["Authorization"] = "Bearer " + secret
    request = Request(url, data=data, headers=headers, method="POST")
    try:
        with build_opener(NoRedirects()).open(request, timeout=timeout) as response:
            status = response.status
            raw = response.read().decode("utf-8", "replace")
            retry_after = response.headers.get("Retry-After")
    except HTTPError as exc:
        try:
            if 300 <= exc.code < 400:
                raise PairingError(None, "REDIRECT_BLOCKED", "API redirects are refused")
            raw = exc.read().decode("utf-8", "replace")
            status = exc.code
            retry_after = exc.headers.get("Retry-After") if exc.headers else None
        except (http.client.HTTPException, OSError) as fault:
            raise PairingError(None, "NETWORK", "incomplete API response") from fault
        finally:
            exc.close()
    except (URLError, TimeoutError, socket.timeout, OSError, http.client.HTTPException) as exc:
        # A truncated response belongs to the same bounded transport backoff.
        raise PairingError(None, "NETWORK", "API transport failed") from exc
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
    return ([legacy] if legacy.exists() else []) + [path for path in data.glob("heartbeat-key.*.txt")
            if re.fullmatch(r"heartbeat-key\.[a-f0-9]{32}\.txt", path.name)]


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


def write_status(data_dir, payload):
    files = pairing_files(data_dir)
    write_private(files["status"], json.dumps(payload, indent=2) + "\n")


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
            state = "rate-limited" if exc.status == 429 else "network-error" if exc.status is None else "failed"
            write_status(data_dir, {"at": time.time(), "ok": False, "status": state,
                                    "code": exc.code, "retryAfterSec": exc.retry_after})
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
    removed = []
    for path in [files["meta"], *managed_key_files(data_dir)]:
        try:
            path.unlink()
            removed.append(str(path))
        except OSError:
            pass
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

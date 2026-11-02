#!/usr/bin/env python3
"""One deterministic, resumable onboarding entrypoint for the local worker.

This is a thin orchestrator over the reviewed install and pairing code. It
does not reimplement claim, credential storage, Host/Origin validation, or
the sender lock. It only:

  * checks the pinned toolchain/platform before changing anything;
  * reuses install.py (never a second installer);
  * reads a pairing code from a private stdin/fd source (never argv, env,
    shell history, output, or state) and calls pairing.cmd_pair in-process;
  * creates/reuses the worker-local daemon token in private storage and
    passes it to the daemon through its child environment only;
  * starts one daemon and one sender, verifying an existing worker instead
    of starting a duplicate;
  * reports daemon health, node identity, heartbeat reachability, and
    whether inference was actually exercised as separate facts.

The entrypoint is deliberately stdlib-only and works with the system Python
used for the first install (3.9+). It never upgrades uv, installs globally,
edits the reviewed pairing/install code, or invokes a shell.
"""
from __future__ import annotations

import argparse
import contextlib
import getpass
import hashlib
import io
import json
import os
import platform
import re
import shutil
import signal
import socket
import stat
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

ROOT = Path(__file__).resolve().parent
DEFAULT_CONFIG = ROOT / "configs" / "mock.toml"
STATE_SCHEMA = "aipster-worker-setup/1"
STATUS_SCHEMA = "aipster-worker-setup-status/1"

EXIT_OK = 0
EXIT_USAGE = 2
EXIT_PREREQ = 3
EXIT_PAIRING = 4
EXIT_NETWORK = 5
EXIT_SENDER_RUNNING = 6
EXIT_BUSY = 75
EXIT_INTERRUPTED = 130

UV_REQUIRED = "0.12.12"
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
MAX_PACKET_BYTES = 256 * 1024
MAX_CODE_BYTES = 4096
MAX_RESPONSE_BYTES = 1024 * 1024
MIN_DISK_BYTES = 1024 * 1024 * 1024

_CODE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._~-]{7,127}$")
_PACKET_CODE_RE = re.compile(r"^\s*PAIRING CODE:\s*(\S+)\s*$")
_SECRET_PATTERNS = (
    re.compile(r"aip_(?:live|test)_[A-Za-z0-9._~-]+"),
    re.compile(r"(?i)\b(bearer)\s+[A-Za-z0-9._~+/=-]+"),
)
_SECRETS_LOCK = threading.Lock()
_KNOWN_SECRETS: set = set()


def register_secret(value: Any) -> None:
    """Register an in-memory credential so every later diagnostic can redact it.

    Values shorter than eight characters are ignored: they are too short to be
    useful credentials, and replacing them would make ordinary diagnostics
    unreadable. Registration is process-local and never persists a value.
    """
    if not isinstance(value, str):
        return
    value = value.strip()
    if len(value) < 8:
        return
    with _SECRETS_LOCK:
        _KNOWN_SECRETS.add(value)


def known_secrets() -> Tuple[str, ...]:
    with _SECRETS_LOCK:
        # Longest first, so a secret that contains another is removed whole.
        return tuple(sorted(_KNOWN_SECRETS, key=len, reverse=True))
_ENV_ALLOW = {
    "PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "WINDIR",
    "COMSPEC", "LANG", "LC_ALL", "LC_CTYPE", "USERPROFILE", "LOCALAPPDATA",
    "APPDATA", "SSL_CERT_FILE", "SSL_CERT_DIR",
}


class SetupError(Exception):
    """A sanitized setup failure with an actionable code and exit status."""

    def __init__(self, code: str, message: str, exit_code: int = EXIT_USAGE):
        super().__init__(message)
        self.code = code
        self.exit_code = exit_code


def redact(text: Any, extra: Sequence[str] = ()) -> str:
    """Remove known credential values and credential-shaped substrings.

    The registry covers values this process has actually handled (pairing code,
    daemon token, heartbeat key). Callers may pass additional values for a
    narrow diagnostic. No value is ever printed to discover it.
    """
    value = str(text)
    for secret in tuple(extra) + known_secrets():
        if secret:
            value = value.replace(secret, "[redacted]")
    for pattern in _SECRET_PATTERNS:
        value = pattern.sub(lambda m: (m.group(1) + " [redacted]") if m.lastindex else "[redacted]", value)
    return value


def sanitized_traceback(exc: BaseException) -> str:
    """Format a traceback without source text or an unredacted exception string."""
    import traceback  # noqa: PLC0415 - only needed on the debug/error path

    lines = ["Traceback (most recent call last):"]
    for frame in traceback.extract_tb(exc.__traceback__):
        lines.append('  File "%s", line %d, in %s'
                     % (redact(frame.filename), frame.lineno, redact(frame.name)))
    lines.append("%s: %s" % (type(exc).__name__, redact(exc)))
    return redact("\n".join(lines))


def utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def extract_pairing_code(packet: str) -> str:
    """Extract exactly one PAIRING CODE data field from a v2 setup packet."""
    if len(packet.encode("utf-8", "replace")) > MAX_PACKET_BYTES:
        raise SetupError("PACKET_TOO_LARGE", "setup packet is larger than the accepted limit")
    found = []
    for line in packet.splitlines():
        match = _PACKET_CODE_RE.match(line)
        if match:
            found.append(match.group(1))
    if not found:
        raise SetupError("NO_PAIRING_CODE", "setup packet contains no 'PAIRING CODE:' field")
    if len(set(found)) != 1:
        raise SetupError("AMBIGUOUS_PAIRING_CODE", "setup packet contains more than one pairing code")
    return validate_pairing_code(found[0])


def validate_pairing_code(code: str) -> str:
    """Validate without echoing: the value is never placed in an error."""
    register_secret(code)
    if not isinstance(code, str):
        raise SetupError("BAD_PAIRING_CODE", "pairing code must be text")
    # Reject anything that could be interpreted as shell/control syntax even
    # though the code is never passed through a shell. This keeps the private
    # input path from becoming an injection surface for future callers. The
    # stdin/fd readers strip one transport newline before calling this.
    if any(ord(ch) < 0x21 or ord(ch) > 0x7E for ch in code):
        raise SetupError("BAD_PAIRING_CODE", "pairing code contains non-printable characters")
    if len(code.encode("utf-8", "replace")) > 127 or not _CODE_RE.fullmatch(code):
        raise SetupError("BAD_PAIRING_CODE", "pairing code has an invalid shape")
    return code


def read_private_code(args: argparse.Namespace, stdin: Any = None,
                      getpass_fn: Optional[Callable[[str], str]] = None) -> Optional[str]:
    """Read a code from a private source. No code ever enters argv or output.

    Sources are mutually exclusive: --packet-stdin (whole packet on a pipe),
    --code-stdin (one code on a pipe, or a no-echo prompt on a TTY), and
    --code-fd N (inherited descriptor). If none is supplied and stdin is not a
    TTY, return None so the caller can report a blocked pair phase without
    prompting or reading an unrelated stream.
    """
    stdin = stdin if stdin is not None else sys.stdin
    getpass_fn = getpass_fn or getpass.getpass
    selected = [bool(getattr(args, "packet_stdin", False)),
                bool(getattr(args, "code_stdin", False)),
                getattr(args, "code_fd", None) is not None]
    if sum(selected) > 1:
        raise SetupError("CODE_SOURCE_CONFLICT",
                         "choose one private code source: --packet-stdin, --code-stdin, or --code-fd")

    if getattr(args, "packet_stdin", False):
        if getattr(stdin, "isatty", lambda: False)():
            raise SetupError("PACKET_TTY_REFUSED",
                             "refusing to echo a packet on a terminal; pipe it to --packet-stdin "
                             "or use --code-stdin for a no-echo prompt")
        packet = stdin.read(MAX_PACKET_BYTES + 1)
        if len(packet.encode("utf-8", "replace")) > MAX_PACKET_BYTES:
            raise SetupError("PACKET_TOO_LARGE", "setup packet is larger than the accepted limit")
        return extract_pairing_code(packet)

    if getattr(args, "code_stdin", False):
        if getattr(stdin, "isatty", lambda: False)():
            value = getpass_fn("Pairing code from the AIPSTER dashboard (not echoed): ")
        else:
            value = stdin.readline(MAX_CODE_BYTES + 2)
            if len(value.encode("utf-8", "replace")) > MAX_CODE_BYTES:
                raise SetupError("BAD_PAIRING_CODE", "pairing code input is too long")
        if not value or not value.strip():
            return None
        return validate_pairing_code(value.strip())

    fd = getattr(args, "code_fd", None)
    if fd is not None:
        try:
            duplicate = os.dup(fd)
        except OSError as exc:
            raise SetupError("BAD_CODE_FD", "cannot read the inherited pairing-code descriptor") from exc
        try:
            with os.fdopen(duplicate, "r", encoding="utf-8", errors="strict") as handle:
                value = handle.read(MAX_CODE_BYTES + 2)
        except (OSError, UnicodeError) as exc:
            raise SetupError("BAD_CODE_FD", "cannot read the inherited pairing-code descriptor") from exc
        if len(value.encode("utf-8", "replace")) > MAX_CODE_BYTES:
            raise SetupError("BAD_PAIRING_CODE", "pairing code input is too long")
        if not value.strip():
            return None
        return validate_pairing_code(value.strip())

    if getattr(stdin, "isatty", lambda: False)():
        value = getpass_fn("Pairing code from the AIPSTER dashboard (not echoed): ")
        if not value or not value.strip():
            return None
        return validate_pairing_code(value.strip())
    return None


class SetupLock:
    """Non-blocking exclusive lock for mutating setup phases.

    Separate from pairing's pair/sender locks, so a resumed setup never
    duplicates a pair claim or sender while still allowing the sender's own
    single-instance guard to remain authoritative.
    """

    def __init__(self, path: Path):
        self.path = Path(path)
        self.handle = None

    def acquire(self) -> bool:
        # The data dir must be private before the lock file exists. A plain
        # mkdir would leave 0755 and make pairing's fail-closed private-store
        # check refuse the store after the lock was already created.
        try:
            pairing = self._pairing()
            pairing.private_dir(self.path.parent)
        except Exception as exc:  # noqa: BLE001 - fail closed, never loosen storage
            raise SetupError("LOCK_FAILED", "cannot establish private setup storage: " + redact(exc),
                             EXIT_PREREQ) from exc
        try:
            fd = os.open(str(self.path), os.O_CREAT | os.O_RDWR, 0o600)
        except OSError as exc:
            raise SetupError("LOCK_FAILED", "cannot create the setup lock", EXIT_PREREQ) from exc
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(fd)
            return False
        self.handle = fd
        return True

    @staticmethod
    def _pairing():
        if str(ROOT) not in sys.path:
            sys.path.insert(0, str(ROOT))
        import pairing  # noqa: PLC0415
        return pairing

    def release(self) -> None:
        fd, self.handle = self.handle, None
        if fd is None:
            return
        try:
            if os.name == "nt":
                import msvcrt
                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(fd, fcntl.LOCK_UN)
        except OSError:
            pass
        finally:
            try:
                os.close(fd)
            except OSError:
                pass

    def __enter__(self):
        if not self.acquire():
            raise SetupError("SETUP_BUSY", "another setup process holds the worker setup lock", EXIT_BUSY)
        return self

    def __exit__(self, *_exc):
        self.release()
        return False


class _NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        # Never forward the local daemon token to a redirect target.
        return None


class LocalHttp:
    """Loopback-only HTTP client with no proxies, redirects, or token leaks."""

    def __init__(self):
        self.opener = build_opener(ProxyHandler({}), _NoRedirects())

    def request(self, method: str, url: str, token: Optional[str] = None,
                payload: Optional[dict] = None, timeout: float = 2.0
                ) -> Tuple[Optional[int], Dict[str, Any], str]:
        split = urlsplit(url)
        if split.scheme != "http" or split.hostname not in LOOPBACK_HOSTS:
            return None, {}, "refused a non-loopback daemon URL"
        data = None
        headers = {"Accept": "application/json", "User-Agent": "aipster-worker-setup/1"}
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if token is not None:
            headers["Authorization"] = "Bearer " + token
        request = Request(url, data=data, headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=timeout) as response:
                status = response.status
                raw = response.read(MAX_RESPONSE_BYTES + 1)
        except HTTPError as exc:
            status = exc.code
            try:
                raw = exc.read(MAX_RESPONSE_BYTES + 1)
            except (OSError, ValueError):
                raw = b""
            finally:
                exc.close()
        except (URLError, TimeoutError, socket.timeout, OSError, ValueError):
            return None, {}, "daemon is not reachable"
        if len(raw) > MAX_RESPONSE_BYTES:
            return status, {}, "daemon response exceeded the size limit"
        try:
            body = json.loads(raw.decode("utf-8")) if raw.strip() else {}
        except (ValueError, UnicodeError):
            body = {}
        if not isinstance(body, dict):
            body = {}
        return status, body, ""


class ProcessHandle:
    """Owned child process; termination targets only the process group we made."""

    def __init__(self, proc: subprocess.Popen):
        self.proc = proc
        self.pid = proc.pid

    def poll(self):
        return self.proc.poll()

    def terminate(self) -> None:
        if self.proc.poll() is not None:
            return
        try:
            if os.name == "nt":
                self.proc.terminate()
            else:
                os.killpg(os.getpgid(self.proc.pid), signal.SIGTERM)
        except (OSError, ProcessLookupError):
            return

    def wait(self, timeout: float = 5.0) -> None:
        try:
            self.proc.wait(timeout=timeout)
        except (subprocess.TimeoutExpired, OSError):
            try:
                self.proc.kill()
            except OSError:
                pass


def _default_runner(argv: Sequence[str], *, cwd: Optional[Path] = None,
                    env: Optional[Dict[str, str]] = None, timeout: Optional[float] = None,
                    capture: bool = False):
    return subprocess.run(list(argv), cwd=str(cwd) if cwd else None, env=env,
                          timeout=timeout, check=False, capture_output=capture, text=True)


def _default_spawner(argv: Sequence[str], *, cwd: Path, env: Dict[str, str],
                     log_path: Path) -> ProcessHandle:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    flags = os.O_CREAT | os.O_WRONLY | os.O_APPEND
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(str(log_path), flags, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise OSError("setup log is not a regular file")
        os.chmod(log_path, 0o600)
        kwargs: Dict[str, Any] = {"stdin": subprocess.DEVNULL, "stdout": fd,
                                  "stderr": subprocess.STDOUT, "cwd": str(cwd),
                                  "env": env, "close_fds": True}
        if os.name == "nt":
            kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        else:
            kwargs["start_new_session"] = True
        proc = subprocess.Popen(list(argv), **kwargs)
    finally:
        os.close(fd)
    return ProcessHandle(proc)


class Setup:
    """Dependency-injected setup session; the CLI constructs the real one."""

    def __init__(self, *, root: Path, data_dir: Path, config: Path, api_base: str,
                 name: Optional[str] = None, allow_unqualified: bool = False,
                 retry_pair: bool = False, verify_inference: bool = False,
                 runner: Optional[Callable[..., Any]] = None,
                 spawner: Optional[Callable[..., Any]] = None,
                 http: Optional[Any] = None,
                 pairer: Optional[Callable[[str], int]] = None,
                 token_provider: Optional[Callable[[bool], Optional[str]]] = None,
                 sender_lock_probe: Optional[Callable[[Path], bool]] = None,
                 which: Optional[Callable[[str], Optional[str]]] = None,
                 port_open: Optional[Callable[[str, int], bool]] = None,
                 platform_name: Optional[str] = None,
                 machine: Optional[str] = None,
                 hostname: Optional[Callable[[], str]] = None,
                 expect_target: Optional[str] = None,
                 sleep: Optional[Callable[[float], None]] = None,
                 clock: Optional[Callable[[], float]] = None,
                 out: Optional[Callable[[str], None]] = None,
                 err: Optional[Callable[[str], None]] = None,
                 install_timeout: float = 900.0,
                 start_timeout: float = 20.0,
                 heartbeat_wait: float = 15.0,
                 poll_interval: float = 0.25):
        self.root = Path(root).resolve()
        self.setup_root = ROOT
        self.data_dir = Path(data_dir).expanduser()
        self.config = Path(config).expanduser()
        self.api_base = api_base
        self.name = name
        self.allow_unqualified = allow_unqualified
        self.retry_pair = retry_pair
        self.verify_inference = verify_inference
        self.runner = runner or _default_runner
        self.spawner = spawner or _default_spawner
        self.http = http or LocalHttp()
        self.pairer = pairer
        self.token_provider = token_provider
        self.sender_lock_probe = sender_lock_probe
        self.which = which or shutil.which
        self.port_open = port_open or self._default_port_open
        self.platform_name = platform_name if platform_name is not None else os.name
        self.machine = machine if machine is not None else platform.machine()
        self.hostname = hostname or socket.gethostname
        self.expect_target = (expect_target or "").strip().lower() or None
        self.sleep = sleep or time.sleep
        self.clock = clock or time.monotonic
        self.out = out or (lambda line: print(line, flush=True))
        self.err = err or (lambda line: print(line, file=sys.stderr, flush=True))
        self.install_timeout = install_timeout
        self.start_timeout = start_timeout
        self.heartbeat_wait = heartbeat_wait
        self.poll_interval = poll_interval
        self.state_path = self.data_dir / "setup-state.json"
        self.state = self._load_state()
        self.json_output = False
        self.last_facts: Optional[Dict[str, Any]] = None
        self.last_heartbeat: Optional[Dict[str, Any]] = None
        self.last_blocked: List[Dict[str, str]] = []

    # -- state ---------------------------------------------------------------
    def _load_state(self) -> Dict[str, Any]:
        fresh = {"schema": STATE_SCHEMA, "phases": {}, "processes": {}}
        try:
            if self.state_path.exists():
                candidate = json.loads(self.state_path.read_text(encoding="utf-8"))
                if isinstance(candidate, dict):
                    candidate.setdefault("schema", STATE_SCHEMA)
                    candidate.setdefault("phases", {})
                    candidate.setdefault("processes", {})
                    if isinstance(candidate["phases"], dict) and isinstance(candidate["processes"], dict):
                        return candidate
                self.err("setup: existing setup state is unreadable; starting a fresh non-secret record")
        except (OSError, ValueError, UnicodeError):
            self.err("setup: existing setup state is unreadable; starting a fresh non-secret record")
        return fresh

    def _save_state(self) -> None:
        self.state["schema"] = STATE_SCHEMA
        self.state["updated_at"] = utc_now()
        try:
            pairing = self._pairing()
            pairing.private_dir(self.data_dir)
            pairing.write_private(self.state_path, json.dumps(self.state, indent=2, sort_keys=True) + "\n")
        except Exception as exc:  # noqa: BLE001 - state is non-secret and never blocks pairing
            self.err("setup: warning: could not save non-secret setup state: " + redact(exc))

    def _record(self, phase: str, state: str, detail: str = "", **fields: Any) -> None:
        record = {"state": state, "at": utc_now()}
        if detail:
            record["detail"] = redact(detail)
        record.update({k: v for k, v in fields.items() if v is not None})
        self.state.setdefault("phases", {})[phase] = record

    # -- shared helpers ------------------------------------------------------
    def _pairing(self):
        if str(self.setup_root) not in sys.path:
            sys.path.insert(0, str(self.setup_root))
        import pairing  # noqa: PLC0415 - reviewed local module
        return pairing

    def _env(self) -> Dict[str, str]:
        env = {k: v for k, v in os.environ.items() if k.upper() in _ENV_ALLOW}
        env.update(PYTHONNOUSERSITE="1", PYTHONDONTWRITEBYTECODE="1")
        return env

    def _install_state(self) -> Dict[str, Any]:
        venv = self.root / ".venv"
        python = venv / ("Scripts/python.exe" if self.platform_name == "nt" else "bin/python")
        dendrite = venv / ("Scripts/dendrite.exe" if self.platform_name == "nt" else "bin/dendrite")
        installed = python.is_file() and dendrite.is_file()
        return {"venv": venv, "python": python, "dendrite": dendrite,
                "installed": installed, "partial": venv.exists() and not installed}

    def _node_section(self) -> Dict[str, Any]:
        try:
            if self.config.stat().st_size > 64 * 1024:
                raise SetupError("BAD_CONFIG", "worker config is unexpectedly large", EXIT_PREREQ)
            text = self.config.read_text(encoding="utf-8")
        except OSError as exc:
            raise SetupError("BAD_CONFIG", "worker config cannot be read", EXIT_PREREQ) from exc
        match = re.search(r"(?ms)^\[node\][ \t]*\r?\n(.*?)(?=^\[|\Z)", text)
        if not match:
            raise SetupError("BAD_CONFIG", "worker config has no [node] section", EXIT_PREREQ)
        body = match.group(1)
        host_match = re.search(r'(?m)^\s*host\s*=\s*"([^"\r\n]*)"\s*(?:#.*)?$', body)
        port_match = re.search(r"(?m)^\s*port\s*=\s*(\d+)\s*(?:#.*)?$", body)
        token_match = re.search(r'(?m)^\s*token_env\s*=\s*"([^"\r\n]*)"\s*(?:#.*)?$', body)
        host = host_match.group(1) if host_match else "127.0.0.1"
        try:
            port = int(port_match.group(1)) if port_match else 8090
        except ValueError as exc:
            raise SetupError("BAD_CONFIG", "worker config port is not an integer", EXIT_PREREQ) from exc
        token_env = token_match.group(1) if token_match else "DENDRITE_API_TOKEN"
        if host not in LOOPBACK_HOSTS:
            raise SetupError("NON_LOOPBACK_CONFIG",
                             "setup only starts a loopback worker; config host is not loopback",
                             EXIT_PREREQ)
        if not 1 <= port <= 65535:
            raise SetupError("BAD_CONFIG", "worker config port is out of range", EXIT_PREREQ)
        if not re.fullmatch(r"[A-Z_][A-Z0-9_]*", token_env):
            raise SetupError("BAD_CONFIG", "worker config token_env is not an environment name",
                             EXIT_PREREQ)
        origin = "http://[%s]:%d" % (host, port) if ":" in host else "http://%s:%d" % (host, port)
        return {"host": host, "port": port, "token_env": token_env, "origin": origin}

    def _uv(self) -> Dict[str, Any]:
        path = self.which("uv")
        if not path:
            return {"path": None, "version": None, "ok": False, "detail": "uv not found on PATH"}
        try:
            result = self.runner([path, "--version"], env=self._env(), timeout=5.0, capture=True)
            text = (getattr(result, "stdout", "") or "").strip()
            version = text.split()[1] if text.startswith("uv ") and len(text.split()) > 1 else None
        except (OSError, subprocess.TimeoutExpired, IndexError):
            version = None
        return {"path": path, "version": version, "ok": version == UV_REQUIRED,
                "detail": ("uv " + version) if version else "uv version could not be read"}

    def _default_port_open(self, host: str, port: int) -> bool:
        try:
            with socket.create_connection((host, port), timeout=0.5):
                return True
        except OSError:
            return False

    def _token(self, create: bool = True) -> Optional[str]:
        if self.token_provider is not None:
            value = self.token_provider(create)
            register_secret(value)
            return value
        try:
            package_root = self.setup_root / "packaging"
            if str(package_root) not in sys.path:
                sys.path.insert(0, str(package_root))
            from aipster_tray.firstrun import ensure_private_token  # noqa: PLC0415
        except (ImportError, OSError) as exc:
            raise SetupError("TOKEN_UNAVAILABLE", "private token helper is unavailable",
                             EXIT_PREREQ) from exc
        token_path = self.data_dir / "api-token.txt"
        if not create and not token_path.exists():
            return None
        try:
            value, _fresh = ensure_private_token(token_path)
        except SystemExit as exc:
            raise SetupError("TOKEN_UNAVAILABLE", redact(exc), EXIT_PREREQ) from exc
        except OSError as exc:
            raise SetupError("TOKEN_UNAVAILABLE", "cannot establish private token storage",
                             EXIT_PREREQ) from exc
        if not value:
            raise SetupError("TOKEN_UNAVAILABLE", "private token storage is empty", EXIT_PREREQ)
        register_secret(value)
        return value

    # -- HTTP ----------------------------------------------------------------
    def _health(self) -> Dict[str, Any]:
        status, body, detail = self.http.request("GET", self._origin() + "/healthz", timeout=1.5)
        return {"ok": status == 200 and body.get("status") == "ok",
                "status": status, "detail": detail}

    def _node(self, token: str) -> Dict[str, Any]:
        status, body, detail = self.http.request(
            "GET", self._origin() + "/v1/node", token=token, timeout=2.0)
        return {"ok": status == 200 and bool(body.get("node_id")),
                "status": status, "body": body, "detail": detail}

    def _execute(self, token: str) -> Dict[str, Any]:
        payload = {"capability": "summarize",
                   "prompt": "AIPSTER setup connectivity check. Reply with OK.",
                   "max_tokens": 8}
        status, body, detail = self.http.request(
            "POST", self._origin() + "/v1/execute", token=token, payload=payload, timeout=30.0)
        return {"ok": status == 200 and "simulated" in body,
                "status": status, "body": body, "detail": detail}

    def _log_path(self, name: str) -> Path:
        logs = self.data_dir / "logs"
        try:
            self._pairing().private_dir(logs)
        except Exception as exc:  # noqa: BLE001 - fail closed on shared log storage
            raise SetupError("LOG_STORAGE", "cannot establish private log storage: " + redact(exc),
                             EXIT_PREREQ) from exc
        return logs / name

    def _origin(self) -> str:
        return self._node_section()["origin"]

    # -- target identity -----------------------------------------------------
    def target_identity(self) -> Dict[str, str]:
        """Identify the machine this process is actually running on.

        An assistant may run setup inside its own sandbox or on a different
        host than the machine the user chose. The fingerprint is recorded in
        the checkpoint before the first mutation and compared on every later
        run; it is not derived from the checkout path, which may legitimately
        move between runs.
        """
        try:
            host = str(self.hostname() or "").strip().lower()
        except OSError:
            host = ""
        material = "|".join((host, self.platform_name, str(self.machine).lower()))
        fingerprint = hashlib.sha256(material.encode("utf-8")).hexdigest()[:16]
        return {"host": host, "platform": self.platform_name,
                "machine": str(self.machine).lower(), "fingerprint": fingerprint}

    def _guard_target(self) -> Dict[str, str]:
        """Refuse to mutate a machine that is not the selected/recorded one."""
        identity = self.target_identity()
        actual = identity["fingerprint"]
        if self.expect_target and self.expect_target != actual:
            raise SetupError(
                "TARGET_MISMATCH",
                "this is not the selected machine: expected target %s, current machine is %s (%s/%s)"
                % (self.expect_target, actual, self.platform_name, identity["machine"]),
                EXIT_USAGE)
        recorded = self.state.get("target")
        if isinstance(recorded, dict):
            previous = str(recorded.get("fingerprint") or "")
            if previous and previous != actual and self.expect_target != actual:
                raise SetupError(
                    "TARGET_CHANGED",
                    "this data dir was prepared for target %s but setup is running on %s; "
                    "run on the original machine, or confirm the new target with --expect-target %s"
                    % (previous, actual, actual),
                    EXIT_USAGE)
        if not isinstance(recorded, dict) or recorded.get("fingerprint") != actual:
            self.state["target"] = identity
            self._save_state()
        return identity

    def _block_on_target(self, phase: str) -> Optional[int]:
        try:
            self._guard_target()
        except SetupError as exc:
            # A refused target is a pre-mutation stop: report it, but leave the
            # checkpoint untouched rather than recording state for a machine
            # this data dir was not prepared for.
            self.err("%s: BLOCKED [%s] %s" % (phase, exc.code, redact(exc)))
            return exc.exit_code
        return None

    # -- check ---------------------------------------------------------------
    def check(self, *, for_verify: bool = False) -> Dict[str, Any]:
        report: Dict[str, Any] = {"blocked": [], "checks": [],
                                  "qualified": False, "allow_unqualified": self.allow_unqualified}
        machine = str(self.machine).lower()
        windows = self.platform_name == "nt"
        arch_ok = machine in {"amd64", "x86_64", "x64"}
        qualified = windows and arch_ok
        report.update(qualified=qualified, platform=self.platform_name, machine=machine)
        if qualified:
            report["checks"].append(("platform", "PASSED", "Windows x64"))
        else:
            detail = "only Windows x64 is qualified; %s/%s is untested" % (self.platform_name, machine)
            report["checks"].append(("platform", "WARNING" if self.allow_unqualified else "BLOCKED", detail))
            if not self.allow_unqualified:
                report["blocked"].append({"code": "UNQUALIFIED_PLATFORM", "detail": detail})

        identity = self.target_identity()
        report["target"] = identity
        report["expect_target"] = self.expect_target
        report["checks"].append(("target", "PASSED", "machine %s (%s/%s)"
                                 % (identity["fingerprint"], self.platform_name,
                                    identity["machine"])))
        recorded = self.state.get("target")
        if self.expect_target and self.expect_target != identity["fingerprint"]:
            detail = ("this is not the selected machine: expected %s, current %s"
                      % (self.expect_target, identity["fingerprint"]))
            report["checks"].append(("target", "BLOCKED", detail))
            report["blocked"].append({"code": "TARGET_MISMATCH", "detail": detail})
        elif isinstance(recorded, dict) and recorded.get("fingerprint") not in (
                None, "", identity["fingerprint"]) and self.expect_target != identity["fingerprint"]:
            detail = ("this data dir was prepared for target %s; confirm this machine with "
                      "--expect-target %s" % (recorded.get("fingerprint"), identity["fingerprint"]))
            report["checks"].append(("target", "BLOCKED", detail))
            report["blocked"].append({"code": "TARGET_CHANGED", "detail": detail})

        install = self._install_state()
        report.update(installed=install["installed"], partial=install["partial"],                      venv_python=str(install["python"]), dendrite=str(install["dendrite"]))
        if install["installed"]:
            report["checks"].append(("install", "PASSED", "existing .venv and dendrite found"))
        elif install["partial"]:
            report["checks"].append(("install", "BLOCKED", "existing .venv is incomplete"))
            report["blocked"].append({"code": "PARTIAL_INSTALL",
                                      "detail": "remove only local-worker/.venv and rerun install"})
        else:
            report["checks"].append(("install", "MISSING", "no local worker environment"))

        for name in ("install.py", "pairing.py"):
            if not (self.root / name).is_file():
                report["checks"].append(("checkout", "BLOCKED", name + " is missing"))
                report["blocked"].append({"code": "BAD_CHECKOUT",
                                          "detail": "worker file %s is missing" % name})

        if sys.version_info < (3, 9):
            report["checks"].append(("python", "BLOCKED", "setup requires Python 3.9 or newer"))
            report["blocked"].append({"code": "PYTHON_VERSION",
                                      "detail": "setup requires Python 3.9 or newer"})
        else:
            report["checks"].append(("python", "PASSED", platform.python_version()))

        try:
            node = self._node_section()
            report.update(config=str(self.config), host=node["host"], port=node["port"],
                          origin=node["origin"], token_env=node["token_env"])
            report["checks"].append(("config", "PASSED",
                                     "%s (loopback)" % node["origin"]))
        except SetupError as exc:
            report["checks"].append(("config", "BLOCKED", str(exc)))
            report["blocked"].append({"code": exc.code, "detail": str(exc)})

        uv = self._uv()
        report["uv"] = uv
        uv_detail = uv["detail"] + (" (required)" if not uv["ok"] else " (required, matched)")
        report["checks"].append(("uv", "PASSED" if uv["ok"] else "MISMATCH", uv_detail))
        if not install["installed"] and not install["partial"] and not uv["ok"] and not for_verify:
            report["blocked"].append({"code": "UV_VERSION",
                                      "detail": "install requires uv %s exactly" % UV_REQUIRED})
        elif install["installed"] and not uv["ok"]:
            report["checks"].append(("uv", "WARNING", "not needed for a completed install"))

        try:
            free = shutil.disk_usage(str(self.root)).free
            report["disk_free_bytes"] = free
            report["checks"].append(("disk", "PASSED" if free >= MIN_DISK_BYTES else "WARNING",
                                     "%.1f GiB free" % (free / (1024 ** 3))))
            if free < MIN_DISK_BYTES and not install["installed"] and not for_verify:
                report["blocked"].append({"code": "LOW_DISK",
                                          "detail": "less than 1 GiB free for install"})
        except OSError:
            report["checks"].append(("disk", "WARNING", "free space could not be read"))

        if not for_verify:
            self._record("check", "blocked" if report["blocked"] else "passed",
                         "; ".join(item["code"] for item in report["blocked"]))
        self.last_blocked = list(report["blocked"])
        return report

    def print_check(self, report: Dict[str, Any]) -> None:
        state = "BLOCKED" if report["blocked"] else "PASSED"
        self.out("setup check: " + state)
        for name, check_state, detail in report["checks"]:
            self.out("  %-9s %-12s %s" % (name + ":", check_state, redact(detail)))
        for item in report["blocked"]:
            self.out("  blocked:   %-12s %s" % (item["code"], redact(item["detail"])))

    # -- install -------------------------------------------------------------
    def install(self, report: Optional[Dict[str, Any]] = None) -> int:
        blocked = self._block_on_target("install")
        if blocked is not None:
            return blocked
        report = report or self.check()
        if report["blocked"]:
            for item in report["blocked"]:
                self.err("install: BLOCKED [%s] %s" % (item["code"], redact(item["detail"])))
            self._record("install", "blocked", "check is blocked")
            self._save_state()
            return EXIT_PREREQ
        install = self._install_state()
        if install["installed"]:
            self._record("install", "skipped", "existing .venv and dendrite found")
            self._save_state()
            self.out("install: already complete; not rerunning install.py")
            await_uv = report.get("uv", {})
            if not await_uv.get("ok"):
                self.out("install: note: uv %s is absent/mismatched, but the completed install does not need it"
                         % UV_REQUIRED)
            return EXIT_OK
        if install["partial"]:
            self._record("install", "failed", "existing .venv is incomplete")
            self._save_state()
            self.err("install: BLOCKED: existing .venv is incomplete; remove only local-worker/.venv "
                     "and rerun install")
            return EXIT_PREREQ
        uv = report.get("uv", {})
        if not uv.get("ok"):
            self._record("install", "failed", "uv %s is required" % UV_REQUIRED)
            self._save_state()
            self.err("install: BLOCKED: uv %s is required exactly; found %s"
                     % (UV_REQUIRED, uv.get("version") or "none"))
            return EXIT_PREREQ
        self.out("install: running the reviewed install.py (hash-locked public PyPI wheels)")
        argv = [sys.executable, str(self.root / "install.py")]
        detail = ""
        try:
            result = self.runner(argv, cwd=self.root, env=self._env(),
                                 timeout=self.install_timeout, capture=False)
            returncode = getattr(result, "returncode", 1)
        except subprocess.TimeoutExpired:
            returncode = None
            detail = "installer timed out"
        except OSError as exc:
            returncode = None
            detail = "installer could not start: " + redact(exc)
        if returncode != 0:
            if not detail:
                detail = "installer exited %s" % returncode
            self._record("install", "failed", detail)
            self._save_state()
            self.err("install: FAILED: " + detail)
            return EXIT_PREREQ
        if not self._install_state()["installed"]:
            self._record("install", "failed", "installer exited 0 but .venv/dendrite is missing")
            self._save_state()
            self.err("install: FAILED: installer exited 0 but .venv/dendrite is missing")
            return EXIT_PREREQ
        self._record("install", "passed", "reviewed install.py completed")
        self._save_state()
        self.out("install: complete")
        return EXIT_OK

    # -- pair ----------------------------------------------------------------
    def _manifest(self) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
        pairing = self._pairing()
        files = pairing.pairing_files(self.data_dir)
        if not files["meta"].exists():
            return None, None
        try:
            meta = pairing.load_pairing(self.data_dir)
            register_secret(meta.get("heartbeat_key"))
            return meta, None
        except Exception as exc:  # noqa: BLE001 - malformed store is a state, not a crash
            return None, redact(exc)

    def pair(self, code: Optional[str]) -> int:
        blocked = self._block_on_target("pair")
        if blocked is not None:
            return blocked
        pairing = self._pairing()
        try:
            pairing.private_dir(self.data_dir)
        except Exception as exc:  # noqa: BLE001
            self._record("pair", "failed", "cannot establish private worker storage")
            self._save_state()
            self.err("pair: BLOCKED: cannot establish private worker storage: " + redact(exc))
            return EXIT_PREREQ

        meta, problem = self._manifest()
        if meta is not None:
            self._record("pair", "already-paired", "existing pairing preserved",
                         resource_id=meta.get("resource_id"))
            self._save_state()
            self.out("pair: already paired resource=%s; code not consumed" % meta.get("resource_id"))
            return EXIT_OK
        if problem is not None:
            self._record("pair", "failed", "pairing store unreadable: " + problem)
            self._save_state()
            self.err("pair: BLOCKED: pairing store is unreadable; repair it before pairing again: " + problem)
            return EXIT_PAIRING

        previous = self.state.get("phases", {}).get("pair", {}).get("state")
        if previous in ("in_progress", "uncertain") and not self.retry_pair:
            self._record("pair", "uncertain",
                         "a previous pairing attempt may have consumed the code; "
                         "check the dashboard/status, then rerun with --retry-pair")
            self._save_state()
            self.err("pair: UNCERTAIN: a previous attempt was interrupted after it may have "
                     "reached AIPSTER. Do not burn another code blindly. Check My Compute/status, "
                     "then rerun with --retry-pair only if it is still unpaired.")
            return EXIT_PAIRING

        if not code:
            self._record("pair", "blocked", "no private pairing code supplied")
            self._save_state()
            self.err("pair: BLOCKED: no private pairing code supplied. Pipe the setup packet with "
                     "--packet-stdin, use --code-stdin for a no-echo prompt, or use --code-fd. "
                     "Never pass the code as an argument.")
            return EXIT_PAIRING

        try:
            code = validate_pairing_code(code)
        except SetupError as exc:
            self._record("pair", "failed", exc.code)
            self._save_state()
            self.err("pair: " + str(exc))
            return EXIT_USAGE

        self._record("pair", "in_progress", "pairing claim in progress")
        self._save_state()
        pairer = self.pairer or self._default_pairer
        try:
            returncode = pairer(code)
        except KeyboardInterrupt:
            self._record("pair", "in_progress", "interrupted during the pairing claim")
            self._save_state()
            self.err("pair: interrupted; rerun to resume. If the claim may have reached AIPSTER, "
                     "check status/dashboard before consuming another code.")
            raise
        except Exception as exc:  # noqa: BLE001 - an unknown failure may follow the claim
            self._record("pair", "uncertain", "unexpected pairing failure after dispatch: " + redact(exc))
            self._save_state()
            self.err("pair: UNCERTAIN: " + redact(exc))
            return EXIT_NETWORK

        if returncode == 0:
            meta, problem = self._manifest()
            if meta is None:
                self._record("pair", "uncertain",
                             "pairing reported success but the local store is missing: " + (problem or "unknown"))
                self._save_state()
                self.err("pair: UNCERTAIN: pairing reported success but the local store is missing")
                return EXIT_PAIRING
            self._record("pair", "passed", "pairing credential stored privately",
                         resource_id=meta.get("resource_id"))
            self._save_state()
            self.out("pair: registered resource=%s; sender key stored privately"
                     % meta.get("resource_id"))
            return EXIT_OK
        if returncode == EXIT_NETWORK:
            self._record("pair", "uncertain",
                         "network failure during the pairing claim; the code may have been consumed")
            self._save_state()
            self.err("pair: NETWORK: the claim may or may not have reached AIPSTER. Check status/"
                     "dashboard before rerunning; use --retry-pair only if still unpaired.")
            return EXIT_NETWORK
        self._record("pair", "failed", "pairing rejected or could not start (exit %s)" % returncode)
        self._save_state()
        self.err("pair: FAILED: pairing was not accepted (exit %s); no local pairing was written"
                 % returncode)
        return EXIT_PAIRING

    def _default_pairer(self, code: str) -> int:
        pairing = self._pairing()
        args = argparse.Namespace(api_base=self.api_base, data_dir=str(self.data_dir),
                                  config=str(self.config), name=self.name, code=code)
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer), contextlib.redirect_stderr(buffer):
            returncode = pairing.cmd_pair(args)
        text = redact(buffer.getvalue(), (code,)).rstrip()
        if text:
            self.out(text)
        return returncode

    # -- start ---------------------------------------------------------------
    def _load_meta(self) -> Optional[Dict[str, Any]]:
        meta, _problem = self._manifest()
        return meta

    def _sender_lock_held(self) -> bool:
        if self.sender_lock_probe is not None:
            return bool(self.sender_lock_probe(self.data_dir))
        pairing = self._pairing()
        try:
            return bool(pairing.sender_lock_held(self.data_dir))
        except Exception:  # noqa: BLE001 - the sender's own lock remains authoritative
            return False

    def _wait_for_daemon(self, handle: Any, token: str) -> Tuple[str, str]:
        deadline = self.clock() + max(self.start_timeout, 0.0)
        while True:
            code = handle.poll()
            if code is not None:
                return "exited", "daemon exited with %s" % code
            health = self._health()
            if health["ok"]:
                node = self._node(token)
                if node["ok"]:
                    return "ok", ""
                if node["status"] in (401, 403):
                    return "conflict", "daemon is healthy but rejected the setup token"
                return "unhealthy", "daemon health ok but node check failed (HTTP %s)" % node["status"]
            if self.clock() >= deadline:
                return "timeout", "daemon did not become healthy within %.0fs" % self.start_timeout
            self.sleep(self.poll_interval)

    def start(self, report: Optional[Dict[str, Any]] = None) -> int:
        blocked = self._block_on_target("start")
        if blocked is not None:
            return blocked
        report = report or self.check()
        if report["blocked"]:
            self._record("start", "blocked", "check is blocked")
            self._save_state()
            return EXIT_PREREQ
        install = self._install_state()
        if not install["installed"]:
            self._record("start", "blocked", "worker is not installed")
            self._save_state()
            self.err("start: BLOCKED: worker is not installed")
            return EXIT_PREREQ
        token = self._token(create=False)
        node = self._node_section()
        daemon_state = ""
        health = self._health()
        if health["ok"]:
            if not token:
                self._record("start", "conflict",
                             "a worker answers on %s but no local daemon token exists" % node["origin"])
                self._save_state()
                self.err("start: BLOCKED: %s already has a worker, but this data dir has no token "
                         "to prove it is the same worker; stop it or use its data dir" % node["origin"])
                return EXIT_PREREQ
            existing = self._node(token)
            if existing["ok"]:
                daemon_state = "already-running"
            elif existing["status"] in (401, 403):
                self._record("start", "conflict",
                             "a worker answers on %s but rejected this token" % node["origin"])
                self._save_state()
                self.err("start: BLOCKED: %s already has a worker that does not accept this "
                         "data dir's token; stop it or use its data dir" % node["origin"])
                return EXIT_PREREQ
            else:
                self._record("start", "failed", "existing service is not a usable worker")
                self._save_state()
                self.err("start: BLOCKED: something answers on %s but is not this worker" % node["origin"])
                return EXIT_NETWORK
        elif self.port_open(node["host"], node["port"]):
            self._record("start", "failed", "port is in use by an unresponsive service")
            self._save_state()
            self.err("start: BLOCKED: %s:%s is already in use and did not answer /healthz; "
                     "stop the other service first" % (node["host"], node["port"]))
            return EXIT_PREREQ
        else:
            if not token:
                token = self._token(create=True)
            if not token:
                self._record("start", "blocked", "private daemon token unavailable")
                self._save_state()
                self.err("start: BLOCKED: private daemon token is unavailable")
                return EXIT_PREREQ
            env = self._env()
            env[node["token_env"]] = token
            argv = [str(install["dendrite"]), "serve", "--config", str(self.config)]
            log_path = self._log_path("setup-daemon.log")
            try:
                handle = self.spawner(argv, cwd=self.root, env=env, log_path=log_path)
            except OSError as exc:
                self._record("start", "failed", "daemon could not start: " + redact(exc))
                self._save_state()
                self.err("start: FAILED: daemon could not start: " + redact(exc))
                return EXIT_PREREQ
            self.state.setdefault("processes", {})["daemon"] = {
                "pid": getattr(handle, "pid", None), "origin": node["origin"],
                "log": str(log_path), "started_at": utc_now()}
            result, detail = self._wait_for_daemon(handle, token)
            if result == "ok":
                daemon_state = "started"
            else:
                handle.terminate()
                handle.wait(5.0)
                self._record("start", "failed", detail)
                self._save_state()
                self.err("start: FAILED: " + detail)
                tail = self._log_tail(log_path, (token,))
                if tail:
                    self.err(tail)
                return EXIT_PREREQ if result == "conflict" else EXIT_NETWORK

        meta = self._load_meta()
        if meta is None:
            self._record("start", "partial", "daemon " + daemon_state + "; sender skipped (not paired)")
            self._save_state()
            self.out("start: daemon %s at %s; sender skipped because the worker is not paired"
                     % (daemon_state, node["origin"]))
            return EXIT_OK

        if self._sender_lock_held():
            self._record("start", "passed", "daemon " + daemon_state + "; sender already running")
            self._save_state()
            self.out("start: daemon %s; sender already running (one sender per data dir)"
                     % daemon_state)
            return EXIT_OK

        argv = [str(install["python"]), str(self.setup_root / "pairing.py"),
                "--data-dir", str(self.data_dir), "heartbeat-loop",
                "--config", str(self.config)]
        log_path = self._log_path("setup-sender.log")
        try:
            sender = self.spawner(argv, cwd=self.setup_root, env=self._env(), log_path=log_path)
        except OSError as exc:
            self._record("start", "failed", "sender could not start: " + redact(exc))
            self._save_state()
            self.err("start: FAILED: sender could not start: " + redact(exc))
            return EXIT_PREREQ
        self.state.setdefault("processes", {})["sender"] = {
            "pid": getattr(sender, "pid", None), "log": str(log_path), "started_at": utc_now()}
        heartbeat = self._wait_for_heartbeat(sender)
        if heartbeat == "exited-6":
            self._record("start", "passed", "daemon " + daemon_state + "; sender already running")
            self._save_state()
            self.out("start: daemon %s; another sender already owns the data dir" % daemon_state)
            return EXIT_OK
        if heartbeat == "exited-4":
            self._record("start", "repair-required", "sender key requires a fresh pairing")
            self._save_state()
            self.err("start: REPAIR REQUIRED: the sender key was revoked/expired; pair again")
            return EXIT_PAIRING
        if heartbeat.startswith("exited"):
            self._record("start", "failed", "sender " + heartbeat)
            self._save_state()
            self.err("start: FAILED: sender " + heartbeat)
            tail = self._log_tail(log_path, (meta.get("heartbeat_key"),))
            if tail:
                self.err(tail)
            return EXIT_NETWORK
        if heartbeat == "fresh":
            self._record("start", "passed", "daemon " + daemon_state + "; sender heartbeat ok")
            self._save_state()
            self.out("start: daemon %s; sender heartbeat observed (reachability only)" % daemon_state)
            return EXIT_OK
        self._record("start", "passed", "daemon " + daemon_state + "; sender started; heartbeat not yet observed")
        self._save_state()
        self.out("start: daemon %s; sender started; no heartbeat observed within %.0fs "
                 "(not proof of reachability or inference)" % (daemon_state, self.heartbeat_wait))
        return EXIT_OK

    def _wait_for_heartbeat(self, handle: Any) -> str:
        deadline = self.clock() + max(self.heartbeat_wait, 0.0)
        while True:
            code = handle.poll()
            if code is not None:
                return "exited-%s" % code
            beat = self._heartbeat()
            if beat.get("state") == "fresh":
                return "fresh"
            if self.clock() >= deadline:
                return "pending"
            self.sleep(self.poll_interval)

    def _heartbeat(self) -> Dict[str, Any]:
        pairing = self._pairing()
        meta = self._load_meta()
        if meta is None:
            return {"state": "not-paired"}
        files = pairing.pairing_files(self.data_dir)
        if not files["status"].exists():
            return {"state": "awaiting"}
        try:
            record = json.loads(files["status"].read_text(encoding="utf-8"))
            if not isinstance(record, dict):
                return {"state": "unreadable"}
            if record.get("pairing_generation") != pairing.pairing_status_binding(meta):
                return {"state": "awaiting-current-generation"}
            fresh = record.get("ok") is True and (
                time.time() - float(record.get("at", 0)) <= pairing.STATUS_STALE_SEC)
            return {"state": "fresh" if fresh else ("stale" if record.get("ok") is True else "failed"),
                    "ok": record.get("ok"), "usable": bool(record.get("usable")),
                    "heartbeatAt": record.get("heartbeatAt"),
                    "code": record.get("code")}
        except (OSError, ValueError, TypeError):
            return {"state": "unreadable"}

    def _facts_document(self, heartbeat: Dict[str, Any],
                        inference_state: str) -> Dict[str, Any]:
        """The five readiness facts as data, with their evidence source."""
        install = self._install_state()
        paired = heartbeat.get("state") != "not-paired"
        fresh = heartbeat.get("state") == "fresh"
        usable = "yes" if fresh and heartbeat.get("usable") is True else (
            "false" if fresh else "unknown")
        if inference_state == "mock-simulated":
            qualified = "no (mock only; simulated output is not a qualification)"
        elif inference_state in ("real-inference-exercised", "unknown"):
            qualified = "no (one execute request is not qualification evidence)"
        else:
            qualified = "no (not exercised)"
        return {
            "installed": {"value": "yes" if install["installed"] else
                          ("partial" if install["partial"] else "no"),
                          "source": "local .venv and dendrite"},
            "paired": {"value": "yes" if paired else "no",
                       "source": "private pairing store"},
            "reachable": {"value": "yes" if fresh else "no",
                          "source": "fresh authenticated heartbeat",
                          "observed_at": heartbeat.get("heartbeatAt")},
            "usable": {"value": usable, "source": "last heartbeat flag",
                       "authoritative": False},
            "inference_qualified": {"value": qualified,
                                    "source": "explicit execute request" if
                                    inference_state == "real-inference-exercised"
                                    else "not exercised"},
        }

    def _emit_facts(self, heartbeat: Dict[str, Any], inference_state: str) -> None:
        """List the readiness facts separately, each with its evidence source.

        The declared target is connection. A mock heartbeat with usable=false
        completes that target; it never becomes usability or qualification.
        """
        facts = self._facts_document(heartbeat, inference_state)
        self.last_facts = facts
        self.last_heartbeat = heartbeat
        self.out("verify: target=connection (usability and inference are separate facts)")
        self.out("verify: fact installed=%s (%s)"
                 % (facts["installed"]["value"], facts["installed"]["source"]))
        self.out("verify: fact paired=%s (%s)"
                 % (facts["paired"]["value"], facts["paired"]["source"]))
        self.out("verify: fact reachable=%s (%s at %s)"
                 % (facts["reachable"]["value"], facts["reachable"]["source"],
                    heartbeat.get("heartbeatAt") or "none"))
        self.out("verify: fact usable=%s (last heartbeat flag; not authoritative controller readiness)"
                 % facts["usable"]["value"])
        self.out("verify: fact inference-qualified=%s" % facts["inference_qualified"]["value"])

    # -- structured status (ONB 10) ------------------------------------------
    def status_document(self, command: str, exit_code: int) -> Dict[str, Any]:
        """One versioned machine-readable result; agrees with the exit code."""
        outcome = {
            EXIT_OK: "complete",
            EXIT_USAGE: "failed",
            EXIT_PREREQ: "blocked",
            EXIT_PAIRING: "blocked",
            EXIT_NETWORK: "incomplete",
            EXIT_SENDER_RUNNING: "complete",
            EXIT_BUSY: "blocked",
            EXIT_INTERRUPTED: "cancelled",
        }.get(exit_code, "failed")
        phase = {"run": "verify", "check": "check", "install": "install",
                 "pair": "pair", "start": "start", "verify": "verify",
                 "status": "status"}.get(command, command)
        record = self.state.get("phases", {}).get(phase) or {}
        reason = None
        if exit_code != EXIT_OK:
            blocked = self.last_blocked[0] if self.last_blocked else None
            reason = {"code": blocked["code"] if blocked else record.get("state", "UNKNOWN"),
                      "detail": redact(blocked["detail"] if blocked else record.get("detail", ""))}
        facts = self.last_facts or self._facts_document(
            self.last_heartbeat or self._heartbeat(), "not-exercised")
        document = {
            "schema": STATUS_SCHEMA,
            "command": command,
            "target": "connection",
            "outcome": outcome,
            "stage": phase,
            "exit_code": int(exit_code),
            "retryable": outcome in ("blocked", "incomplete"),
            "next_action": self._next_action(reason, outcome),
            "facts": facts,
            "observed_at": utc_now(),
        }
        return document

    @staticmethod
    def _next_action(reason: Optional[Dict[str, str]], outcome: str) -> Optional[str]:
        if outcome == "complete":
            return None
        if outcome == "cancelled":
            return "rerun setup to resume from the last verified step"
        code = (reason or {}).get("code") or ""
        return {
            "UV_VERSION": "let the wrapper bootstrap the pinned uv, or install uv 0.12.12",
            "PARTIAL_INSTALL": "remove only local-worker/.venv and rerun install",
            "PYTHON_VERSION": "install Python 3.9+ and rerun setup",
            "UNQUALIFIED_PLATFORM": "run on Windows x64, or pass --allow-unqualified-platform",
            "TARGET_MISMATCH": "run setup on the machine the user selected",
            "TARGET_CHANGED": "run on the original machine, or pass --expect-target with its fingerprint",
            "LOW_DISK": "free at least 1 GiB and rerun setup",
            "UNCERTAIN": "check AIPSTER status/dashboard, then pass --retry-pair",
            "in_progress": "check AIPSTER status/dashboard, then pass --retry-pair",
            "uncertain": "check AIPSTER status/dashboard, then pass --retry-pair",
            "repair-required": "pair again; the sender key was revoked or expired",
        }.get(code, "resolve the reported block and rerun setup")

    def _log_tail(self, path: Path, extra: Sequence[str]) -> str:
        try:
            data = path.read_bytes()[-4096:]
        except OSError:
            return ""
        text = data.decode("utf-8", "replace").strip()
        return redact(text, extra) if text else ""

    # -- verify --------------------------------------------------------------
    def verify(self) -> int:
        try:
            node_cfg = self._node_section()
        except SetupError as exc:
            self._record("verify", "blocked", str(exc))
            self._save_state()
            self.err("verify: BLOCKED: " + str(exc))
            return EXIT_PREREQ
        token = self._token(create=False)
        if not token:
            self._record("verify", "blocked", "private daemon token is missing")
            self._save_state()
            self.err("verify: BLOCKED: private daemon token is missing; run start/setup first")
            return EXIT_PREREQ
        health = self._health()
        if not health["ok"]:
            self._record("verify", "failed", "daemon health check failed")
            self._save_state()
            self.err("verify: FAILED: daemon is not healthy at %s" % node_cfg["origin"])
            return EXIT_NETWORK
        node = self._node(token)
        if not node["ok"]:
            self._record("verify", "failed", "node check failed (HTTP %s)" % node["status"])
            self._save_state()
            self.err("verify: FAILED: /v1/node rejected the check (HTTP %s)" % node["status"])
            return EXIT_PREREQ if node["status"] in (401, 403) else EXIT_NETWORK

        body = node["body"]
        models = body.get("models") if isinstance(body.get("models"), list) else []
        simulated = [m for m in models if isinstance(m, dict) and m.get("simulated") is True]
        real = [m for m in models if isinstance(m, dict) and m.get("simulated") is False]
        self.out("verify: daemon healthy at %s" % node_cfg["origin"])
        self.out("verify: node=%s models=%d (mock=%d, real=%d)"
                 % (body.get("node_id"), len(models), len(simulated), len(real)))

        inference_state = "not-exercised"
        inference_detail = "no execute request was sent"
        if self.verify_inference:
            result = self._execute(token)
            if not result["ok"]:
                self._record("verify", "failed", "inference check failed (HTTP %s)" % result["status"])
                self._save_state()
                self.out("verify: inference=EXERCISE-FAILED (HTTP %s)" % result["status"])
                return EXIT_NETWORK
            response = result["body"]
            if response.get("simulated") is True:
                inference_state = "mock-simulated"
                inference_detail = "mock only: worker returned simulated output (not real inference)"
            elif response.get("simulated") is False:
                inference_state = "real-inference-exercised"
                inference_detail = "worker returned non-simulated output; this exercised the configured engine"
            else:
                inference_state = "unknown"
                inference_detail = "worker response did not declare simulated/real"
            self.out("verify: inference=%s (%s)" % (inference_state, inference_detail))
        else:
            self.out("verify: inference=NOT EXERCISED (health and identity are not inference proof; "
                     "use --verify-inference only when you intend to run the configured engine)")

        heartbeat = self._heartbeat()
        self._emit_facts(heartbeat, inference_state)
        if heartbeat.get("state") == "not-paired":
            self._record("verify", "blocked", "worker is not paired", inference=inference_state)
            self._save_state()
            self.out("verify: heartbeat=NOT PAIRED; setup is incomplete")
            return EXIT_PAIRING
        if heartbeat.get("state") != "fresh":
            self._record("verify", "failed", "heartbeat " + str(heartbeat.get("state")),
                         inference=inference_state)
            self._save_state()
            self.out("verify: heartbeat=%s; reachability NOT verified" % heartbeat.get("state"))
            return EXIT_NETWORK
        self._record("verify", "passed", "health, identity, and fresh heartbeat verified; "
                     "inference=" + inference_state, inference=inference_state)
        self._save_state()
        self.out("verify: heartbeat=reachable usable=%s at=%s (reachability only, never inference-ready)"
                 % (str(heartbeat.get("usable")).lower(), heartbeat.get("heartbeatAt")))
        self.out("verify: PASSED (inference=%s)" % inference_state)
        return EXIT_OK

    # -- status --------------------------------------------------------------
    def status(self) -> int:
        self.out("setup status: data=%s" % self.data_dir)
        self.out("setup status: worker=%s" % self.root)
        install = self._install_state()
        self.out("setup status: install=%s" % ("complete" if install["installed"] else
                                              ("partial" if install["partial"] else "missing")))
        try:
            node = self._node_section()
            self.out("setup status: endpoint=%s (loopback)" % node["origin"])
        except SetupError as exc:
            self.out("setup status: config=%s" % redact(exc))
        for phase in ("check", "install", "pair", "start", "verify"):
            record = self.state.get("phases", {}).get(phase)
            if record:
                self.out("setup status: %-7s %-14s %s" % (
                    phase, record.get("state", "?"), redact(record.get("detail", ""))))
        pairing = self._pairing()
        buffer = io.StringIO()
        try:
            with contextlib.redirect_stdout(buffer), contextlib.redirect_stderr(buffer):
                returncode = pairing.main(["--data-dir", str(self.data_dir), "status"])
        except Exception as exc:  # noqa: BLE001
            returncode = EXIT_USAGE
            buffer.write("pairing status unavailable: %s\n" % redact(exc))
        text = redact(buffer.getvalue()).rstrip()
        if text:
            for line in text.splitlines():
                self.out("setup status: " + line)
        return 0 if returncode == 0 else EXIT_USAGE

    # -- run -----------------------------------------------------------------
    def run(self, code: Any) -> int:
        blocked = self._block_on_target("check")
        if blocked is not None:
            return blocked
        report = self.check()
        self.print_check(report)
        if report["blocked"]:
            self._save_state()
            return EXIT_PREREQ
        install_code = self.install(report)
        if install_code != EXIT_OK:
            return install_code
        # ONB 11: obtain the short-lived code after the slow work, not at launch.
        if callable(code):
            try:
                code = code()
            except SetupError as exc:
                self._record("pair", "blocked", "private pairing code unavailable: " + exc.code)
                self._save_state()
                self.err("pair: " + str(exc))
                return exc.exit_code
            except (OSError, UnicodeError):
                self._record("pair", "blocked", "private pairing-code source failed")
                self._save_state()
                self.err("pair: could not read the private pairing-code source")
                return EXIT_USAGE
        pair_code = self.pair(code)
        start_code = self.start()
        if start_code != EXIT_OK:
            self._save_state()
            return start_code
        verify_code = self.verify()
        if pair_code != EXIT_OK:
            return pair_code
        return verify_code


def _resolve_data_dir(explicit: Optional[str]) -> Path:
    if explicit:
        return Path(explicit).expanduser()
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    import pairing  # noqa: PLC0415
    return Path(pairing.default_data_dir())


def _resolve_config(explicit: Optional[str]) -> Path:
    if not explicit:
        return DEFAULT_CONFIG
    candidate = Path(explicit).expanduser()
    if not candidate.is_absolute():
        candidate = Path.cwd() / candidate
    return candidate.resolve()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="setup_worker.py",
        description="One deterministic, resumable AIPSTER worker onboarding entrypoint.")
    parser.add_argument("command", nargs="?", default="run",
                        choices=["run", "check", "install", "pair", "start", "verify", "status"])
    parser.add_argument("--data-dir", default=None,
                        help="worker data dir (default: AIPSTER_WORKER_DATA or the installed location)")
    parser.add_argument("--config", default=None,
                        help="worker config (default: configs/mock.toml); must bind loopback")
    parser.add_argument("--api-base", default=None, help="AIPSTER API base for pairing")
    parser.add_argument("--name", default=None, help="display-name hint for pairing")
    parser.add_argument("--packet-stdin", action="store_true",
                        help="read the setup packet from a pipe and extract PAIRING CODE privately")
    parser.add_argument("--code-stdin", action="store_true",
                        help="read the code from a pipe, or prompt without echo on a terminal")
    parser.add_argument("--code-fd", type=int, default=None,
                        help="read the code from an inherited descriptor (never from argv)")
    parser.add_argument("--retry-pair", action="store_true",
                        help="allow a new code after an interrupted/uncertain pairing attempt")
    parser.add_argument("--allow-unqualified-platform", action="store_true",
                        help="explicitly allow the untested macOS/Linux adaptation")
    parser.add_argument("--expect-target", default=None, metavar="FINGERPRINT",
                        help="assert the machine the user selected; blocks mutation on mismatch")
    parser.add_argument("--verify-inference", action="store_true",
                        help="send one execute request; default verification never runs inference")
    parser.add_argument("--install-timeout", type=float, default=900.0)
    parser.add_argument("--start-timeout", type=float, default=20.0)
    parser.add_argument("--heartbeat-wait", type=float, default=15.0)
    parser.add_argument("--debug", action="store_true", help="show a traceback for unexpected errors")
    parser.add_argument("--json", action="store_true",
                        help="emit one versioned JSON result on stdout instead of prose")
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return int(exc.code)
    try:
        data_dir = _resolve_data_dir(args.data_dir)
    except Exception as exc:  # noqa: BLE001
        print("setup: BLOCKED: cannot locate the worker data dir: " + redact(exc), file=sys.stderr)
        return EXIT_PREREQ
    try:
        if str(ROOT) not in sys.path:
            sys.path.insert(0, str(ROOT))
        import pairing  # noqa: PLC0415
        api_base = pairing.check_api_base(args.api_base or pairing.DEFAULT_API_BASE)
    except Exception as exc:  # noqa: BLE001
        print("setup: BLOCKED: invalid AIPSTER API base: " + redact(exc), file=sys.stderr)
        return EXIT_USAGE
    config = _resolve_config(args.config)

    code: Any = None
    if args.command == "pair":
        try:
            code = read_private_code(args)
        except SetupError as exc:
            print("setup: " + str(exc), file=sys.stderr)
            return exc.exit_code
        except (OSError, UnicodeError):
            print("setup: could not read the private pairing-code source", file=sys.stderr)
            return EXIT_USAGE
    elif args.command == "run":
        # Deferred: read the packet/code only after install, so a slow
        # prerequisite step cannot consume the short-lived pairing window.
        code = lambda: read_private_code(args)

    session = Setup(root=ROOT, data_dir=data_dir, config=config, api_base=api_base,
                    name=args.name, allow_unqualified=args.allow_unqualified_platform,
                    retry_pair=args.retry_pair, verify_inference=args.verify_inference,
                    expect_target=args.expect_target,
                    install_timeout=args.install_timeout, start_timeout=args.start_timeout,
                    heartbeat_wait=args.heartbeat_wait)
    mutating = args.command in ("run", "install", "pair", "start")
    if args.json:
        # Structured mode: stdout carries exactly one JSON document, so human
        # progress is suppressed rather than mixed into the machine result.
        session.out = lambda _line: None
        session.err = lambda _line: None
    lock = SetupLock(data_dir / "setup.lock")
    try:
        if mutating:
            try:
                acquired = lock.acquire()
            except SetupError as exc:
                if not args.json:
                    print("setup: " + str(exc), file=sys.stderr)
                raise
            if not acquired:
                if args.json:
                    print(json.dumps({"schema": STATUS_SCHEMA, "command": args.command,
                                      "target": "connection", "outcome": "blocked",
                                      "stage": args.command, "exit_code": EXIT_BUSY,
                                      "retryable": True,
                                      "next_action": "wait for the other setup process to finish",
                                      "facts": {}, "observed_at": utc_now()}, sort_keys=True))
                    return EXIT_BUSY
                print("setup: BUSY: another setup process holds %s" % lock.path, file=sys.stderr)
                return EXIT_BUSY
        if args.command == "check":
            report = session.check()
            session.print_check(report)
            rc = EXIT_PREREQ if report["blocked"] else EXIT_OK
        elif args.command == "install":
            rc = session.install()
        elif args.command == "pair":
            rc = session.pair(code)
        elif args.command == "start":
            rc = session.start()
        elif args.command == "verify":
            rc = session.verify()
        elif args.command == "status":
            rc = session.status()
        else:
            rc = session.run(code)
    except SetupError as exc:
        if not args.json:
            print("setup: BLOCKED [%s] %s" % (exc.code, redact(exc)), file=sys.stderr)
        session.last_blocked = [{"code": exc.code, "detail": redact(exc)}]
        rc = exc.exit_code
    except KeyboardInterrupt:
        if not args.json:
            print("setup: interrupted; rerun to resume", file=sys.stderr)
        rc = EXIT_INTERRUPTED
    except Exception as exc:  # noqa: BLE001 - never leak a code/token in a traceback path
        if not args.json:
            if args.debug:
                # A raw traceback carries str(exc), which may contain a credential.
                # Show frames and the exception type only; values go through redact().
                print(sanitized_traceback(exc), file=sys.stderr)
            print("setup: FAILED [INTERNAL] " + redact(exc), file=sys.stderr)
        rc = EXIT_USAGE
    finally:
        lock.release()
    if args.json:
        print(json.dumps(session.status_document(args.command, rc), sort_keys=True))
    return rc


if __name__ == "__main__":
    raise SystemExit(main())

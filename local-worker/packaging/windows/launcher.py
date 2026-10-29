"""First-run setup + foreground server for the installed AIPSTER Worker.

Frozen as `aipster-worker.exe` alongside `dendrite.exe` (same bundle, shared
runtime). Responsibilities are deliberately narrow:

- create the per-user data directory (config, token, state, logs);
- generate a strong API token on first run, stored user-ACL-only;
- inject the token via DENDRITE_API_TOKEN and run the reviewed worker in-process.

The token value is never printed or logged; only its file path is shown.
"""
import argparse
import os
from datetime import datetime, timezone
import secrets
import socket
import subprocess
import sys
from pathlib import Path

APP_NAME = "AIPSTER-Worker"
TOKEN_BYTES = 32  # token_urlsafe(32) -> 43 chars; worker requires >= 32 printable ASCII
MIN_TOKEN_LENGTH = 32


def bundle_dir():
    """Directory holding the frozen exes (or this source tree in dev)."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def data_dir():
    override = os.environ.get("AIPSTER_WORKER_DATA")
    if override:
        return Path(override)
    local = os.environ.get("LOCALAPPDATA")
    if not local:
        raise SystemExit("aipster-worker: LOCALAPPDATA is not set; cannot locate the data directory")
    return Path(local) / APP_NAME


def token_is_strong(value):
    return bool(value) and len(value) >= MIN_TOKEN_LENGTH and all("!" <= c <= "~" for c in value)


def restrict_file(path):
    """Best-effort user-only ACL on Windows; no-op elsewhere (documented)."""
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


def ensure_private_token(path):
    if path.exists():
        value = path.read_text(encoding="utf-8").strip()
        if not token_is_strong(value):
            raise SystemExit(
                f"aipster-worker: {path} does not hold a strong token (>= 32 printable "
                "ASCII characters). Delete it (or run `aipster-worker --rotate-token`) "
                "to generate a fresh one on next start.")
        return value, False
    value = secrets.token_urlsafe(TOKEN_BYTES)
    path.write_text(value + "\n", encoding="utf-8")
    restrict_file(path)
    return value, True


def ensure_setup(data):
    data.mkdir(parents=True, exist_ok=True)
    (data / "state").mkdir(exist_ok=True)
    (data / "logs").mkdir(exist_ok=True)
    config = data / "config.toml"
    fresh_config = False
    if not config.exists():
        template = bundle_dir() / "default.toml"
        config.write_text(template.read_text(encoding="utf-8"), encoding="utf-8")
        fresh_config = True
    return config, fresh_config


class Tee:
    """Mirror a text stream to a log file without ever touching secrets."""

    def __init__(self, stream, logfile):
        self.stream = stream
        self.logfile = logfile

    def write(self, data):
        self.stream.write(data)
        self.logfile.write(data)

    def flush(self):
        self.stream.flush()
        self.logfile.flush()

    def __getattr__(self, name):
        return getattr(self.stream, name)


def build_info():
    try:
        import json
        info = json.loads((bundle_dir() / "BUILD.json").read_text(encoding="utf-8"))
        return f"{info.get('worker_name', 'ganglion-dendrite')} {info.get('worker_version', '?')}" \
            f" (installer build {info.get('installer_build', '?')}, {info.get('source_sha', '?')[:7]})"
    except (OSError, ValueError):
        return "AIPSTER Worker (development bundle)"


def run_server(config, data, inspect_only):
    from dendrite.cli import main as dendrite_main
    from dendrite.config import load_config
    from pydantic import ValidationError
    try:
        loaded = load_config(config)  # fail fast with the worker's own validation messages
    except (OSError, ValueError, ValidationError) as exc:
        # Mirror the worker CLI's own error format (dendrite.cli.main).
        print(f"dendrite: {exc}", file=sys.stderr)
        raise SystemExit(2)
    token_name = loaded.node.token_env
    if os.environ.get(token_name):
        print(f"using {token_name} from the environment")
    else:
        token_path = data / "api-token.txt"
        value, fresh = ensure_private_token(token_path)
        os.environ[token_name] = value
        print(f"token {'generated' if fresh else 'loaded'}: {token_path}")
    print(f"config: {config}")
    print(f"data:   {data}")
    print(f"listen: http://{loaded.node.host}:{loaded.node.port} "
          f"(loopback only: {loaded.node.host in ('127.0.0.1', 'localhost', '::1')})")
    if not inspect_only:
        probe = socket.socket()
        try:
            probe.bind((loaded.node.host, loaded.node.port))
        except OSError:
            print(f"aipster-worker: {loaded.node.host}:{loaded.node.port} is already in use; "
                  "stop the other worker first", file=sys.stderr)
            raise SystemExit(2)
        finally:
            probe.close()
    command = "inspect" if inspect_only else "serve"
    sys.argv = ["dendrite", command, "--config", str(config)]
    dendrite_main()
    if not inspect_only:
        # uvicorn only returns from serve() on startup failure (it logs the
        # reason itself); normalize the residual exit code. A tiny TOCTOU race
        # with the pre-bind check above can still land here.
        raise SystemExit(2)


def main(argv=None):
    parser = argparse.ArgumentParser(description="AIPSTER local worker launcher")
    parser.add_argument("command", nargs="?", choices=["run", "inspect"], default="run")
    parser.add_argument("--rotate-token", action="store_true",
                        help="replace the stored API token with a fresh one and exit")
    parser.add_argument("--version", action="store_true")
    args = parser.parse_args(argv)
    if args.version:
        print(build_info())
        return 0
    data = data_dir()
    config, fresh_config = ensure_setup(data)
    if args.rotate_token:
        token_path = data / "api-token.txt"
        if token_path.exists():
            token_path.unlink()
        ensure_private_token(token_path)
        print(f"rotated token: {token_path} (restart the worker to use it)")
        return 0
    if fresh_config:
        print(f"wrote default config: {config}")
    if args.command == "inspect":
        run_server(config, data, inspect_only=True)
        return 0
    log_path = data / "logs" / "worker.log"
    print(f"logging to: {log_path}")
    with open(log_path, "a", encoding="utf-8") as logfile:
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        logfile.write(f"\n===== {stamp} {build_info()} =====\n")
        logfile.flush()
        real_out, real_err = sys.stdout, sys.stderr
        sys.stdout = Tee(sys.stdout, logfile)
        sys.stderr = Tee(sys.stderr, logfile)
        try:
            print(f"starting {build_info()}")
            run_server(config, data, inspect_only=False)
        finally:
            # Restore before shutdown: interpreter-finalization messages must
            # not go through the closed log handle (yields exit code 120).
            sys.stdout, sys.stderr = real_out, real_err
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

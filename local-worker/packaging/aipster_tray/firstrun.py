"""Shared first-run setup for the installed worker (console + tray entries).

Creates the per-user data directory (config, token, state, logs), generates a
strong API token on first run stored user-ACL-only, and injects it via the
configured env var. The token value is never printed or logged.
"""
import os
import secrets
import subprocess
import sys
from pathlib import Path

APP_NAME = "AIPSTER-Worker"
TOKEN_BYTES = 32  # token_urlsafe(32) -> 43 chars; worker requires >= 32 printable ASCII
MIN_TOKEN_LENGTH = 32


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
                f"aipster: {path} does not hold a strong token (>= 32 printable "
                "ASCII characters). Delete it (or run `aipster-worker --rotate-token`) "
                "to generate a fresh one on next start.")
        return value, False
    value = secrets.token_urlsafe(TOKEN_BYTES)
    path.write_text(value + "\n", encoding="utf-8")
    restrict_file(path)
    return value, True


def ensure_setup(data):
    """Create data dirs + default config. Returns (config_path, fresh_config)."""
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


def build_info():
    try:
        import json
        info = json.loads((bundle_dir() / "BUILD.json").read_text(encoding="utf-8"))
        return f"{info.get('worker_name', 'ganglion-dendrite')} {info.get('worker_version', '?')}" \
            f" (installer build {info.get('installer_build', '?')}, {info.get('source_sha', '?')[:7]})"
    except (OSError, ValueError):
        return "AIPSTER Worker (development bundle)"

"""Shared first-run setup for the installed worker (console + tray entries).

Creates the per-user data directory (config, token, state, logs), generates a
strong API token on first run stored user-ACL-only, and injects it via the
configured env var. The token value is never printed or logged.
"""
import os
import json
import secrets
import subprocess
import sys
import tempfile
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


def _private_path(path, directory=False, verify=False):
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
    script = r'''
$ErrorActionPreference = 'Stop'
$item = [Console]::In.ReadToEnd() | ConvertFrom-Json
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$old = Get-Acl -LiteralPath $item.path
if ($old.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { exit 2 }
if ($item.verify) {
  if (-not $old.AreAccessRulesProtected) { exit 3 }
  $allow = $false
  foreach ($entry in $old.Access) {
    if ($entry.AccessControlType -eq 'Allow') {
      if ($entry.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { exit 4 }
      $allow = $true
    }
  }
  if (-not $allow) { exit 5 }
  exit 0
}
if ($item.directory) {
  $acl = [System.Security.AccessControl.DirectorySecurity]::new()
  $inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', $inherit, 'None', 'Allow')
} else {
  $acl = [System.Security.AccessControl.FileSecurity]::new()
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow')
}
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule($rule)
if ($item.directory) { [System.IO.Directory]::SetAccessControl($item.path, $acl) }
else { [System.IO.File]::SetAccessControl($item.path, $acl) }
'''
    ps = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    result = subprocess.run([str(ps), "-NoProfile", "-NonInteractive", "-Command", script],
                            input=json.dumps({"path": str(path.resolve()), "directory": directory, "verify": verify}),
                            text=True, capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
    return result.returncode == 0


def restrict_file(path):
    return _private_path(path)


def private_directory(path):
    path = Path(path)
    path.mkdir(parents=True, exist_ok=True)
    if not _private_path(path, directory=True):
        raise OSError("cannot establish private worker directory")


def private_token_acl(path):
    """Read-only verification for qualification: SID-based and locale-independent."""
    try:
        return _private_path(path, verify=True)
    except OSError:
        return False


def endpoint_url(host, port):
    return f"http://{'[' + host + ']' if ':' in host else host}:{port}"


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
            if not restrict_file(temp):
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

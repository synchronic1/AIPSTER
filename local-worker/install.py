"""Install the pinned standalone worker from public PyPI into a new local venv."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent


def main():
    uv = shutil.which("uv")
    if not uv:
        raise SystemExit("Install uv 0.12.12 and put it on PATH first.")
    version = subprocess.check_output([uv, "--version"], text=True).split()[1]
    if version != "0.12.12":
        raise SystemExit("This installation is pinned to uv 0.12.12; found " + version)
    if (ROOT / ".venv").exists():
        raise SystemExit("Refusing to reuse an existing .venv; use a clean checkout/directory.")
    subprocess.run([sys.executable, str(ROOT / "verify_vendor.py")], check=True)
    # Pass an allowlist, never inherited index URLs, credentials, proxy or token settings.
    env = {k: v for k, v in os.environ.items() if k.upper() in {
        "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP",
        "LOCALAPPDATA", "APPDATA", "USERPROFILE", "HOME", "LANG", "LC_ALL"
    }}
    env.update(UV_NO_CONFIG="1", UV_NO_CACHE="1", UV_KEYRING_PROVIDER="disabled",
               PYTHONNOUSERSITE="1", PYTHONDONTWRITEBYTECODE="1")
    with tempfile.TemporaryDirectory(prefix="aipster-public-install-") as isolated:
        # Disable netrc and uv's persisted authentication store without altering user files.
        netrc = Path(isolated) / "empty-netrc"
        netrc.write_text("")
        env.update(NETRC=str(netrc), UV_CREDENTIALS_DIR=isolated)
        def run(*args):
            subprocess.run([uv, *args], cwd=ROOT, env=env, check=True)
        run("venv", "--python", "3.12.14", str(ROOT / ".venv"))
        python = ROOT / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        for lock in ("requirements.lock", "build-requirements.lock"):
            run("pip", "install", "--python", str(python), "--require-hashes", "--only-binary", ":all:",
                "--default-index", "https://pypi.org/simple", "-r", str(ROOT / lock))
        run("pip", "install", "--python", str(python), "--no-index", "--no-deps",
            "--no-build-isolation", str(ROOT / "vendor/eif"))
        run("pip", "check", "--python", str(python))
    print("Installed. See README.md; AIPSTER execution remains disabled.")


if __name__ == "__main__":
    main()

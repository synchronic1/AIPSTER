"""Build the Windows x86-64 AIPSTER Worker installer.

Pipeline: verify vendor tree -> fresh CPython 3.12.14 venv -> hash-locked
dependency install (the same `uv pip install --require-hashes --only-binary`
invocation as install.py) -> PyInstaller freeze -> license assembly -> NSIS
installer -> manifest + checksums.

Outputs land in packaging/windows/dist/ (gitignored):
  AIPSTER-Worker-<version>-win64-setup.exe, manifest.json, SHA256SUMS.

Prerequisites: Windows x86-64, uv 0.12.12 on PATH, NSIS 3.x (makensis) on
PATH, network access to pypi.org. Nothing is uploaded anywhere.
"""
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

PACKAGING = Path(__file__).resolve().parent
ROOT = PACKAGING.parent.parent  # local-worker/
REPO = ROOT.parent
INSTALLER_BUILD = "1"
REQUIRED_UV = "0.12.12"

ENV_ALLOW = {"PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "LOCALAPPDATA",
             "APPDATA", "USERPROFILE", "HOME", "LANG", "LC_ALL"}


def step(number, total, message):
    print(f"[step {number}/{total}] {message}", flush=True)


def clean_env(extra=None):
    env = {k: v for k, v in os.environ.items() if k.upper() in ENV_ALLOW}
    env.update(UV_NO_CONFIG="1", UV_NO_CACHE="1", UV_KEYRING_PROVIDER="disabled",
               PYTHONNOUSERSITE="1", PYTHONDONTWRITEBYTECODE="1")
    if extra:
        env.update(extra)
    return env


def run(cmd, env, cwd=ROOT):
    print("+ " + " ".join(str(c) for c in cmd), flush=True)
    subprocess.run(cmd, env=env, cwd=cwd, check=True)


def worker_version():
    text = (ROOT / "vendor/eif/pyproject.toml").read_text(encoding="utf-8")
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("version"):
            return line.split("=", 1)[1].strip().strip("\"'")
    raise SystemExit("cannot parse worker version from vendor/eif/pyproject.toml")


def worker_commit():
    try:
        provenance = json.loads((ROOT / "provenance.json").read_text(encoding="utf-8"))
        for key in ("worker_commit", "source_commit", "commit", "pin"):
            if provenance.get(key):
                return str(provenance[key])
    except (OSError, ValueError):
        pass
    return "unknown (see vendor/eif provenance)"


def git_info():
    def out(*args):
        return subprocess.check_output(["git", *args], cwd=REPO, text=True).strip()
    try:
        return {"sha": out("rev-parse", "HEAD"),
                "dirty": bool(out("status", "--short")),
                "branch": out("rev-parse", "--abbrev-ref", "HEAD")}
    except (OSError, subprocess.CalledProcessError):
        return {"sha": "unknown", "dirty": None, "branch": "unknown"}


def sha256_of(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _payload_files(app_dir):
    return sorted(p.relative_to(app_dir) for p in app_dir.rglob("*") if p.is_file())


def _payload_literal(path):
    value = str(path).replace("/", "\\")
    if any(c in value for c in '\r\n"') or ".." in path.parts or path.is_absolute():
        raise ValueError("unsafe payload path")
    return value.replace("$", "$")


def write_uninstall_files(app_dir, destination):
    """Compile exact payload removal; never recursively delete the chosen directory."""
    files = _payload_files(app_dir)
    lines = [f'Delete "$INSTDIR\\{_payload_literal(p)}"' for p in files]
    dirs = {parent for p in files for parent in p.parents if parent != Path(".")}
    lines += [f'RMDir "$INSTDIR\\{_payload_literal(p)}"' for p in sorted(dirs, key=lambda p: (-len(p.parts), str(p)))]
    destination.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_uninstall_verify(app_dir, destination):
    """Compile exact payload verification; leftover files abort before unregistration."""
    lines = [f'IfFileExists "$INSTDIR\\{_payload_literal(p)}" uninstall_incomplete'
             for p in _payload_files(app_dir)]
    destination.write_text("\n".join(lines) + "\n", encoding="utf-8")


def copy_python_license(python_home, license_dir):
    source = Path(python_home) / "LICENSE.txt"
    if not source.is_file():
        raise SystemExit("pinned CPython distribution is missing LICENSE.txt")
    shutil.copy2(source, license_dir / "CPYTHON-LICENSE.txt")


def write_version_info(path, display, vi):
    numbers = tuple(int(p) for p in vi.split("."))
    path.write_text(
        "VSVersionInfo(\n"
        f"  ffi=FixedFileInfo(filevers={numbers}, prodvers={numbers}, mask=0x3f, flags=0x0,\n"
        "                      OS=0x40004, fileType=0x1, subtype=0x0, date=(0, 0)),\n"
        "  kids=[StringFileInfo([StringTable('040904B0', [\n"
        "    StringStruct('CompanyName', 'AIPSTER'),\n"
        "    StringStruct('FileDescription', 'AIPSTER local worker'),\n"
        f"    StringStruct('FileVersion', '{vi}'),\n"
        "    StringStruct('InternalName', 'aipster-worker'),\n"
        "    StringStruct('LegalCopyright', 'Apache-2.0, see LICENSE'),\n"
        "    StringStruct('ProductName', 'AIPSTER Worker'),\n"
        f"    StringStruct('ProductVersion', '{display}')])]),\n"
        "        VarFileInfo([VarStruct('Translation', [1033, 1200])])]\n"
        ")\n", encoding="utf-8")


def main():
    total = 10
    if os.name != "nt" or platform.machine() not in ("AMD64", "x86_64"):
        raise SystemExit("this script builds the Windows x86-64 installer only")
    uv = shutil.which("uv")
    if not uv:
        raise SystemExit("uv 0.12.12 is required on PATH")
    uv_version = subprocess.check_output([uv, "--version"], text=True).split()[1]
    if uv_version != REQUIRED_UV:
        raise SystemExit(f"pinned to uv {REQUIRED_UV}; found {uv_version}")
    makensis = shutil.which("makensis")
    if not makensis:
        fallback = Path(r"C:\Program Files (x86)\NSIS\makensis.exe")
        if fallback.exists():
            makensis = str(fallback)
    if not makensis:
        raise SystemExit("NSIS makensis is required on PATH (winget install NSIS.NSIS)")
    nsis_version = subprocess.check_output(
        [makensis, "-VERSION"], text=True).strip().lstrip("v")
    if nsis_version != "3.13":
        raise SystemExit(f"pinned to NSIS 3.13; found {nsis_version}")
    version = worker_version()
    vi_version = f"{version}.{INSTALLER_BUILD}"
    artifact = f"AIPSTER-Worker-{version}-win64-setup.exe"
    build_dir = PACKAGING / "build"
    dist_dir = PACKAGING / "dist"
    git = git_info()
    print(f"worker {version} (commit {worker_commit()}), installer build {INSTALLER_BUILD}")
    print(f"source {git['sha']} branch {git['branch']} dirty={git['dirty']}")

    step(1, total, "verify vendor tree and patches")
    run([sys.executable, str(ROOT / "verify_vendor.py"), "--check-patches"], clean_env())

    step(2, total, "fresh build directories")
    for directory in (build_dir, dist_dir):
        if not directory.resolve().is_relative_to(PACKAGING.resolve()):
            raise SystemExit("refusing build cleanup outside packaging/windows")
        if directory.exists():
            shutil.rmtree(directory)
        directory.mkdir(parents=True)

    step(3, total, "create CPython 3.12.14 build venv")
    with tempfile.TemporaryDirectory(prefix="aipster-pkg-") as isolated:
        netrc = Path(isolated) / "empty-netrc"
        netrc.write_text("")
        env = clean_env({"NETRC": str(netrc), "UV_CREDENTIALS_DIR": isolated})
        venv = build_dir / "venv"
        run([uv, "venv", "--python", "3.12.14", str(venv)], env)
        python = venv / "Scripts/python.exe"
        build_python = subprocess.check_output(
            [str(python), "--version"], text=True, env=env).strip()

        step(4, total, "hash-locked dependency install")
        for lock in ("requirements.lock", "build-requirements.lock"):
            run([uv, "pip", "install", "--python", str(python), "--require-hashes",
                 "--only-binary", ":all:", "--default-index", "https://pypi.org/simple",
                 "-r", str(ROOT / lock)], env)
        run([uv, "pip", "install", "--python", str(python), "--require-hashes",
             "--only-binary", ":all:", "--default-index", "https://pypi.org/simple",
             "-r", str(PACKAGING / "installer-build.lock")], env)
        run([uv, "pip", "install", "--python", str(python), "--no-index", "--no-deps",
             "--no-build-isolation", str(ROOT / "vendor/eif")], env)
        run([uv, "pip", "check", "--python", str(python)], env)
        freeze = subprocess.check_output(
            [uv, "pip", "freeze", "--python", str(python)], text=True, env=env)
        (build_dir / "pip-freeze.txt").write_text(freeze, encoding="utf-8")
        pyinstaller_version = next(
            line.split("==", 1)[1] for line in freeze.splitlines()
            if line.startswith("pyinstaller=="))
        run([str(python), str(PACKAGING / "test_packaging.py")], env)

    step(5, total, "stage freeze inputs")
    stage = build_dir / "stage"
    stage.mkdir()
    shutil.copy2(PACKAGING / "default.toml", stage / "default.toml")
    (stage / "BUILD.json").write_text(json.dumps({
        "worker_name": "ganglion-dendrite",
        "worker_version": version,
        "worker_commit": worker_commit(),
        "installer_build": INSTALLER_BUILD,
        "source_sha": git["sha"],
        "built_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }, indent=2), encoding="utf-8")
    write_version_info(stage / "version_info.txt", version, vi_version)

    step(6, total, "freeze with PyInstaller")
    freeze_env = clean_env({
        "AIPSTER_STAGE": str(stage),
        "PATH": f"{venv / 'Scripts'}{os.pathsep}{os.environ.get('SYSTEMROOT', r'C:\Windows')}"
                r"\System32",
    })
    run([str(python), "-m", "PyInstaller", str(PACKAGING / "dendrite.spec"),
         "--distpath", str(build_dir / "freeze"), "--workpath", str(build_dir / "pywork"),
         "--noconfirm", "--clean"], freeze_env, cwd=PACKAGING)
    app_dir = build_dir / "freeze" / "app"

    step(7, total, "smoke-test the frozen app (scrubbed environment)")
    smoke_env = {k: v for k, v in os.environ.items()
                 if k.upper() in {"SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP"}}
    smoke_env["PATH"] = os.path.join(os.environ.get("SYSTEMROOT", r"C:\Windows"), "System32")
    with tempfile.TemporaryDirectory(prefix="aipster-smoke-") as temp:
        config = Path(temp) / "mock.toml"
        config.write_text(
            (ROOT / "configs/mock.toml").read_text(encoding="utf-8")
            .replace('state_dir = "../.state"', 'state_dir = "state"'), encoding="utf-8")
        help_proc = subprocess.run([str(app_dir / "dendrite.exe"), "--help"],
                                   capture_output=True, text=True, env=smoke_env)
        if help_proc.returncode != 0:
            raise SystemExit(f"frozen --help failed: {help_proc.stderr[-2000:]}")
        inspect_proc = subprocess.run(
            [str(app_dir / "dendrite.exe"), "inspect", "--config", str(config)],
            capture_output=True, text=True, env=smoke_env)
        if inspect_proc.returncode != 0:
            raise SystemExit(f"frozen inspect failed: {inspect_proc.stderr[-2000:]}")
        snapshot = json.loads(inspect_proc.stdout)
        if not snapshot["models"] or not snapshot["models"][0]["simulated"]:
            raise SystemExit(f"frozen inspect is not simulated: {inspect_proc.stdout[:500]}")
        tray = app_dir / "aipster-tray.exe"
        if not tray.exists():
            raise SystemExit("frozen bundle is missing aipster-tray.exe")
        tray_env = dict(smoke_env)
        tray_env["AIPSTER_WORKER_DATA"] = str(Path(temp) / "tray-data")
        help_proc = subprocess.run([str(tray), "--help"], capture_output=True, text=True,
                                   env=tray_env, timeout=60)
        if help_proc.returncode != 0:
            raise SystemExit(f"frozen tray --help failed: rc={help_proc.returncode}")
        status_proc = subprocess.run([str(tray), "status"], capture_output=True, text=True,
                                     env=tray_env, timeout=60)
        if status_proc.returncode != 2:
            raise SystemExit(f"frozen tray status without state: rc={status_proc.returncode}")
        print("frozen --help + simulated inspect + tray --help/status: OK")

    step(8, total, "assemble licenses and icons")
    icons_src = PACKAGING / "icons"
    for name in ("tray-ok.ico", "tray-warn.ico", "tray-off.ico"):
        if not (icons_src / name).exists():
            raise SystemExit(f"missing tray icon: run packaging/icon/icon.py ({name})")
    shutil.copytree(icons_src, app_dir / "icons")
    license_dir = app_dir / "licenses"
    (license_dir / "python").mkdir(parents=True)
    shutil.copy2(REPO / "LICENSE", license_dir / "AIPSTER-APACHE-LICENSE.txt")
    shutil.copy2(ROOT / "vendor/eif/LICENSE", license_dir / "DENDRITE-LICENSE")
    shutil.copy2(ROOT / "vendor/eif/NOTICE", license_dir / "DENDRITE-NOTICE")
    shutil.copy2(ROOT / "DEPENDENCIES.json", license_dir / "DEPENDENCIES.json")
    python_home = subprocess.check_output([str(python), "-c", "import sys; print(sys.base_prefix)"], text=True, env=clean_env()).strip()
    copy_python_license(python_home, license_dir)
    (license_dir / "PYINSTALLER-BOOTLOADER-NOTE.txt").write_text(
        "This application was frozen with PyInstaller, which is distributed under\n"
        "GPL-2.0-or-later WITH a bootloader exception. The exception permits the\n"
        "frozen application (bootloader + bundled interpreter + AIPSTER code) to be\n"
        "distributed under the application's own license (Apache-2.0, see\n"
        "AIPSTER-APACHE-LICENSE.txt). No GPL obligations attach to the frozen app\n"
        "beyond this notice. PyInstaller source: https://github.com/pyinstaller/pyinstaller\n",
        encoding="utf-8")
    site_packages = venv / "Lib/site-packages"
    copied = 0
    for dist_info in sorted(site_packages.glob("*.dist-info")):
        target = license_dir / "python" / dist_info.name
        for candidate in list(dist_info.glob("licenses/**/*")) + \
                [p for p in dist_info.iterdir() if
                 p.name.upper().startswith(("LICENSE", "NOTICE", "COPYING"))]:
            if not candidate.is_file():
                continue
            relative = candidate.relative_to(dist_info)
            destination = target / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(candidate, destination)
            copied += 1
    print(f"copied {copied} third-party license files")

    step(9, total, "compile NSIS installer")
    payload_files = [p for p in app_dir.rglob("*") if p.is_file()]
    size_kb = (sum(p.stat().st_size for p in payload_files) + 1023) // 1024
    uninstall_files = stage / "uninstall-files.nsh"
    write_uninstall_files(app_dir, uninstall_files)
    uninstall_verify = stage / "uninstall-verify.nsh"
    write_uninstall_verify(app_dir, uninstall_verify)
    run([makensis, f"/DAPP_VERSION={version}", f"/DVI_VERSION={vi_version}",
         f"/DBUILD={INSTALLER_BUILD}", f"/DAPPDIR={app_dir}", f"/DSIZE_KB={size_kb}",
         f"/DLICENSE={REPO / 'LICENSE'}", f"/DUNINSTALL_FILES={uninstall_files}", f"/DUNINSTALL_VERIFY={uninstall_verify}", f"/DOUTFILE={dist_dir / artifact}",
         str(PACKAGING / "worker.nsi")],
        clean_env())
    installer = dist_dir / artifact

    step(10, total, "manifest and checksums")
    files = [{"path": p.relative_to(app_dir).as_posix(), "sha256": sha256_of(p),
              "size": p.stat().st_size} for p in sorted(payload_files)]
    manifest = {
        "artifact": artifact,
        "artifact_sha256": sha256_of(installer),
        "artifact_size": installer.stat().st_size,
        "worker_name": "ganglion-dendrite",
        "worker_version": version,
        "worker_commit": worker_commit(),
        "installer_build": INSTALLER_BUILD,
        "source_sha": git["sha"],
        "source_branch": git["branch"],
        "source_dirty": git["dirty"],
        "toolchain": {"python": build_python, "uv": uv_version, "nsis": nsis_version,
                      "pyinstaller": pyinstaller_version},
        "locks": ["requirements.lock", "build-requirements.lock",
                  "packaging/windows/installer-build.lock"],
        "payload_files": len(files),
        "payload_size": sum(f["size"] for f in files),
        "files": files,
        "built_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    (dist_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    (dist_dir / "SHA256SUMS").write_text(
        f"{manifest['artifact_sha256']}  {artifact}\n"
        f"{sha256_of(dist_dir / 'manifest.json')}  manifest.json\n", encoding="utf-8")
    print(f"built {installer} ({manifest['artifact_size']} bytes)")
    print(f"sha256 {manifest['artifact_sha256']}")
    print("dashboard entry needs: version "
          f"{version}, sha256 {manifest['artifact_sha256']}, url set by the release owner")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

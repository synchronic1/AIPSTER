# PyInstaller spec for the AIPSTER Worker (Windows). Two console executables share
# one directory: `aipster-worker` (first-run setup + foreground server) and
# `dendrite` (the reviewed worker CLI: serve/inspect). Always built by build.py,
# which stages AIPSTER_STAGE (default.toml, BUILD.json, version_info.txt) and
# runs the venv-installed PyInstaller under CPython 3.12.14.
import os
from pathlib import Path

SPECDIR = Path(SPECPATH)  # noqa: F821 - provided by PyInstaller
STAGE = Path(os.environ.get("AIPSTER_STAGE", SPECDIR))
VERSION_FILE = STAGE / "version_info.txt"

# uvicorn's protocol/lifespan/loop implementations are resolved dynamically at
# runtime; Analysis cannot see them, so they are listed explicitly. Everything
# else is found by static analysis from the dendrite package.
UVICORN_HIDDEN = [
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.protocols.websockets.websockets_impl",
    "uvicorn.lifespan.on",
    "uvicorn.lifespan.off",
    "uvicorn.loops.auto",
    "uvicorn.loops.asyncio",
]

launcher = Analysis(  # noqa: F821
    [str(SPECDIR / "launcher.py")],
    pathex=[],
    binaries=[],
    datas=[(str(STAGE / "default.toml"), "."), (str(STAGE / "BUILD.json"), ".")],
    hiddenimports=list(UVICORN_HIDDEN),
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter", "unittest", "pydoc", "test"],
    noarchive=False,
)
cli = Analysis(  # noqa: F821
    [str(SPECDIR / "cli_entry.py")],
    pathex=[],
    binaries=[],
    datas=[],
    hiddenimports=list(UVICORN_HIDDEN),
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter", "unittest", "pydoc", "test"],
    noarchive=False,
)

launcher_pyz = PYZ(launcher.pure)  # noqa: F821
cli_pyz = PYZ(cli.pure)  # noqa: F821

exe_options = dict(
    exclude_binaries=True,
    console=True,
    # Flat onedir layout: datas (default.toml, BUILD.json) land beside the exes,
    # where the launcher expects them, instead of in _internal/.
    contents_directory=".",
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    version=str(VERSION_FILE) if VERSION_FILE.exists() else None,
)
launcher_exe = EXE(launcher_pyz, launcher.scripts, [], name="aipster-worker", **exe_options)  # noqa: F821,E501
cli_exe = EXE(cli_pyz, cli.scripts, [], name="dendrite", **exe_options)  # noqa: F821

coll = COLLECT(  # noqa: F821
    launcher_exe,
    cli_exe,
    launcher.binaries,
    launcher.datas,
    cli.binaries,
    cli.datas,
    strip=False,
    upx=False,  # UPX packing hurts reproducibility and trips antivirus heuristics
    upx_exclude=[],
    name="app",
)

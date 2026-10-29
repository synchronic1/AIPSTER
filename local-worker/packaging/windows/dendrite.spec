# PyInstaller spec for the AIPSTER Worker (Windows). Three executables share one
# directory: `aipster-tray` (windowed tray controller, the primary desktop
# entry), `aipster-worker` (console launcher + foreground server + tray CLI),
# and `dendrite` (the reviewed worker CLI: serve/inspect). Always built by
# build.py, which stages AIPSTER_STAGE (default.toml, BUILD.json,
# version_info.txt) and runs the venv-installed PyInstaller under CPython
# 3.12.14.
import os
from pathlib import Path

SPECDIR = Path(SPECPATH)  # noqa: F821 - provided by PyInstaller
PACKAGING = SPECDIR.parent  # aipster_tray lives here (shared with future OSes)
STAGE = Path(os.environ.get("AIPSTER_STAGE", SPECDIR))
VERSION_FILE = STAGE / "version_info.txt"
APP_ICON = SPECDIR / "icons" / "tray-ok.ico"

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


def analysis(script, datas=(), hidden=()):
    return Analysis(  # noqa: F821
        [str(SPECDIR / script)],
        pathex=[str(PACKAGING)],
        binaries=[],
        datas=list(datas),
        hiddenimports=list(hidden),
        hookspath=[],
        hooksconfig={},
        runtime_hooks=[],
        excludes=["tkinter", "unittest", "pydoc", "test"],
        noarchive=False,
    )


launcher = analysis("launcher.py",
                    [(str(STAGE / "default.toml"), "."), (str(STAGE / "BUILD.json"), ".")],
                    UVICORN_HIDDEN)
cli = analysis("cli_entry.py", [], UVICORN_HIDDEN)
tray = analysis("tray_entry.py")  # spawns dendrite.exe; imports no uvicorn

launcher_pyz = PYZ(launcher.pure)  # noqa: F821
cli_pyz = PYZ(cli.pure)  # noqa: F821
tray_pyz = PYZ(tray.pure)  # noqa: F821

exe_options = dict(
    exclude_binaries=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=str(APP_ICON) if APP_ICON.exists() else None,
    version=str(VERSION_FILE) if VERSION_FILE.exists() else None,
    # Flat onedir layout: datas (default.toml, BUILD.json) land beside the
    # exes, where the launcher expects them, instead of in _internal/.
    contents_directory=".",
)
launcher_exe = EXE(launcher_pyz, launcher.scripts, [], name="aipster-worker",  # noqa: F821,E501
                   console=True, **exe_options)
cli_exe = EXE(cli_pyz, cli.scripts, [], name="dendrite", console=True, **exe_options)  # noqa: F821,E501
tray_exe = EXE(tray_pyz, tray.scripts, [], name="aipster-tray", console=False,  # noqa: F821,E501
               **exe_options)

coll = COLLECT(  # noqa: F821
    launcher_exe,
    cli_exe,
    tray_exe,
    launcher.binaries,
    launcher.datas,
    cli.binaries,
    cli.datas,
    tray.binaries,
    tray.datas,
    strip=False,
    upx=False,  # UPX packing hurts reproducibility and trips antivirus heuristics
    upx_exclude=[],
    name="app",
)

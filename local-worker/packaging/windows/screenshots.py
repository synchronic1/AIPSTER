"""Capture the real installer UI for UX evidence (needs a desktop session).

Drives the Setup wizard end to end into a temp directory (location prefilled
via /D=, still user-editable on the Directory page), checks the autostart
opt-in to exercise the consent UI, screenshots the installed Start Menu entry
and a running worker console, then drives the uninstaller UI including the
data-preserved notice. Verifies the machine is left clean.

Usage:  python packaging/windows/screenshots.py
Output: packaging/windows/dist/shots/*.png (gitignored)
"""
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

PACKAGING = Path(__file__).resolve().parent
DIST = PACKAGING / "dist"

import ctypes
from ctypes import wintypes

user32 = ctypes.windll.user32


def find_window(title_part, timeout=30):
    deadline = time.monotonic() + timeout
    handle = []
    while time.monotonic() < deadline:
        del handle[:]

        def enum(hwnd, _):
            if user32.IsWindowVisible(hwnd):
                length = user32.GetWindowTextLengthW(hwnd)
                buffer = ctypes.create_unicode_buffer(length + 1)
                user32.GetWindowTextW(hwnd, buffer, length + 1)
                if title_part.lower() in buffer.value.lower():
                    handle.append(hwnd)
            return True

        user32.EnumWindows(ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)(enum), 0)
        if handle:
            return handle[0]
        time.sleep(0.5)
    return None


def window_rect(hwnd):
    rect = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    return rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top


def capture(path, rect=None):
    """Capture a screen region (or fullscreen) to PNG via System.Drawing."""
    if rect is None:
        script = ("Add-Type -AssemblyName System.Windows.Forms,System.Drawing;"
                  "$s=[Windows.Forms.Screen]::PrimaryScreen.Bounds;"
                  "$b=New-Object Drawing.Bitmap($s.Width,$s.Height);"
                  "$g=[Drawing.Graphics]::FromImage($b);"
                  "$g.CopyFromScreen(0,0,0,0,$b.Size);")
    else:
        x, y, w, h = (int(v) for v in rect)
        script = ("Add-Type -AssemblyName System.Drawing;"
                  f"$b=New-Object Drawing.Bitmap({w},{h});"
                  "$g=[Drawing.Graphics]::FromImage($b);"
                  f"$g.CopyFromScreen({x},{y},0,0,$b.Size);")
    script += (f"$b.Save('{path}');$b.Dispose();$g.Dispose()")
    subprocess.run(["powershell", "-NoProfile", "-Command", script], check=True,
                   capture_output=True)


WIZARD_TITLE = "AIPSTER Worker"


def send_keys(text):
    """Send keys only after verifying the wizard still owns the screen.

    Refusing to type blindly: if the wizard was closed externally (e.g. the
    user dismissed it), keystrokes must never land in another application.
    """
    script = ("$ws=New-Object -ComObject WScript.Shell;"
              f"if(-not $ws.AppActivate('{WIZARD_TITLE}')){{exit 3}};"
              "Start-Sleep -Milliseconds 400;"
              f"$ws.SendKeys('{text}')")
    try:
        subprocess.run(["powershell", "-NoProfile", "-Command", script], check=True,
                       capture_output=True)
    except subprocess.CalledProcessError as exc:
        raise SystemExit("wizard window is gone; refusing to send more keystrokes "
                         "(closed externally?)") from exc


def shot_window(shots, name, hwnd, pad=12):
    x, y, w, h = window_rect(hwnd)
    import ctypes as _c
    sw, sh = _c.windll.user32.GetSystemMetrics(0), _c.windll.user32.GetSystemMetrics(1)
    x, y = max(0, x - pad), max(0, y - pad)
    w, h = min(sw - x, w + 2 * pad), min(sh - y, h + 2 * pad)
    path = shots / f"{name}.png"
    capture(str(path), (x, y, w, h))
    print(f"shot {name}.png ({w}x{h})")


def child_texts(hwnd):
    texts = []

    def enum(child, _):
        length = user32.GetWindowTextLengthW(child)
        buffer = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(child, buffer, length + 1)
        if buffer.value:
            texts.append(buffer.value)
        return True

    user32.EnumChildWindows(hwnd,
                            ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)(enum), 0)
    return texts


def all_windows(title_part):
    handles = []

    def enum(hwnd, _):
        if user32.IsWindowVisible(hwnd):
            length = user32.GetWindowTextLengthW(hwnd)
            buffer = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, buffer, length + 1)
            if title_part.lower() in buffer.value.lower():
                handles.append(hwnd)
        return True

    user32.EnumWindows(ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)(enum), 0)
    return handles


def wait_button(title_part, label, timeout=240):
    deadline = time.monotonic() + timeout
    missing = 0
    while time.monotonic() < deadline:
        windows = all_windows(title_part)
        if not windows:
            missing += 1
            if missing >= 3:
                raise SystemExit(f"wizard window vanished while waiting for '{label}' "
                                 "(closed externally?)")
        else:
            missing = 0
            for hwnd in windows:
                if any(label.lower() in text.lower() for text in child_texts(hwnd)):
                    return hwnd
        time.sleep(2)
    return None


def wait_vanish(title_part, timeout=60):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if find_window(title_part, timeout=1) is None:
            return True
    return False


def main():
    if os.environ.get("AIPSTER_SCREENSHOTS_OK") != "1":
        raise SystemExit("refusing to drive the desktop UI without AIPSTER_SCREENSHOTS_OK=1: "
                         "this pops installer windows on the interactive screen, so never run "
                         "it while the user is active")
    setups = sorted(DIST.glob("AIPSTER-Worker-*-win64-setup.exe"))
    if len(setups) != 1:
        raise SystemExit(f"expected exactly one Setup exe in {DIST}")
    setup = setups[0]
    work = Path(tempfile.mkdtemp(prefix="aipster-shots-"))
    install, home = work / "app", work / "home"
    home.mkdir()
    shots = DIST / "shots"
    shots.mkdir(exist_ok=True)
    print(f"install dir: {install}")

    proc = subprocess.Popen([str(setup), f"/D={install}"])
    try:
        wizard = find_window("AIPSTER Worker", timeout=90)
        if wizard is None:
            raise SystemExit("wizard window did not appear")
        time.sleep(1)
        shot_window(shots, "01-welcome", wizard)
        send_keys("{ENTER}"); time.sleep(1.5)  # Welcome -> License
        shot_window(shots, "02-license", find_window("AIPSTER Worker"))
        send_keys("{ENTER}"); time.sleep(1.5)  # I Agree -> Components
        shot_window(shots, "03-components", find_window("AIPSTER Worker"))
        # Keep defaults (autostart off): the opt-in path is qualify-covered via
        # /AUTOSTART=1, and keystroke-toggling the tree proved unreliable.
        send_keys("{ENTER}"); time.sleep(1.5)  # Next -> Directory
        shot_window(shots, "04-directory", find_window("AIPSTER Worker"))
        send_keys("{ENTER}"); time.sleep(3)  # Install -> Installing
        shot_window(shots, "05-installing", find_window("AIPSTER Worker"))
        finish = wait_button("AIPSTER Worker", "Finish", timeout=240)
        if finish is None:
            raise SystemExit("wizard never reached Finish")
        time.sleep(1)
        shot_window(shots, "06-finish", finish)
        send_keys("{ENTER}"); time.sleep(2)  # Close (Start-now stays unchecked)
        if not wait_vanish("AIPSTER Worker", timeout=30):
            raise SystemExit("wizard did not close")
    finally:
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()

    print("installed:", (install / "aipster-worker.exe").exists())
    # Start Menu evidence.
    start_menu = Path(os.environ["APPDATA"]) / \
        "Microsoft/Windows/Start Menu/Programs/AIPSTER Worker"
    print("start menu:", sorted(p.name for p in start_menu.iterdir()) if start_menu.exists() else None)
    subprocess.Popen(["explorer", str(start_menu)])
    explorer = find_window("AIPSTER Worker", timeout=20)
    if explorer:
        # Explorer shows "Working on it..." while populating: wait for the
        # entries (already log-verified above) before shooting, else the PNG
        # catches an empty spinner (seen twice on windows-2025).
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            if any(".lnk" in text for text in child_texts(explorer)):
                break
            time.sleep(1)
        shot_window(shots, "07-start-menu", explorer)
        send_keys("%{F4}")  # close Explorer
    # Running worker console evidence (temp data home, loopback only).
    env = {k: v for k, v in os.environ.items()
           if k.upper() in {"SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP"}}
    env["PATH"] = os.path.join(os.environ.get("SYSTEMROOT", r"C:\Windows"), "System32")
    env["LOCALAPPDATA"] = str(home)
    server = subprocess.Popen([str(install / "aipster-worker.exe")], env=env,
                              creationflags=subprocess.CREATE_NEW_CONSOLE)
    try:
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            try:
                urllib.request.urlopen("http://127.0.0.1:8090/healthz", timeout=2)
                break
            except Exception:
                time.sleep(0.5)
        console = find_window("aipster-worker", timeout=10)
        if console:
            time.sleep(0.5)
            shot_window(shots, "08-worker-console", console)
    finally:
        server.terminate()
        server.wait(timeout=15)
    # Uninstaller UI including the data-preserved notice.
    subprocess.Popen([str(install / "uninstall.exe")])
    uninst = find_window("Uninstall", timeout=60)
    if uninst is None:
        raise SystemExit("uninstaller window did not appear")
    time.sleep(1)
    shot_window(shots, "09-uninstall-confirm", uninst)
    send_keys("{ENTER}"); time.sleep(4)  # confirm -> Remove-data page
    choice = wait_button("AIPSTER Worker", "Also remove my worker data", timeout=60)
    if choice is None:
        raise SystemExit("remove-data page did not appear after the confirm page")
    time.sleep(1)
    shot_window(shots, "10-uninstall-data-choice", choice)
    # Keep the box unchecked (preserve is the default; removal is covered by
    # /REMOVEDATA=1 in qualify) and advance to the progress page.
    send_keys("{ENTER}"); time.sleep(4)
    notice = wait_button("AIPSTER Worker", "preserved", timeout=180)
    if notice:
        # Modal notice first (it blocks the finish page).
        time.sleep(1)
        shot_window(shots, "11-uninstall-data-notice", notice)
        send_keys("{ENTER}"); time.sleep(2)
    finish = wait_button("AIPSTER Worker", "Close", timeout=60)
    if finish:
        shot_window(shots, "12-uninstall-finish", finish)
        send_keys("{ENTER}"); time.sleep(2)
    deadline = time.monotonic() + 180
    while install.exists() and time.monotonic() < deadline:
        time.sleep(0.5)
    removed = not install.exists()
    preserved = (home / "AIPSTER-Worker/api-token.txt").exists()
    print("install removed:", removed)
    print("data preserved:", preserved)
    if not removed or not preserved:
        stuck = find_window("AIPSTER Worker", timeout=5) or find_window("Uninstall", timeout=5)
        if stuck:
            shot_window(shots, "13-uninstall-stuck", stuck)
            print("stuck dialog texts:", child_texts(stuck)[:8])
        raise SystemExit(f"GUI uninstall incomplete (removed={removed} preserved={preserved})")
    import shutil
    shutil.rmtree(work, ignore_errors=True)
    print("shots in", shots)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

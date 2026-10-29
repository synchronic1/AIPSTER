"""Windows single-instance + control IPC for the tray controller.

One tray instance per data directory: a named mutex (suffixed with a short
hash of the data dir so test instances never collide with a live one) plus a
hidden window whose title carries the same suffix. Second launches and the
`tray` CLI find the window and deliver WM_APP commands with SendMessageTimeout
(no broadcast, no network, no new processes left behind).

Message contract (wParam/lParam unused; result 1 = accepted):
  WM_APP+10 ENSURE  start the worker if stopped + status balloon
  WM_APP+11 STOP    stop the worker
  WM_APP+12 START   start the worker
  WM_APP+13 RESTART restart the worker
  WM_APP+14 QUIT    stop the worker and exit the tray
"""
import hashlib
import os
from pathlib import Path

WM_APP = 0x8000
ENSURE, STOP, START, RESTART, QUIT = (WM_APP + 10, WM_APP + 11, WM_APP + 12,
                                      WM_APP + 13, WM_APP + 14)
COMMANDS = {"ensure": ENSURE, "stop": STOP, "start": START, "restart": RESTART,
            "quit": QUIT}

WINDOW_CLASS = "AIPSTER-Worker-Tray"
SMTO_ABORTIFHUNG = 0x0002


def instance_tag(data_dir):
    digest = hashlib.sha1(str(Path(data_dir).resolve()).lower().encode("utf-8")).hexdigest()
    return digest[:8]


def mutex_name(data_dir):
    return f"Local\\AIPSTER-Worker-Tray-{instance_tag(data_dir)}"


def window_title(data_dir):
    return f"AIPSTER Worker [{instance_tag(data_dir)}]"


class SingleInstance:
    """Named mutex guard. held is True when this process owns the instance."""

    def __init__(self, data_dir):
        self.data_dir = data_dir
        self.handle = None
        self.held = False

    def acquire(self):
        # Existence-only protocol: nobody ever waits on this mutex, so a dead
        # previous owner cannot wedge us — the OS destroys its handle and the
        # next CreateMutex starts fresh (no ERROR_ALREADY_EXISTS).
        from .win32 import kernel32
        kernel = kernel32()
        handle = kernel.CreateMutexW(None, False, mutex_name(self.data_dir))
        if not handle:
            raise OSError("CreateMutex failed")
        if kernel.GetLastError() == 183:  # ERROR_ALREADY_EXISTS
            kernel.CloseHandle(handle)
            return False
        self.handle = handle
        self.held = True
        return True

    def release(self):
        if self.handle:
            try:
                from .win32 import kernel32
                kernel32().CloseHandle(self.handle)
            except (OSError, AttributeError):
                pass
            self.handle = None
            self.held = False


def find_window(data_dir):
    """HWND of the running instance for this data dir, or None."""
    import ctypes
    from .win32 import WNDENUMPROC, user32
    user = user32()
    want_class = WINDOW_CLASS
    want_title = window_title(data_dir)
    found = []

    def enum(hwnd, _):
        cls = ctypes.create_unicode_buffer(64)
        user.GetClassNameW(hwnd, cls, 64)
        if cls.value != want_class:
            return True
        length = user.GetWindowTextLengthW(hwnd)
        title = ctypes.create_unicode_buffer(length + 1)
        user.GetWindowTextW(hwnd, title, length + 1)
        if title.value == want_title:
            found.append(hwnd)
        return True

    callback = WNDENUMPROC(enum)  # keep alive for the call
    user.EnumWindows(callback, 0)
    return found[0] if found else None


def send_command(data_dir, command, timeout_ms=5000):
    """Deliver a command to the running instance. Returns (delivered, result)."""
    import ctypes
    from ctypes import wintypes
    from .win32 import user32
    hwnd = find_window(data_dir)
    if not hwnd:
        return False, 0
    result = wintypes.LPARAM(0)
    code = user32().SendMessageTimeoutW(hwnd, COMMANDS[command], 0, 0,
                                        SMTO_ABORTIFHUNG, timeout_ms,
                                        ctypes.byref(result))
    if not code:
        return False, 0
    return True, result.value


def running(data_dir):
    return find_window(data_dir) is not None


def require_windows():
    if os.name != "nt":
        raise SystemExit("tray IPC is Windows-only in this milestone "
                         "(no macOS/Linux backend yet)")

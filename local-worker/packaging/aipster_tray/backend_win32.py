"""Win32 tray backend via ctypes (no new dependencies).

Presents the controller on the interactive desktop: a state-colored tray icon
loaded from the bundled ICOs, a popup menu rendered from state.menu_model, and
balloon notifications. All shell handles (icons, menus) are released on their
own paths; every call is guarded so a shell failure degrades to a log line and
never crashes the controller.

Untestable here without an interactive desktop: reviewed by reading + a
capture driver for the owner VM. Behavior behind the menu (menu model,
actions, states) is covered headless.
"""
import os
from pathlib import Path

from . import state as st
from .backend_base import Backend

WM_TRAY = 0x8000 + 1
NIM_ADD, NIM_MODIFY, NIM_DELETE = 0x0, 0x1, 0x2
NIF_MESSAGE, NIF_ICON, NIF_TIP, NIF_INFO = 0x1, 0x2, 0x4, 0x10
IMAGE_ICON, LR_LOADFROMFILE = 1, 0x10
MF_STRING, MF_SEPARATOR, MF_GRAYED, MF_DISABLED = 0x0, 0x800, 0x1, 0x2
TPM_LEFTALIGN, TPM_RIGHTBUTTON, TPM_RETURNCMD = 0x0, 0x2, 0x100
WM_LBUTTONUP, WM_RBUTTONUP = 0x202, 0x205


def _shell():
    from .win32 import shell32
    return shell32()


def _user32():
    from .win32 import user32
    return user32()


def _notify_struct():
    import ctypes

    class NotifyIconData(ctypes.Structure):
        _fields_ = [("cbSize", ctypes.c_uint), ("hWnd", ctypes.c_void_p),
                    ("uID", ctypes.c_uint), ("uFlags", ctypes.c_uint),
                    ("uCallbackMessage", ctypes.c_uint), ("hIcon", ctypes.c_void_p),
                    ("szTip", ctypes.c_wchar * 128), ("dwState", ctypes.c_uint),
                    ("dwStateMask", ctypes.c_uint), ("szInfo", ctypes.c_wchar * 256),
                    ("uTimeout", ctypes.c_uint), ("szInfoTitle", ctypes.c_wchar * 64),
                    ("dwInfoFlags", ctypes.c_uint), ("guidItem", ctypes.c_byte * 16),
                    ("hBalloonIcon", ctypes.c_void_p)]

    return NotifyIconData


class Win32Backend(Backend):
    name = "win32"

    def __init__(self, log, icons_dir):
        self.log = log
        self.icons_dir = Path(icons_dir)
        self.controller = None
        self.hwnd = None
        self.hicon = None
        self.icon_file = ""
        self.added = False

    # -- lifecycle ------------------------------------------------------
    def attach(self, controller):
        self.controller = controller
        self.hwnd = controller.hwnd
        self._load_icon(st.STATE_ICON[controller.state])
        if self._notify(NIM_ADD, NIF_MESSAGE | NIF_ICON | NIF_TIP,
                        tip=self._tooltip(controller.state, controller.detail)):
            self.added = True
        else:
            self.log("backend=win32 Shell_NotifyIcon(ADD) failed (no taskbar?)")

    def detach(self):
        try:
            if self.added and self.hwnd:
                self._notify(NIM_DELETE, 0)
        except (OSError, AttributeError) as exc:
            self.log(f"backend=win32 detach failed: {exc}")
        finally:
            self.added = False
            self._free_icon()

    def refresh(self, state, detail=""):
        if not self.added:
            return
        want = st.STATE_ICON[state]
        if want != self.icon_file:
            self._load_icon(want)
        self._notify(NIM_MODIFY, NIF_ICON | NIF_TIP, tip=self._tooltip(state, detail))

    def notify(self, event, state="", detail=""):
        if not self.added:
            return
        try:
            title, body = st.balloon_for(event, state, detail)
        except ValueError as exc:
            self.log(f"backend=win32 bad balloon event: {exc}")
            return
        self._notify(NIM_MODIFY, NIF_INFO, info=(title, body))

    # -- tray callback (called from the controller wndproc) --------------
    def on_tray_event(self, msg):
        if msg == WM_RBUTTONUP:
            self._popup()
        elif msg == WM_LBUTTONUP:
            state, detail = self.controller.state, self.controller.detail
            self.notify("reuse", state, detail)

    def _popup(self):
        user32 = _user32()
        items = st.menu_model(self.controller.state, self.controller.endpoint_label(),
                              self.controller.detail,
                              getattr(self.controller, "pairing", None))
        menu = user32.CreatePopupMenu()
        actions = {}
        try:
            next_id = 1000
            for item in items:
                if item["kind"] == "sep":
                    user32.AppendMenuW(menu, MF_SEPARATOR, 0, None)
                elif item["kind"] == "text":
                    user32.AppendMenuW(menu, MF_STRING | MF_GRAYED | MF_DISABLED, 0,
                                       item["label"])
                else:
                    flags = MF_STRING if item["enabled"] else MF_STRING | MF_GRAYED | MF_DISABLED
                    user32.AppendMenuW(menu, flags, next_id, item["label"])
                    actions[next_id] = item["id"]
                    next_id += 1
            import ctypes
            from .win32 import POINT
            point = POINT()
            user32.GetCursorPos(ctypes.byref(point))
            user32.SetForegroundWindow(self.hwnd)
            picked = user32.TrackPopupMenu(menu, TPM_LEFTALIGN | TPM_RIGHTBUTTON | TPM_RETURNCMD,
                                           point.x, point.y, 0, self.hwnd, None)
            user32.PostMessageW(self.hwnd, 0x0000, 0, 0)  # WM_NULL: menu-dismiss dance
            if picked in actions:
                self.controller.menu_action(actions[picked])
        except (OSError, AttributeError) as exc:
            self.log(f"backend=win32 popup failed: {exc}")
        finally:
            try:
                user32.DestroyMenu(menu)
            except (OSError, AttributeError):
                pass

    # -- openers ----------------------------------------------------------
    def open_dashboard(self, url):
        try:
            _shell().ShellExecuteW(None, "open", url, None, None, 1)
        except (OSError, AttributeError) as exc:
            self.log(f"backend=win32 open_dashboard failed: {exc}")
        return url

    def open_logs(self, path):
        try:
            _shell().ShellExecuteW(None, "open", str(path), None, None, 1)
        except (OSError, AttributeError) as exc:
            self.log(f"backend=win32 open_logs failed: {exc}")
        return str(path)

    def open_config(self, path):
        try:
            _shell().ShellExecuteW(None, "open", str(path), None, None, 1)
        except (OSError, AttributeError) as exc:
            self.log(f"backend=win32 open_config failed: {exc}")
        return str(path)

    def copy_text(self, text):
        try:
            import ctypes
            from .win32 import kernel32
            CF_UNICODETEXT, GMEM_MOVEABLE = 13, 0x0002
            user32 = _user32()
            if not user32.OpenClipboard(None):
                raise OSError("OpenClipboard failed")
            try:
                user32.EmptyClipboard()
                data = str(text).encode("utf-16-le") + b"\x00\x00"
                kernel = kernel32()
                handle = kernel.GlobalAlloc(GMEM_MOVEABLE, len(data))
                if not handle:
                    raise OSError("GlobalAlloc failed")
                locked = kernel.GlobalLock(handle)
                if not locked:
                    kernel.GlobalFree(handle)
                    raise OSError("GlobalLock failed")
                ctypes.memmove(locked, data, len(data))
                kernel.GlobalUnlock(handle)
                if not user32.SetClipboardData(CF_UNICODETEXT, handle):
                    kernel.GlobalFree(handle)
                    raise OSError("SetClipboardData failed")
            finally:
                user32.CloseClipboard()
        except (OSError, AttributeError, ValueError) as exc:
            self.log(f"backend=win32 copy_text failed: {exc}")
            return False
        return True

    def run_pair_console(self, exe, args):
        # ShellExecute "open" on the console launcher spawns a visible
        # console window with the no-echo prompt; the tray stays windowed.
        # The code is typed there, never passes through the tray, and is
        # never logged. Every call is guarded like the other openers.
        try:
            _shell().ShellExecuteW(None, "open", str(exe), " ".join(args), None, 1)
        except (OSError, AttributeError) as exc:
            self.log(f"backend=win32 run_pair_console failed: {exc}")
        return (str(exe), list(args))

    # -- internals ----------------------------------------------------------
    def _tooltip(self, state, detail=""):
        tip = f"AIPSTER Worker — {st.STATE_TEXT[state]}"
        if detail and state in (st.PORT_BUSY, st.ERROR):
            tip += f": {detail}"
        return tip[:120]

    def _load_icon(self, filename):
        self._free_icon()
        path = self.icons_dir / filename
        try:
            handle = _user32().LoadImageW(None, str(path), IMAGE_ICON, 0, 0, LR_LOADFROMFILE)
        except (OSError, AttributeError) as exc:
            self.log(f"backend=win32 icon load failed {path}: {exc}")
            return
        if handle:
            self.hicon = handle
            self.icon_file = filename
        else:
            self.log(f"backend=win32 icon load failed {path} (missing file?)")

    def _free_icon(self):
        if self.hicon:
            try:
                _user32().DestroyIcon(self.hicon)
            except (OSError, AttributeError):
                pass
            self.hicon = None
            self.icon_file = ""

    def _notify(self, message, flags, tip="", info=None):
        import ctypes
        try:
            data = _notify_struct()()
            data.cbSize = ctypes.sizeof(data)
            data.hWnd = self.hwnd
            data.uID = 1
            data.uFlags = flags
            data.uCallbackMessage = WM_TRAY
            data.hIcon = self.hicon or 0
            data.szTip = tip[:127]
            if info is not None:
                data.szInfoTitle = info[0][:63]
                data.szInfo = info[1][:255]
                data.uTimeout = 10000
            return bool(_shell().Shell_NotifyIconW(message, ctypes.byref(data)))
        except (OSError, AttributeError, ValueError) as exc:
            self.log(f"backend=win32 notify failed: {exc}")
            return False

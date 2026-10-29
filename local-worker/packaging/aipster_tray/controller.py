"""Tray controller: owns worker state, the child process, IPC, and one backend.

Runs the hidden controller window (required in both modes: it receives the
second-instance and CLI commands), supervises at most one `dendrite serve`
child, and presents state through a backend (real Win32 tray or headless
stub). All decisions are observable via data/state.json and tray.log.

Exit codes: 0 ok (run exits only on Quit; second launch exits 0 after reuse),
2 usage/config/no-instance errors.
"""
import os
import sys
import time
import urllib.request
from pathlib import Path

from . import state as st
from .child import WorkerChild, port_busy, looks_like_bind_error
from .firstrun import (APP_NAME, bundle_dir, build_info, data_dir, ensure_setup,
                       ensure_private_token, private_directory)

HEALTH_TIMEOUT = 25
TICK_SECONDS = 1
HEARTBEAT_SECONDS = 30
RESTART_WINDOW = 300
RESTART_LIMIT = 3
RESTART_DELAYS = (1, 5, 15)
SECOND_LAUNCH_WAIT = 10

_ACTIVE = None  # controller owning this process's window (single instance)


def _health_ok(host, port):
    try:
        with urllib.request.urlopen(st.http_origin(host, port) + "/healthz", timeout=1.5) as r:
            import json
            return json.load(r).get("status") == "ok"
    except Exception:
        return False


class Controller:
    def __init__(self, data, backend, log_lines=False):
        self.data = Path(data)
        self.backend = backend
        self.hwnd = None
        self.taskbar_msg = None
        self.config = None
        self.loaded = None
        self.token_env = "DENDRITE_API_TOKEN"
        self.token_value = ""
        self.child = None
        self.state = st.STOPPED
        self.detail = ""
        self.restarts = []
        self.restart_at = None
        self.health_deadline = None
        self.intentional_stop = False
        self.running = True
        self.last_heartbeat = 0.0
        self.console = log_lines
        self.log_file = None

    # -- logging ---------------------------------------------------------
    def log(self, message):
        line = f"{st.utcnow()} {message}"
        if self.log_file is not None:
            try:
                self.log_file.write(line + "\n")
            except OSError:
                pass
        if self.console:
            print(line, flush=True)

    # -- setup -------------------------------------------------------------
    def prepare(self):
        from .child import RotatingLog
        config, fresh = ensure_setup(self.data)
        self.config = config
        self.log_file = RotatingLog(self.data / "logs" / "tray.log")
        self.log(f"tray start {build_info()} data={self.data} fresh_config={fresh}")
        self.child = WorkerChild(bundle_dir(), self.data / "logs" / "worker.log")
        error = self._reload()
        if error:
            self.set_state(st.ERROR, error)
        else:
            self.set_state(st.STOPPED)

    def _reload(self):
        """(Re)load config + token. Returns an error detail or ''."""
        try:
            from dendrite.config import load_config
            from pydantic import ValidationError
            try:
                self.loaded = load_config(self.config)
            except (OSError, ValueError, ValidationError) as exc:
                return f"bad config: {exc}"
            self.token_env = self.loaded.node.token_env
            self.token_value = os.environ.get(self.token_env, "")
            if not self.token_value:
                try:
                    value, _ = ensure_private_token(self.data / "api-token.txt")
                except SystemExit as exc:
                    return str(exc)
                self.token_value = value
            return ""
        except SystemExit as exc:
            return str(exc)

    def child_env(self):
        system32 = os.path.join(os.environ.get("SYSTEMROOT", r"C:\Windows"), "System32")
        env = {"SYSTEMROOT": os.environ.get("SYSTEMROOT", r"C:\Windows"),
               "WINDIR": os.environ.get("WINDIR", r"C:\Windows"),
               "COMSPEC": os.environ.get("COMSPEC", system32 + r"\cmd.exe"),
               "TEMP": os.environ.get("TEMP", ""), "TMP": os.environ.get("TMP", ""),
               "PATH": system32, self.token_env: self.token_value}
        return {k: v for k, v in env.items() if v}

    # -- state ---------------------------------------------------------------
    def set_state(self, state, detail=""):
        self.state = state
        self.detail = detail
        host = self.loaded.node.host if self.loaded else ""
        port = self.loaded.node.port if self.loaded else 0
        st.write_state(self.data / "state.json", state, detail,
                       self.child.pid() if self.child else None,
                       host, port, len(self.restarts), build_info())
        self.last_heartbeat = time.monotonic()
        try:
            self.backend.refresh(state, detail)
        except Exception as exc:  # noqa: BLE001 - backend must never break us
            self.log(f"backend refresh failed: {exc}")
        self.log(f"state={state} detail={detail}")

    def endpoint_label(self):
        if not self.loaded:
            return ""
        return st.http_origin(self.loaded.node.host, self.loaded.node.port)

    # -- worker ops ------------------------------------------------------------
    def start_worker(self, manual=True):
        if self.state in (st.RUNNING, st.STARTING):
            return True
        error = self._reload()
        if error:
            self.set_state(st.ERROR, error)
            return False
        host, port = self.loaded.node.host, self.loaded.node.port
        if port_busy(host, port):
            if manual:
                self.restarts.clear()
            self.restart_at = None
            self.set_state(st.PORT_BUSY, f"port {port} is already in use")
            self.backend.notify("port_busy", st.PORT_BUSY, str(port))
            return False
        self.log(f"spawning worker {host}:{port}")
        self.child.start(self.config, self.child_env())
        self.log(f"child pid={self.child.pid()} confined={self.child.confined} "
                 f"confine_error={self.child.confine_error!r}")
        if manual:
            self.restarts.clear()
        self.restart_at = None
        self.health_deadline = time.monotonic() + HEALTH_TIMEOUT
        self.set_state(st.STARTING)
        return True

    def stop_worker(self):
        # Cancel any scheduled crash retry first: a stop during the backoff
        # window must win over the automatic restart.
        self.restart_at = None
        self.health_deadline = None
        if self.state == st.STOPPED and not (self.child and self.child.running()):
            return True
        self.intentional_stop = True
        try:
            self.child.stop()
        finally:
            self.intentional_stop = False
        self.set_state(st.STOPPED)
        return True

    def restart_worker(self):
        self.restarts.clear()
        self.stop_worker()
        return self.start_worker()

    def request_quit(self):
        self.log("quit requested")
        self.running = False
        try:
            from .win32 import user32
            user32().PostQuitMessage(0)
        except (OSError, AttributeError):
            pass

    # -- periodic ---------------------------------------------------------------
    def tick(self):
        now = time.monotonic()
        if now - self.last_heartbeat >= HEARTBEAT_SECONDS:
            self.set_state(self.state, self.detail)
            return
        if self.restart_at is not None and now >= self.restart_at \
                and self.state != st.RUNNING:
            # Crash backoff elapsed (state is STOPPED "restarting..."): the dead
            # child is already accounted for, so just fire the retry.
            self.restart_at = None
            self.log("retrying worker start after backoff")
            self.start_worker(manual=False)
            return
        if self.state == st.STARTING:
            code = self.child.exited()
            if code is not None:
                self._classify_exit(code)
            elif self.loaded and _health_ok(self.loaded.node.host, self.loaded.node.port):
                self.set_state(st.RUNNING)
                self.backend.notify("started", st.RUNNING)
            elif now >= (self.health_deadline or now):
                self.log("worker did not become healthy in time")
                self.intentional_stop = True
                try:
                    self.child.stop()
                finally:
                    self.intentional_stop = False
                self.set_state(st.ERROR, "worker did not become healthy")
        elif self.state == st.RUNNING:
            if self.intentional_stop:
                return
            code = self.child.exited()
            if code is not None:
                self._on_crash(code)

    def _classify_exit(self, code):
        host = self.loaded.node.host if self.loaded else ""
        port = self.loaded.node.port if self.loaded else 0
        if looks_like_bind_error(self.child.early_text()) or port_busy(host, port):
            self.set_state(st.PORT_BUSY, f"port {port} is already in use")
            self.backend.notify("port_busy", st.PORT_BUSY, str(port))
        else:
            self._on_crash(code)

    def _on_crash(self, code):
        now = time.monotonic()
        self.restarts.append(now)
        self.restarts = [t for t in self.restarts if now - t < RESTART_WINDOW]
        if len(self.restarts) > RESTART_LIMIT:
            detail = f"worker exited (code {code}); restarts stopped"
            self.set_state(st.ERROR, detail)
            self.backend.notify("giveup", st.ERROR, f"exit code {code}")
            return
        delay = RESTART_DELAYS[min(len(self.restarts) - 1, len(RESTART_DELAYS) - 1)]
        self.log(f"worker exited (code {code}); restart in {delay}s "
                 f"(attempt {len(self.restarts)}/{RESTART_LIMIT})")
        # STOPPED (not STARTING) so the scheduled retry can spawn, and so a
        # manual Start during the backoff overrides it cleanly.
        self.set_state(st.STOPPED, f"restarting after exit code {code}")
        self.backend.notify("restarted", st.STOPPED)
        self.restart_at = now + delay
        self.health_deadline = None  # set when the retry actually spawns

    # -- menu + IPC ---------------------------------------------------------------
    def menu_action(self, action):
        self.log(f"menu action={action}")
        if action == "dashboard":
            self.backend.open_dashboard(st.DASHBOARD_URL)
        elif action == "logs":
            self.backend.open_logs(self.data / "logs")
        elif action == "start":
            self.start_worker()
        elif action == "stop":
            self.stop_worker()
        elif action == "quit":
            self.request_quit()

    def ipc(self, command_id):
        from . import ipc_win32 as ipc
        if command_id == ipc.ENSURE:
            self.backend.notify("reuse", self.state, self.detail)
            if self.state in (st.STOPPED, st.ERROR, st.PORT_BUSY):
                self.start_worker()
        elif command_id == ipc.STOP:
            self.stop_worker()
        elif command_id == ipc.START:
            self.start_worker()
        elif command_id == ipc.RESTART:
            self.restart_worker()
        elif command_id == ipc.QUIT:
            self.request_quit()
        return 1

    def shutdown(self):
        self.log("shutdown: stopping worker, detaching backend")
        try:
            if self.child:
                self.child.stop(timeout=5)
        except Exception as exc:  # noqa: BLE001 - shutdown must complete
            self.log(f"shutdown child stop failed: {exc}")
        try:
            self.backend.detach()
        except Exception as exc:  # noqa: BLE001 - shutdown must complete
            self.log(f"shutdown detach failed: {exc}")
        try:
            self.set_state(st.STOPPED)
        except OSError:
            pass


# -- hidden window ---------------------------------------------------------------
def _wndproc(hwnd, msg, wparam, lparam):
    from .win32 import user32
    user = user32()
    ctl = _ACTIVE
    if ctl is None:
        return user.DefWindowProcW(hwnd, msg, wparam, lparam)
    from . import ipc_win32 as ipc
    from .backend_win32 import WM_TRAY
    if msg == WM_TRAY:
        try:
            ctl.backend.on_tray_event(lparam)
        except Exception as exc:  # noqa: BLE001 - never break the pump
            ctl.log(f"tray event failed: {exc}")
        return 0
    if msg in (ipc.ENSURE, ipc.STOP, ipc.START, ipc.RESTART, ipc.QUIT):
        try:
            return ctl.ipc(msg)
        except Exception as exc:  # noqa: BLE001 - IPC must always answer
            ctl.log(f"ipc failed: {exc}")
            return 0
    if msg == 0x0113:  # WM_TIMER
        try:
            ctl.tick()
        except Exception as exc:  # noqa: BLE001 - never break the pump
            ctl.log(f"tick failed: {exc}")
        return 0
    if msg == 0x0016:  # WM_ENDSESSION, wParam TRUE = ending
        if wparam:
            ctl.running = False
            ctl.shutdown()
        return 0
    if msg == 0x0011:  # WM_QUERYENDSESSION
        return 1
    if ctl.taskbar_msg is not None and msg == ctl.taskbar_msg:
        try:
            ctl.backend.detach()
            ctl.backend.attach(ctl)  # explorer restarted: re-add the icon
        except Exception as exc:  # noqa: BLE001 - never break the pump
            ctl.log(f"taskbar reattach failed: {exc}")
        return 0
    if msg == 0x0002:  # WM_DESTROY
        try:
            user.PostQuitMessage(0)
        except (OSError, AttributeError):
            pass
        return 0
    return user.DefWindowProcW(hwnd, msg, wparam, lparam)


def create_window(data):
    """Register + create the hidden controller window. Returns HWND."""
    import ctypes
    from ctypes import wintypes
    from . import ipc_win32 as ipc
    from .win32 import WNDPROC, kernel32, user32
    user = user32()
    kernel = kernel32()

    class WndClass(ctypes.Structure):
        _fields_ = [("style", ctypes.c_uint), ("lpfnWndProc", WNDPROC),
                    ("cbClsExtra", ctypes.c_int), ("cbWndExtra", ctypes.c_int),
                    ("hInstance", wintypes.HINSTANCE), ("hIcon", ctypes.c_void_p),
                    ("hCursor", ctypes.c_void_p), ("hbrBackground", ctypes.c_void_p),
                    ("lpszMenuName", ctypes.c_wchar_p), ("lpszClassName", ctypes.c_wchar_p)]

    global _WNDPROC_REF
    _WNDPROC_REF = WNDPROC(_wndproc)  # keep alive: GC would crash the pump
    cls = WndClass(0, _WNDPROC_REF, 0, 0, kernel.GetModuleHandleW(None),
                   None, None, None, None, ipc.WINDOW_CLASS)
    atom = user.RegisterClassW(ctypes.byref(cls))
    if not atom and kernel.GetLastError() != 1410:  # not ALREADY_EXISTS
        raise OSError("RegisterClass failed")
    hwnd = user.CreateWindowExW(0x80, ipc.WINDOW_CLASS, ipc.window_title(data), 0,
                                0, 0, 0, 0, None, None,
                                kernel.GetModuleHandleW(None), None)
    if not hwnd:
        raise OSError("CreateWindowEx failed")
    return hwnd


_WNDPROC_REF = None


# -- run loops ---------------------------------------------------------------------
def run_win32(controller):
    import ctypes
    from .win32 import MSG, user32
    user = user32()
    user.SetTimer(controller.hwnd, 1, TICK_SECONDS * 1000, None)
    msg = MSG()
    while user.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
        user.TranslateMessage(ctypes.byref(msg))
        user.DispatchMessageW(ctypes.byref(msg))


def run_headless_loop(controller):
    import ctypes
    from .win32 import MSG, user32
    user = user32()
    msg = MSG()
    last_tick = 0.0
    while controller.running:
        while user.PeekMessageW(ctypes.byref(msg), None, 0, 0, 1):  # PM_REMOVE
            if msg.message == 0x0012:  # WM_QUIT
                controller.running = False
                break
            user.TranslateMessage(ctypes.byref(msg))
            user.DispatchMessageW(ctypes.byref(msg))
        now = time.monotonic()
        if now - last_tick >= TICK_SECONDS:
            last_tick = now
            try:
                controller.tick()
            except Exception as exc:  # noqa: BLE001 - loop must survive
                controller.log(f"tick failed: {exc}")
        time.sleep(0.2)


# -- CLI -----------------------------------------------------------------------------
def _redirect_to_log(data):
    """Windowed exes have no console: send prints to tray.log instead of crashing."""
    if sys.stdout is not None:
        return False
    try:
        data = Path(data)
        private_directory(data)
        (data / "logs").mkdir(exist_ok=True)
        handle = open(data / "logs" / "tray.log", "a", encoding="utf-8")
        sys.stdout = handle
        sys.stderr = handle
        return True
    except OSError:
        return False


def main(argv=None):
    from . import ipc_win32 as ipc
    ipc.require_windows()
    args = list(argv if argv is not None else sys.argv[1:])
    headless = False
    if "--headless" in args:
        headless = True
        args.remove("--headless")
    if os.environ.get("AIPSTER_TRAY_HEADLESS") == "1":
        headless = True
    command = args[0] if args else "run"
    data = data_dir()
    redirected = _redirect_to_log(data)
    console = sys.stdout is not None and not redirected
    if command in ("-h", "--help", "help"):
        print("usage: aipster-tray [run] [--headless] | start | stop | restart | quit | status")
        print("  run     start the tray (reuses a running instance for this data dir)")
        print("  status  print worker state (live when the tray runs, last-known otherwise)")
        print("Data dir: %LOCALAPPDATA%\\AIPSTER-Worker or $AIPSTER_WORKER_DATA.")
        return 0

    if command == "status":
        payload = st.read_state(data / "state.json")
        if payload is None:
            print("AIPSTER Worker tray has never run here (no state file).")
            return 2
        live = ipc.running(data)
        print(st.describe(payload) + (" (live)" if live else " (tray not running)"))
        return 0
    if command in ("start", "stop", "restart", "quit"):
        if not ipc.running(data):
            print(f"no running tray for {data}", file=sys.stderr)
            return 2
        delivered, _ = ipc.send_command(data, command)
        if not delivered:
            print(f"tray did not answer {command}", file=sys.stderr)
            return 2
        print(f"{command} delivered")
        return 0
    if command != "run":
        print(f"unknown command: {command}", file=sys.stderr)
        return 2

    # run: single instance per data dir, else reuse the existing one.
    from .ipc_win32 import SingleInstance
    guard = SingleInstance(data)
    if not guard.acquire():
        deadline = time.monotonic() + SECOND_LAUNCH_WAIT
        delivered = False
        while time.monotonic() < deadline:
            if ipc.running(data):
                delivered, _ = ipc.send_command(data, "ensure")
                if delivered:
                    break
            time.sleep(0.5)
        if delivered:
            print("tray already running for this data dir; reused it")
            return 0
        print("another instance holds the lock but is not responding", file=sys.stderr)
        return 2

    global _ACTIVE
    try:
        hwnd = create_window(data)
    except OSError as exc:
        print(f"cannot create controller window: {exc}", file=sys.stderr)
        guard.release()
        return 2
    controller = Controller(data, None, log_lines=console)
    controller.hwnd = hwnd
    if headless:
        from .backend_headless import HeadlessBackend
        controller.backend = HeadlessBackend(controller.log)
    else:
        from .backend_win32 import Win32Backend
        controller.backend = Win32Backend(controller.log, bundle_dir() / "icons")
    _ACTIVE = controller
    try:
        from .win32 import user32
        controller.taskbar_msg = user32().RegisterWindowMessageW("TaskbarCreated")
    except (OSError, AttributeError):
        controller.taskbar_msg = None
    try:
        try:
            controller.prepare()
        except SystemExit as exc:
            print(f"aipster-tray: {exc}", file=sys.stderr)
            return 2
        controller.backend.attach(controller)
        controller.log(f"backend={controller.backend.name} windowed run")
        # The tray owns a running worker: start on launch (a busy port or bad
        # config becomes a visible state, never a silent exit).
        if controller.state == st.STOPPED:
            controller.start_worker()
        if headless:
            run_headless_loop(controller)
        else:
            run_win32(controller)
    finally:
        _ACTIVE = None
        try:
            controller.shutdown()
        finally:
            try:
                from .win32 import user32
                user32().DestroyWindow(hwnd)
            except (OSError, AttributeError):
                pass
            guard.release()
    return 0

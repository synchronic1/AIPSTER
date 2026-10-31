"""Worker child lifecycle for the tray controller.

Spawns the frozen `dendrite serve` child with no window, captures its output
into a size-bounded rotating log, and classifies fast failures (notably port
conflicts) from its early output so the controller never restart-loops a busy
port. On Windows the child joins a kill-on-close job object, so a parent crash
can never orphan a worker. SenderChild applies the same supervision to the
heartbeat sender (frozen `aipster-worker sender`), which is port-independent:
it runs while serving whether or not the daemon bound its port.
"""
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

CREATE_NO_WINDOW = 0x08000000
LOG_MAX_BYTES = 1 << 20  # 1 MiB per file
LOG_BACKUPS = 3
SNIFF_SECONDS = 5

BIND_MARKERS = ("attempting to bind", "address already in use", "only one usage of each",
                "10048", "10013", "errno 98", "errno 48", "addrinuse")


class RotatingLog:
    """Minimal size-bounded append log: path, path.1 .. path.N (stdlib only)."""

    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.Lock()

    def write(self, text):
        data = text.encode("utf-8", "replace")
        with self.lock:
            with open(self.path, "ab") as handle:
                handle.write(data)
            if self.path.stat().st_size > LOG_MAX_BYTES:
                self._rotate()

    def _rotate(self):
        oldest = self.path.with_name(self.path.name + f".{LOG_BACKUPS}")
        try:
            oldest.unlink()
        except OSError:
            pass
        for i in range(LOG_BACKUPS - 1, 0, -1):
            src = self.path.with_name(self.path.name + f".{i}")
            dst = self.path.with_name(self.path.name + f".{i + 1}")
            try:
                src.rename(dst)
            except OSError:
                pass
        try:
            self.path.rename(self.path.with_name(self.path.name + ".1"))
        except OSError:
            pass


def dendrite_exe(bundle):
    direct = Path(bundle) / ("dendrite.exe" if os.name == "nt" else "dendrite")
    if direct.exists():
        return str(direct)
    found = shutil.which("dendrite")
    if found:
        return found
    raise SystemExit("aipster-tray: dendrite executable not found next to the tray app")


def port_busy(host, port):
    """True when the configured endpoint cannot be bound.

    Resolves like the worker does (IPv4/IPv6/hostnames) and probes every
    result with a matching family: busy only if ALL fail. An unresolvable
    host is not "busy" — the worker itself reports the real config error,
    and the uvicorn output sniff remains the backstop for races.
    """
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except (socket.gaierror, OverflowError, ValueError):
        return False
    if not infos:
        return False
    for family, _, _, _, sockaddr in infos:
        probe = socket.socket(family)
        if family == socket.AF_INET6:
            try:
                probe.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
            except OSError:
                pass
        try:
            # Each address tested independently: busy only if ALL fail.
            probe.bind(sockaddr)
            return False
        except OSError:
            continue
        finally:
            probe.close()
    return True


def looks_like_bind_error(text):
    lowered = text.lower()
    return any(marker in lowered for marker in BIND_MARKERS)


class WorkerChild:
    """Owns at most one dendrite child process plus its log/sniff threads."""

    def __init__(self, bundle, log_path):
        self.bundle = bundle
        self.log = RotatingLog(log_path)
        self.proc = None
        self.job = None
        self.confined = False
        self.confine_error = ""
        self.output_lock = threading.Lock()
        self.early_output = []
        self.started_at = 0.0

    def running(self):
        return self.proc is not None and self.proc.poll() is None

    def pid(self):
        return self.proc.pid if self.running() else None

    def start(self, config, env):
        if self.running():
            return self.proc.pid
        self.stop()  # Reap the previous process/job before replacing either handle.
        cmd = [dendrite_exe(self.bundle), "serve", "--config", str(config)]
        kwargs = {"stdout": subprocess.PIPE, "stderr": subprocess.PIPE,
                  "stdin": subprocess.DEVNULL, "env": env, "cwd": str(Path(config).parent)}
        if os.name == "nt":
            kwargs["creationflags"] = CREATE_NO_WINDOW
        else:
            kwargs["start_new_session"] = True
        self.proc = subprocess.Popen(cmd, **kwargs)
        self.started_at = time.monotonic()
        with self.output_lock:
            self.early_output = []
        self._confine(self.proc)
        for stream in (self.proc.stdout, self.proc.stderr):
            thread = threading.Thread(target=self._drain, args=(stream,), daemon=True)
            thread.start()
        return self.proc.pid

    def _confine(self, proc):
        """Kill-on-close job object (Windows only): the child dies with us.

        Fails observably (never silently) when the process already belongs to
        a job that forbids nesting, e.g. under a sandboxed launcher: a process
        joins one job only. Normal desktop launches are unaffected.
        """
        confined, error, job = assign_kill_on_close(proc.pid)
        self.job = job
        self.confined = confined
        self.confine_error = error
        return confined

    def _drain(self, stream):
        try:
            for raw in iter(stream.readline, b""):
                try:
                    text = raw.decode("utf-8", "replace")
                except Exception:
                    continue
                self.log.write(text)
                if time.monotonic() - self.started_at < SNIFF_SECONDS:
                    with self.output_lock:
                        if len(self.early_output) < 200:
                            self.early_output.append(text)
        except (OSError, ValueError):
            pass

    def early_text(self):
        with self.output_lock:
            return "".join(self.early_output)

    def stop(self, timeout=10):
        proc, self.proc = self.proc, None
        if proc is None:
            self._close_job()
            return
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=10)
        self._close_job()

    def _close_job(self):
        if self.job is not None and os.name == "nt":
            try:
                from .win32 import kernel32
                kernel32().CloseHandle(self.job)
            except (OSError, AttributeError):
                pass
            self.job = None
            self.confined = False

    def exited(self):
        """Return the exit code if the child died, else None (does not clear)."""
        if self.proc is None:
            return None
        return self.proc.poll()


def assign_kill_on_close(pid):
    """Attach a pid to a fresh kill-on-close job. Returns (confined, error, job).

    Shared by the daemon and sender children so a parent crash can orphan
    neither. Non-Windows returns (False, "non-windows", None).
    """
    if os.name != "nt":
        return False, "non-windows", None
    job = None
    try:
        import ctypes
        from .win32 import kernel32

        class BasicLimit(ctypes.Structure):
            _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64),
                        ("PerJobUserTimeLimit", ctypes.c_int64),
                        ("LimitFlags", ctypes.c_uint),
                        ("MinimumWorkingSetSize", ctypes.c_size_t),
                        ("MaximumWorkingSetSize", ctypes.c_size_t),
                        ("ActiveProcessLimit", ctypes.c_uint),
                        ("Affinity", ctypes.c_size_t),
                        ("PriorityClass", ctypes.c_uint),
                        ("SchedulingClass", ctypes.c_uint)]

        class ExtendedLimit(ctypes.Structure):
            _fields_ = [("BasicLimitInformation", BasicLimit),
                        ("IoInfo", ctypes.c_byte * 48),
                        ("ProcessMemoryLimit", ctypes.c_size_t),
                        ("JobMemoryLimit", ctypes.c_size_t),
                        ("PeakProcessMemoryUsed", ctypes.c_size_t),
                        ("PeakJobMemoryUsed", ctypes.c_size_t)]

        kernel = kernel32()
        job = kernel.CreateJobObjectW(None, None)
        if not job:
            return False, f"CreateJobObject failed ({kernel.GetLastError()})", None
        info = ExtendedLimit()
        info.BasicLimitInformation.LimitFlags = 0x2000  # KILL_ON_JOB_CLOSE
        ok = kernel.SetInformationJobObject(job, 4, ctypes.byref(info),
                                            ctypes.sizeof(info))
        if not ok:
            error = f"SetInformationJobObject failed ({kernel.GetLastError()})"
            kernel.CloseHandle(job)
            return False, error, None
        # Least privilege: assignment needs SET_QUOTA + TERMINATE only.
        handle = kernel.OpenProcess(0x0101, False, pid)
        if not handle:
            error = f"OpenProcess failed ({kernel.GetLastError()})"
            kernel.CloseHandle(job)
            return False, error, None
        assigned = kernel.AssignProcessToJobObject(job, handle)
        kernel.CloseHandle(handle)
        if not assigned:
            code = kernel.GetLastError()
            error = f"AssignProcessToJobObject failed ({code})"
            kernel.CloseHandle(job)
            return False, error, None
        return True, "", job
    except (OSError, AttributeError) as exc:
        return False, f"exception: {exc}", job


EXIT_REPAIR_REQUIRED = 4  # sender key revoked/expired: pair again (pairing.EXIT_*)


def sender_argv(bundle, data_dir):
    """Argv for the supervised heartbeat sender (no echo, no secrets)."""
    worker_exe = Path(bundle) / ("aipster-worker.exe" if os.name == "nt" else "aipster-worker")
    if worker_exe.exists():
        # Frozen bundle, or a dev checkout beside a built bundle: same entry.
        return [str(worker_exe), "sender", "--data-dir", str(data_dir)]
    # Source checkout: the launcher module in this same tree.
    launcher = Path(__file__).resolve().parent.parent / "windows" / "launcher.py"
    return [sys.executable, str(launcher), "sender", "--data-dir", str(data_dir)]


class SenderChild:
    """Owns at most one heartbeat-sender child plus its log/drain threads.

    The sender is an outbound HTTPS client: it needs no local port, so the
    controller runs it while serving even when the daemon's port is busy.
    Exit code 4 means the sender key died (pair again); any other nonzero
    exit is reported, never restart-looped (the sender already backs off
    bounded network retries internally).
    """

    def __init__(self, bundle, log_path, data_dir):
        self.bundle = bundle
        self.data_dir = data_dir
        self.log = RotatingLog(log_path)
        self.proc = None
        self.job = None
        self.confined = False
        self.confine_error = ""
        self.last_exit = None

    def running(self):
        return self.proc is not None and self.proc.poll() is None

    def pid(self):
        return self.proc.pid if self.running() else None

    def start(self):
        if self.running():
            return self.proc.pid
        self.stop()  # Reap the previous process/job before replacing either handle.
        cmd = sender_argv(self.bundle, self.data_dir)
        kwargs = {"stdout": subprocess.PIPE, "stderr": subprocess.PIPE,
                  "stdin": subprocess.DEVNULL,
                  "cwd": str(Path(self.data_dir).parent)}
        if os.name == "nt":
            kwargs["creationflags"] = CREATE_NO_WINDOW
        else:
            kwargs["start_new_session"] = True
        try:
            self.proc = subprocess.Popen(cmd, **kwargs)
        except OSError as exc:
            self.last_exit = None
            raise SystemExit(f"aipster-tray: cannot start sender: {exc}")
        self.last_exit = None
        confined, error, job = assign_kill_on_close(self.proc.pid)
        self.job = job
        self.confined = confined
        self.confine_error = error
        for stream in (self.proc.stdout, self.proc.stderr):
            thread = threading.Thread(target=self._drain, args=(stream,), daemon=True)
            thread.start()
        return self.proc.pid

    def _drain(self, stream):
        try:
            for raw in iter(stream.readline, b""):
                try:
                    text = raw.decode("utf-8", "replace")
                except Exception:
                    continue
                # The sender never prints secrets (pairing CLI contract), so
                # its output is safe to retain in the rotating sender log.
                self.log.write(text)
        except (OSError, ValueError):
            pass

    def stop(self, timeout=10):
        proc, self.proc = self.proc, None
        if proc is None:
            self._close_job()
            return
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=10)
        self.last_exit = proc.poll()
        self._close_job()

    def _close_job(self):
        if self.job is not None and os.name == "nt":
            try:
                from .win32 import kernel32
                kernel32().CloseHandle(self.job)
            except (OSError, AttributeError):
                pass
            self.job = None
            self.confined = False

    def exited(self):
        """Return the exit code if the sender died, else None (does not clear)."""
        if self.proc is None:
            return None
        code = self.proc.poll()
        if code is not None:
            self.last_exit = code
        return code

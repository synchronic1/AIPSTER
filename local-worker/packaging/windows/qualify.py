"""Qualify the packaged Windows installer and tray controller.

Two profiles (auto-protection: a live install is never touched):
- full (default when NO live install owns the HKCU singletons): silent
  install from dist/Setup, installer/registry/shortcut/autostart checks, the
  console-launcher server matrix, the tray behavior matrix, uninstall paths
  (preserve default + /REMOVEDATA=1). This is what CI runs on fresh runners.
- coexist (--app-dir PATH): behavior-only against a prebuilt app directory
  (build output). No install, uninstall, registry, or shortcut changes, so it
  runs safely next to Peter's live test installation. Installer paths print
  explicit SKIP lines (deferred to CI/owner VM, never silently dropped).

All test servers use dynamically discovered ports; the live install keeps
port 8090. Every check prints PASS, FAIL, or SKIP; exit code is nonzero on
any FAIL. UI-visible tray screenshots are NOT taken here (no isolated
desktop); see screenshots.py + BUILD-REPORT.md.

Usage:
  python packaging/windows/qualify.py [--app-dir packaging/windows/build/freeze/app]
"""
import json
import os
import secrets
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.error
import winreg
from pathlib import Path

PACKAGING = Path(__file__).resolve().parent
DIST = PACKAGING / "dist"
FAILURES = []
USED_PORTS = set()


def check(name, condition, detail=""):
    print(("PASS " if condition else "FAIL ") + name + (f" -- {detail}" if detail and not condition else ""),
          flush=True)
    if not condition:
        FAILURES.append(name)


def skip(name, reason):
    print(f"SKIP {name} ({reason})", flush=True)


def check_token_acl(name, token_file, scratch_dir, env):
    """Strict SID-based read-only verification; inability to secure tokens is a failure."""
    sys.path.insert(0, str(PACKAGING.parent))
    from aipster_tray.firstrun import private_token_acl
    check(name, private_token_acl(token_file))


def private_fixture_directory(path):
    """Create fresh fixture data through the production owner-provenance contract."""
    sys.path.insert(0, str(PACKAGING.parent))
    from aipster_tray.firstrun import private_directory
    private_directory(Path(path))


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    USED_PORTS.add(port)
    return port


def scrubbed_env():
    env = {k: v for k, v in os.environ.items()
           if k.upper() in {"SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP"}}
    env["PATH"] = os.path.join(os.environ.get("SYSTEMROOT", r"C:\Windows"), "System32")
    return env


def run_silent(cmd, env, timeout=180):
    return subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=timeout)


def wait_gone(path, timeout=180):
    """NSIS uninstall.exe detaches: it exits 0 after spawning a self-copy in
    TEMP that performs the removal. Callers must poll for completion."""
    deadline = time.monotonic() + timeout
    while Path(path).exists() and time.monotonic() < deadline:
        time.sleep(0.5)
    return not Path(path).exists()


def reg_value(root, path, name):
    try:
        with winreg.OpenKey(root, path) as key:
            return winreg.QueryValueEx(key, name)[0]
    except FileNotFoundError:
        return None


def reg_key_exists(root, path):
    try:
        with winreg.OpenKey(root, path):
            return True
    except FileNotFoundError:
        return False


APP_KEY = r"Software\AIPSTER-Worker"
UNINSTALL_KEY = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\AIPSTER-Worker"
RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"


def live_install_detected():
    return reg_key_exists(winreg.HKEY_CURRENT_USER, APP_KEY)


def wait_health(port, timeout=25):
    base = f"http://127.0.0.1:{port}"
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(base + "/healthz", timeout=2) as response:
                if json.load(response).get("status") == "ok":
                    return True
        except Exception:
            time.sleep(0.2)
    return False


def http_status(port, path, data=None, headers=None):
    request = urllib.request.Request(f"http://127.0.0.1:{port}" + path, data=data,
                                     headers=headers or {})
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()
    except urllib.error.URLError:
        return None, b""


def raw_status(port, host_lines, auth):
    with socket.create_connection(("127.0.0.1", port), timeout=5) as conn:
        conn.sendall(f"GET /v1/node HTTP/1.1\r\n{host_lines}{auth}Connection: close\r\n\r\n".encode())
        reply = b""
        while chunk := conn.recv(65536):
            reply += chunk
    return int(reply.split()[1])


def lnk_target(path):
    out = subprocess.run(["powershell", "-NoProfile", "-Command",
                          "(New-Object -ComObject WScript.Shell).CreateShortcut("
                          f"'{path}').TargetPath"],
                         capture_output=True, text=True, timeout=60)
    return out.stdout.strip()


def pe_subsystem(path):
    """2 = windowed (GUI), 3 = console (CUI)."""
    with open(path, "rb") as handle:
        data = handle.read(0x200)
    e_lfanew = struct.unpack("<I", data[0x3C:0x40])[0]
    return struct.unpack("<H", data[e_lfanew + 24 + 68:e_lfanew + 24 + 70])[0]


def ico_entries(path):
    with open(path, "rb") as handle:
        data = handle.read()
    reserved, typ, count = struct.unpack("<HHH", data[:6])
    assert (reserved, typ) == (0, 1), path
    entries = []
    for i in range(count):
        w, h, _, _, _, _, size, offset = struct.unpack("<BBBBHHII", data[6 + 16 * i:22 + 16 * i])
        entries.append((w or 256, h or 256))
        assert data[offset:offset + 8] == b"\x89PNG\r\n\x1a\n", (path, i)
    return entries


def read_state_file(data):
    try:
        return json.loads((Path(data) / "state.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def wait_state(data, want, timeout=30):
    if isinstance(want, str):
        want = {want}
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = read_state_file(data)
        if last and last.get("state") in want:
            return last
        time.sleep(0.5)
    return last


# ---------------------------------------------------------------- pure tests
def pure_tests():
    sys.path.insert(0, str(PACKAGING.parent))
    import aipster_tray.state as st
    from aipster_tray.child import RotatingLog
    from aipster_tray import ipc_win32 as ipc
    check("tray states are exactly the five honest ones",
          st.STATES == ("stopped", "starting", "running", "port_busy", "error"))
    ok = True
    for state in st.STATES:
        model = st.menu_model(state, "http://127.0.0.1:8090", "sample detail")
        labels = [i.get("label", i["kind"]) for i in model]
        actions = [i["id"] for i in model if i["kind"] == "action"]
        if not labels[0].startswith("AIPSTER Worker — "):
            ok = False
        if st.PAIRING_LINE not in labels:
            ok = False
        if not {"dashboard", "logs", "quit"} <= set(actions):
            ok = False
        want_toggle = "stop" if state in ("running", "starting") else "start"
        if want_toggle not in actions or ("start" in actions and "stop" in actions):
            ok = False
        for item in model:
            if item["kind"] == "action" and item["id"] in ("dashboard", "logs", "quit",
                                                           "start", "stop"):
                for word in st.FORBIDDEN_STATUS_WORDS:
                    if word in item["label"].lower():
                        ok = False
    check("menu model per state (toggle, pairing line, no overclaim)", ok)
    events = {e: st.balloon_for(e, "running", "8090") for e in
              ("reuse", "restarted", "giveup", "port_busy", "started", "stopped")}
    check("balloon text for every event",
          all(title == "AIPSTER Worker" and len(body) > 10 for title, body in events.values()))
    try:
        st.check_honest("Connected")
        honest_gate = False
    except ValueError:
        honest_gate = True
    check("honesty gate rejects overclaims", honest_gate)
    with tempfile.TemporaryDirectory(prefix="aipster-rot-") as temp:
        log = RotatingLog(Path(temp) / "test.log")
        chunk = "x" * 10240 + "\n"
        for _ in range(320):  # ~3.2 MB through a 1 MB x3 rotation
            log.write(chunk)
        files = list(Path(temp).glob("test.log*"))
        total = sum(p.stat().st_size for p in files)
        check("log rotation is bounded", len(files) <= 4 and total <= 4 * (1 << 20) + 10240,
              f"{len(files)} files, {total} bytes")
    tag_a = ipc.instance_tag(r"C:\Users\test\AppData\Local\AIPSTER-Worker")
    tag_b = ipc.instance_tag(r"C:\users\TEST\appdata\local\aipster-worker")
    tag_c = ipc.instance_tag(tempfile.gettempdir())
    check("instance tag stable per dir (case-insensitive), distinct across dirs",
          tag_a == tag_b and tag_a != tag_c and len(tag_a) == 8)
    check("http_origin brackets IPv6, leaves IPv4/hostnames plain",
          st.http_origin("::1", 8090) == "http://[::1]:8090"
          and st.http_origin("127.0.0.1", 8090) == "http://127.0.0.1:8090"
          and st.http_origin("localhost", 8090) == "http://localhost:8090")
    check("status line shows a bracketed IPv6 endpoint",
          "endpoint=http://[::1]:8090" in st.describe({"state": "running", "host": "::1",
                                                       "port": 8090}))
    from aipster_tray.child import port_busy
    free = free_port()
    check("port_busy False on a free IPv4 port", port_busy("127.0.0.1", free) is False)
    hold = socket.socket()
    hold.bind(("127.0.0.1", free))
    try:
        check("port_busy True on a bound IPv4 port", port_busy("127.0.0.1", free) is True)
    finally:
        hold.close()
    from unittest.mock import patch
    with patch("socket.getaddrinfo", side_effect=socket.gaierror("synthetic resolver failure")):
        check("port_busy False on an unresolvable host (worker reports the config error)",
              port_busy("synthetic.invalid", free) is False)
    try:
        v6 = socket.socket(socket.AF_INET6)
        v6.bind(("::1", 0))
        v6port = v6.getsockname()[1]
    except OSError:
        skip("port_busy IPv6 literal", "no IPv6 loopback on this box")
    else:
        try:
            check("port_busy True on a bound IPv6 port", port_busy("::1", v6port) is True)
        finally:
            v6.close()
        check("port_busy False on a free IPv6 port", port_busy("::1", v6port) is False)
    pairs = []
    try:
        for family, _, _, _, sockaddr in socket.getaddrinfo("localhost", 0,
                                                             type=socket.SOCK_STREAM):
            if (family, sockaddr[0]) not in pairs:
                pairs.append((family, sockaddr[0]))
    except socket.gaierror:
        pairs = []
    if len(pairs) < 2:
        skip("port_busy multi-address all-fail semantics", "localhost resolves to <2 addresses")
    else:
        multi_port = free_port()
        holders = []
        try:
            for family, addr in pairs[:-1]:
                holder = socket.socket(family)
                if family == socket.AF_INET6:
                    holder.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
                holder.bind((addr, multi_port))
                holders.append(holder)
            one_free = port_busy("localhost", multi_port)
            last = socket.socket(pairs[-1][0])
            if pairs[-1][0] == socket.AF_INET6:
                last.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
            last.bind((pairs[-1][1], multi_port))
            holders.append(last)
            all_held = port_busy("localhost", multi_port)
        finally:
            for holder in holders:
                holder.close()
        check("port_busy multi-address: one free allows, all bound blocks",
              one_free is False and all_held is True, f"one_free={one_free} all={all_held}")
    # Token reload: stub the dendrite/pydantic imports _reload needs so this
    # runs on bare CI python; the frozen-exe rotation proof is T12 below.
    import types
    from types import SimpleNamespace
    saved_modules = {name: sys.modules.get(name)
                     for name in ("dendrite", "dendrite.config", "pydantic")}
    fake_node = SimpleNamespace(token_env="DENDRITE_API_TOKEN", host="127.0.0.1", port=8090)
    fake_config_mod = types.ModuleType("dendrite.config")
    fake_config_mod.load_config = lambda path: SimpleNamespace(node=fake_node)
    fake_dendrite = types.ModuleType("dendrite")
    fake_dendrite.config = fake_config_mod
    fake_pydantic = types.ModuleType("pydantic")
    fake_pydantic.ValidationError = type("ValidationError", (Exception,), {})
    sys.modules["dendrite"] = fake_dendrite
    sys.modules["dendrite.config"] = fake_config_mod
    sys.modules["pydantic"] = fake_pydantic
    try:
        from aipster_tray.controller import Controller
        from aipster_tray.firstrun import ensure_private_token
        backend = SimpleNamespace(refresh=lambda *a: None, notify=lambda *a: None)
        with tempfile.TemporaryDirectory(prefix="aipster-reload-") as temp:
            data = Path(temp) / "worker-data"
            private_fixture_directory(data)
            (data / "config.toml").write_text("[node]\n", encoding="utf-8")
            saved_env = os.environ.get("DENDRITE_API_TOKEN")
            os.environ.pop("DENDRITE_API_TOKEN", None)
            try:
                ctl = Controller(data, backend)
                ctl.config = data / "config.toml"
                first_err = ctl._reload()
                first = ctl.child_env().get(ctl.token_env)
                rotated = secrets.token_urlsafe(32)
                (data / "api-token.txt").write_text(rotated + "\n", encoding="utf-8")
                second_err = ctl._reload()
                second = ctl.child_env().get(ctl.token_env)
                check("restart reload picks up a rotated token file",
                      first_err == "" and second_err == "" and bool(first)
                      and second == rotated and first != rotated)
                check("rotated file token survives ensure_private_token re-read",
                      ensure_private_token(data / "api-token.txt")[0] == rotated)
                fake_node.token_env = "AIPSTER_QUAL_PRESET_TOKEN"
                os.environ["AIPSTER_QUAL_PRESET_TOKEN"] = "preset-env-token-value"
                try:
                    ctl2 = Controller(data, backend)
                    ctl2.config = data / "config.toml"
                    preset_err = ctl2._reload()
                    check("preset parent env wins over the token file",
                          preset_err == ""
                          and os.environ["AIPSTER_QUAL_PRESET_TOKEN"] == "preset-env-token-value"
                          and (data / "api-token.txt").read_text(encoding="utf-8").strip()
                          == rotated)
                finally:
                    os.environ.pop("AIPSTER_QUAL_PRESET_TOKEN", None)
                    fake_node.token_env = "DENDRITE_API_TOKEN"
            finally:
                if saved_env is None:
                    os.environ.pop("DENDRITE_API_TOKEN", None)
                else:
                    os.environ["DENDRITE_API_TOKEN"] = saved_env
    finally:
        for name, module in saved_modules.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module


# ------------------------------------------------------- tray behavior matrix
class TrayLab:
    """Headless tray instances under temp data dirs (no install, no UI)."""

    def __init__(self, app_dir, work):
        self.tray_exe = Path(app_dir) / "aipster-tray.exe"
        self.worker_exe = Path(app_dir) / "aipster-worker.exe"
        self.work = Path(work)
        self.procs = []

    def env_for(self, name):
        data = self.work / name
        private_fixture_directory(data)
        env = scrubbed_env()
        env["AIPSTER_WORKER_DATA"] = str(data)
        return env, data

    def launch(self, env):
        proc = subprocess.Popen([str(self.tray_exe), "--headless"], env=env,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.procs.append(proc)
        return proc

    def cli(self, env, *args):
        return run_silent([str(self.worker_exe), "tray", *args], env)

    def quit_all(self):
        for proc in self.procs:
            try:
                if proc.poll() is None:
                    proc.terminate()
                    proc.wait(timeout=10)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass


def tray_matrix(app_dir, work):
    lab = TrayLab(app_dir, work)
    try:
        # T1: headless run to RUNNING on a dynamic port.
        port = free_port()
        env, data = lab.env_for("tray1")
        (data / "config.toml").write_text(
            f'[node]\nid = "tray-qual"\nhost = "127.0.0.1"\nport = {port}\nstate_dir = "state"\n'
            '\n[[runtimes]]\nid = "mock"\nkind = "mock"\ngpu_layers = 0\n'
            '\n[[models]]\nid = "mock-summary"\nruntime = "mock"\ncapabilities = ["summarize"]\n',
            encoding="utf-8")
        proc = lab.launch(env)
        payload = wait_state(data, "running", timeout=40)
        check("headless tray reaches running", bool(payload and payload["state"] == "running"),
              json.dumps(payload) if payload else "no state file")
        worker_pid = (payload or {}).get("worker_pid")
        check("state carries the worker pid + endpoint",
              bool(worker_pid) and (payload or {}).get("port") == port, json.dumps(payload))
        token = (data / "api-token.txt").read_text(encoding="utf-8").strip()
        code, body = http_status(port, "/v1/execute", data=json.dumps(
            {"capability": "summarize", "model_id": "mock-summary",
             "prompt": "SYNTHETIC TRAY FIXTURE", "max_tokens": 4}).encode(),
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + token})
        check("tray-owned worker serves simulated execute",
              code == 200 and json.loads(body).get("simulated") is True, f"{code} {body[:150]}")

        # T2: second launch reuses (fast exit, same worker, no conflict).
        # A piped stdio reaches the captured pipe; a real windowed launch
        # without pipes goes to tray.log. Accept the message in either place.
        again = run_silent([str(lab.tray_exe), "--headless"], env, timeout=60)
        check("second launch exits 0 (reuse)", again.returncode == 0, f"rc={again.returncode}")
        payload2 = read_state_file(data)
        check("reuse keeps the same worker pid",
              bool(payload2) and payload2.get("worker_pid") == worker_pid, json.dumps(payload2))
        tray_log = (data / "logs" / "tray.log").read_text(encoding="utf-8", errors="replace")
        check("reuse is logged", "already running" in (again.stdout + tray_log))

        # T3: status CLI via the console launcher.
        status = lab.cli(env, "status")
        check("tray status reports live running",
              status.returncode == 0 and "state=running" in status.stdout
              and "(live)" in status.stdout, status.stdout[:200])

        # T4: stop/start/restart via CLI.
        stopped = lab.cli(env, "stop")
        payload = wait_state(data, "stopped", timeout=20)
        check("tray stop reaches stopped",
              stopped.returncode == 0 and bool(payload and payload["state"] == "stopped"))
        with socket.socket() as probe:
            try:
                probe.bind(("127.0.0.1", port))
                port_closed = True
            except OSError:
                port_closed = False
        check("stopped worker releases its port", port_closed)
        started = lab.cli(env, "start")
        payload = wait_state(data, "running", timeout=40)
        check("tray start recovers to running",
              started.returncode == 0 and bool(payload and payload["state"] == "running"))
        pid_before = (payload or {}).get("worker_pid")
        restarted = lab.cli(env, "restart")
        deadline = time.monotonic() + 40
        pid_after = pid_before
        while time.monotonic() < deadline:
            current = read_state_file(data)
            if current and current.get("state") == "running" \
                    and current.get("worker_pid") != pid_before:
                pid_after = current.get("worker_pid")
                break
            time.sleep(0.5)
        check("tray restart replaces the worker",
              restarted.returncode == 0 and pid_after != pid_before,
              f"{pid_before} -> {pid_after}")

        # T5: crash recovery (kill -F the child once).
        victim = read_state_file(data).get("worker_pid")
        subprocess.run(["taskkill", "/F", "/PID", str(victim)], capture_output=True, env=env,
                       timeout=60)
        deadline = time.monotonic() + 45
        recovered, restarts = None, None
        while time.monotonic() < deadline:
            current = read_state_file(data)
            if current and current.get("state") == "running" \
                    and current.get("worker_pid") not in (None, victim):
                recovered, restarts = current.get("worker_pid"), current.get("restarts")
                break
            time.sleep(0.5)
        check("killed worker is restarted automatically",
              recovered is not None and restarts == 1, f"pid={recovered} restarts={restarts}")

        # T6: crash loop gives up bounded (4 rapid kills -> error, then quiet).
        for _ in range(4):
            current = wait_state(data, "running", timeout=45)
            if not current or current.get("state") != "running":
                break
            subprocess.run(["taskkill", "/F", "/PID", str(current["worker_pid"])],
                           capture_output=True, env=env, timeout=60)
            # Wait until the controller notices the death (no stale reads).
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                noticed = read_state_file(data)
                if noticed and (noticed.get("state") != "running"
                                or noticed.get("worker_pid") != current["worker_pid"]):
                    break
                time.sleep(0.3)
        payload = wait_state(data, "error", timeout=60)
        check("crash loop ends in bounded error",
              bool(payload and payload["state"] == "error"
                   and "restarts stopped" in (payload.get("detail") or "")),
              json.dumps(payload) if payload else "no state file")
        quiet_pid = (payload or {}).get("worker_pid")
        time.sleep(8)
        payload = read_state_file(data)
        check("no further restarts after giveup",
              bool(payload) and payload.get("state") == "error"
              and payload.get("worker_pid") == quiet_pid)
        manual = lab.cli(env, "start")
        payload = wait_state(data, "running", timeout=45)
        check("manual start recovers from giveup",
              manual.returncode == 0 and bool(payload and payload["state"] == "running"))

        # T7: confinement is always observable; enforced where the OS allows.
        # Under a sandboxed launcher the process already belongs to a job that
        # forbids nesting, so assignment fails with a logged reason (verified
        # by probe); normal desktop launches confine. The strict orphan kill
        # (T11) runs only when confinement actually engaged.
        tray_log_text = (data / "logs" / "tray.log").read_text(encoding="utf-8",
                                                               errors="replace")
        check("confinement outcome is logged with a reason",
              "confined=True" in tray_log_text
              or ("confined=False" in tray_log_text and "confine_error=" in tray_log_text))
        token = (data / "api-token.txt").read_text(encoding="utf-8").strip()
        haystacks = [(data / "logs" / "tray.log").read_text(encoding="utf-8", errors="replace"),
                     (data / "logs" / "worker.log").read_text(encoding="utf-8", errors="replace"),
                     (data / "state.json").read_text(encoding="utf-8")]
        check("token value absent from tray log, worker log, state file",
              all(token not in hay for hay in haystacks))

        # T8: quit stops everything owned (tray + worker + port).
        quit_proc = lab.cli(env, "quit")
        try:
            proc.wait(timeout=20)
            exited = True
        except subprocess.TimeoutExpired:
            exited = False
        check("tray quit exits the controller",
              quit_proc.returncode == 0 and exited, f"rc={quit_proc.returncode}")
        with socket.socket() as probe:
            try:
                probe.bind(("127.0.0.1", port))
                port_closed = True
            except OSError:
                port_closed = False
        check("quit releases the port", port_closed)
        payload = read_state_file(data)
        check("quit leaves an honest stopped state",
              bool(payload) and payload["state"] == "stopped"
              and payload.get("worker_pid") is None)
        status = lab.cli(env, "status")
        check("status after quit says tray not running",
              status.returncode == 0 and "(tray not running)" in status.stdout,
              status.stdout[:200])
    finally:
        lab.quit_all()

    # T9: port conflict becomes PORT_BUSY (no restart loop), Start retries.
    lab2 = TrayLab(app_dir, work)
    holder = socket.socket()
    holder.bind(("127.0.0.1", 0))
    busy_port = holder.getsockname()[1]
    USED_PORTS.add(busy_port)
    try:
        env, data = lab2.env_for("tray-busy")
        (data / "config.toml").write_text(
            f'[node]\nid = "tray-busy"\nhost = "127.0.0.1"\nport = {busy_port}\n'
            'state_dir = "state"\n\n[[runtimes]]\nid = "mock"\nkind = "mock"\ngpu_layers = 0\n'
            '\n[[models]]\nid = "mock-summary"\nruntime = "mock"\ncapabilities = ["summarize"]\n',
            encoding="utf-8")
        proc = lab2.launch(env)
        payload = wait_state(data, "port_busy", timeout=30)
        check("busy port becomes port_busy (not a crash loop)",
              bool(payload and payload["state"] == "port_busy"
                   and payload.get("restarts") == 0 and payload.get("worker_pid") is None),
              json.dumps(payload) if payload else "no state file")
        holder.close()
        started = lab2.cli(env, "start")
        payload = wait_state(data, "running", timeout=45)
        check("start after freeing the port reaches running",
              started.returncode == 0 and bool(payload and payload["state"] == "running"))
        lab2.cli(env, "quit")
        try:
            proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            pass
    finally:
        try:
            holder.close()
        except OSError:
            pass
        lab2.quit_all()

    # T10: fresh-dir first run (generated config/token/ACL) on a free port.
    lab3 = TrayLab(app_dir, work)
    try:
        env, data = lab3.env_for("tray-fresh")
        proc = lab3.launch(env)
        payload = wait_state(data, ("running", "port_busy"), timeout=45)
        token_file = data / "api-token.txt"
        token = token_file.read_text(encoding="utf-8").strip() if token_file.exists() else ""
        check("fresh tray run generates config + strong token",
              (data / "config.toml").exists() and len(token) == 43
              and all("!" <= c <= "~" for c in token))
        check_token_acl("fresh token file is user-ACL-only", token_file, data, env)
        if payload and payload["state"] == "port_busy":
            # Coexistence: default 8090 is taken; reconfigure and start.
            text = (data / "config.toml").read_text(encoding="utf-8")
            (data / "config.toml").write_text(text.replace("port = 8090", f"port = {free_port()}"),
                                              encoding="utf-8")
            lab3.cli(env, "start")
            payload = wait_state(data, "running", timeout=45)
        check("fresh tray run reaches running",
              bool(payload and payload["state"] == "running"),
              json.dumps(payload) if payload else "no state file")
        check("state file carries version + endpoint",
              bool(payload) and payload.get("port", 0) > 0 and bool(payload.get("version")),
              json.dumps(payload) if payload else "no state file")
        lab3.cli(env, "quit")
        try:
            proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            pass
    finally:
        lab3.quit_all()

    # T11: killing the parent orphans nothing (job object kills the child).
    lab4 = TrayLab(app_dir, work)
    try:
        orphan_port = free_port()
        env, data = lab4.env_for("tray-orphan")
        (data / "config.toml").write_text(
            f'[node]\nid = "tray-orphan"\nhost = "127.0.0.1"\nport = {orphan_port}\n'
            'state_dir = "state"\n\n[[runtimes]]\nid = "mock"\nkind = "mock"\ngpu_layers = 0\n'
            '\n[[models]]\nid = "mock-summary"\nruntime = "mock"\ncapabilities = ["summarize"]\n',
            encoding="utf-8")
        proc = lab4.launch(env)
        payload = wait_state(data, "running", timeout=45)
        victim = (payload or {}).get("worker_pid")
        check("orphan-test worker starts", bool(victim))
        confined_here = "confined=True" in (data / "logs" / "tray.log").read_text(
            encoding="utf-8", errors="replace")
        if victim and not confined_here:
            skip("parent-death orphan kill", "no job confinement in this launcher "
                 "(sandboxed; strict where confined)")
            lab4.cli(env, "quit")
            try:
                proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                pass
        if victim and confined_here:
            proc.terminate()  # parent dies without cleanup; the job must kill the child
            try:
                proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                pass
            deadline = time.monotonic() + 15
            child_gone, port_closed = False, False
            while time.monotonic() < deadline:
                listed = subprocess.run(["tasklist", "/FI", f"PID eq {victim}", "/FO", "CSV",
                                         "/NH"], capture_output=True, text=True, env=env,
                                        timeout=60)
                child_gone = "No tasks" in listed.stdout
                with socket.socket() as probe:
                    try:
                        probe.bind(("127.0.0.1", orphan_port))
                        port_closed = True
                    except OSError:
                        port_closed = False
                if child_gone and port_closed:
                    break
                time.sleep(0.5)
            # Belt and braces: never leave our own child behind on failure.
            if not child_gone:
                subprocess.run(["taskkill", "/F", "/PID", str(victim)], capture_output=True,
                               env=env, timeout=60)
            check("parent death kills the owned child (no orphan)", child_gone)
            check("orphaned port is released", port_closed)
    finally:
        lab4.quit_all()

    # T12: token rotation takes effect on restart (stop, replace file, start).
    lab5 = TrayLab(app_dir, work)
    try:
        rotate_port = free_port()
        env, data = lab5.env_for("tray-rotate")
        (data / "config.toml").write_text(
            f'[node]\nid = "tray-rotate"\nhost = "127.0.0.1"\nport = {rotate_port}\n'
            'state_dir = "state"\n\n[[runtimes]]\nid = "mock"\nkind = "mock"\ngpu_layers = 0\n'
            '\n[[models]]\nid = "mock-summary"\nruntime = "mock"\ncapabilities = ["summarize"]\n',
            encoding="utf-8")
        proc = lab5.launch(env)
        payload = wait_state(data, "running", timeout=45)
        check("rotation-test worker starts", bool(payload and payload["state"] == "running"))
        old_token = (data / "api-token.txt").read_text(encoding="utf-8").strip()
        payload_bytes = json.dumps(
            {"capability": "summarize", "model_id": "mock-summary",
             "prompt": "SYNTHETIC ROTATE FIXTURE", "max_tokens": 4}).encode()
        json_headers = {"Content-Type": "application/json"}
        code, _ = http_status(rotate_port, "/v1/execute", data=payload_bytes,
                              headers=json_headers | {"Authorization": "Bearer " + old_token})
        check("worker serves with the filed token before rotation", code == 200, str(code))
        lab5.cli(env, "stop")
        wait_state(data, "stopped", timeout=20)
        new_token = secrets.token_urlsafe(32)
        (data / "api-token.txt").write_text(new_token + "\n", encoding="utf-8")
        lab5.cli(env, "start")
        payload = wait_state(data, "running", timeout=45)
        check("worker restarts after rotation",
              bool(payload and payload["state"] == "running"),
              json.dumps(payload) if payload else "no state file")
        code_old, _ = http_status(rotate_port, "/v1/execute", data=payload_bytes,
                                  headers=json_headers | {"Authorization": "Bearer " + old_token})
        code_new, body_new = http_status(rotate_port, "/v1/execute", data=payload_bytes,
                                         headers=json_headers | {"Authorization": "Bearer " + new_token})
        check("restarted worker rejects the old token, serves the rotated one",
              code_old == 401 and code_new == 200, f"old={code_old} new={code_new}")
        lab5.cli(env, "quit")
        try:
            proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            pass
    finally:
        lab5.quit_all()


# ------------------------------------------------------------- full profile
def full_profile(setup):
    work = Path(tempfile.mkdtemp(prefix="aipster-qual-"))
    install = work / "app"
    home = work / "home"
    home.mkdir()
    env = scrubbed_env()
    env["LOCALAPPDATA"] = str(home)
    created = []
    procs = []

    def _cleanup():
        for proc in list(procs):
            try:
                proc.terminate()
                proc.wait(timeout=10)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
        for existing in list(created):
            uninstaller = Path(existing) / "uninstall.exe"
            try:
                if uninstaller.exists():
                    subprocess.run([str(uninstaller), "/S"], capture_output=True,
                                   env=env, timeout=120)
                    wait_gone(existing, timeout=120)
            except Exception:
                pass
        shutil.rmtree(work, ignore_errors=True)

    import atexit
    atexit.register(_cleanup)

    check("no Python/Git/uv/Node on scrubbed PATH",
          all(tool not in env["PATH"] for tool in ("Python", "Git", "uv", "node")), env["PATH"])
    check("no inherited interpreter/token env",
          not any(k.upper().startswith(("PYTHON", "UV_", "DENDRITE_", "GANGLION_")) for k in env),
          str(sorted(env)))

    proc = run_silent([str(setup), "/S", f"/D={install}"], env)
    check("silent install exits 0", proc.returncode == 0, proc.stderr[-500:])
    created.append(install)
    launcher, cli, tray = (install / "aipster-worker.exe", install / "dendrite.exe",
                           install / "aipster-tray.exe")
    check("installed exes + bundle files exist",
          launcher.exists() and cli.exists() and tray.exists()
          and (install / "default.toml").exists() and (install / "BUILD.json").exists()
          and (install / "uninstall.exe").exists())
    check("tray icons ship",
          all((install / "icons" / name).exists()
              for name in ("tray-ok.ico", "tray-warn.ico", "tray-off.ico")))
    try:
        sizes = {name: ico_entries(install / "icons" / name)
                 for name in ("tray-ok.ico", "tray-warn.ico", "tray-off.ico")}
        icons_ok = all(len(v) == 7 and {(16, 16), (32, 32), (48, 48)} <= set(v)
                       for v in sizes.values())
    except (AssertionError, OSError) as exc:
        icons_ok, detail = False, str(exc)[:200]
    else:
        detail = ""
    check("ICOs hold 7 PNG sizes incl. 16/32/48", icons_ok, detail)
    check("tray is windowed, launcher+cli are console",
          pe_subsystem(tray) == 2 and pe_subsystem(launcher) == 3 and pe_subsystem(cli) == 3,
          f"{pe_subsystem(tray)}/{pe_subsystem(launcher)}/{pe_subsystem(cli)}")
    check("CPython license ships", (install / "licenses" / "CPYTHON-LICENSE.txt").exists())
    check("licenses ship", (install / "licenses" / "AIPSTER-APACHE-LICENSE.txt").exists()
          and (install / "licenses" / "DENDRITE-LICENSE").exists()
          and (install / "licenses" / "PYINSTALLER-BOOTLOADER-NOTE.txt").exists()
          and (install / "licenses" / "DEPENDENCIES.json").exists())
    check("no Python source or tests ship",
          not list(install.rglob("*.py")) and not list(install.rglob("*test*"))
          and not list(install.rglob("*.whl")))
    check("app registry records location",
          reg_value(winreg.HKEY_CURRENT_USER, APP_KEY, "InstallDir") == str(install))
    check("Add/Remove entry present",
          reg_value(winreg.HKEY_CURRENT_USER, UNINSTALL_KEY, "DisplayName") == "AIPSTER Worker"
          and reg_value(winreg.HKEY_CURRENT_USER, UNINSTALL_KEY, "DisplayVersion") is not None
          and "uninstall.exe" in (reg_value(winreg.HKEY_CURRENT_USER, UNINSTALL_KEY,
                                            "UninstallString") or ""))
    start_menu = Path(os.environ["APPDATA"]) / "Microsoft/Windows/Start Menu/Programs/AIPSTER Worker"
    start_lnk = start_menu / "AIPSTER Worker.lnk"
    check("Start Menu shortcut present", start_lnk.exists())
    check("Start Menu points at the tray exe",
          start_lnk.exists() and lnk_target(start_lnk).lower().endswith("aipster-tray.exe"),
          lnk_target(start_lnk) if start_lnk.exists() else "missing")
    desktop_lnk = Path(os.environ["USERPROFILE"]) / "Desktop/AIPSTER Worker.lnk"
    check("desktop shortcut present by default", desktop_lnk.exists())
    check("desktop shortcut points at the tray exe",
          desktop_lnk.exists() and lnk_target(desktop_lnk).lower().endswith("aipster-tray.exe"),
          lnk_target(desktop_lnk) if desktop_lnk.exists() else "missing")
    skip("desktop-shortcut opt-out", "UI-only component path; deferred to owner VM")
    check("autostart defaults to off",
          reg_value(winreg.HKEY_CURRENT_USER, RUN_KEY, "AIPSTER-Worker") is None)
    proc = run_silent([str(setup), "/S", f"/D={install}"], env)
    check("silent reinstall exits 0", proc.returncode == 0, proc.stderr[-500:])

    # Console first run (dynamic port; branches on 8090 being externally busy).
    port = free_port()
    server = subprocess.Popen([str(launcher)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                              text=True, env=env)
    procs.append(server)
    data = home / "AIPSTER-Worker"
    base = None
    try:
        deadline = time.monotonic() + 30
        healthy, exited = False, None
        while time.monotonic() < deadline:
            exited = server.poll()
            if exited is not None or wait_health(8090, timeout=1):
                healthy = exited is None
                break
        if exited is not None:
            output = server.communicate()[0]
            token_file = data / "api-token.txt"
            check("busy-port first run exits 2 with files created",
                  exited == 2 and "already in use" in output and token_file.exists()
                  and (data / "config.toml").exists(), f"rc={exited} {output[-300:]}")
            text = (data / "config.toml").read_text(encoding="utf-8")
            (data / "config.toml").write_text(text.replace("port = 8090", f"port = {port}"),
                                              encoding="utf-8")
            server = subprocess.Popen([str(launcher)], stdout=subprocess.PIPE,
                                      stderr=subprocess.STDOUT, text=True, env=env)
            procs.append(server)
            check("worker reaches /healthz after reconfig", wait_health(port, timeout=30))
        else:
            check("worker reaches /healthz from frozen bundle", healthy)
            port = 8090
            USED_PORTS.add(port)
        base = f"http://127.0.0.1:{port}"
        token_file = data / "api-token.txt"
        token = token_file.read_text(encoding="utf-8").strip() if token_file.exists() else ""
        check("token file generated (strong, 43 chars)",
              len(token) == 43 and all("!" <= c <= "~" for c in token))
        check("config + state + logs created",
              (data / "config.toml").exists() and (data / "state").is_dir()
              and (data / "logs").is_dir())
        check_token_acl("token file is user-ACL-only", token_file, home, env)
        payload = json.dumps({"capability": "summarize", "model_id": "mock-summary",
                              "prompt": "SYNTHETIC QUAL FIXTURE", "max_tokens": 8}).encode()
        json_headers = {"Content-Type": "application/json"}
        code, _ = http_status(port, "/v1/execute", data=payload, headers=json_headers)
        check("execute without token is 401", code == 401, str(code))
        code, _ = http_status(port, "/v1/execute", data=payload,
                              headers=json_headers | {"Authorization": "Bearer wrong-token-000000000000000000"})
        check("execute with wrong token is 401", code == 401, str(code))
        code, body = http_status(port, "/v1/execute", data=payload,
                                 headers=json_headers | {"Authorization": "Bearer " + token})
        try:
            result = json.loads(body)
        except ValueError:
            result = {}
        check("execute with token returns simulated result",
              code == 200 and result.get("simulated") is True
              and result.get("model_id") == "mock-summary"
              and result.get("node_id") == "standalone-demo", f"{code} {body[:200]}")
        auth = "Authorization: Bearer " + token + "\r\n"
        check("hostile Host is 400",
              raw_status(port, f"Host: attacker.example:{port}\r\n", auth) == 400)
        check("duplicate Host is 400",
              raw_status(port, f"Host: 127.0.0.1:{port}\r\nHost: attacker.example\r\n", auth) == 400)
        try:
            lan = socket.gethostbyname(socket.gethostname())
        except OSError:
            lan = None
        if lan and not lan.startswith("127."):
            try:
                socket.create_connection((lan, port), timeout=3).close()
                loopback_only = False
            except OSError:
                loopback_only = True
            check(f"loopback-only bind (LAN {lan} refused)", loopback_only)
        else:
            print("SKIP loopback-only bind (no LAN address)")
        logs = (data / "logs" / "worker.log").read_text(encoding="utf-8", errors="replace")
        check("token value absent from logs", token not in logs)
        check("worker.log records the run", "standalone-demo" in logs or "listening" in logs
              or "starting" in logs)
        marker = data / "qual-marker.txt"
        marker.write_text("preserve-me", encoding="utf-8")

        conflict = run_silent([str(launcher)], env)
        check("second instance on busy port exits 2", conflict.returncode == 2,
              f"rc={conflict.returncode} {conflict.stdout[-300:]}")
        check("conflict error is actionable",
              "already in use" in (conflict.stdout + conflict.stderr))

        broken_home = work / "broken-home"
        broken_home.mkdir()
        broken_data = broken_home / "AIPSTER-Worker"
        private_fixture_directory(broken_data)
        (broken_data / "config.toml").write_text("[node\n", encoding="utf-8")
        broken = run_silent([str(launcher)], scrubbed_env_with_home(broken_home))
        check("broken config exits 2", broken.returncode == 2, f"rc={broken.returncode}")
        check("broken config names the problem",
              "dendrite:" in (broken.stdout + broken.stderr))

        cpu_home = work / "cpu-home"
        cpu_home.mkdir()
        cpu_data = cpu_home / "AIPSTER-Worker"
        private_fixture_directory(cpu_data)
        (cpu_data / "state").mkdir()
        (cpu_data / "logs").mkdir()
        (cpu_data / "fixture.gguf").write_bytes(b"GGUF-fixture-not-a-model")
        cpu_port = free_port()
        (cpu_data / "config.toml").write_text(
            f'[node]\nid = "cpu-qual"\nhost = "127.0.0.1"\nport = {cpu_port}\nstate_dir = "state"\n'
            '\n[[runtimes]]\nid = "cpu"\nkind = "ik_llama"\n'
            'executable = "absent-aipster-engine-qual"\n'
            '\n[[models]]\nid = "cpu-model"\nruntime = "cpu"\ncapabilities = ["summarize"]\n'
            'path = "fixture.gguf"\n', encoding="utf-8")
        cpu_env = scrubbed_env_with_home(cpu_home)
        cpu = subprocess.Popen([str(launcher)], stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, env=cpu_env)
        procs.append(cpu)
        try:
            check("cpu-configured server still starts", wait_health(cpu_port))
            cpu_token = (cpu_data / "api-token.txt").read_text(encoding="utf-8").strip()
            code, body = http_status(cpu_port, "/v1/execute", data=json.dumps(
                {"capability": "summarize", "model_id": "cpu-model",
                 "prompt": "x", "max_tokens": 4}).encode(),
                headers=json_headers | {"Authorization": "Bearer " + cpu_token})
            text = body.decode("utf-8", "replace")
            check("missing engine fails honestly (no 200, names cause)",
                  code != 200 and ("availab" in text or "binary not found" in text
                                   or "GGUF" in text or "engine" in text),
                  f"{code} {text[:200]}")
            check("server healthy after failed execute", wait_health(cpu_port, timeout=10))
            check("no model materialized in state dir",
                  not any((cpu_data / "state").rglob("*.gguf"))
                  and not any((cpu_data / "state").rglob("*.bin")))
        finally:
            cpu.terminate()
            cpu.wait(timeout=15)
    finally:
        server.terminate()
        try:
            output = server.communicate(timeout=15)[0]
        except subprocess.TimeoutExpired:
            server.kill()
            output = server.communicate()[0]
    token_again = (home / "AIPSTER-Worker/api-token.txt").read_text(encoding="utf-8").strip()
    check("token value absent from console output", token_again not in output)

    pure_tests()
    tray_matrix(install, work)

    proc = run_silent([str(setup), "/S", f"/D={install}"], env)
    check("pre-uninstall reinstall exits 0", proc.returncode == 0)
    check("reinstall preserves token + marker",
          (home / "AIPSTER-Worker/api-token.txt").read_text(encoding="utf-8").strip() == token_again
          and (home / "AIPSTER-Worker/qual-marker.txt").read_text(encoding="utf-8") == "preserve-me")
    unrelated = install / "unrelated-user-file.txt"
    unrelated.write_text("synthetic preserve-me")
    proc = run_silent([str(install / "uninstall.exe"), "/S"], env)
    check("silent uninstall exits 0", proc.returncode == 0, proc.stderr[-500:])
    check("uninstall completes (async self-copy)", wait_gone(install / "uninstall.exe"))
    check("uninstall removes payload but preserves unrelated user files",
          not launcher.exists() and unrelated.exists()
          and unrelated.read_text() == "synthetic preserve-me")
    unrelated.unlink()
    try:
        install.rmdir()  # Empty test directory only; never recursive.
    except FileNotFoundError:
        pass  # Async uninstaller may have just removed the now-empty directory.
    check("empty install directory can be removed", not install.exists())
    check("Start Menu entry removed", not start_menu.exists())
    check("desktop shortcut removed", not desktop_lnk.exists())
    check("app registry removed", not reg_key_exists(winreg.HKEY_CURRENT_USER, APP_KEY))
    check("Add/Remove entry removed", not reg_key_exists(winreg.HKEY_CURRENT_USER, UNINSTALL_KEY))
    check("Run key absent after uninstall",
          reg_value(winreg.HKEY_CURRENT_USER, RUN_KEY, "AIPSTER-Worker") is None)
    check("data dir preserved by uninstall",
          (home / "AIPSTER-Worker/qual-marker.txt").exists()
          and (home / "AIPSTER-Worker/api-token.txt").exists()
          and (home / "AIPSTER-Worker/logs").is_dir())

    install2 = work / "app2"
    proc = run_silent([str(setup), "/S", "/AUTOSTART=1", f"/D={install2}"], env)
    check("install with /AUTOSTART=1 exits 0", proc.returncode == 0, proc.stderr[-500:])
    created.append(install2)
    run_value = reg_value(winreg.HKEY_CURRENT_USER, RUN_KEY, "AIPSTER-Worker") or ""
    check("Run key points at the installed tray",
          str(install2) in run_value and run_value.endswith('aipster-tray.exe"'), run_value)
    proc = run_silent([str(install2 / "uninstall.exe"), "/S"], env)
    check("second uninstall exits 0", proc.returncode == 0, proc.stderr[-500:])
    check("second uninstall completes (async self-copy)", wait_gone(install2))
    check("Run key cleared by uninstall",
          reg_value(winreg.HKEY_CURRENT_USER, RUN_KEY, "AIPSTER-Worker") is None)
    check("second install dir removed", not install2.exists())

    # /REMOVEDATA=1 removes the default data dir (marker proves it). Refuse
    # when the real profile already holds data: never delete unknown files.
    real_data = Path(os.environ["LOCALAPPDATA"]) / "AIPSTER-Worker"
    preexisting = real_data.exists() and any(real_data.iterdir())
    install3 = work / "app3"
    proc = run_silent([str(setup), "/S", f"/D={install3}"], env)
    check("third install exits 0", proc.returncode == 0, proc.stderr[-500:])
    created.append(install3)
    if preexisting:
        skip("/REMOVEDATA removes data", "real profile already holds data; refusing to touch it")
        proc = run_silent([str(install3 / "uninstall.exe"), "/S"], env)
        check("third uninstall exits 0", proc.returncode == 0, proc.stderr[-500:])
        check("third uninstall completes", wait_gone(install3))
    else:
        removal_marker = real_data / "qual-removal-marker.txt"
        real_data.mkdir(parents=True, exist_ok=True)
        removal_marker.write_text("remove-me", encoding="utf-8")
        proc = run_silent([str(install3 / "uninstall.exe"), "/S", "/REMOVEDATA=1"], env)
        check("uninstall with /REMOVEDATA=1 exits 0", proc.returncode == 0, proc.stderr[-500:])
        check("removal uninstall completes", wait_gone(install3))
        # Data removal runs after the app dir goes; poll the marker too.
        check("data removal completes", wait_gone(removal_marker))
        check("default data dir removed by /REMOVEDATA=1", not removal_marker.exists())
        check("data dir fully gone when it held only the marker", not real_data.exists())
    skip("uninstall data checkbox", "UI-only path; /REMOVEDATA=1 covers the code path headless")
    uninstall_failure_matrix(setup, env, work, created, procs)
    check("registry fully clean",
          not reg_key_exists(winreg.HKEY_CURRENT_USER, APP_KEY)
          and not reg_key_exists(winreg.HKEY_CURRENT_USER, UNINSTALL_KEY))
    ports_closed = True
    for used in USED_PORTS:
        with socket.socket() as probe:
            try:
                probe.bind(("127.0.0.1", used))
            except OSError:
                ports_closed = False
    check("no listener left behind", ports_closed)
    shutil.rmtree(work, ignore_errors=True)
    print(f"\n{len(FAILURES)} failure(s)" + (": " + ", ".join(FAILURES) if FAILURES else ""))
    return 1 if FAILURES else 0


def uninstall_failure_matrix(setup, env, work, created, procs):
    """Failure paths keep the install registered and retryable; never false success.

    Runs uninstall.exe synchronously with _?=<dir> so its real exit code is
    observed. Only scratch installs, fixture processes and files this run
    created are touched.
    """
    def sync_uninstall(target):
        return run_silent([str(target / "uninstall.exe"), "/S", f"_?={target}"], env)

    def payload_left(target):
        return sorted(str(p.relative_to(target)) for p in target.rglob("*")
                      if p.is_file() and p.name not in ("uninstall.exe", "partial-sentinel.txt"))

    def registered_to(target):
        return (reg_value(winreg.HKEY_CURRENT_USER, APP_KEY, "InstallDir") == str(target)
                and str(target / "uninstall.exe") in (reg_value(
                    winreg.HKEY_CURRENT_USER, UNINSTALL_KEY, "UninstallString") or ""))

    install = work / "app4"
    proc = run_silent([str(setup), "/S", f"/D={install}"], env)
    check("failure-matrix install exits 0", proc.returncode == 0, proc.stderr[-500:])
    created.append(install)
    sentinel = install / "partial-sentinel.txt"
    sentinel.write_text("synthetic preserve-me")
    full = payload_left(install)

    # Running worker: a fixture process with the worker image name (a copy of
    # PING.EXE, not the real worker) must abort the uninstall untouched.
    fixture_dir = work / "running-fixture"
    fixture_dir.mkdir()
    fake = fixture_dir / "dendrite.exe"
    shutil.copy2(Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "PING.EXE", fake)
    runner = subprocess.Popen([str(fake), "-n", "120", "127.0.0.1"],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    procs.append(runner)
    try:
        proc = sync_uninstall(install)
        check("uninstall over a running worker exits 2", proc.returncode == 2, str(proc.returncode))
        check("running-worker abort removes nothing", payload_left(install) == full)
        check("running-worker abort keeps registration", registered_to(install))
    finally:
        runner.terminate()
        runner.wait(timeout=15)

    # Locked payload: a held DLL (no delete sharing) survives removal. The
    # uninstall reports failure, keeps registration AND the uninstaller it
    # points to, and has already removed dendrite.exe (a partial state).
    locked = next(p for p in sorted(install.rglob("*.dll")))
    with open(locked, "rb"):
        proc = sync_uninstall(install)
        check("locked-payload uninstall exits 2", proc.returncode == 2, str(proc.returncode))
        check("locked file survives", locked.exists())
        check("partial removal took dendrite.exe", not (install / "dendrite.exe").exists())
        check("uninstaller retained after failed removal", (install / "uninstall.exe").exists())
        check("registration preserved and still points at a working uninstaller",
              registered_to(install))

    # A foreign directory holding only a copied uninstaller is never adopted,
    # even while a retained partial install is registered elsewhere.
    foreign = work / "foreign"
    foreign.mkdir()
    (foreign / "unrelated.txt").write_text("synthetic unrelated")
    shutil.copy2(install / "uninstall.exe", foreign / "uninstall.exe")
    proc = sync_uninstall(foreign)
    check("foreign directory uninstall refused (exit 2)", proc.returncode == 2, str(proc.returncode))
    check("foreign files untouched", (foreign / "unrelated.txt").read_text() == "synthetic unrelated")
    check("registration unchanged by refused foreign run", registered_to(install))

    # Retry after the lock is released: the retained partial install (no
    # dendrite.exe) is still recognized and now removes completely.
    proc = sync_uninstall(install)
    check("retry after partial cleanup exits 0", proc.returncode == 0, str(proc.returncode))
    check("retry removes every payload file", payload_left(install) == [], str(payload_left(install)[:5]))
    check("retry preserves unrelated files", sentinel.read_text() == "synthetic preserve-me")
    check("retry unregisters", not reg_key_exists(winreg.HKEY_CURRENT_USER, UNINSTALL_KEY)
          and not reg_key_exists(winreg.HKEY_CURRENT_USER, APP_KEY))

    # Denied deletion: Windows lets "delete child" on the parent override a
    # file's own DELETE deny, so the fixture denies both (file D, parent DC)
    # for this user. Removing both denies makes the retry succeed.
    install5 = work / "app5"
    proc = run_silent([str(setup), "/S", f"/D={install5}"], env)
    check("denied-deletion install exits 0", proc.returncode == 0, proc.stderr[-500:])
    created.append(install5)
    denied = next(p for p in sorted(install5.rglob("*.dll")))
    user = os.environ.get("USERNAME", "")
    deny = subprocess.run(["icacls", str(denied), "/deny", f"{user}:(D)"], capture_output=True, text=True)
    deny_parent = subprocess.run(["icacls", str(denied.parent), "/deny", f"{user}:(DC)"],
                                 capture_output=True, text=True)
    check("fixture deny ACLs applied", deny.returncode == 0 and deny_parent.returncode == 0,
          deny.stdout[-300:] + deny.stderr[-300:] + deny_parent.stdout[-300:] + deny_parent.stderr[-300:])
    try:
        proc = sync_uninstall(install5)
        check("denied-deletion uninstall exits 2", proc.returncode == 2, str(proc.returncode))
        check("denied file survives", denied.exists())
        check("denied-deletion keeps working registration", registered_to(install5))
    finally:
        subprocess.run(["icacls", str(denied.parent), "/remove:d", user], capture_output=True)
        subprocess.run(["icacls", str(denied), "/remove:d", user], capture_output=True)
    proc = sync_uninstall(install5)
    check("retry after deny removed exits 0", proc.returncode == 0, str(proc.returncode))
    check("retry removes the denied file and all payload", payload_left(install5) == [])
    check("registry clean after failure matrix",
          not reg_key_exists(winreg.HKEY_CURRENT_USER, APP_KEY)
          and not reg_key_exists(winreg.HKEY_CURRENT_USER, UNINSTALL_KEY))
    # _?= runs in place, so NSIS cannot delete the running uninstaller; remove
    # the scratch leftovers this matrix created (exact names, never recursive).
    for target in (install, install5):
        for leftover in ("uninstall.exe", "partial-sentinel.txt"):
            try:
                (target / leftover).unlink()
            except FileNotFoundError:
                pass
        for directory in sorted((p for p in target.rglob("*") if p.is_dir()),
                                key=lambda p: -len(p.parts)):
            directory.rmdir()
        target.rmdir()
        created.remove(target)


def scrubbed_env_with_home(home):
    env = scrubbed_env()
    env["LOCALAPPDATA"] = str(home)
    return env


# -------------------------------------------------------- coexistence profile
def coexist_profile(app_dir):
    app_dir = Path(app_dir)
    for name in ("aipster-tray.exe", "aipster-worker.exe", "dendrite.exe"):
        if not (app_dir / name).exists():
            raise SystemExit(f"--app-dir {app_dir} is missing {name}")
    work = Path(tempfile.mkdtemp(prefix="aipster-qual-"))

    def _cleanup():
        # Belt and braces: quit any tray instance we started via its own CLI.
        for data in work.glob("tray-*"):
            try:
                subprocess.run([str(app_dir / "aipster-worker.exe"), "tray", "quit"],
                               capture_output=True, env={**scrubbed_env(),
                                                         "AIPSTER_WORKER_DATA": str(data)},
                               timeout=30)
            except Exception:
                pass
        shutil.rmtree(work, ignore_errors=True)

    import atexit
    atexit.register(_cleanup)

    skip("silent install", "live install owns the HKCU singletons; covered by CI full profile")
    skip("registry/Start Menu/desktop/autostart", "untouched to preserve the live install")
    skip("uninstall (preserve + /REMOVEDATA)", "untouched to preserve the live install")
    check("tray is windowed, launcher+cli are console",
          pe_subsystem(app_dir / "aipster-tray.exe") == 2
          and pe_subsystem(app_dir / "aipster-worker.exe") == 3
          and pe_subsystem(app_dir / "dendrite.exe") == 3)
    try:
        sizes = {name: ico_entries(app_dir / "icons" / name)
                 for name in ("tray-ok.ico", "tray-warn.ico", "tray-off.ico")}
        icons_ok = all(len(v) == 7 and {(16, 16), (32, 32), (48, 48)} <= set(v)
                       for v in sizes.values())
    except (AssertionError, OSError) as exc:
        icons_ok, detail = False, str(exc)[:200]
    else:
        detail = ""
    check("ICOs hold 7 PNG sizes incl. 16/32/48", icons_ok, detail)
    pure_tests()
    tray_matrix(app_dir, work)
    ports_closed = True
    for used in USED_PORTS:
        with socket.socket() as probe:
            try:
                probe.bind(("127.0.0.1", used))
            except OSError:
                ports_closed = False
    check("no listener left behind", ports_closed)
    shutil.rmtree(work, ignore_errors=True)
    print(f"\n{len(FAILURES)} failure(s)" + (": " + ", ".join(FAILURES) if FAILURES else ""))
    return 1 if FAILURES else 0


def main():
    args = sys.argv[1:]
    app_dir = None
    if "--app-dir" in args:
        i = args.index("--app-dir")
        try:
            app_dir = args[i + 1]
        except IndexError:
            raise SystemExit("usage: qualify.py [--app-dir PATH]")
    if app_dir:
        print(f"profile=coexist app-dir={app_dir}")
        return coexist_profile(app_dir)
    if live_install_detected():
        raise SystemExit("refusing: a live install owns the HKCU singletons "
                         "(preserve it). Run the coexistence profile instead:\n"
                         "  python packaging/windows/qualify.py --app-dir "
                         "packaging/windows/build/freeze/app")
    setups = sorted(DIST.glob("AIPSTER-Worker-*-win64-setup.exe"))
    if len(setups) != 1:
        raise SystemExit(f"expected exactly one Setup exe in {DIST}, found {len(setups)}")
    print(f"profile=full setup={setups[0].name}")
    return full_profile(setups[0])


if __name__ == "__main__":
    raise SystemExit(main())

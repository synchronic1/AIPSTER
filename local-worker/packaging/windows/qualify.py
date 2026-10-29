"""Qualify the packaged Windows installer in a scrubbed environment.

Runs the Setup exe silently into a temp directory, exercises the installed
worker with no Python/Git/uv on PATH (proving the bundle is self-contained),
then uninstalls and verifies complete cleanup with the data directory
preserved. Every check prints PASS or FAIL; exit code is nonzero on any FAIL.

Usage:  python packaging/windows/qualify.py
Needs:  packaging/windows/dist/AIPSTER-Worker-*-win64-setup.exe (see build.py)

This touches the real per-user registry/Start Menu (HKCU only, never system
state) and removes everything it creates; leftover detection fails the run.
"""
import json
import os
import shutil
import socket
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
# Synthetic test-only token prefix material; the real token is generated at runtime.
FAILURES = []
PORT = 8090


def check(name, condition, detail=""):
    print(("PASS " if condition else "FAIL ") + name + (f" -- {detail}" if detail and not condition else ""),
          flush=True)
    if not condition:
        FAILURES.append(name)


def scrubbed_env(home):
    env = {k: v for k, v in os.environ.items()
           if k.upper() in {"SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP"}}
    env["PATH"] = os.path.join(os.environ.get("SYSTEMROOT", r"C:\Windows"), "System32")
    env["LOCALAPPDATA"] = str(home)
    return env


def run_silent(cmd, env):
    return subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=180)


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


def wait_health(base, timeout=25):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(base + "/healthz", timeout=2) as response:
                if json.load(response).get("status") == "ok":
                    return True
        except Exception:
            time.sleep(0.2)
    return False


def http_status(base, path, data=None, headers=None):
    request = urllib.request.Request(base + path, data=data, headers=headers or {})
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


def main():
    setups = sorted(DIST.glob("AIPSTER-Worker-*-win64-setup.exe"))
    if len(setups) != 1:
        raise SystemExit(f"expected exactly one Setup exe in {DIST}, found {len(setups)}")
    setup = setups[0]
    work = Path(tempfile.mkdtemp(prefix="aipster-qual-"))
    install = work / "app"
    home = work / "home"
    home.mkdir()
    env = scrubbed_env(home)
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
          all(tool not in env["PATH"] for tool in ("Python", "Git", "uv", "node")),
          env["PATH"])
    check("no inherited interpreter/token env",
          not any(k.upper().startswith(("PYTHON", "UV_", "DENDRITE_", "GANGLION_"))
                  for k in env), str(sorted(env)))
    with socket.socket() as probe:
        try:
            probe.bind(("127.0.0.1", PORT))
            port_free = True
        except OSError:
            port_free = False
    check(f"default port {PORT} is free", port_free, "stop whatever listens on 8090 and rerun")
    if not port_free:
        return 1

    # 1. silent install with defaults
    proc = run_silent([str(setup), "/S", f"/D={install}"], env)
    check("silent install exits 0", proc.returncode == 0, proc.stderr[-500:])
    created.append(install)
    launcher, cli = install / "aipster-worker.exe", install / "dendrite.exe"
    check("installed exes + bundle files exist",
          launcher.exists() and cli.exists() and (install / "default.toml").exists()
          and (install / "BUILD.json").exists() and (install / "uninstall.exe").exists())
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
    check("Start Menu shortcut present", (start_menu / "AIPSTER Worker.lnk").exists())
    check("autostart defaults to off",
          reg_value(winreg.HKEY_CURRENT_USER, RUN_KEY, "AIPSTER-Worker") is None)
    # reinstall over the same location (idempotent upgrade path for one build)
    proc = run_silent([str(setup), "/S", f"/D={install}"], env)
    check("silent reinstall exits 0", proc.returncode == 0, proc.stderr[-500:])

    # 2. first run: data dir, token, config, server (scrubbed env, no system Python)
    server = subprocess.Popen([str(launcher)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                              text=True, env=env)
    procs.append(server)
    try:
        base = f"http://127.0.0.1:{PORT}"
        check("worker reaches /healthz from frozen bundle", wait_health(base))
        data = home / "AIPSTER-Worker"
        token_file = data / "api-token.txt"
        token = token_file.read_text(encoding="utf-8").strip() if token_file.exists() else ""
        check("token file generated (strong, 43 chars)",
              len(token) == 43 and len(token) >= 32
              and all("!" <= c <= "~" for c in token))
        check("config + state + logs created",
              (data / "config.toml").exists() and (data / "state").is_dir()
              and (data / "logs").is_dir())
        icacls = subprocess.run(["icacls", str(token_file)], capture_output=True, text=True,
                                env=env)
        check("token file is user-ACL-only",
              "BUILTIN" not in icacls.stdout and "(F)" in icacls.stdout, icacls.stdout[:300])
        payload = json.dumps({"capability": "summarize", "model_id": "mock-summary",
                              "prompt": "SYNTHETIC QUAL FIXTURE", "max_tokens": 8}).encode()
        json_headers = {"Content-Type": "application/json"}
        code, _ = http_status(base, "/v1/execute", data=payload, headers=json_headers)
        check("execute without token is 401", code == 401, str(code))
        code, _ = http_status(base, "/v1/execute", data=payload,
                              headers=json_headers | {"Authorization": "Bearer wrong-token-000000000000000000"})
        check("execute with wrong token is 401", code == 401, str(code))
        code, body = http_status(base, "/v1/execute", data=payload,
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
              raw_status(PORT, f"Host: attacker.example:{PORT}\r\n", auth) == 400)
        check("duplicate Host is 400",
              raw_status(PORT, f"Host: 127.0.0.1:{PORT}\r\nHost: attacker.example\r\n", auth) == 400)
        try:
            lan = socket.gethostbyname(socket.gethostname())
        except OSError:
            lan = None
        if lan and not lan.startswith("127."):
            try:
                socket.create_connection((lan, PORT), timeout=3).close()
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

        # 3. port conflict: a second launcher on the same data dir fails cleanly
        conflict = run_silent([str(launcher)], env)
        check("second instance on busy port exits 2", conflict.returncode == 2,
              f"rc={conflict.returncode} {conflict.stdout[-300:]}")
        check("conflict error is actionable",
              "already in use" in (conflict.stdout + conflict.stderr))

        # 4. bad config fails closed (separate data dir, nothing shared)
        broken_home = work / "broken-home"
        broken_home.mkdir()
        broken_data = broken_home / "AIPSTER-Worker"
        broken_data.mkdir()
        (broken_data / "config.toml").write_text("[node\n", encoding="utf-8")
        broken = run_silent([str(launcher)], scrubbed_env(broken_home))
        check("broken config exits 2", broken.returncode == 2, f"rc={broken.returncode}")
        check("broken config names the problem",
              "dendrite:" in (broken.stdout + broken.stderr))

        # 5. missing model: clean failure, no spawn, server stays healthy
        cpu_home = work / "cpu-home"
        cpu_home.mkdir()
        cpu_data = cpu_home / "AIPSTER-Worker"
        (cpu_data / "state").mkdir(parents=True)
        (cpu_data / "logs").mkdir()
        (cpu_data / "fixture.gguf").write_bytes(b"GGUF-fixture-not-a-model")
        (cpu_data / "config.toml").write_text(
            '[node]\nid = "cpu-qual"\nhost = "127.0.0.1"\nport = 8091\nstate_dir = "state"\n'
            '\n[[runtimes]]\nid = "cpu"\nkind = "ik_llama"\n'
            'executable = "absent-aipster-engine-qual"\n'
            '\n[[models]]\nid = "cpu-model"\nruntime = "cpu"\ncapabilities = ["summarize"]\n'
            'path = "fixture.gguf"\n', encoding="utf-8")
        cpu_env = scrubbed_env(cpu_home)
        cpu = subprocess.Popen([str(launcher)], stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, env=cpu_env)
        procs.append(cpu)
        try:
            cpu_base = "http://127.0.0.1:8091"
            check("cpu-configured server still starts", wait_health(cpu_base))
            cpu_token = (cpu_data / "api-token.txt").read_text(encoding="utf-8").strip()
            code, body = http_status(cpu_base, "/v1/execute", data=json.dumps(
                {"capability": "summarize", "model_id": "cpu-model",
                 "prompt": "x", "max_tokens": 4}).encode(),
                headers=json_headers | {"Authorization": "Bearer " + cpu_token})
            text = body.decode("utf-8", "replace")
            check("missing engine fails honestly (no 200, names cause)",
                  code != 200 and ("availab" in text or "binary not found" in text
                                   or "GGUF" in text or "engine" in text),
                  f"{code} {text[:200]}")
            check("server healthy after failed execute", wait_health(cpu_base, timeout=10))
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

    # 6. reinstall preserves data and token; uninstall removes app, preserves data
    proc = run_silent([str(setup), "/S", f"/D={install}"], env)
    check("pre-uninstall reinstall exits 0", proc.returncode == 0)
    check("reinstall preserves token + marker",
          (home / "AIPSTER-Worker/api-token.txt").read_text(encoding="utf-8").strip() == token_again
          and (home / "AIPSTER-Worker/qual-marker.txt").read_text(encoding="utf-8") == "preserve-me")
    proc = run_silent([str(install / "uninstall.exe"), "/S"], env)
    check("silent uninstall exits 0", proc.returncode == 0, proc.stderr[-500:])
    check("uninstall completes (async self-copy)", wait_gone(install))
    check("install dir removed", not install.exists())
    check("Start Menu entry removed", not start_menu.exists())
    check("app registry removed", not reg_key_exists(winreg.HKEY_CURRENT_USER, APP_KEY))
    check("Add/Remove entry removed", not reg_key_exists(winreg.HKEY_CURRENT_USER, UNINSTALL_KEY))
    check("Run key absent after uninstall",
          reg_value(winreg.HKEY_CURRENT_USER, RUN_KEY, "AIPSTER-Worker") is None)
    check("data dir preserved by uninstall",
          (home / "AIPSTER-Worker/qual-marker.txt").exists()
          and (home / "AIPSTER-Worker/api-token.txt").exists()
          and (home / "AIPSTER-Worker/logs").is_dir())

    # 7. explicit autostart opt-in writes the per-user Run key, uninstall clears it
    install2 = work / "app2"
    proc = run_silent([str(setup), "/S", "/AUTOSTART=1", f"/D={install2}"], env)
    check("install with /AUTOSTART=1 exits 0", proc.returncode == 0, proc.stderr[-500:])
    created.append(install2)
    run_value = reg_value(winreg.HKEY_CURRENT_USER, RUN_KEY, "AIPSTER-Worker") or ""
    check("Run key points at the installed launcher",
          str(install2) in run_value and run_value.endswith('aipster-worker.exe"'), run_value)
    proc = run_silent([str(install2 / "uninstall.exe"), "/S"], env)
    check("second uninstall exits 0", proc.returncode == 0, proc.stderr[-500:])
    check("second uninstall completes (async self-copy)", wait_gone(install2))
    check("Run key cleared by uninstall",
          reg_value(winreg.HKEY_CURRENT_USER, RUN_KEY, "AIPSTER-Worker") is None)
    check("second install dir removed", not install2.exists())
    check("registry fully clean",
          not reg_key_exists(winreg.HKEY_CURRENT_USER, APP_KEY)
          and not reg_key_exists(winreg.HKEY_CURRENT_USER, UNINSTALL_KEY))
    with socket.socket() as probe:
        try:
            probe.bind(("127.0.0.1", PORT))
            port_free_again = True
        except OSError:
            port_free_again = False
    check("no listener left behind", port_free_again)
    shutil.rmtree(work, ignore_errors=True)
    print(f"\n{len(FAILURES)} failure(s)" + (": " + ", ".join(FAILURES) if FAILURES else ""))
    return 1 if FAILURES else 0


if __name__ == "__main__":
    raise SystemExit(main())

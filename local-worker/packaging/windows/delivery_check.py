"""Delivery validation for the installed AIPSTER Worker bundle.

Read-only preflight for upgrades/qualification: requires the visible tray
executable plus the frozen console bundle, correct source/runtime
capability evidence (BUILD.json/default.toml plus a real configured
runtime), and enrollment-preserving single-sender upgrade semantics.

Never writes, installs, downloads, starts, or stops anything. Enrollment
files (pairing.json, api-token.txt) are only read for presence/fingerprint;
a live heartbeat sender blocks the upgrade instead of being disturbed.
"""

from __future__ import annotations

import json
import re
from hashlib import sha256
from pathlib import Path

EXIT_READY = 0
EXIT_BLOCKED = 2
EXIT_SENDER_RUNNING = 6

REQUIRED_APP_FILES = (
    "aipster-tray.exe",
    "aipster-worker.exe",
    "dendrite.exe",
    "BUILD.json",
    "default.toml",
)

TRAY_EXE = "aipster-tray.exe"


def _fingerprint(path):
    """Short stable fingerprint of an enrollment file (never logs values)."""
    try:
        digest = sha256(Path(path).read_bytes()).hexdigest()[:16]
        return {"present": True, "sha16": digest,
                "size": Path(path).stat().st_size}
    except OSError:
        return {"present": False}


def _read_build_evidence(app_dir):
    """Parse BUILD.json capability evidence; return (info, error)."""
    try:
        info = json.loads((app_dir / "BUILD.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return None, f"unreadable BUILD.json capability evidence: {exc}"
    if not isinstance(info, dict):
        return None, "BUILD.json capability evidence is not an object"
    missing = [k for k in ("worker_name", "worker_version") if not info.get(k)]
    if missing:
        return None, ("BUILD.json capability evidence is missing: "
                       + ", ".join(missing))
    return info, ""


def _minimal_runtime_status(config_text, config_path):
    """Classify config text without importing the worker (read-only scan).

    Mirrors firstrun.classify_runtime_selection for the delivery gate:
    mock-only selections stay setup-required; a managed real runtime
    needs an existing model path; attach needs an upstream_model.
    """
    kinds = re.findall(r'^\s*kind\s*=\s*"([^"]+)"', config_text,
                       flags=re.MULTILINE)
    if "[[runtimes]]" not in config_text or "[[models]]" not in config_text:
        return {"status": "setup-required", "mock_only": False,
                "reason": "no runtimes/models are configured"}
    if kinds and all(k == "mock" for k in kinds):
        return {"status": "setup-required", "mock_only": True,
                "reason": ("mock runtime is a test/demo option only; "
                           "select a real configured runtime to operate")}
    if any(k in ("ik_llama", "llama_cpp") for k in kinds):
        paths = re.findall(r'^\s*path\s*=\s*"([^"]+)"', config_text,
                           flags=re.MULTILINE)
        has_placeholder = any("replace-with-your-model" in p for p in paths)
        real_paths = [p for p in paths if "replace-with-your-model" not in p]
        if re.search(r'^\s*upstream_model\s*=', config_text,
                     flags=re.MULTILINE):
            return {"status": "ready", "mock_only": False,
                    "reason": "attached runtime serves a loopback model"}
        base = config_path.parent
        for candidate in real_paths:
            if (base / candidate).exists() or Path(candidate).exists():
                return {"status": "ready", "mock_only": False,
                        "reason": "managed runtime serves a configured model"}
        if has_placeholder or not real_paths:
            return {"status": "setup-required", "mock_only": False,
                    "reason": ("no real model is configured; install a GGUF "
                               "model file yourself (never downloaded "
                               "automatically) and point a real runtime at "
                               "it in config.toml")}
        return {"status": "setup-required", "mock_only": False,
                "reason": "configured model path does not exist"}
    return {"status": "setup-required", "mock_only": False,
            "reason": "no supported real runtime is configured"}


def _sender_running(data_dir):
    """True when another live process holds the heartbeat sender lock."""
    try:
        import pairing
    except ImportError:
        return False
    try:
        return bool(pairing.sender_lock_held(Path(data_dir)))
    except Exception:
        return False


def check_delivery(app_dir, data_dir, loaded=None):
    """Validate an installed bundle + data dir without changing either.

    Returns a dict with status ("ready"/"blocked"), exit_code (0/2/6),
    reason, guidance, checks, enrollment fingerprints, and a safe
    failure/rollback plan. Never creates, modifies, or deletes files.
    """
    app_dir, data_dir = Path(app_dir), Path(data_dir)
    checks = []

    def note(name, ok, detail=""):
        checks.append({"name": name, "ok": bool(ok), "detail": detail})
        return ok

    if not app_dir.exists():
        note("package present", False, f"{app_dir} does not exist")
        return _blocked(
            f"package absent: {app_dir} does not exist", checks)
    missing = [name for name in REQUIRED_APP_FILES
               if not (app_dir / name).is_file()]
    note("package present", not missing,
         "" if not missing else "missing: " + ", ".join(missing))
    if TRAY_EXE in missing:
        return _blocked(
            f"visible tray executable missing: {app_dir / TRAY_EXE} "
            "is absent; reinstall the qualified package before upgrading",
            checks)
    if missing:
        return _blocked(
            "package incomplete, missing: " + ", ".join(missing)
            + "; reinstall the qualified package before upgrading",
            checks)
    build_info, build_error = _read_build_evidence(app_dir)
    note("capability evidence", build_info is not None, build_error)
    if build_info is None:
        return _blocked(build_error, checks)

    config_path = data_dir / "config.toml"
    if not config_path.is_file():
        note("runtime configured", False, "config.toml is absent")
        return _blocked(
            "runtime absent: no config.toml in the data dir; first run "
            "has not completed and there is nothing to upgrade",
            checks, build_info=build_info)
    try:
        config_text = config_path.read_text(encoding="utf-8")
    except OSError as exc:
        note("runtime configured", False, str(exc))
        return _blocked(f"runtime unreadable: {exc}", checks,
                        build_info=build_info)
    if loaded is not None:
        try:
            from aipster_tray.firstrun import classify_runtime_selection
            runtime = classify_runtime_selection(loaded)
        except Exception as exc:
            runtime = {"status": "setup-required", "mock_only": False,
                       "reason": f"runtime classification failed: {exc}"}
    else:
        runtime = _minimal_runtime_status(config_text, config_path)
    runtime_ok = runtime.get("status") == "ready"
    note("runtime configured", runtime_ok, runtime.get("reason", ""))
    if not runtime_ok:
        guidance = ("Supported configurations: native ik_llama managed "
                    "runtime with a real GGUF model file (set the "
                    "[[models]] path yourself), or llama_cpp managed with "
                    "a real GGUF / attach with an upstream_model on a "
                    "loopback server you run yourself. The mock runtime "
                    "is a test/demo option only and never counts as "
                    "operational.")
        return _blocked("setup required: " + runtime.get("reason", ""),
                        checks, build_info=build_info, guidance=guidance,
                        runtime=runtime)

    enrollment = {
        "pairing.json": _fingerprint(data_dir / "pairing.json"),
        "api-token.txt": _fingerprint(data_dir / "api-token.txt"),
    }
    note("enrollment preserved (read-only)",
         True, "validator never writes enrollment files")
    if _sender_running(data_dir):
        note("single sender", False, "heartbeat sender lock is held")
        result = _blocked(
            "upgrade blocked: heartbeat sender is running "
            "(single-sender); stop the worker before upgrading",
            checks, build_info=build_info, runtime=runtime,
            enrollment=enrollment)
        result["exit_code"] = EXIT_SENDER_RUNNING
        return result
    note("single sender", True, "no live sender holds the lock")

    return {
        "status": "ready",
        "exit_code": EXIT_READY,
        "reason": ("delivery ready: tray bundle "
                   f"{build_info.get('worker_name')} "
                   f"{build_info.get('worker_version')} with "
                   f"{runtime.get('reason', 'a real configured runtime')}"),
        "guidance": "",
        "checks": checks,
        "build": {"worker_name": build_info.get("worker_name"),
                  "worker_version": build_info.get("worker_version"),
                  "installer_build": build_info.get("installer_build"),
                  "source_sha": build_info.get("source_sha")},
        "runtime": runtime,
        "enrollment": enrollment,
        "rollback": ("safe failure plan: this check changed nothing; to roll "
                     "back an upgrade, stop the worker, restore the prior "
                     "package directory, and restart — pairing.json and "
                     "api-token.txt stay in the data dir untouched."),
    }


def _blocked(reason, checks, build_info=None, guidance="", runtime=None,
             enrollment=None):
    return {
        "status": "blocked",
        "exit_code": EXIT_BLOCKED,
        "reason": reason,
        "guidance": guidance,
        "checks": checks,
        "build": ({"worker_name": (build_info or {}).get("worker_name"),
                   "worker_version": (build_info or {}).get("worker_version"),
                   "installer_build": (build_info or {}).get("installer_build"),
                   "source_sha": (build_info or {}).get("source_sha")}
                  if build_info else {}),
        "runtime": runtime or {},
        "enrollment": enrollment or {},
        "rollback": ("safe failure plan: this check changed nothing; to roll "
                     "back an upgrade, stop the worker, restore the prior "
                     "package directory, and restart — pairing.json and "
                     "api-token.txt stay in the data dir untouched."),
    }


def format_result(result):
    """One human-readable verdict line plus per-check lines."""
    lines = [f"delivery-check: {result['status']}: {result['reason']}"]
    for check in result.get("checks", []):
        lines.append(f"  [{'PASS' if check['ok'] else 'FAIL'}] "
                     f"{check['name']}"
                     + (f" -- {check['detail']}" if check["detail"] and not check["ok"] else ""))
    if result.get("guidance"):
        lines.append(result["guidance"])
    lines.append(result.get("rollback", ""))
    return "\n".join(lines)

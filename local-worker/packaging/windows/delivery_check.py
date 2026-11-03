"""Delivery validation for the installed AIPSTER Worker bundle.

Read-only upgrade preflight: requires the visible tray executable plus
the frozen console bundle, bundle metadata (BUILD.json/default.toml),
and a data-dir config selecting a real runtime. Single-sender upgrade
semantics are enforced through a strictly no-create sender-lock probe:
the probe never creates, modifies, or deletes any file, and an
unavailable or failing probe blocks the upgrade as unverified instead
of reporting safe-to-upgrade.

Scope is bundle/config validation only. Nothing here proves a live
runtime, model capability, or a qualified artifact, and no statement
below claims otherwise.

Never writes, installs, downloads, starts, or stops anything. Enrollment
files (pairing.json, api-token.txt) are described by filesystem metadata
only (presence, size, mtime); their contents are never read or hashed.
"""

from __future__ import annotations

import errno
import json
import os
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

SUPPORTED_MANAGED_KINDS = ("ik_llama", "llama_cpp")
PLACEHOLDER_MODEL_MARKER = "replace-with-your-model"

NOT_QUALIFIED = ("bundle/config validation only; not a live-runtime "
                 "or qualified-artifact proof")


def _describe_enrollment(path):
    """Filesystem metadata for an enrollment file; contents never read."""
    try:
        stat = Path(path).stat()
    except OSError:
        return {"present": False}
    return {"present": True, "size": stat.st_size,
            "mtime_ns": stat.st_mtime_ns}


def _read_build_evidence(app_dir):
    """Parse BUILD.json bundle metadata; return (info, error).

    Presence and shape only: worker_name/version metadata is reported,
    never presented as qualification of the source or runtime.
    """
    try:
        info = json.loads((app_dir / "BUILD.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return None, f"unreadable BUILD.json bundle metadata: {exc}"
    if not isinstance(info, dict):
        return None, "BUILD.json bundle metadata is not an object"
    missing = [k for k in ("worker_name", "worker_version") if not info.get(k)]
    if missing:
        return None, ("BUILD.json bundle metadata is missing: "
                       + ", ".join(missing))
    return info, ""


def _scan_config_status(config_text, config_path):
    """Classify config text with a strict TOML parse (no worker import).

    Returns {"status", ...} where status is "ready" (config names a real
    runtime with a usable model reference), "setup-required", or "unknown"
    (config present but not parseable, so the selection is unverified).
    "ready" describes the config text only: it is not a live-runtime,
    model-capability, or artifact-qualification claim.
    """
    try:
        import tomllib
    except ImportError:
        return {"status": "unknown", "mock_only": False,
                "reason": ("config cannot be verified: "
                           "TOML parser unavailable")}
    try:
        doc = tomllib.loads(config_text)
    except Exception:
        return {"status": "unknown", "mock_only": False,
                "reason": ("config.toml is not parseable; "
                           "runtime selection is unverified")}
    if not isinstance(doc, dict):
        return {"status": "unknown", "mock_only": False,
                "reason": ("config.toml is not a TOML document; "
                           "runtime selection is unverified")}
    runtimes = doc.get("runtimes")
    models = doc.get("models")
    if (not isinstance(runtimes, list) or not runtimes
            or not isinstance(models, list) or not models):
        return {"status": "setup-required", "mock_only": False,
                "reason": "no runtimes/models are configured"}
    table_runtimes = [r for r in runtimes if isinstance(r, dict)]
    table_models = [m for m in models if isinstance(m, dict)]
    if not table_runtimes or not table_models:
        return {"status": "setup-required", "mock_only": False,
                "reason": "no runtimes/models are configured"}
    by_id = {r.get("id"): r for r in table_runtimes}
    kinds = [r.get("kind") for r in table_runtimes]
    if kinds and all(k == "mock" for k in kinds):
        return {"status": "setup-required", "mock_only": True,
                "reason": ("mock runtime is a test/demo option only; "
                           "select a real configured runtime to operate")}
    if not any(k in SUPPORTED_MANAGED_KINDS for k in kinds):
        return {"status": "setup-required", "mock_only": False,
                "reason": "no supported real runtime is configured"}
    for model in table_models:
        runtime = by_id.get(model.get("runtime"))
        if not isinstance(runtime, dict):
            continue
        kind = runtime.get("kind")
        if kind == "mock" or kind not in SUPPORTED_MANAGED_KINDS:
            continue
        if runtime.get("mode", "managed") == "attach":
            if model.get("upstream_model"):
                return {"status": "ready", "mock_only": False,
                        "reason": (
                            "config validation passed: attached runtime "
                            f"{runtime.get('id')!r} names an upstream model "
                            f"for model {model.get('id')!r} "
                            f"({NOT_QUALIFIED})")}
            continue
        path = model.get("path")
        if not path or not isinstance(path, str):
            continue
        if PLACEHOLDER_MODEL_MARKER in path:
            continue
        if Path(path).exists() or (config_path.parent / path).exists():
            return {"status": "ready", "mock_only": False,
                    "reason": (
                        "config validation passed: managed runtime "
                        f"{runtime.get('id')!r} names an existing model path "
                        f"for model {model.get('id')!r} "
                        f"({NOT_QUALIFIED})")}
    return {"status": "setup-required", "mock_only": False,
            "reason": ("no configured model with an existing path; install "
                       "a GGUF model file yourself (never downloaded "
                       "automatically) and point a real runtime at it in "
                       "config.toml")}


# errnos that denote genuine lock contention (held by another live
# process) across the CRT/flock conventions used below. Verified on
# Windows: msvcrt.locking LK_NBLCK against a held byte-0 region fails
# with EACCES. Anything else from the lock call is mechanics, not
# contention, and fails closed to unknown.
_LOCK_CONFLICT_ERRNOS = frozenset({
    errno.EACCES, errno.EAGAIN, errno.EWOULDBLOCK, errno.EDEADLOCK,
})


def _probe_windows_lock(fd):
    """Non-blocking exclusive probe of one already-open descriptor.

    Returns True (held) only on contention errnos, False after a clean
    acquire+release, None on any mechanics error or missing API.
    The descriptor stays open; the caller owns cleanup.
    """
    try:
        import msvcrt
    except ImportError:
        return None
    try:
        msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
    except OSError as exc:
        return True if exc.errno in _LOCK_CONFLICT_ERRNOS else None
    except Exception:
        return None
    try:
        msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
    except Exception:
        pass  # Acquire already proved freedom; close releases regardless.
    return False


def _probe_posix_lock(fd):
    """Non-blocking exclusive probe of one already-open descriptor.

    Same tri-state contract as the Windows probe. Untested on this
    Windows-only box; implemented against documented flock semantics.
    """
    try:
        import fcntl
    except ImportError:
        return None
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as exc:
        return True if exc.errno in _LOCK_CONFLICT_ERRNOS else None
    except Exception:
        return None
    try:
        fcntl.flock(fd, fcntl.LOCK_UN)
    except Exception:
        pass  # Acquire already proved freedom; close releases regardless.
    return False


def _sender_state(data_dir):
    """Tri-state heartbeat-sender probe on ONE descriptor, never creating.

    pairing.sender_lock_held is never called: any second open would
    reintroduce the swallowed-access-failure and O_CREAT-recreation
    modes. Instead this function opens the lock path exactly once with
    ``os.open(O_RDWR)`` and *without* ``O_CREAT`` — O_RDWR is an
    access-mode requirement of the exclusive-lock APIs (verified: the
    lock call itself performs no file-data write), never a creation:

    - pairing subsystem unavailable -> None (unverified; fail closed).
    - open fails with file-not-found -> False (missing is proven; no
      holder can exist; nothing was or can be created here).
    - open fails any other way (EACCES/read-only file and friends) ->
      None (access errors are unknown, never free).
    - open succeeds -> one non-blocking exclusive attempt on that same
      descriptor: acquired+released -> False (positively verified
      free); contention errnos -> True (held); any mechanics error or
      missing platform API -> None.
    - non-Windows/non-POSIX platforms -> None (fail closed, untested).

    The descriptor is closed on every path. pairing.py is not modified
    and none of its entry points are invoked.
    """
    try:
        import pairing  # noqa: F401 -- availability gate only; never called
    except ImportError:
        return None
    lock = Path(data_dir) / "sender.lock"
    try:
        fd = os.open(os.fspath(lock), os.O_RDWR)
    except FileNotFoundError:
        return False
    except OSError:
        return None
    try:
        if os.name == "nt":
            return _probe_windows_lock(fd)
        if os.name == "posix":
            return _probe_posix_lock(fd)
        return None
    finally:
        try:
            os.close(fd)
        except OSError:
            pass


def check_delivery(app_dir, data_dir, loaded=None):
    """Validate an installed bundle + data dir without changing either.

    Returns a dict with status ("ready"/"blocked"), exit_code (0/2/6),
    reason, guidance, checks, enrollment metadata, and a safe
    failure/rollback plan. Creates, modifies, reads secret contents of,
    or deletes nothing. An unknown sender state or an unparseable
    config blocks the upgrade; only a positively verified free sender
    and a positively validated config report ready. "ready" is an
    upgrade-preflight verdict on bundle/config evidence, not a
    live-runtime or qualified-artifact claim.
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
    note("bundle metadata (BUILD.json)", build_info is not None, build_error)
    if build_info is None:
        return _blocked(build_error, checks)

    config_path = data_dir / "config.toml"
    if not config_path.is_file():
        note("runtime config present", False, "config.toml is absent")
        return _blocked(
            "runtime config absent: no config.toml in the data dir; first "
            "run has not completed and there is nothing to upgrade",
            checks, build_info=build_info)
    try:
        config_text = config_path.read_text(encoding="utf-8")
    except OSError as exc:
        note("runtime config present", False, str(exc))
        return _blocked(f"runtime config unreadable: {exc}", checks,
                        build_info=build_info)
    if loaded is not None:
        try:
            from aipster_tray.firstrun import classify_runtime_selection
            runtime = classify_runtime_selection(loaded)
        except Exception as exc:
            runtime = {"status": "setup-required", "mock_only": False,
                       "reason": f"runtime classification failed: {exc}"}
    else:
        runtime = _scan_config_status(config_text, config_path)
    runtime_ok = runtime.get("status") == "ready"
    note("runtime config selects a real runtime", runtime_ok,
         runtime.get("reason", ""))
    if not runtime_ok:
        if runtime.get("status") == "unknown":
            return _blocked(
                "verification unknown: " + runtime.get("reason", ""),
                checks, build_info=build_info,
                guidance=("The config cannot be verified; fix or replace "
                          "config.toml and re-run this check before "
                          "upgrading."),
                runtime=runtime)
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
        "pairing.json": _describe_enrollment(data_dir / "pairing.json"),
        "api-token.txt": _describe_enrollment(data_dir / "api-token.txt"),
    }
    note("enrollment untouched (metadata-only)",
         True, "validator never reads enrollment contents or writes files")
    sender = _sender_state(data_dir)
    if sender is True:
        note("single sender", False, "heartbeat sender lock is held")
        result = _blocked(
            "upgrade blocked: heartbeat sender is running "
            "(single-sender); stop the worker before upgrading",
            checks, build_info=build_info, runtime=runtime,
            enrollment=enrollment)
        result["exit_code"] = EXIT_SENDER_RUNNING
        return result
    if sender is None:
        note("single sender", False,
             "sender lock not verifiable read-only (unavailable subsystem, "
             "access denial, or lock-mechanics error)")
        return _blocked(
            "upgrade blocked: heartbeat sender state is unknown/unverified "
            "(the sender lock cannot be verified read-only: unavailable "
            "subsystem, access denial, or lock-mechanics error); "
            "stop the worker and re-run this check before upgrading",
            checks, build_info=build_info, runtime=runtime,
            enrollment=enrollment)
    note("single sender", True,
         "no live sender holds the lock (absent lock file, or exclusive "
         "lock acquired and released on one no-create descriptor)")

    return {
        "status": "ready",
        "exit_code": EXIT_READY,
        "reason": ("delivery preflight passed: tray bundle "
                   f"{build_info.get('worker_name')} "
                   f"{build_info.get('worker_version')} names a real "
                   "runtime in config "
                   f"({runtime.get('reason', 'config validation passed')}; "
                   f"{NOT_QUALIFIED})"),
        "guidance": ("Scope: bundle and config validation only. BUILD.json "
                     "metadata and config checks do not prove a live "
                     "runtime, model capability, or a qualified artifact."),
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

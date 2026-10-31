"""Tray controller state model. Pure (windowless): menu text, state file, honesty rules.

States describe the LOCAL worker process only. There is deliberately no
CONNECTED or INFERENCE_READY state: dispatch stays disabled, so the tray
must never display those words as a status. Pairing is a separate local
overlay (unpaired / registered / reachable / stale / repair-required /
actionable-error) derived from the pairing store plus the sender child; a
heartbeat proves reachability only, never readiness. The menu carries a
Pair action and the overlay lines instead of daemon-state claims.
"""
import json
from datetime import datetime, timezone

STOPPED = "stopped"
STARTING = "starting"
RUNNING = "running"
PORT_BUSY = "port_busy"
ERROR = "error"

STATES = (STOPPED, STARTING, RUNNING, PORT_BUSY, ERROR)

# Honest human text per state. "Connected" and "inference ready" never appear.
STATE_TEXT = {
    STOPPED: "Stopped",
    STARTING: "Starting…",
    RUNNING: "Running locally (simulated engine)",
    PORT_BUSY: "Port busy",
    ERROR: "Error",
}

# Map state -> tray icon asset.
STATE_ICON = {
    STOPPED: "tray-off.ico",
    STARTING: "tray-off.ico",
    RUNNING: "tray-ok.ico",
    PORT_BUSY: "tray-warn.ico",
    ERROR: "tray-warn.ico",
}

DASHBOARD_URL = "https://aipster.net/app"

# Pairing overlay keys. Steady local derivations only; "authorizing" is the
# transient pair-prompt/sender-start moment (card mint phase + controller
# log), never a stored state. "update-needed" has no tray sensor (there is
# no update channel and no auto-update): the card's installer copy and the
# published pin carry it, and reinstalling from a newer reviewed pin is the
# only update path.
PAIR_UNPAIRED = "unpaired"
PAIR_REGISTERED = "registered"  # paired, awaiting first heartbeat
PAIR_REACHABLE = "reachable"  # fresh beat: reachability only, never ready
PAIR_STALE = "stale"
PAIR_REPAIR = "repair-required"
PAIR_ERROR = "actionable-error"

UNPAIRED_LINE = "Not paired — mint a code in My Compute, then Pair this computer"

FORBIDDEN_STATUS_WORDS = ("connected", "inference ready", "inference-ready", "online", "live")


def check_honest(text):
    """Refuse any status wording that overclaims. Raises ValueError."""
    lowered = text.lower()
    for word in FORBIDDEN_STATUS_WORDS:
        if word in lowered:
            raise ValueError(f"status text overclaims: {text!r}")
    return text


def header_line(state, detail=""):
    # Only our template is gated: dynamic details (ports, exit codes, config
    # errors) are data under an honest header, not status claims, so a model
    # or hostname containing "live" must never break the menu.
    text = check_honest(STATE_TEXT[state])
    if detail and state in (PORT_BUSY, ERROR):
        text += f" — {detail}"
    return text


def pairing_overlay(data_dir, sender="stopped"):
    """Derive the pairing overlay from the local store. Secret-free.

    Returns {"key": overlay key, "line": menu line, "sender": sender line}.
    Mirrors pairing.cmd_status: the status record counts only when bound to
    the current pairing generation, and old success goes stale after five
    minutes. Never raises for store conditions (they are overlay keys);
    unexpected I/O failures degrade to actionable-error, never to
    "unpaired" (which would hide a live pairing).
    """
    from pairing import (STATUS_STALE_SEC, PairingError, load_pairing,
                         pairing_files, pairing_status_binding)
    import json
    import time
    from pathlib import Path
    sender_line = f"Sender: {sender}"
    try:
        files = pairing_files(Path(data_dir))
        if not files["meta"].exists():
            return {"key": PAIR_UNPAIRED, "line": UNPAIRED_LINE,
                    "sender": sender_line}
        try:
            meta = load_pairing(data_dir)
        except PairingError as exc:
            if exc.code == "NOT_PAIRED":
                return {"key": PAIR_UNPAIRED, "line": UNPAIRED_LINE,
                        "sender": sender_line}
            return {"key": PAIR_ERROR,
                    "line": "Pairing store unreadable — pair again",
                    "sender": sender_line}
        rid = meta.get("resource_id", "?")
        record = None
        if files["status"].exists():
            try:
                candidate = json.loads(files["status"].read_text(encoding="utf-8"))
                if isinstance(candidate, dict) and candidate.get(
                        "pairing_generation") == pairing_status_binding(meta):
                    record = candidate
            except (OSError, ValueError):
                record = None
        if record is None:
            return {"key": PAIR_REGISTERED,
                    "line": f"Paired {rid} — awaiting first heartbeat",
                    "sender": sender_line}
        try:
            fresh = record.get("ok") is True and (
                time.time() - float(record.get("at", 0))) <= STATUS_STALE_SEC
        except (TypeError, ValueError):
            fresh = False
        if record.get("ok") is True and fresh:
            return {"key": PAIR_REACHABLE,
                    "line": (f"Paired {rid} — heartbeat ok, reachability only "
                             f"(usable={bool(record.get('usable'))})"),
                    "sender": sender_line}
        if record.get("ok") is True:
            return {"key": PAIR_STALE,
                    "line": (f"Paired {rid} — last beat "
                             f"{record.get('heartbeatAt') or 'unknown'}; "
                             f"start the sender"),
                    "sender": sender_line}
        if record.get("status") == "repair-required":
            return {"key": PAIR_REPAIR,
                    "line": (f"Paired {rid} — sender key is dead; "
                             f"pair again with a new code"),
                    "sender": sender_line}
        return {"key": PAIR_ERROR,
                "line": (f"Paired {rid} — last sender beat failed "
                         f"({record.get('code') or 'unknown'}); "
                         f"Start worker retries"),
                "sender": sender_line}
    except Exception:
        return {"key": PAIR_ERROR,
                "line": "Pairing state unreadable — see tray.log",
                "sender": sender_line}


def menu_model(state, endpoint="", detail="", pairing=None):
    """Menu structure for a state. Returns a list of item dicts:

    {"kind": "text", "label": ...}                      disabled status line
    {"kind": "action", "id": ..., "label": ..., "enabled": bool}

    pairing is a pairing_overlay() dict (or None for the unpaired default).
    Pair stays enabled in every daemon state: pairing and the sender are
    port-independent, so a busy daemon port never blocks linking.
    """
    header_line(state, detail)  # honesty gate on our template (raises on overclaim)
    overlay = pairing or {"key": PAIR_UNPAIRED, "line": UNPAIRED_LINE,
                          "sender": "Sender: stopped"}
    items = [
        {"kind": "text", "label": f"AIPSTER Worker — {STATE_TEXT[state]}"},
    ]
    if endpoint and state in (STARTING, RUNNING):
        items.append({"kind": "text", "label": endpoint})
    if detail and state in (PORT_BUSY, ERROR):
        items.append({"kind": "text", "label": detail})
    items.append({"kind": "sep"})
    items.append({"kind": "action", "id": "dashboard", "label": "Open AIPSTER dashboard",
                  "enabled": True})
    items.append({"kind": "action", "id": "logs", "label": "View logs", "enabled": True})
    items.append({"kind": "action", "id": "pair", "label": "Pair this computer…",
                  "enabled": True})
    items.append({"kind": "text", "label": overlay["line"]})
    items.append({"kind": "text", "label": overlay["sender"]})
    items.append({"kind": "sep"})
    if state == RUNNING or state == STARTING:
        items.append({"kind": "action", "id": "stop", "label": "Stop worker", "enabled": True})
    else:
        items.append({"kind": "action", "id": "start", "label": "Start worker", "enabled": True})
    items.append({"kind": "action", "id": "quit", "label": "Quit", "enabled": True})
    return items


def balloon_for(event, state="", detail=""):
    """(title, body) notification text for a controller event."""
    if event == "reuse":
        return ("AIPSTER Worker", f"Already running — {check_honest(STATE_TEXT[state])}")
    if event == "restarted":
        return ("AIPSTER Worker", "Worker process restarted after a crash.")
    if event == "giveup":
        return ("AIPSTER Worker", f"Worker keeps failing ({detail}); "
                                  "automatic restarts stopped. Use Start worker to retry.")
    if event == "port_busy":
        return ("AIPSTER Worker", f"Port {detail} is already in use; stop the "
                                  "other worker through its own controls or pick "
                                  "a free loopback port, then Start worker. "
                                  "Pairing stays available either way "
                                  "(it needs no local port).")
    if event == "started":
        return ("AIPSTER Worker", "Worker running locally (simulated engine).")
    if event == "stopped":
        return ("AIPSTER Worker", "Worker stopped.")
    if event == "paired":
        return ("AIPSTER Worker", f"Paired {detail} — sender starting.")
    if event == "pair_again":
        return ("AIPSTER Worker", "Sender key is dead — pair again with a new code.")
    if event == "sender_stopped":
        return ("AIPSTER Worker", f"Sender stopped ({detail}); "
                                  "Start worker runs it again.")
    raise ValueError(f"unknown balloon event: {event}")


# Fail fast (import time) if any shipped template overclaims. Menu headers embed
# STATE_TEXT verbatim, so gating the values covers the menu too.
for _text in list(STATE_TEXT.values()) + [UNPAIRED_LINE]:
    check_honest(_text)
for _event, _state in (("reuse", RUNNING), ("restarted", STARTING), ("giveup", ERROR),
                       ("port_busy", PORT_BUSY), ("started", RUNNING), ("stopped", STOPPED),
                       ("paired", RUNNING), ("pair_again", RUNNING), ("sender_stopped", ERROR)):
    check_honest(balloon_for(_event, _state, "sample")[1])
del _text, _event, _state


def utcnow():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def http_origin(host, port):
    """http:// origin with brackets around IPv6 literals."""
    part = f"[{host}]" if ":" in str(host) else host
    return f"http://{part}:{port}"


def write_state(path, state, detail="", worker_pid=None, host="", port=0, restarts=0,
                version="", pairing=None):
    header_line(state, detail)  # honesty gate
    payload = {"state": state, "detail": detail, "worker_pid": worker_pid, "host": host,
               "port": port, "restarts": restarts, "version": version,
               "updated_at": utcnow()}
    if pairing is not None:
        payload["pairing"] = {"key": pairing.get("key"), "line": pairing.get("line"),
                              "sender": pairing.get("sender")}
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return payload


def read_state(path):
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(payload, dict) or payload.get("state") not in STATES:
        return None
    return payload


def describe(payload):
    """One-line human status for the status CLI."""
    if payload is None:
        return "AIPSTER Worker tray has never run here (no state file)."
    line = f"state={payload['state']}"
    if payload.get("detail"):
        line += f" detail={payload['detail']}"
    if payload.get("worker_pid"):
        line += f" worker_pid={payload['worker_pid']}"
    if payload.get("port"):
        line += f" endpoint={http_origin(payload.get('host') or '?', payload['port'])}"
    line += f" restarts={payload.get('restarts', 0)} updated_at={payload.get('updated_at', '?')}"
    overlay = payload.get("pairing") or {}
    if overlay.get("key"):
        line += f" pairing={overlay['key']}"
    return line

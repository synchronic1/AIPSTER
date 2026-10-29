"""Tray controller state model. Pure (windowless): menu text, state file, honesty rules.

States describe the LOCAL worker process only. There is deliberately no
CONNECTED or INFERENCE_READY state: pairing is not implemented and dispatch
stays disabled, so the tray must never display those words as a status. The
menu carries a disabled "Pairing: not implemented" line instead.
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
    RUNNING: "Running locally (simulated engine) — not paired",
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
PAIRING_LINE = "Pairing: not implemented (worker never contacts AIPSTER)"

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


def menu_model(state, endpoint="", detail=""):
    """Menu structure for a state. Returns a list of item dicts:

    {"kind": "text", "label": ...}                      disabled status line
    {"kind": "sep"}                                     separator
    {"kind": "action", "id": ..., "label": ..., "enabled": bool}
    """
    header_line(state, detail)  # honesty gate on our template (raises on overclaim)
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
    items.append({"kind": "text", "label": PAIRING_LINE})
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
        return ("AIPSTER Worker", f"Port {detail} is already in use; "
                                  "stop the other worker, then Start worker.")
    if event == "started":
        return ("AIPSTER Worker", "Worker running locally — not paired.")
    if event == "stopped":
        return ("AIPSTER Worker", "Worker stopped.")
    raise ValueError(f"unknown balloon event: {event}")


# Fail fast (import time) if any shipped template overclaims. Menu headers embed
# STATE_TEXT verbatim, so gating the values covers the menu too.
for _text in list(STATE_TEXT.values()) + [PAIRING_LINE]:
    check_honest(_text)
for _event, _state in (("reuse", RUNNING), ("restarted", STARTING), ("giveup", ERROR),
                       ("port_busy", PORT_BUSY), ("started", RUNNING), ("stopped", STOPPED)):
    check_honest(balloon_for(_event, _state, "sample")[1])
del _text, _event, _state


def utcnow():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def write_state(path, state, detail="", worker_pid=None, host="", port=0, restarts=0,
                version=""):
    header_line(state, detail)  # honesty gate
    payload = {"state": state, "detail": detail, "worker_pid": worker_pid, "host": host,
               "port": port, "restarts": restarts, "version": version,
               "updated_at": utcnow()}
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
        from .firstrun import endpoint_url
        line += " endpoint=" + endpoint_url(payload.get('host', '?'), payload['port'])
    line += f" restarts={payload.get('restarts', 0)} updated_at={payload.get('updated_at', '?')}"
    return line

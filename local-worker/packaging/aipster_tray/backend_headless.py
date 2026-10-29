"""Headless backend: full controller behavior with zero shell/UI calls.

Used by qualify.py and CI, where no interactive desktop may be touched. State
transitions and notifications are logged; open_* return their targets without
opening anything. IPC (mutex + window messages) still works: the hidden
controller window is windowless, not absent.
"""
from .backend_base import Backend


class HeadlessBackend(Backend):
    name = "headless"

    def __init__(self, log):
        self.log = log
        self.events = []

    def attach(self, controller):
        self.log("backend=headless attached (no shell calls)")

    def detach(self):
        self.log("backend=headless detached")

    def refresh(self, state, detail=""):
        self.log(f"backend=headless state={state} detail={detail}")

    def notify(self, event, state="", detail=""):
        self.events.append((event, state, detail))
        self.log(f"backend=headless notify={event} state={state} detail={detail}")

    def open_dashboard(self, url):
        self.log(f"backend=headless open_dashboard suppressed url={url}")
        return url

    def open_logs(self, path):
        self.log(f"backend=headless open_logs suppressed path={path}")
        return str(path)

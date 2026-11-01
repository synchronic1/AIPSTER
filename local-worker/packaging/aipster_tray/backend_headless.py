"""Headless backend: full controller behavior with zero shell/UI calls.

Used by qualify.py and CI, where no interactive desktop may be touched. State
transitions and notifications are logged; open_* return their targets without
opening anything. IPC (mutex + window messages) still works: the hidden
controller window is windowless, not absent.
"""
import os
import shlex
import subprocess

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

    def open_config(self, path):
        self.events.append(("open_config", str(path)))
        self.log(f"backend=headless open_config suppressed path={path}")
        return str(path)

    def copy_text(self, text):
        self.events.append(("copy_text", str(text)))
        self.log("backend=headless copy_text suppressed")
        return True

    def run_pair_console(self, exe, args):
        if os.name == "nt":
            display = subprocess.list2cmdline([str(exe), *args])
            arg_display = subprocess.list2cmdline(list(args))
        else:
            display = shlex.join([str(exe), *args])
            arg_display = shlex.join(list(args))
        self.events.append(("pair_console", str(exe), arg_display))
        self.log(f"backend=headless pair_console suppressed cmd={display}")
        return (str(exe), list(args))

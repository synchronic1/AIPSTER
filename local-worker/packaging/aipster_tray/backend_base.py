"""Backend interface: the controller drives worker state; a backend presents it.

Two backends exist: win32 (real tray icon/menu/balloons, needs an interactive
desktop) and headless (stub for tests and CI: no shell calls at all, every
notification goes to the log). macOS/Linux have no backend in this milestone.
"""


class Backend:
    name = "base"

    def attach(self, controller):
        """Called once the controller window exists. Create UI affordances."""

    def detach(self):
        """Remove all UI affordances. Must never fail the shutdown path."""

    def refresh(self, state, detail=""):
        """Reflect a state transition (icon swap, tooltip)."""

    def notify(self, event, state="", detail=""):
        """User-visible notification for a controller event (may log only)."""

    def open_dashboard(self, url):
        """Open the dashboard URL. Returns the URL (test hook)."""

    def open_logs(self, path):
        """Open the logs directory. Returns the path (test hook)."""

    def run_pair_console(self, exe, args):
        """Launch the pair prompt in its own console. Returns (exe, args).

        The windowed tray has no console for the no-echo code prompt, so
        pairing runs in the console launcher (`aipster-worker pair`), which
        prompts, claims, and reports the paired resource id / key prefix
        only. Headless records the launch without spawning anything.
        """

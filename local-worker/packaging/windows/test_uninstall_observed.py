"""Source-level tests for qualify.py synchronous uninstall orchestration.

Fake runner/process/filesystem/clock outcomes only: no install, uninstall,
tray, daemon, registry, model, service, or network activity. Synthetic temp
dirs on the real filesystem (to prove exact-path scope); the child process
itself is always a scripted fake. Registry assertions stay CI-only.
"""
import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

WINDOWS = Path(__file__).resolve().parent
ROOT = WINDOWS.parent.parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / 'vendor/eif'))
sys.path.insert(0, str(WINDOWS.parent))
sys.path.insert(0, str(WINDOWS))
sys.path.insert(0, str(ROOT))

spec = importlib.util.spec_from_file_location('observed_qualify', WINDOWS / 'qualify.py')
qualify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qualify)


def completed(returncode=0, stdout="", stderr=""):
    return SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr)


class FakeRunner:
    """Scripted subprocess.run replacement.

    String commands are uninstall invocations (served from outcomes in
    order; BaseException instances are raised); tasklist lists are
    answered from tasklist_hits/tasklist_rc/tasklist_error. Anything
    else fails the test loudly.
    """

    def __init__(self, uninstall_outcomes=(), tasklist_hits=(),
                 tasklist_rc=0, tasklist_error=None):
        self.uninstall_outcomes = list(uninstall_outcomes)
        self.tasklist_hits = set(tasklist_hits)
        self.tasklist_rc = tasklist_rc
        self.tasklist_error = tasklist_error
        self.uninstall_calls = []
        self.tasklist_calls = []

    def __call__(self, cmd, **kwargs):
        if isinstance(cmd, str) and "uninstall-observe" in cmd:
            self.uninstall_calls.append((cmd, kwargs))
            outcome = self.uninstall_outcomes.pop(0)
            if isinstance(outcome, BaseException):
                raise outcome
            return outcome
        if isinstance(cmd, list) and cmd and os.path.basename(cmd[0]).lower() == "tasklist":
            self.tasklist_calls.append((cmd, kwargs))
            if self.tasklist_error is not None:
                raise self.tasklist_error
            lines = []
            for image in sorted(self.tasklist_hits):
                lines.append(f'"{image}","1234","Console","1","10,000 K"')
            return SimpleNamespace(returncode=self.tasklist_rc,
                                   stdout="\n".join(lines), stderr="")
        raise AssertionError(f"unexpected command: {cmd!r}")


def make_target(base, name="app", spaced=False):
    target = base / ("app with space" if spaced else name)
    target.mkdir(parents=True, exist_ok=True)
    (target / "uninstall.exe").write_bytes(b"fake-uninstaller-image")
    (target / "payload.dll").write_bytes(b"fake-payload")
    return target


def snapshot(target):
    return {p.name: p.read_bytes() for p in target.iterdir() if p.is_file()}


class UninstallCmdlineTests(unittest.TestCase):
    def test_exact_shape_unquoted_last(self):
        target = r"C:\Users\Runner Admin\App Installs\aipster qual space"
        cmd = qualify.uninstall_cmdline(r"C:\Tools\uninstall-observe.exe", target)
        self.assertEqual(cmd, '"C:\\Tools\\uninstall-observe.exe" /S _?=' + target)
        self.assertTrue(cmd.endswith("_?=" + target))
        self.assertNotIn('"_?=', cmd)
        self.assertLess(cmd.index("/S"), cmd.index("_?="))

    def test_rejects_relative_and_quoted_paths(self):
        with self.assertRaises(SystemExit):
            qualify.uninstall_cmdline("uninstall-observe.exe", r"relative\dir")
        with self.assertRaises(SystemExit):
            qualify.uninstall_cmdline("uninstall-observe.exe", r'C:\dir"quoted')
        with self.assertRaises(SystemExit):
            qualify.uninstall_cmdline(r'C:\dir"q\uninstall-observe.exe', r"C:\dir")
        with self.assertRaises(SystemExit):
            qualify.uninstall_cmdline("uninstall-observe.exe", r"C:\dir",
                                      extra=('/X"bad',))

    def test_list_form_would_quote_spaced_target(self):
        # Failing-first evidence for the verbatim-string form: an argv
        # list quotes a spaced _?= value, which NSIS 3.2.2 forbids.
        spaced = r"C:\path with space\target"
        quoted = subprocess.list2cmdline(["uninstall.exe", "/S", "_?=" + spaced])
        self.assertIn('"_?=', quoted)


class SyncUninstallOwnedTests(unittest.TestCase):
    def test_success_observed_and_copy_removed(self):
        with tempfile.TemporaryDirectory(prefix="aipster-uninst-") as tmp:
            base = Path(tmp)
            target = make_target(base)
            before = snapshot(target)
            runner = FakeRunner([completed(0, "silent ok", "")])
            with patch("subprocess.run", side_effect=runner):
                proc, detail = qualify.sync_uninstall_owned(
                    target, base / "work", {}, label="t")
            self.assertEqual(proc.returncode, 0)
            self.assertIn("observed exit 0", detail)
            self.assertEqual(snapshot(target), before)
            copy = base / "work" / "uninstall-owned-copy" / "uninstall-observe.exe"
            self.assertFalse(copy.exists())
            self.assertEqual(len(runner.uninstall_calls), 1)
            cmd, kwargs = runner.uninstall_calls[0]
            self.assertIsInstance(cmd, str)
            self.assertNotIn("shell", kwargs)
            self.assertTrue(cmd.startswith('"') and " /S " in cmd)
            self.assertTrue(cmd.endswith("_?=" + str(target)))

    def test_missing_exe_never_launches(self):
        with tempfile.TemporaryDirectory(prefix="aipster-uninst-") as tmp:
            base = Path(tmp)
            target = base / "app"
            target.mkdir()
            with patch("subprocess.run") as fake_run:
                with self.assertRaises(SystemExit):
                    qualify.sync_uninstall_owned(target, base / "work", {})
                fake_run.assert_not_called()
            self.assertFalse((base / "work" / "uninstall-owned-copy").exists())

    def test_copy_mismatch_never_launches(self):
        with tempfile.TemporaryDirectory(prefix="aipster-uninst-") as tmp:
            base = Path(tmp)
            target = make_target(base)
            with patch.object(qualify, "_file_sha256", side_effect=["aaa", "bbb"]), \
                 patch("subprocess.run") as fake_run:
                with self.assertRaises(SystemExit):
                    qualify.sync_uninstall_owned(target, base / "work", {})
                fake_run.assert_not_called()
            copy = base / "work" / "uninstall-owned-copy" / "uninstall-observe.exe"
            self.assertFalse(copy.exists())

    def test_timeout_reports_unknown_without_retry(self):
        with tempfile.TemporaryDirectory(prefix="aipster-uninst-") as tmp:
            base = Path(tmp)
            target = make_target(base)
            before = snapshot(target)
            runner = FakeRunner(
                [subprocess.TimeoutExpired("uninstall-observe.exe /S _?=x", 120)])
            with patch("subprocess.run", side_effect=runner):
                proc, detail = qualify.uninstall_cycle(
                    target, base / "work", {}, label="t")
            self.assertIsNone(proc)
            self.assertIn("timed out", detail)
            self.assertEqual(len(runner.uninstall_calls), 1)
            for cmd, _ in runner.uninstall_calls:
                self.assertNotIn("taskkill", cmd.lower())
            self.assertEqual(snapshot(target), before)
            copy = base / "work" / "uninstall-owned-copy" / "uninstall-observe.exe"
            self.assertFalse(copy.exists())

    def test_launch_failure_records_without_run(self):
        with tempfile.TemporaryDirectory(prefix="aipster-uninst-") as tmp:
            base = Path(tmp)
            target = make_target(base)
            before = snapshot(target)
            runner = FakeRunner([FileNotFoundError(2, "synthetic missing image")])
            with patch("subprocess.run", side_effect=runner):
                proc, detail = qualify.uninstall_cycle(
                    target, base / "work", {}, label="t")
            self.assertIsNone(proc)
            self.assertIn("launch failed", detail)
            self.assertEqual(len(runner.uninstall_calls), 1)
            self.assertEqual(snapshot(target), before)


class UninstallCycleRetryTests(unittest.TestCase):
    def test_exit2_without_worker_retries_once_then_passes(self):
        with tempfile.TemporaryDirectory(prefix="aipster-uninst-") as tmp:
            base = Path(tmp)
            target = make_target(base)
            runner = FakeRunner([completed(2, "", "locked"),
                                 completed(0, "removed", "")])
            with patch("subprocess.run", side_effect=runner):
                proc, log = qualify.uninstall_cycle(
                    target, base / "work", {}, label="t")
            self.assertEqual(proc.returncode, 0)
            self.assertIn("attempt1:", log)
            self.assertIn("attempt2:", log)
            self.assertEqual(len(runner.uninstall_calls), 2)
            self.assertNotEqual(runner.tasklist_calls, [])

    def test_exit2_with_live_worker_never_retries(self):
        with tempfile.TemporaryDirectory(prefix="aipster-uninst-") as tmp:
            base = Path(tmp)
            target = make_target(base)
            runner = FakeRunner([completed(2, "", "locked")],
                                tasklist_hits={"dendrite.exe"})
            with patch("subprocess.run", side_effect=runner):
                proc, log = qualify.uninstall_cycle(
                    target, base / "work", {}, label="t")
            self.assertEqual(proc.returncode, 2)
            self.assertEqual(len(runner.uninstall_calls), 1)
            self.assertIn("dendrite.exe", log)

    def test_exit2_with_unknown_tasklist_never_retries(self):
        with tempfile.TemporaryDirectory(prefix="aipster-uninst-") as tmp:
            base = Path(tmp)
            target = make_target(base)
            runner = FakeRunner([completed(2, "", "locked")],
                                tasklist_error=OSError("synthetic tasklist failure"))
            with patch("subprocess.run", side_effect=runner):
                proc, log = qualify.uninstall_cycle(
                    target, base / "work", {}, label="t")
            self.assertEqual(proc.returncode, 2)
            self.assertEqual(len(runner.uninstall_calls), 1)
            self.assertIn("unknown", log)

    def test_clean_exit_never_retries(self):
        with tempfile.TemporaryDirectory(prefix="aipster-uninst-") as tmp:
            base = Path(tmp)
            target = make_target(base)
            runner = FakeRunner([completed(0, "removed", "")])
            with patch("subprocess.run", side_effect=runner):
                proc, log = qualify.uninstall_cycle(
                    target, base / "work", {}, label="t")
            self.assertEqual(proc.returncode, 0)
            self.assertEqual(len(runner.uninstall_calls), 1)
            self.assertEqual(runner.tasklist_calls, [])

    def test_spaced_target_stays_unquoted_through_cycle(self):
        with tempfile.TemporaryDirectory(prefix="aipster-uninst-") as tmp:
            base = Path(tmp)
            target = make_target(base, spaced=True)
            runner = FakeRunner([completed(0, "removed", "")])
            with patch("subprocess.run", side_effect=runner):
                proc, _ = qualify.uninstall_cycle(
                    target, base / "work", {}, label="t")
            self.assertEqual(proc.returncode, 0)
            cmd, _ = runner.uninstall_calls[0]
            self.assertTrue(cmd.endswith("_?=" + str(target)))
            self.assertNotIn('"_?=', cmd)


class WorkerImagesTests(unittest.TestCase):
    def run_snapshot(self, runner):
        with patch("subprocess.run", side_effect=runner):
            return qualify.worker_images_running()

    def test_empty_means_clean(self):
        self.assertEqual(self.run_snapshot(FakeRunner()), ([], []))

    def test_worker_line_is_reported(self):
        running, unknown = self.run_snapshot(
            FakeRunner(tasklist_hits={"dendrite.exe"}))
        self.assertEqual(running, ["dendrite.exe"])
        self.assertEqual(unknown, [])

    def test_tasklist_failure_is_unknown_not_clean(self):
        running, unknown = self.run_snapshot(
            FakeRunner(tasklist_rc=1))
        self.assertEqual(running, [])
        self.assertTrue(unknown)


if __name__ == "__main__":
    unittest.main()

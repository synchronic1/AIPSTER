"""Source-level tests for qualify.py synchronous uninstall orchestration.

Fake runner/process/filesystem/clock outcomes only: no install, uninstall,
tray, daemon, registry, model, service, or network activity. Synthetic temp
dirs on the real filesystem (to prove exact-path scope); the child process
itself is always a scripted fake. Registry assertions stay CI-only.
"""
import importlib.util
import os
import shutil
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


def ok_proc(returncode=0, stdout="", stderr=""):
    return SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr)


class FakeRunner:
    """Scripted subprocess.run replacement.

    Verbatim-string commands are owned-copy sync invocations (served
    from outcomes in order); [uninstall.exe, /S...] lists are detached
    launches (served from detached_outcomes); tasklist lists are
    answered from tasklist_hits/tasklist_rc/tasklist_error. BaseException
    instances are raised. Anything else fails the test loudly.
    """

    INSTALL_TOKEN = "synthetic-fixture-token"

    def __init__(self, uninstall_outcomes=(), tasklist_hits=(),
                 tasklist_rc=0, tasklist_error=None, detached_outcomes=()):
        self.uninstall_outcomes = list(uninstall_outcomes)
        self.detached_outcomes = list(detached_outcomes)
        self.tasklist_hits = set(tasklist_hits)
        self.tasklist_rc = tasklist_rc
        self.tasklist_error = tasklist_error
        self.uninstall_calls = []
        self.detached_calls = []
        self.tasklist_calls = []
        self.setup_calls = []
        self.launcher_calls = []
        self.calls = []

    def __call__(self, cmd, **kwargs):
        if isinstance(cmd, str) and "uninstall-observe" in cmd:
            self.uninstall_calls.append((cmd, kwargs))
            outcome = self.uninstall_outcomes.pop(0)
            if isinstance(outcome, BaseException):
                raise outcome
            return outcome
        if isinstance(cmd, list) and cmd:
            name = os.path.basename(cmd[0]).lower()
            if name == "tasklist":
                self.tasklist_calls.append((cmd, kwargs))
                if self.tasklist_error is not None:
                    raise self.tasklist_error
                lines = []
                for image in sorted(self.tasklist_hits):
                    lines.append(f'"{image}","1234","Console","1","10,000 K"')
                return SimpleNamespace(returncode=self.tasklist_rc,
                                       stdout="\n".join(lines), stderr="")
            if name.startswith("setup"):
                self.setup_calls.append((cmd, kwargs))
                self.calls.append(("setup", cmd))
                target = None
                for part in cmd[1:]:
                    if isinstance(part, str) and part.startswith("/D="):
                        target = Path(part[3:])
                if target is None:
                    raise AssertionError(f"setup without /D=: {cmd!r}")
                make_install_tree(target)
                return SimpleNamespace(returncode=0, stdout="", stderr="")
            if name == "aipster-worker.exe":
                self.launcher_calls.append((cmd, kwargs))
                env = kwargs.get("env") or {}
                if "broken-home" in str(env.get("LOCALAPPDATA", "")):
                    return SimpleNamespace(
                        returncode=2, stdout="",
                        stderr="dendrite: no engine binary found")
                return SimpleNamespace(returncode=2, stdout="",
                                       stderr="address already in use")
            if name == "uninstall.exe":
                self.detached_calls.append((cmd, kwargs))
                self.calls.append(("detached", cmd))
                outcome = self.detached_outcomes.pop(0)
                if isinstance(outcome, BaseException):
                    raise outcome
                return outcome
        raise AssertionError(f"unexpected command: {cmd!r}")


def make_install_tree(target):
    target.mkdir(parents=True, exist_ok=True)
    for name in ("uninstall.exe", "aipster-worker.exe", "dendrite.exe",
                 "aipster-tray.exe", "default.toml", "BUILD.json"):
        (target / name).write_bytes(b"synthetic-" + name.encode())


def make_fake_popen(spawned):
    class FakePopen:
        def __init__(self, *args, **kwargs):
            self.args = args
            self.kwargs = kwargs
            spawned.append(self)
            env = kwargs.get("env") or {}
            local = env.get("LOCALAPPDATA")
            if local:
                data = Path(local) / "AIPSTER-Worker"
                data.mkdir(parents=True, exist_ok=True)
                (data / "api-token.txt").write_text(FakeRunner.INSTALL_TOKEN)
                logs = data / "logs"
                logs.mkdir(exist_ok=True)
                (logs / "worker.log").write_text("listening on 127.0.0.1\n")
            self._terminated = False

        def poll(self):
            return None

        def terminate(self):
            self._terminated = True

        def kill(self):
            self._terminated = True

        def wait(self, timeout=None):
            return 0

        def communicate(self, input=None, timeout=None):
            return ("", "")

    return FakePopen


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
            runner = FakeRunner([ok_proc(0, "silent ok", "")])
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
            runner = FakeRunner([ok_proc(2, "", "locked"),
                                 ok_proc(0, "removed", "")])
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
            runner = FakeRunner([ok_proc(2, "", "locked")],
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
            runner = FakeRunner([ok_proc(2, "", "locked")],
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
            runner = FakeRunner([ok_proc(0, "removed", "")])
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
            runner = FakeRunner([ok_proc(0, "removed", "")])
            with patch("subprocess.run", side_effect=runner):
                proc, _ = qualify.uninstall_cycle(
                    target, base / "work", {}, label="t")
            self.assertEqual(proc.returncode, 0)
            cmd, _ = runner.uninstall_calls[0]
            self.assertTrue(cmd.endswith("_?=" + str(target)))
            self.assertNotIn('"_?=', cmd)


class ExtraFlagOrderingTests(unittest.TestCase):
    def test_extra_flags_stay_before_target(self):
        cmd = qualify.uninstall_cmdline("u.exe", r"C:\T", extra=("/REMOVEDATA=1",))
        self.assertEqual(cmd, '"u.exe" /S /REMOVEDATA=1 _?=C:\\T')
        self.assertTrue(cmd.endswith("_?=C:\\T"))


class ScratchContainmentTests(unittest.TestCase):
    def test_scratch_inside_target_rejected_without_launch(self):
        with tempfile.TemporaryDirectory(prefix="aipster-uninst-") as tmp:
            base = Path(tmp)
            target = make_target(base)
            before = snapshot(target)
            work = target / "w"
            with patch("subprocess.run") as run_mock:
                with self.assertRaises(SystemExit):
                    qualify.sync_uninstall_owned(target, work, {}, label="t")
                run_mock.assert_not_called()
            self.assertEqual(snapshot(target), before)
            self.assertFalse((work / "uninstall-owned-copy").exists())

    def test_canonical_junction_escape_rejected(self):
        # Simulate work/ resolving inside the removal target (junction):
        # resolved containment must win over the unresolved strings.
        with tempfile.TemporaryDirectory(prefix="aipster-uninst-") as tmp:
            base = Path(tmp)
            target = make_target(base)
            work = base / "elsewhere"
            work.mkdir()
            real_resolve = Path.resolve
            real_work = real_resolve(work)
            real_target = real_resolve(target)

            def resolving(self, strict=False):
                out = real_resolve(self)
                prefix = str(real_work)
                if out == real_work or str(out).startswith(prefix + os.sep):
                    return Path(str(real_target) + os.sep + "smuggled"
                                + str(out)[len(prefix):])
                return out

            with patch.object(Path, "resolve", autospec=True,
                              side_effect=resolving):
                with patch("subprocess.run") as run_mock:
                    with self.assertRaises(SystemExit):
                        qualify.sync_uninstall_owned(target, work, {}, label="t")
                    run_mock.assert_not_called()

    def test_builder_failure_stages_nothing(self):
        with tempfile.TemporaryDirectory(prefix="aipster-uninst-") as tmp:
            base = Path(tmp)
            target = make_target(base)
            with patch("subprocess.run") as run_mock:
                with self.assertRaises(SystemExit):
                    qualify.sync_uninstall_owned(
                        target, base / "work", {}, label="t",
                        extra=('/X"bad',))
                run_mock.assert_not_called()
            self.assertFalse((base / "work" / "uninstall-owned-copy").exists())

    def test_staging_failure_cleans_up_without_launch(self):
        with tempfile.TemporaryDirectory(prefix="aipster-uninst-") as tmp:
            base = Path(tmp)
            target = make_target(base)
            with patch("os.open",
                        side_effect=OSError("synthetic stage failure")):
                with patch("subprocess.run") as run_mock:
                    with self.assertRaises(SystemExit):
                        qualify.sync_uninstall_owned(
                            target, base / "work", {}, label="t")
                    run_mock.assert_not_called()
            probe = base / "work" / "uninstall-owned-copy"
            self.assertFalse([p for p in probe.rglob("*") if p.is_file()])


class DetachedUninstallCycleTests(unittest.TestCase):
    def run_cycle(self, target, runner, gone, env=None):
        with patch("subprocess.run", side_effect=runner), \
             patch.object(qualify, "wait_gone", return_value=gone):
            return qualify.detached_uninstall_cycle(
                target, env or {}, label="t")

    def test_ordinary_path_success(self):
        with tempfile.TemporaryDirectory(prefix="aipster-uninst-") as tmp:
            base = Path(tmp)
            target = make_target(base)
            before = snapshot(target)
            runner = FakeRunner(detached_outcomes=[ok_proc(0, "removed", "")])
            launcher_ok, completed, log = self.run_cycle(
                target, runner, gone=True)
            self.assertTrue(launcher_ok)
            self.assertTrue(completed)
            self.assertIn("completed", log)
            self.assertEqual(len(runner.detached_calls), 1)
            self.assertEqual(snapshot(target), before)

    def test_launcher_exit_nonzero_is_failure(self):
        with tempfile.TemporaryDirectory(prefix="aipster-uninst-") as tmp:
            base = Path(tmp)
            target = make_target(base)
            runner = FakeRunner(detached_outcomes=[ok_proc(2, "", "denied")])
            launcher_ok, completed, log = self.run_cycle(
                target, runner, gone=True)
            self.assertFalse(launcher_ok)
            self.assertFalse(completed)
            self.assertIn("launcher exit 2", log)
            self.assertEqual(len(runner.detached_calls), 1)

    def test_launcher_timeout_is_unknown(self):
        with tempfile.TemporaryDirectory(prefix="aipster-uninst-") as tmp:
            base = Path(tmp)
            target = make_target(base)
            runner = FakeRunner(detached_outcomes=[
                subprocess.TimeoutExpired("uninstall.exe /S", 60)])
            launcher_ok, completed, log = self.run_cycle(
                target, runner, gone=False)
            self.assertFalse(launcher_ok)
            self.assertFalse(completed)
            self.assertIn("launcher itself timed out", log)

    def test_launch_failure_is_unknown(self):
        with tempfile.TemporaryDirectory(prefix="aipster-uninst-") as tmp:
            base = Path(tmp)
            target = make_target(base)
            runner = FakeRunner(detached_outcomes=[
                FileNotFoundError(2, "synthetic missing image")])
            launcher_ok, completed, log = self.run_cycle(
                target, runner, gone=False)
            self.assertFalse(launcher_ok)
            self.assertFalse(completed)
            self.assertIn("launch failed", log)

    def test_exit0_but_target_remains_fails_without_second_launch(self):
        # The PR86 shape: launcher exit 0 proves spawn, not completion.
        # Unknown completion must FAIL with read-only evidence and must
        # never start another uninstaller against that target.
        with tempfile.TemporaryDirectory(prefix="aipster-uninst-") as tmp:
            base = Path(tmp)
            target = make_target(base)
            before = snapshot(target)
            runner = FakeRunner(detached_outcomes=[ok_proc(0, "spawned", "")])
            launcher_ok, completed, log = self.run_cycle(
                target, runner, gone=False)
            self.assertTrue(launcher_ok)
            self.assertFalse(completed)
            self.assertIn("completion unobserved", log)
            self.assertIn("payload.dll", log)
            self.assertIn("uninstall.exe", log)
            self.assertEqual(len(runner.detached_calls), 1)
            self.assertEqual(len(runner.uninstall_calls), 0)
            self.assertNotEqual(runner.tasklist_calls, [])
            self.assertEqual(snapshot(target), before)

    def test_unknown_timeout_names_live_worker(self):
        with tempfile.TemporaryDirectory(prefix="aipster-uninst-") as tmp:
            base = Path(tmp)
            target = make_target(base)
            runner = FakeRunner(
                detached_outcomes=[ok_proc(0, "spawned", "")],
                tasklist_hits={"aipster-tray.exe"})
            launcher_ok, completed, log = self.run_cycle(
                target, runner, gone=False)
            self.assertTrue(launcher_ok)
            self.assertFalse(completed)
            self.assertIn("aipster-tray.exe", log)
            self.assertEqual(len(runner.detached_calls), 1)
            self.assertEqual(len(runner.uninstall_calls), 0)


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



class ExtraFlagTests(unittest.TestCase):
    def test_extra_flags_stay_before_target(self):
        cmd = qualify.uninstall_cmdline("u.exe", r"C:\T", extra=("/REMOVEDATA=1",))
        self.assertEqual(cmd, '"u.exe" /S /REMOVEDATA=1 _?=C:\\T')
        self.assertTrue(cmd.endswith("_?=C:\\T"))


class ScratchContainmentTests(unittest.TestCase):
    def test_scratch_inside_target_rejected_without_launch(self):
        with tempfile.TemporaryDirectory(prefix="aipster-uninst-") as tmp:
            base = Path(tmp)
            target = make_target(base)
            before = snapshot(target)
            work = target / "w"
            with patch("subprocess.run") as run_mock:
                with self.assertRaises(SystemExit):
                    qualify.sync_uninstall_owned(target, work, {}, label="t")
                run_mock.assert_not_called()
            self.assertEqual(snapshot(target), before)
            self.assertFalse((work / "uninstall-owned-copy").exists())

    def test_canonical_junction_escape_rejected(self):
        # A work dir that *resolves* inside the removal target (junction)
        # must be refused even though the unresolved strings differ.
        with tempfile.TemporaryDirectory(prefix="aipster-uninst-") as tmp:
            base = Path(tmp)
            target = make_target(base)
            work = base / "elsewhere"
            work.mkdir()
            real_resolve = Path.resolve
            real_work = real_resolve(work)
            real_target = real_resolve(target)

            def resolving(self, strict=False):
                out = real_resolve(self)
                prefix = str(real_work)
                if out == real_work or str(out).startswith(prefix + os.sep):
                    return Path(str(real_target) + os.sep + "smuggled"
                                + str(out)[len(prefix):])
                return out

            with patch.object(Path, "resolve", autospec=True,
                              side_effect=resolving):
                with patch("subprocess.run") as run_mock:
                    with self.assertRaises(SystemExit):
                        qualify.sync_uninstall_owned(target, work, {}, label="t")
                    run_mock.assert_not_called()

    def test_builder_failure_stages_nothing(self):
        with tempfile.TemporaryDirectory(prefix="aipster-uninst-") as tmp:
            base = Path(tmp)
            target = make_target(base)
            with patch("subprocess.run") as run_mock:
                with self.assertRaises(SystemExit):
                    qualify.sync_uninstall_owned(
                        target, base / "work", {}, label="t",
                        extra=('/X"bad',))
                run_mock.assert_not_called()
            self.assertFalse((base / "work" / "uninstall-owned-copy").exists())

    def test_staging_failure_cleans_up_without_launch(self):
        with tempfile.TemporaryDirectory(prefix="aipster-uninst-") as tmp:
            base = Path(tmp)
            target = make_target(base)
            with patch("os.open",
                        side_effect=OSError("synthetic stage failure")):
                with patch("subprocess.run") as run_mock:
                    with self.assertRaises(SystemExit):
                        qualify.sync_uninstall_owned(
                            target, base / "work", {}, label="t")
                    run_mock.assert_not_called()
            probe = base / "work" / "uninstall-owned-copy"
            self.assertFalse([p for p in probe.rglob("*") if p.is_file()])


class DetachedUninstallCycleTests(unittest.TestCase):
    def run_cycle(self, target, runner, gone):
        with patch("subprocess.run", side_effect=runner), \
                patch.object(qualify, "wait_gone", return_value=gone):
            return qualify.detached_uninstall_cycle(
                target, {}, label="t")

    def test_ordinary_path_success(self):
        with tempfile.TemporaryDirectory(prefix="aipster-uninst-") as tmp:
            base = Path(tmp)
            target = make_target(base)
            before = snapshot(target)
            runner = FakeRunner(detached_outcomes=[ok_proc(0, "removed", "")])
            launcher_ok, completed, log = self.run_cycle(target, runner, True)
            self.assertTrue(launcher_ok)
            self.assertTrue(completed)
            self.assertIn("completed", log)
            self.assertEqual(len(runner.detached_calls), 1)
            self.assertEqual(snapshot(target), before)

    def test_launcher_exit_nonzero_is_failure(self):
        with tempfile.TemporaryDirectory(prefix="aipster-uninst-") as tmp:
            base = Path(tmp)
            target = make_target(base)
            runner = FakeRunner(detached_outcomes=[ok_proc(2, "", "denied")])
            launcher_ok, completed, log = self.run_cycle(target, runner, True)
            self.assertFalse(launcher_ok)
            self.assertFalse(completed)
            self.assertIn("launcher exit 2", log)
            self.assertEqual(len(runner.detached_calls), 1)

    def test_launcher_timeout_is_unknown(self):
        with tempfile.TemporaryDirectory(prefix="aipster-uninst-") as tmp:
            base = Path(tmp)
            target = make_target(base)
            runner = FakeRunner(detached_outcomes=[
                subprocess.TimeoutExpired("uninstall.exe /S", 60)])
            launcher_ok, completed, log = self.run_cycle(target, runner, False)
            self.assertFalse(launcher_ok)
            self.assertFalse(completed)
            self.assertIn("launcher itself timed out", log)

    def test_launch_failure_is_unknown(self):
        with tempfile.TemporaryDirectory(prefix="aipster-uninst-") as tmp:
            base = Path(tmp)
            target = make_target(base)
            runner = FakeRunner(detached_outcomes=[
                FileNotFoundError(2, "synthetic missing image")])
            launcher_ok, completed, log = self.run_cycle(target, runner, False)
            self.assertFalse(launcher_ok)
            self.assertFalse(completed)
            self.assertIn("launch failed", log)

    def test_exit0_but_target_remains_fails_without_second_launch(self):
        # The PR86 shape: launcher exit 0 proves spawn, not completion.
        # Unknown completion must FAIL with read-only evidence and must
        # never start another uninstaller against that target.
        with tempfile.TemporaryDirectory(prefix="aipster-uninst-") as tmp:
            base = Path(tmp)
            target = make_target(base)
            before = snapshot(target)
            runner = FakeRunner(detached_outcomes=[ok_proc(0, "spawned", "")])
            launcher_ok, completed, log = self.run_cycle(target, runner, False)
            self.assertTrue(launcher_ok)
            self.assertFalse(completed)
            self.assertIn("completion unobserved", log)
            self.assertIn("payload.dll", log)
            self.assertIn("uninstall.exe", log)
            self.assertEqual(len(runner.detached_calls), 1)
            self.assertEqual(runner.uninstall_calls, [])
            self.assertNotEqual(runner.tasklist_calls, [])
            self.assertEqual(snapshot(target), before)

    def test_unknown_timeout_names_live_worker(self):
        with tempfile.TemporaryDirectory(prefix="aipster-uninst-") as tmp:
            base = Path(tmp)
            target = make_target(base)
            runner = FakeRunner(
                detached_outcomes=[ok_proc(0, "spawned", "")],
                tasklist_hits={"aipster-tray.exe"})
            launcher_ok, completed, log = self.run_cycle(target, runner, False)
            self.assertTrue(launcher_ok)
            self.assertFalse(completed)
            self.assertIn("aipster-tray.exe", log)
            self.assertEqual(len(runner.detached_calls), 1)
            self.assertEqual(runner.uninstall_calls, [])
class FullProfileHaltTests(unittest.TestCase):
    """F-A: real full_profile halts ALL destructive work on detached-unknown.

    Every external effect is stubbed at the module seam (installer/launcher
    runs, Popen, HTTP, registry, PE/icon readers, matrices, mkdtemp); the
    real orchestration -- halt flag, created.release, marker write, skips,
    nonzero return, atexit preservation -- executes. Pre-uninstall checks
    FAIL under stubs; those failures must propagate (rc nonzero), not be
    masked by the halt.
    """

    def _seed_cpu_data(self, path):
        p = Path(path)
        p.mkdir(parents=True, exist_ok=True)
        (p / "api-token.txt").write_text("C" * 43, encoding="utf-8")

    def _drive_halted_profile(self, extra=()):
        """Run the real full_profile to a detached-unknown halt; return evidence."""
        from contextlib import ExitStack
        tmp = Path(tempfile.mkdtemp(prefix="aipster-fullhalt-"))
        real_rmtree = shutil.rmtree
        self.addCleanup(real_rmtree, tmp, ignore_errors=True)
        work = tmp / "work"

        run_calls = []
        launcher_runs = []
        popen_calls = []
        cycle_calls = []
        uninstall_cycle_calls = []
        sync_owned_calls = []
        matrix_calls = []
        preflight_calls = []
        tray_calls = []
        pure_calls = []
        rmtree_calls = []
        atexit_funcs = []
        ports = iter([18091, 18092, 18093, 18094])

        class FakeProc:
            def __init__(self, args):
                self.args = args

            def poll(self):
                return None

            def terminate(self):
                pass

            def kill(self):
                pass

            def wait(self, timeout=None):
                return 0

            def communicate(self, timeout=None):
                return ("", "")

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        def fake_mkdtemp(*args, **kwargs):
            work.mkdir(parents=True, exist_ok=True)
            (work / "app").mkdir(parents=True, exist_ok=True)
            return str(work)

        real_mkdir = Path.mkdir

        def seed_mkdir(self, *args, **kwargs):
            real_mkdir(self, *args, **kwargs)
            if self.name == "home" and self.parent == work:
                # Production code creates home/; the fixture OS (installer
                # plus launcher) would populate it -- seed the profile here.
                data = self / "AIPSTER-Worker"
                (data / "state").mkdir(parents=True, exist_ok=True)
                (data / "logs").mkdir(parents=True, exist_ok=True)
                (data / "api-token.txt").write_text("K" * 43, encoding="utf-8")
                (data / "config.toml").write_text("[node]\n", encoding="utf-8")
                (data / "qual-marker.txt").write_text("preserve-me",
                                                      encoding="utf-8")
                (data / "logs" / "worker.log").write_text("listening\n",
                                                          encoding="utf-8")

        def fake_run(cmd, env, timeout=180):
            run_calls.append(cmd)
            argv = cmd if isinstance(cmd, list) else [cmd]
            first = str(argv[0])
            if first.lower().endswith("setup.exe"):
                return ok_proc(0, "", "")
            if len(argv) == 1 and first.lower().endswith(".exe"):
                launcher_runs.append(first)
                if len(launcher_runs) == 1:
                    return ok_proc(2, "already in use", "")
                return ok_proc(2, "dendrite: bad config", "")
            return ok_proc(0, "", "")

        def fake_detached(target, env, label, timeout=180):
            cycle_calls.append((str(target), label))
            return True, False, "synthetic detached completion unknown"

        saved_failures = list(qualify.FAILURES)
        saved_ports = set(qualify.USED_PORTS)
        qualify.FAILURES.clear()
        try:
            with ExitStack() as stack:
                stack.enter_context(patch("tempfile.mkdtemp",
                                          side_effect=fake_mkdtemp))
                stack.enter_context(patch(
                    "subprocess.Popen",
                    side_effect=lambda *a, **k: popen_calls.append(a[0])
                    or FakeProc(a[0])))
                stack.enter_context(patch(
                    "atexit.register",
                    side_effect=lambda fn: atexit_funcs.append(fn)))
                stack.enter_context(patch(
                    "shutil.rmtree",
                    side_effect=lambda p, *a, **k: rmtree_calls.append(
                        str(p))))
                stack.enter_context(patch("socket.gethostbyname",
                                          side_effect=OSError("no LAN here")))
                stack.enter_context(patch.object(Path, "mkdir", seed_mkdir))
                stack.enter_context(patch.object(qualify, "run_silent",
                                                 side_effect=fake_run))
                stack.enter_context(patch.object(
                    qualify, "detached_uninstall_cycle",
                    side_effect=fake_detached))
                stack.enter_context(patch.object(
                    qualify, "uninstall_cycle",
                    side_effect=lambda *a, **k: uninstall_cycle_calls.append(
                        a)))
                stack.enter_context(patch.object(
                    qualify, "sync_uninstall_owned",
                    side_effect=lambda *a, **k: sync_owned_calls.append(a)))
                stack.enter_context(patch.object(
                    qualify, "uninstall_failure_matrix",
                    side_effect=lambda *a: matrix_calls.append(a)))
                stack.enter_context(patch.object(
                    qualify, "preflight_matrix",
                    side_effect=lambda *a: preflight_calls.append(a)))
                stack.enter_context(patch.object(
                    qualify, "tray_matrix",
                    side_effect=lambda *a: tray_calls.append(a)))
                stack.enter_context(patch.object(
                    qualify, "pure_tests",
                    side_effect=lambda: pure_calls.append(True)))
                stack.enter_context(patch.object(qualify, "wait_health",
                                                 return_value=True))
                stack.enter_context(patch.object(qualify, "http_status",
                                                 return_value=(599, b"")))
                stack.enter_context(patch.object(qualify, "raw_status",
                                                 return_value=599))
                stack.enter_context(patch.object(
                    qualify, "check_token_acl",
                    side_effect=lambda *a: None))
                stack.enter_context(patch.object(
                    qualify, "private_fixture_directory",
                    side_effect=self._seed_cpu_data))
                stack.enter_context(patch.object(
                    qualify, "pe_subsystem",
                    side_effect=lambda p: 2
                    if Path(p).name == "aipster-tray.exe" else 3))
                stack.enter_context(patch.object(
                    qualify, "ico_entries",
                    return_value=[(16, 16), (32, 32), (48, 48), (64, 64),
                                  (128, 128), (256, 256), (48, 48)]))
                stack.enter_context(patch.object(qualify, "reg_value",
                                                 return_value=None))
                stack.enter_context(patch.object(qualify, "reg_key_exists",
                                                 return_value=False))
                stack.enter_context(patch.object(
                    qualify, "free_port", side_effect=lambda: next(ports)))
                stack.enter_context(patch.object(
                    qualify, "lnk_target",
                    return_value="C:\\fake\\aipster-tray.exe"))
                for context in extra:
                    stack.enter_context(context)
                rc = qualify.full_profile(str(tmp / "Setup.exe"))
            observed = list(qualify.FAILURES)
        finally:
            qualify.FAILURES[:] = saved_failures
            qualify.USED_PORTS.clear()
            qualify.USED_PORTS.update(saved_ports)

        install = work / "app"
        return SimpleNamespace(
            rc=rc, observed=observed, work=work, install=install,
            marker=work / qualify.HALTED_MARKER_NAME,
            run_calls=run_calls, launcher_runs=launcher_runs,
            popen_calls=popen_calls, cycle_calls=cycle_calls,
            uninstall_cycle_calls=uninstall_cycle_calls,
            sync_owned_calls=sync_owned_calls, matrix_calls=matrix_calls,
            preflight_calls=preflight_calls, tray_calls=tray_calls,
            pure_calls=pure_calls, rmtree_calls=rmtree_calls,
            atexit_funcs=atexit_funcs)

    def invoke_cleanup(self, r):
        with patch("shutil.rmtree",
                   side_effect=lambda p, *a, **k: r.rmtree_calls.append(
                       str(p))):
            r.atexit_funcs[0]()

    def test_unknown_detached_halts_destructive_work(self):
        r = self._drive_halted_profile()
        # First FAIL preserved; halt path returns nonzero.
        self.assertEqual(r.rc, 1)
        self.assertIn("uninstall completes (async self-copy)", r.observed)
        self.assertNotIn("silent uninstall exits 0", r.observed)
        # Exactly one ordinary detached attempt; no sync substitute.
        self.assertEqual(len(r.cycle_calls), 1)
        self.assertEqual(r.cycle_calls[0], (str(r.install),
                                            "silent uninstall"))
        # Tripwire: no later install/uninstall/retry/matrix anywhere.
        self.assertEqual(r.uninstall_cycle_calls, [])
        self.assertEqual(r.sync_owned_calls, [])
        self.assertEqual(r.matrix_calls, [])
        setup_runs = [c for c in r.run_calls
                      if isinstance(c, list)
                      and str(c[0]).lower().endswith("setup.exe")]
        self.assertEqual(len(r.run_calls), 5)
        self.assertEqual(len(setup_runs), 3)
        self.assertEqual(len(r.launcher_runs), 2)
        for cmd in r.run_calls:
            text = cmd if isinstance(cmd, str) else " ".join(cmd)
            for banned in ("app2", "app3", "app4", "AUTOSTART", "REMOVEDATA",
                           "uninstall-observe", "uninstall.exe"):
                self.assertNotIn(banned, text)
        for argv in r.popen_calls:
            self.assertNotIn("uninstall",
                             " ".join(str(x) for x in argv).lower())
        # Pre-uninstall matrices ran (stubbed); failure matrix never did.
        self.assertEqual(len(r.preflight_calls), 1)
        self.assertEqual(len(r.tray_calls), 1)
        self.assertEqual(len(r.pure_calls), 1)
        # Target dropped from atexit cleanup; marker records the release.
        self.assertTrue(r.marker.is_file())
        text = r.marker.read_text(encoding="utf-8")
        self.assertIn("detached uninstall outcome unknown", text)
        self.assertIn("released", text)
        self.assertIn("no second launch", text)
        self.assertIn(str(r.install), text)
        # Tail + atexit preservation: no destructive cleanup of unknown work.
        self.assertTrue(r.work.exists())
        self.assertTrue(r.install.exists())
        self.assertEqual(r.rmtree_calls, [])
        self.assertEqual(len(r.atexit_funcs), 1)
        self.invoke_cleanup(r)
        self.assertEqual(r.rmtree_calls, [])
        self.assertTrue(r.work.exists())
        self.assertTrue(r.install.exists())
        self.assertTrue(r.marker.is_file())

    def test_marker_write_failure_returns_nonzero_halt(self):
        """Disk-full marker write: OSError must not escape; halt holds."""
        real_write_text = Path.write_text

        def fail_marker(self, *args, **kwargs):
            if self.name == qualify.HALTED_MARKER_NAME:
                raise OSError("synthetic disk full")
            return real_write_text(self, *args, **kwargs)

        r = self._drive_halted_profile(
            extra=[patch.object(Path, "write_text", fail_marker)])
        self.assertEqual(r.rc, 1)
        self.assertIn("uninstall completes (async self-copy)", r.observed)
        self.assertFalse(r.marker.exists())

    def test_marker_write_failure_cleanup_preserves_scratch(self):
        """With the marker never on disk, atexit cleanup still refuses."""
        real_write_text = Path.write_text

        def fail_marker(self, *args, **kwargs):
            if self.name == qualify.HALTED_MARKER_NAME:
                raise OSError("synthetic disk full")
            return real_write_text(self, *args, **kwargs)

        r = self._drive_halted_profile(
            extra=[patch.object(Path, "write_text", fail_marker)])
        self.assertFalse(r.marker.exists())
        self.assertEqual(len(r.atexit_funcs), 1)
        self.invoke_cleanup(r)
        self.assertEqual(r.rmtree_calls, [])
        self.assertTrue(r.work.exists())
        self.assertTrue(r.install.exists())

    def test_marker_absent_but_unknown_still_refuses_cleanup(self):
        """Marker written then deleted: in-memory halt still refuses cleanup."""
        r = self._drive_halted_profile()
        self.assertTrue(r.marker.is_file())
        r.marker.unlink()
        self.assertEqual(len(r.atexit_funcs), 1)
        self.invoke_cleanup(r)
        self.assertEqual(r.rmtree_calls, [])
        self.assertTrue(r.work.exists())
        self.assertTrue(r.install.exists())


class OwnedCopyStagingTests(unittest.TestCase):
    """F-B: exclusive owned-copy staging never writes through a link."""

    def make_tree(self):
        tmp = Path(tempfile.mkdtemp(prefix="aipster-ownedcopy-"))
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        target = tmp / "app"
        target.mkdir()
        (target / "uninstall.exe").write_bytes(b"FAKE-uninstaller-image")
        work = tmp / "scratch"
        work.mkdir()
        return tmp, target, work

    def no_launch(self, launched):
        return patch("subprocess.run",
                     side_effect=lambda *a, **k: launched.append(a)
                     or ok_proc(0))

    def test_occupied_destination_refused_and_preserved(self):
        tmp, target, work = self.make_tree()
        leaf = work / "uninstall-owned-copy" / qualify.UNINSTALL_COPY_NAME
        leaf.parent.mkdir(parents=True)
        occupant = b"SENTINEL-occupant-not-ours"
        leaf.write_bytes(occupant)
        launched = []
        with self.no_launch(launched):
            with self.assertRaises(SystemExit) as ctx:
                qualify.sync_uninstall_owned(target, work, {}, label="f-b")
        self.assertIn("already exists", str(ctx.exception))
        # Occupant preserved byte-identical; nothing launched or deleted.
        self.assertEqual(leaf.read_bytes(), occupant)
        self.assertEqual(launched, [])
        self.assertEqual(sorted(p.name for p in leaf.parent.iterdir()),
                         [qualify.UNINSTALL_COPY_NAME])

    def test_symlink_destination_refused_without_writethrough(self):
        tmp, target, work = self.make_tree()
        probe = work / "uninstall-owned-copy"
        probe.mkdir(parents=True)
        outside = tmp / "outside"
        outside.mkdir()
        loot = outside / "precious.bin"
        loot.write_bytes(b"SENTINEL-outside-not-ours")
        leaf = probe / qualify.UNINSTALL_COPY_NAME
        try:
            os.symlink(str(loot), str(leaf))
        except (OSError, NotImplementedError):
            self.skipTest("native symlink rights absent here; the "
                          "occupied-file test covers the same O_EXCL gate")
        try:
            launched = []
            with self.no_launch(launched):
                with self.assertRaises(SystemExit) as ctx:
                    qualify.sync_uninstall_owned(target, work, {}, label="f-b")
            self.assertIn("already exists", str(ctx.exception))
            # Written-through copy would have clobbered the link target.
            self.assertEqual(loot.read_bytes(), b"SENTINEL-outside-not-ours")
            self.assertTrue(leaf.is_symlink())
            self.assertEqual(launched, [])
        finally:
            try:
                if leaf.is_symlink():
                    leaf.unlink()
            except OSError:
                pass

    def test_symlinked_scratch_dir_refused(self):
        tmp, target, work = self.make_tree()
        probe = work / "uninstall-owned-copy"
        redirect = tmp / "redirect"
        redirect.mkdir()
        try:
            os.symlink(str(redirect), str(probe), target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("native symlink rights absent here")
        try:
            launched = []
            with self.no_launch(launched):
                with self.assertRaises(SystemExit) as ctx:
                    qualify.sync_uninstall_owned(target, work, {}, label="f-b")
            self.assertIn("not an owned directory", str(ctx.exception))
            self.assertEqual(list(redirect.iterdir()), [])
            self.assertEqual(launched, [])
        finally:
            try:
                if probe.is_symlink():
                    probe.unlink()
            except OSError:
                pass


if __name__ == "__main__":
    unittest.main()

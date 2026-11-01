"""One-process worker service tests. Stdlib only; no venv needed.

`pairing.py serve` runs the heartbeat sender and, with --jobs, the inference
job runner in one process. These tests drive the real CLI against the same
fake in-thread AIPSTER API and fake Ganglion the job-runner tests use:
everything is loopback and synthetic, no live upstream, no AIPSTER network,
no model load, no inference. Pairing credentials are throwaway fixtures.

Scenarios that stop a running service go through a real child process, because
that is how the service ends: the sender loop owns its own sleep and has no
external stop hook, so a stop finishes the in-flight job, posts it, and the
process exit ends the sender. Scenarios where the service ends by itself (a
refused lock, a dead key) also run in-process, where the exit code is exact.

The sender floors its period at HEARTBEAT_MIN_INTERVAL_SEC (30 s), so a child
that must show heartbeats *continuing* would need half a minute per beat.
FAST_FLOOR lowers only that one constant before running the same
`pairing.py` CLI (which still asks for `--interval 0`, since the flag is in
whole seconds and the floor is a minimum); the production floor is untouched.
"""

import argparse
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stdout, redirect_stderr
from io import StringIO
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import inference_worker
import pairing
import worker_service
from test_inference_worker import (FAKE_CODE, FAKE_SECRET, FakeApiState,
                                   FakeGanglionState, lease, make_api_server,
                                   make_ganglion_server)

CLI = [sys.executable, str(ROOT / "pairing.py")]
# Test-only: run the real `pairing.py` CLI with a short sender period.
FAST_FLOOR = (
    "import sys, pairing; "
    "pairing.HEARTBEAT_MIN_INTERVAL_SEC = float(sys.argv[1]); "
    "raise SystemExit(pairing.main(sys.argv[2:]))")


def fast_cli(interval=0.05):
    return [sys.executable, "-c", FAST_FLOOR, str(interval)]


class WorkerServiceTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data = Path(self.tmp.name) / "data"
        self.api = FakeApiState()
        self.api_server, self.base = make_api_server(self.api)
        self.addCleanup(self.api_server.server_close)
        self.addCleanup(self.api_server.shutdown)
        self.ganglion = FakeGanglionState()
        self.ganglion_server, self.gbase = make_ganglion_server(self.ganglion)
        self.addCleanup(self.ganglion_server.server_close)
        self.addCleanup(self.ganglion_server.shutdown)
        self._pair()

    def _pair(self):
        args = type("Args", (), {})()
        args.api_base = self.base
        args.data_dir = str(self.data)
        args.config = None
        args.name = None
        args.code = FAKE_CODE
        with redirect_stdout(StringIO()), redirect_stderr(StringIO()):
            self.assertEqual(pairing.cmd_pair(args), pairing.EXIT_OK)

    # -- harness ---------------------------------------------------------

    def heartbeat_args(self, interval=0.02):
        return argparse.Namespace(data_dir=str(self.data), config=None,
                                  interval=interval)

    def make_service(self, jobs=False, **over):
        """The service `cmd_serve` builds, minus the argument parsing."""
        runner = None
        if jobs:
            runner = inference_worker.JobRunner(
                self.data,
                ganglion_base=over.pop("ganglion_base", self.gbase),
                poll_interval=over.pop("poll_interval", 0.02))
        return worker_service.WorkerService(
            self.data, self.heartbeat_args(), jobs_runner=runner)

    def start(self, service):
        codes = []
        out, err = StringIO(), StringIO()

        def target():
            try:
                with redirect_stdout(out), redirect_stderr(err):
                    codes.append(service.run())
            except BaseException as exc:  # reported by finish(), not swallowed
                codes.append(exc)

        thread = threading.Thread(target=target, name="serve-under-test", daemon=True)
        thread.start()
        return thread, codes, out, err

    def wait_until(self, predicate, timeout=20.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return
            time.sleep(0.01)
        self.fail("condition not reached in %.1fs" % timeout)

    def finish(self, service, thread, codes, timeout=20.0):
        """The service ended by itself; return its exit code."""
        thread.join(timeout)
        self.assertFalse(thread.is_alive(), "the service did not stop within %ss" % timeout)
        self.assertEqual(len(codes), 1, "the service returned exactly once")
        code = codes[0]
        self.assertIsInstance(code, int, "the service returned an exit code, not %r" % (code,))
        return code

    def assert_sender_lock_released(self):
        # Nothing may be left beating for a data dir the service gave up on.
        self.wait_until(lambda: not pairing.sender_lock_held(self.data), timeout=5.0)

    def assert_no_secret(self, *streams):
        combined = "".join(stream.getvalue() for stream in streams)
        self.assertNotIn(FAKE_SECRET, combined)

    # -- child processes --------------------------------------------------

    def serve_argv(self, *extra, jobs=True):
        argv = ["--data-dir", str(self.data), "serve"]
        if jobs:
            argv += ["--jobs", "--upstream-url", self.gbase,
                     "--poll-interval", "0.05"]
        return argv + list(extra)

    def spawn(self, argv, fast=False, interval=0.05):
        argv = list(argv)
        if fast:
            # The floor is a minimum and the CLI takes whole seconds, so ask
            # for the shortest period it accepts; the floor does the rest.
            argv += ["--interval", "0"]
            argv = fast_cli(interval) + argv
        else:
            argv = CLI + argv
        proc = subprocess.Popen(
            argv, cwd=str(ROOT), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True)
        self.addCleanup(lambda: self._terminate(proc))
        return proc

    def _terminate(self, proc):
        """Stop a child and return its (stdout, stderr), once."""
        cached = getattr(proc, "collected_output", None)
        if cached is not None:
            return cached
        if proc.returncode is None:
            proc.terminate()
        try:
            result = proc.communicate(timeout=30)
        except subprocess.TimeoutExpired:
            proc.kill()
            result = proc.communicate()
        proc.collected_output = result
        return result

    def collect(self, proc, timeout=20):
        try:
            result = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            proc.kill()
            out, err = proc.communicate()
            self.fail("serve did not stop within %ss: %r" % (timeout, err))
        proc.collected_output = result
        return result

    # -- both loops -------------------------------------------------------

    def test_serve_runs_the_heartbeat_and_job_loops_together(self):
        proc = self.spawn(self.serve_argv())
        self.wait_until(lambda: self.api.beats and self.api.next_hits)
        self.assertIsNone(proc.poll(), "the service stays up")
        self.assertIs(self.api.beats[0]["usable"], False,
                      "a mock config never claims inference readiness")
        out, err = self._terminate(proc)
        self.assertNotIn(FAKE_SECRET, out + err)

    def test_serve_runs_a_leased_job_in_its_jobs_loop(self):
        self.api.leases = [lease()]
        proc = self.spawn(self.serve_argv())
        self.wait_until(lambda: self.api.results)
        self._terminate(proc)
        self.assertEqual(self.ganglion.hits["completions"], 1)
        body = self.api.results[0]["body"]
        self.assertEqual(body["status"], "succeeded")
        self.assertEqual(body["result"]["content"], "hello")
        self.assertTrue(inference_worker.StartedLedger(self.data).contains("job_1"))

    def test_heartbeat_only_mode_never_leases(self):
        self.api.leases = [lease()]
        proc = self.spawn(self.serve_argv(jobs=False), fast=True)
        self.wait_until(lambda: len(self.api.beats) >= 3)
        self._terminate(proc)
        self.assertEqual(self.api.next_hits, 0, "heartbeat-only mode runs no job loop")
        self.assertEqual(self.api.results, [])

    def test_upstream_down_means_no_lease_while_heartbeats_continue(self):
        self.ganglion.models_status = 503
        self.api.leases = [lease()]
        proc = self.spawn(self.serve_argv(), fast=True)
        self.wait_until(lambda: len(self.api.beats) >= 3)
        self.assertIsNone(proc.poll(), "the job loop backs off instead of exiting")
        self.assertEqual(self.api.next_hits, 0,
                         "a busy upstream is never leased work it would have to fail")
        self.assertEqual(self.api.results, [])
        self._terminate(proc)

    # -- single-instance locks -------------------------------------------

    def test_second_instance_is_refused_when_the_sender_lock_is_held(self):
        guard = pairing._hold_sender_lock(self.data)
        self.assertIsNotNone(guard, "the test holds the sender lock")
        self.addCleanup(guard.release)
        service = self.make_service(jobs=True)
        thread, codes, out, err = self.start(service)
        code = self.finish(service, thread, codes)
        self.assertEqual(code, pairing.EXIT_SENDER_RUNNING, err.getvalue())
        self.assertIn("SENDER_RUNNING", err.getvalue())
        self.assertEqual(self.api.next_hits, 0,
                         "a refused instance leases nothing before it exits")
        self.assertEqual(self.api.beats, [])

    def test_second_instance_is_refused_when_the_jobs_lock_is_held(self):
        guard = inference_worker._hold_lock(self.data,
                                            inference_worker.JOBS_LOCK_NAME)
        self.assertIsNotNone(guard, "the test holds the jobs lock")
        self.addCleanup(guard.release)
        proc = self.spawn(self.serve_argv())
        out, err = self.collect(proc)
        self.assertEqual(proc.returncode, pairing.EXIT_SENDER_RUNNING, out + err)
        self.assertIn("JOBS_RUNNING", err)
        self.assertEqual(self.api.next_hits, 0)
        self.assertEqual(self.api.results, [])
        self.assert_sender_lock_released()

    def test_second_instance_is_refused_across_processes(self):
        blocker = subprocess.Popen(
            CLI + ["--data-dir", str(self.data), "heartbeat-loop", "--interval", "30"],
            cwd=str(ROOT), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(lambda: blocker.poll() is None and blocker.kill())
        self.wait_until(lambda: pairing.sender_lock_held(self.data), timeout=15.0)
        try:
            result = subprocess.run(
                CLI + ["--data-dir", str(self.data), "serve", "--jobs",
                       "--upstream-url", self.gbase, "--poll-interval", "0.05"],
                cwd=str(ROOT), capture_output=True, text=True, timeout=60)
        finally:
            blocker.terminate()
            blocker.communicate()
        self.assertEqual(result.returncode, pairing.EXIT_SENDER_RUNNING,
                         result.stdout + result.stderr)
        self.assertEqual(self.api.next_hits, 0)
        self.assertEqual(self.api.results, [])

    # -- revoked key stops both loops ------------------------------------

    def test_revoked_heartbeat_key_exits_repair_required(self):
        self.api.live_keys = set()
        service = self.make_service(jobs=True)
        thread, codes, out, err = self.start(service)
        code = self.finish(service, thread, codes)
        self.assertEqual(code, pairing.EXIT_REPAIR_REQUIRED, err.getvalue())
        self.assertIn("KEY_REVOKED", err.getvalue())
        self.assertEqual(self.api.results, [], "no job result is posted for a dead key")
        self.assert_sender_lock_released()

    def test_revoked_key_from_the_job_loop_exits_repair_required(self):
        self.api.next_plan = [(401, {"code": "KEY_REVOKED", "error": "revoked"}, {})]
        proc = self.spawn(self.serve_argv())
        out, err = self.collect(proc)
        self.assertEqual(proc.returncode, pairing.EXIT_REPAIR_REQUIRED, out + err)
        self.assertIn("KEY_REVOKED", err)
        self.assertGreaterEqual(len(self.api.beats), 1,
                                "the sender kept beating until the job loop failed")
        self.assert_sender_lock_released()

    # -- CLI wiring -------------------------------------------------------

    def test_parser_wires_serve_with_job_flags(self):
        args = pairing.build_parser().parse_args(
            ["--data-dir", str(self.data), "serve", "--jobs",
             "--upstream-url", "http://127.0.0.1:8471", "--runtime-id", "llama-server",
             "--poll-interval", "0.5"])
        self.assertEqual(args.command, "serve")
        self.assertTrue(args.jobs)
        self.assertEqual(args.runtime_id, "llama-server")
        self.assertEqual(args.poll_interval, 0.5)
        self.assertEqual(args.ganglion_base, "http://127.0.0.1:8471")

    def test_parser_defaults_serve_to_heartbeat_only(self):
        args = pairing.build_parser().parse_args(["--data-dir", str(self.data), "serve"])
        self.assertFalse(args.jobs, "jobs are opt-in")
        self.assertIsNone(args.ganglion_base)

    def test_cli_serve_stops_with_repair_required_on_a_dead_key(self):
        self.api.live_keys = set()
        out, err = StringIO(), StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = pairing.main(["--data-dir", str(self.data), "serve"])
        self.assertEqual(code, pairing.EXIT_REPAIR_REQUIRED, err.getvalue())
        self.assertIn("KEY_REVOKED", err.getvalue())
        self.assert_no_secret(out, err)

    def test_module_cli_serves_heartbeats_and_stops_on_a_dead_key(self):
        self.api.live_keys = set()
        out, err = StringIO(), StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = worker_service.main(["--data-dir", str(self.data), "serve"])
        self.assertEqual(code, pairing.EXIT_REPAIR_REQUIRED, err.getvalue())

    def test_module_cli_refuses_a_bad_upstream_before_beating(self):
        out, err = StringIO(), StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = worker_service.main(["--data-dir", str(self.data), "serve", "--jobs",
                                        "--upstream-url", "http://192.168.1.203:8471"])
        self.assertEqual(code, pairing.EXIT_USAGE, err.getvalue())
        self.assertIn("BAD_GANGLION_BASE", err.getvalue())
        self.assertEqual(self.api.beats, [], "a misconfigured service never beats")
        self.assertEqual(self.api.next_hits, 0)

    # -- POSIX lifecycle --------------------------------------------------
    #
    # launchd and Ctrl+C signal a real process. Windows cannot deliver these
    # to a console-less child, so they skip there, as the job-runner signal
    # tests do. These children keep the production 30 s sender period: the
    # point is that a stop is prompt because it never waits for that sleep.

    @unittest.skipUnless(os.name == "posix", "POSIX signal semantics")
    def test_sigterm_with_a_job_in_flight_posts_it_then_exits_zero(self):
        self.api.leases = [lease()]
        self.ganglion.completion_delay = 0.8
        proc = self.spawn(self.serve_argv())
        self.wait_until(lambda: self.ganglion.hits["completions"] >= 1)
        proc.send_signal(signal.SIGTERM)
        started = time.monotonic()
        out, err = self.collect(proc)
        elapsed = time.monotonic() - started
        self.assertEqual(proc.returncode, 0, err)
        self.assertNotIn("Traceback", err)
        self.assertIn("stop requested", err)
        self.assertLess(elapsed, 5.0, "a stop never waits out the sender's sleep")
        self.assertEqual(self.ganglion.hits["completions"], 1,
                         "a stop never abandons or repeats the in-flight job")
        self.assertEqual(len(self.api.results), 1, "the finished report is posted")
        self.assertEqual(self.api.results[0]["body"]["status"], "succeeded")
        self.assertTrue(inference_worker.StartedLedger(self.data).contains("job_1"))
        self.assertNotIn(FAKE_SECRET, out + err)
        self.assert_sender_lock_released()

    @unittest.skipUnless(os.name == "posix", "POSIX signal semantics")
    def test_sigterm_while_idle_stops_heartbeats_and_exits_zero(self):
        proc = self.spawn(self.serve_argv())
        self.wait_until(lambda: self.api.beats and self.api.next_hits)
        beats_before = len(self.api.beats)
        proc.send_signal(signal.SIGTERM)
        _, err = self.collect(proc)
        self.assertEqual(proc.returncode, 0, err)
        self.assertIn("stop requested", err)
        time.sleep(0.3)
        self.assertEqual(len(self.api.beats), beats_before,
                         "no heartbeat outlives the service")
        self.assert_sender_lock_released()

    @unittest.skipUnless(os.name == "posix", "POSIX signal semantics")
    def test_sigint_while_idle_exits_zero(self):
        proc = self.spawn(self.serve_argv())
        self.wait_until(lambda: self.api.next_hits >= 1)
        proc.send_signal(signal.SIGINT)
        _, err = self.collect(proc)
        self.assertEqual(proc.returncode, 0, err)
        self.assertNotIn("Traceback", err)
        self.assertIn("stop requested", err)


if __name__ == "__main__":
    unittest.main()

"""One supported worker service: heartbeats and leased jobs in one process.

Operators used to run two long-lived commands side by side
(`pairing.py heartbeat-loop` and `pairing.py serve-jobs`). `pairing.py serve`
is the supported replacement: it runs both loops for one data dir and reports
one exit code.

  pairing.py serve                  heartbeats only
  pairing.py serve --jobs [...]     heartbeats and leased inference jobs

Nothing here reimplements a loop. Both halves are the existing commands'
own code, unchanged:

  * `pairing.cmd_heartbeat(loop=True)` owns the sender, the sender lock and
    every heartbeat policy (per-beat pairing reload, re-pair handoff,
    rate-limit and network backoff, status writes).
  * `inference_worker.JobRunner.run()` owns the job loop, the jobs lock, the
    started-job ledger and the probe/lease/complete/report sequence.

Why two threads and not one cooperative loop: both loops block -- on a fixed
heartbeat period, and on HTTP calls whose timeout is a job deadline or a
backoff step -- and each carries semantics this service must not re-express
(a second implementation of the sender's re-pair handoff or the job runner's
ledger rules would drift). The threads share the data dir and nothing else,
and each still takes its own OS-held lock, exactly as the two commands did.
A cooperative rewrite would buy nothing and risk both.

Stopping:

  * The first SIGTERM/SIGINT asks both loops to stop. The job loop finishes
    the job it is holding, posts its result, and only then leaves, so a stop
    never strands a job the upstream may already have run.
  * The sender sleeps for its whole interval and cannot be woken early. The
    service waits at most HEARTBEAT_STOP_GRACE_SEC for a beat already on the
    wire, then returns. In service use the process then exits, so no
    heartbeat outlives it; a heartbeat carries no job state, so abandoning
    one is honest.
  * A second signal restores the default action, so a wedged upstream can
    still be killed.
  * Either loop failing on its own (a revoked key, a held lock, an exhausted
    API retry budget) stops the service and its exit code is reported: one
    worker state, never half a worker.
"""

import argparse
import os
import signal
import sys
import threading
import time
import traceback
from pathlib import Path

import inference_worker
import pairing

# Longest a stop waits for a heartbeat already on the wire (never longer than
# the sender's own period). See the stop notes above.
HEARTBEAT_STOP_GRACE_SEC = 1.0
SUPERVISOR_POLL_SEC = 0.05


class WorkerService:
    """Run the heartbeat sender and, optionally, the job runner as one service."""

    def __init__(self, data_dir, heartbeat_args, jobs_runner=None):
        self.data_dir = Path(data_dir)
        # A namespace like `heartbeat-loop`'s: data_dir, config, interval.
        self.heartbeat_args = heartbeat_args
        # None means heartbeat-only. A runner is constructed (and validated)
        # by the caller, before the service starts anything.
        self.jobs_runner = jobs_runner
        self._stop = threading.Event()
        self._stop_signum = None
        self._codes = {}
        self._ended_by = None
        self._heartbeat_thread = None
        self._jobs_thread = None

    # -- control ---------------------------------------------------------

    def request_stop(self, signum=None):
        """Ask both loops to stop. Safe from any thread and from a handler."""
        if signum is not None and self._stop_signum is None:
            self._stop_signum = signum
        self._stop.set()
        if self.jobs_runner is not None:
            self.jobs_runner.request_stop(signum)

    def run(self):
        """Run until stopped. Returns the exit code for the whole service."""
        restore_handlers = self._install_stop_handlers()
        try:
            return self._run_loops()
        finally:
            restore_handlers()

    # -- loops -----------------------------------------------------------

    def _run_loops(self):
        # A second instance must be refused before anything touches the API.
        # This is a probe, not the lock: the sender loop takes and holds the
        # real lock, and its own refusal (exit 6) stays authoritative when the
        # probe is uncertain or another process wins the race.
        if pairing.sender_lock_held(self.data_dir):
            print("serve: [SENDER_RUNNING] another sender is already running "
                  "for this data dir; not starting a second", file=sys.stderr)
            return pairing.EXIT_SENDER_RUNNING
        self._heartbeat_thread = self._start_loop(
            "heartbeat", "aipster-heartbeat",
            lambda: pairing.cmd_heartbeat(self.heartbeat_args, loop=True))
        if self.jobs_runner is not None and not self._stop.is_set():
            self._jobs_thread = self._start_loop(
                "jobs", "aipster-jobs",
                lambda: self.jobs_runner.run(max_cycles=None))
        return self._supervise()

    def _start_loop(self, name, thread_name, target):
        thread = threading.Thread(target=self._loop_result, args=(name, target),
                                  name=thread_name, daemon=True)
        thread.start()
        return thread

    def _loop_result(self, name, target):
        """Run one loop to its exit code and stop the service when it ends."""
        try:
            code = target()
        except pairing.PairingError as exc:
            print(f"serve: {name}: [{exc.code}] {exc}", file=sys.stderr)
            code = pairing.EXIT_USAGE
        except Exception as exc:  # a crashed loop must stop the service, not go quiet
            print(f"serve: {name} stopped unexpectedly: {exc}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            code = pairing.EXIT_USAGE
        self._codes[name] = code
        self._ended_by = name
        # Neither half may keep running alone.
        self.request_stop()
        return code

    def _supervise(self):
        while True:
            if self._ended_by is not None:
                return self._loop_stopped(self._ended_by)
            if self._stop.is_set():
                return self._stopped()
            self._stop.wait(SUPERVISOR_POLL_SEC)

    # -- shutdown --------------------------------------------------------

    def _loop_stopped(self, name):
        """One loop ended on its own: stop the other one, report its code."""
        code = self._codes.get(name, pairing.EXIT_USAGE)
        self._join_jobs()
        self._join_heartbeat()
        print(f"serve: the {name} loop ended (exit {code}); the service is stopping",
              file=sys.stderr)
        return code

    def _stopped(self):
        """A stop was requested: post any in-flight job, then stop beating."""
        self._join_jobs()
        self._join_heartbeat()
        code = next((value for value in (self._codes.get("heartbeat"),
                                         self._codes.get("jobs")) if value),
                    pairing.EXIT_OK)
        print(f"serve: stop requested ({self._stop_name()}); no job was re-run "
              "and none is left mid-flight", file=sys.stderr)
        return code

    def _stop_name(self):
        try:
            return signal.Signals(self._stop_signum).name
        except (TypeError, ValueError):
            return "stop request"

    def _join_jobs(self):
        # Unbounded on purpose: an in-flight completion must finish and post,
        # and it is already bounded by the job's own deadline. A second signal
        # restores the default action, so a wedged upstream stays escapable.
        if self._jobs_thread is not None:
            self._jobs_thread.join()

    def _join_heartbeat(self):
        if self._heartbeat_thread is None:
            return
        interval = max(float(getattr(self.heartbeat_args, "interval",
                                     pairing.HEARTBEAT_INTERVAL_SEC)),
                       pairing.HEARTBEAT_MIN_INTERVAL_SEC)
        self._heartbeat_thread.join(min(interval, HEARTBEAT_STOP_GRACE_SEC))

    # -- signals ---------------------------------------------------------

    def _install_stop_handlers(self):
        """Turn SIGTERM/SIGINT into a bounded, recorded stop.

        The first signal stops both loops as described in the module
        docstring. A second signal restores the default action and re-raises,
        so an operator can always escape a wedged upstream. Only the main
        thread can install handlers; a service embedded in another thread (or
        on Windows, which has no such signal delivery) is stopped through
        `request_stop()` instead.
        """
        if os.name == "nt" or threading.current_thread() is not threading.main_thread():
            return lambda: None
        previous = {}

        def handler(signum, _frame):
            if self._stop.is_set():
                for sig, old in previous.items():
                    try:
                        signal.signal(sig, old if old is not None else signal.SIG_DFL)
                    except (OSError, ValueError, RuntimeError):
                        pass
                try:
                    signal.raise_signal(signum)
                except (AttributeError, OSError, RuntimeError):
                    raise KeyboardInterrupt
                return
            self.request_stop(signum)

        for name in ("SIGTERM", "SIGINT"):
            sig = getattr(signal, name, None)
            if sig is None:
                continue
            try:
                previous[sig] = signal.getsignal(sig)
                signal.signal(sig, handler)
            except (OSError, ValueError, RuntimeError):
                previous.pop(sig, None)

        def restore():
            for sig, old in previous.items():
                try:
                    signal.signal(sig, old if old is not None else signal.SIG_DFL)
                except (OSError, ValueError, RuntimeError):
                    pass

        return restore


def cmd_serve(args):
    """`pairing.py serve`: run the worker service until it stops."""
    data_dir = Path(args.data_dir) if args.data_dir else pairing.default_data_dir()
    heartbeat_args = argparse.Namespace(
        data_dir=str(data_dir),
        config=getattr(args, "config", None),
        interval=getattr(args, "interval", pairing.HEARTBEAT_INTERVAL_SEC))
    runner = None
    if getattr(args, "jobs", False):
        try:
            runner = inference_worker.JobRunner(
                data_dir,
                ganglion_base=args.ganglion_base
                or inference_worker.default_ganglion_base(),
                ganglion_token=os.environ.get(inference_worker.GANGLION_TOKEN_ENV) or None,
                allow_non_loopback=args.allow_non_loopback_ganglion,
                poll_interval=args.poll_interval,
                models_cache_ttl=args.models_cache_ttl,
                runtime_id=args.runtime_id)
        except pairing.PairingError as exc:
            # A bad upstream or runtime id is a configuration error, refused
            # before a heartbeat can claim this worker is running.
            print(f"serve: [{exc.code}] {exc}", file=sys.stderr)
            return pairing.EXIT_USAGE
    return WorkerService(data_dir, heartbeat_args, jobs_runner=runner).run()


def build_parser():
    parser = argparse.ArgumentParser(
        description="AIPSTER worker service: heartbeats and, with --jobs, "
                    "leased inference jobs in one process")
    parser.add_argument("--data-dir", default=None,
                        help="worker data dir (default: installed location)")
    sub = parser.add_subparsers(dest="command", required=True)
    serve = sub.add_parser("serve", help="run the worker until stopped")
    serve.add_argument("--config", default=None,
                       help="worker config for the usable-bit policy")
    serve.add_argument("--interval", type=int, default=pairing.HEARTBEAT_INTERVAL_SEC,
                       help="heartbeat interval in seconds")
    serve.add_argument("--jobs", action="store_true",
                       help="also lease and run inference jobs (dark by default)")
    serve.add_argument("--poll-interval", type=float,
                       default=inference_worker.JOBS_POLL_INTERVAL_SEC,
                       help="base idle job poll interval in seconds")
    serve.add_argument("--ganglion-base", "--upstream-url", dest="ganglion_base",
                       default=None,
                       help="local upstream base URL, Ganglion or llama-server "
                            f"(default {inference_worker.DEFAULT_GANGLION_BASE}); "
                            "--upstream-url is an alias")
    serve.add_argument("--allow-non-loopback-ganglion", action="store_true",
                       help="permit a non-loopback upstream base (not qualified)")
    serve.add_argument("--runtime-id", default=inference_worker.DEFAULT_RUNTIME_ID,
                       help="runtime identity this worker claims: "
                            f"{', '.join(inference_worker.RUNTIME_ALLOWLIST)} "
                            f"(default {inference_worker.DEFAULT_RUNTIME_ID})")
    serve.add_argument("--models-cache-ttl", type=float,
                       default=inference_worker.MODELS_CACHE_TTL_SEC,
                       help="seconds to cache the upstream model list")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        if args.command == "serve":
            return cmd_serve(args)
    except KeyboardInterrupt:
        print("interrupted", file=sys.stderr)
        return 130
    return pairing.EXIT_USAGE


if __name__ == "__main__":
    raise SystemExit(main())

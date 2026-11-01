"""Console entry for the installed AIPSTER Worker.

Frozen as `aipster-worker.exe` (console, shared bundle). Foreground server
plus visible control/query commands for the windowed tray (`tray ...`), whose
own stdout has nowhere to go, plus the pairing entry (`pair`: no-echo code
prompt, in-process claim) and the supervised sender (`sender`: foreground
heartbeat-loop for the tray child). First-run setup is shared with the tray
via aipster_tray.firstrun. The token value is never printed or logged, and
neither is any pairing code or sender key.
"""
import argparse
import os
from datetime import datetime, timezone
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
if not getattr(sys, "frozen", False):
    # Source runs also need local-worker/ itself for the pairing CLI
    # (frozen builds get it from the spec pathex instead).
    _SOURCE_ROOT = str(Path(__file__).resolve().parents[2])
    if _SOURCE_ROOT not in sys.path:
        sys.path.insert(0, _SOURCE_ROOT)

from aipster_tray.child import port_busy
from aipster_tray.firstrun import (build_info, data_dir, ensure_private_token,
                                   ensure_setup)
from aipster_tray.state import http_origin


class Tee:
    """Mirror a text stream to a log file without ever touching secrets."""

    def __init__(self, stream, logfile):
        self.stream = stream
        self.logfile = logfile

    def write(self, data):
        self.stream.write(data)
        self.logfile.write(data)

    def flush(self):
        self.stream.flush()
        self.logfile.flush()

    def __getattr__(self, name):
        return getattr(self.stream, name)


def run_server(config, data, inspect_only):
    from dendrite.cli import main as dendrite_main
    from dendrite.config import load_config
    from pydantic import ValidationError
    try:
        loaded = load_config(config)  # fail fast with the worker's own validation messages
    except (OSError, ValueError, ValidationError) as exc:
        # Mirror the worker CLI's own error format (dendrite.cli.main).
        print(f"dendrite: {exc}", file=sys.stderr)
        raise SystemExit(2)
    token_name = loaded.node.token_env
    if os.environ.get(token_name):
        print(f"using {token_name} from the environment")
    else:
        token_path = data / "api-token.txt"
        value, fresh = ensure_private_token(token_path)
        os.environ[token_name] = value
        print(f"token {'generated' if fresh else 'loaded'}: {token_path}")
    print(f"config: {config}")
    print(f"data:   {data}")
    print(f"listen: {http_origin(loaded.node.host, loaded.node.port)} "
          f"(loopback only: {loaded.node.host in ('127.0.0.1', 'localhost', '::1')})")
    if not inspect_only:
        if port_busy(loaded.node.host, loaded.node.port):
            print(f"aipster-worker: {loaded.node.host}:{loaded.node.port} is already in use; "
                  "stop the other worker first", file=sys.stderr)
            raise SystemExit(2)
    command = "inspect" if inspect_only else "serve"
    sys.argv = ["dendrite", command, "--config", str(config)]
    dendrite_main()
    if not inspect_only:
        # uvicorn only returns from serve() on startup failure (it logs the
        # reason itself); normalize the residual exit code. A tiny TOCTOU race
        # with the pre-bind check above can still land here.
        raise SystemExit(2)


def pair_forward(args):
    """Argv for the in-process pairing CLI. Secrets stay out of argv by default."""
    from pairing import main as pairing_main
    print("Pairing links THIS computer to the AIPSTER account that minted the code.")
    print("The code is single-use and is never stored; typing it is your consent.")
    print("Leave it empty to cancel.")
    # pairing's parser takes globals before the subcommand; pair-only flags after.
    argv = []
    if args.api_base:
        argv += ["--api-base", args.api_base]
    if args.data_dir:
        argv += ["--data-dir", args.data_dir]
    argv += ["pair"]
    if args.config:
        argv += ["--config", args.config]
    if args.name:
        argv += ["--name", args.name]
    if args.code:
        argv += ["--code", args.code]
    return pairing_main(argv)


def sender_forward(args, config):
    """Argv for the in-process sender (foreground, for tray supervision)."""
    from pairing import main as pairing_main
    argv = []
    if args.api_base:
        argv += ["--api-base", args.api_base]
    if args.data_dir:
        argv += ["--data-dir", args.data_dir]
    argv += ["heartbeat-once" if args.once else "heartbeat-loop"]
    argv += ["--config", args.config or str(config)]
    if args.interval is not None:
        argv += ["--interval", str(args.interval)]
    return pairing_main(argv)


def main(argv=None):
    parser = argparse.ArgumentParser(description="AIPSTER local worker launcher")
    parser.add_argument("command", nargs="?", choices=["run", "inspect", "tray", "pair", "sender"],
                        default="run")
    parser.add_argument("tray_command", nargs="?",
                        help="with 'tray': status | start | stop | restart | quit")
    parser.add_argument("--rotate-token", action="store_true",
                        help="replace the stored API token with a fresh one and exit")
    parser.add_argument("--version", action="store_true")
    parser.add_argument("--api-base", default=None,
                        help="with 'pair'/'sender': AIPSTER API base (default: production)")
    parser.add_argument("--data-dir", default=None,
                        help="with 'pair'/'sender': worker data dir (default: installed location)")
    parser.add_argument("--config", default=None,
                        help="with 'pair'/'sender': worker config (sender default: installed config)")
    parser.add_argument("--name", default=None,
                        help="with 'pair': display-name hint (default: hostname)")
    parser.add_argument("--code", default=None,
                        help="with 'pair': one-time code (fixture/bridge use only; "
                             "humans are prompted without echo and must not pass --code, "
                             "which would expose it on the command line)")
    parser.add_argument("--interval", type=int, default=None,
                        help="with 'sender': seconds between beats (default 60, floor 30)")
    parser.add_argument("--once", action="store_true",
                        help="with 'sender': post a single beat and exit")
    args = parser.parse_args(argv)
    if args.version:
        print(build_info())
        return 0
    if args.command == "tray":
        from aipster_tray.controller import main as tray_main
        return tray_main([args.tray_command or "status"])
    if args.command in ("pair", "sender") and args.data_dir:
        data = Path(args.data_dir)
    else:
        data = data_dir()
    config, fresh_config = ensure_setup(data)
    if args.command == "pair":
        return pair_forward(args)
    if args.command == "sender":
        return sender_forward(args, config)
    if args.rotate_token:
        token_path = data / "api-token.txt"
        if token_path.exists():
            token_path.unlink()
        ensure_private_token(token_path)
        print(f"rotated token: {token_path} (restart the worker to use it)")
        return 0
    if fresh_config:
        print(f"wrote default config: {config}")
    if args.command == "inspect":
        run_server(config, data, inspect_only=True)
        return 0
    log_path = data / "logs" / "worker.log"
    print(f"logging to: {log_path}")
    with open(log_path, "a", encoding="utf-8") as logfile:
        stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        logfile.write(f"\n===== {stamp} {build_info()} =====\n")
        logfile.flush()
        real_out, real_err = sys.stdout, sys.stderr
        sys.stdout = Tee(sys.stdout, logfile)
        sys.stderr = Tee(sys.stderr, logfile)
        try:
            print(f"starting {build_info()}")
            run_server(config, data, inspect_only=False)
        finally:
            # Restore before shutdown: interpreter-finalization messages must
            # not go through the closed log handle (yields exit code 120).
            sys.stdout, sys.stderr = real_out, real_err
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

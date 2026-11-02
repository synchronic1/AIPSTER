#!/bin/sh
# Front door for local-worker/setup_worker.py (macOS/Linux).
#
# Uses a suitable uv 0.12.12 from PATH when one exists. Otherwise it provisions
# the same pinned uv build into a user-private cache through uv_bootstrap.py,
# verifying the official archive SHA-256 before extraction. It never upgrades,
# replaces, or writes to a global uv. The private directory is added to PATH
# and AIPSTER_UV for the child process only.
#
# No pairing code is accepted through this script's arguments; use
# `--packet-stdin`, `--code-stdin`, or `--code-fd`.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ ! -f "$here/setup_worker.py" ]; then
    echo "setup-worker: setup_worker.py is missing beside this wrapper" >&2
    exit 3
fi

uv_bin=${AIPSTER_UV:-}
if [ -z "$uv_bin" ]; then
    uv_bin=$(command -v uv 2>/dev/null || true)
fi

uv_version=""
if [ -n "$uv_bin" ] && [ -x "$uv_bin" ]; then
    uv_version=$("$uv_bin" --version 2>/dev/null | awk '{print $2}') || uv_version=""
fi

if [ "$uv_version" != "0.12.12" ]; then
    if [ -f "$here/uv_bootstrap.py" ]; then
        python_bin=${AIPSTER_PYTHON:-}
        if [ -z "$python_bin" ]; then
            for candidate in python3 python; do
                if command -v "$candidate" >/dev/null 2>&1; then
                    if "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)' \
                            >/dev/null 2>&1; then
                        python_bin=$candidate
                        break
                    fi
                fi
            done
        fi
        if [ -z "$python_bin" ]; then
            echo "setup-worker: uv 0.12.12 is absent and Python 3.9+ is unavailable for the private bootstrap." >&2
            echo "setup-worker: install Python 3.9+ (or a qualified packaged installer); no global uv was changed." >&2
            exit 3
        fi
        if [ -n "$uv_version" ]; then
            echo "setup-worker: found uv $uv_version, not the pinned 0.12.12; using a private pinned uv without changing it." >&2
        fi
        bootstrap_out=$("$python_bin" "$here/uv_bootstrap.py" --print-path) || {
            status=$?
            echo "setup-worker: private pinned uv bootstrap failed; no global uv was changed." >&2
            exit "$status"
        }
        uv_bin=$bootstrap_out
        if [ -z "$uv_bin" ] || [ ! -x "$uv_bin" ]; then
            echo "setup-worker: private pinned uv bootstrap returned no executable; no global uv was changed." >&2
            exit 3
        fi
        uv_dir=$(dirname -- "$uv_bin")
        echo "setup-worker: using private pinned uv at $uv_bin for this command only." >&2
        UV_NO_CONFIG=1 PYTHONNOUSERSITE=1 PYTHONDONTWRITEBYTECODE=1 \
            AIPSTER_UV="$uv_bin" PATH="$uv_dir:$PATH" \
            exec "$uv_bin" run --no-project --python 3.12.14 python \
            "$here/setup_worker.py" "$@"
    fi
    echo "setup-worker: uv 0.12.12 is required exactly; install it and rerun (no global upgrade is attempted)." >&2
    exit 3
fi

UV_NO_CONFIG=1 PYTHONNOUSERSITE=1 PYTHONDONTWRITEBYTECODE=1 \
    exec "$uv_bin" run --no-project --python 3.12.14 python \
    "$here/setup_worker.py" "$@"

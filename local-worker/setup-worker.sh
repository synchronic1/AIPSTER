#!/bin/sh
# Pinned front door for local-worker/setup_worker.py (macOS/Linux).
#
# This wrapper never installs or upgrades uv. It requires uv 0.12.12 exactly,
# then asks uv to provide the project-pinned CPython 3.12.14 for the
# orchestrator. No pairing code is accepted through this script's arguments;
# use `--packet-stdin`, `--code-stdin`, or `--code-fd`.
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
if [ -z "$uv_bin" ]; then
    echo "setup-worker: uv 0.12.12 is required exactly; install it and rerun (no global upgrade is attempted)." >&2
    exit 3
fi

version=$("$uv_bin" --version 2>/dev/null | awk '{print $2}') || {
    echo "setup-worker: could not read the uv version; uv 0.12.12 is required exactly." >&2
    exit 3
}
if [ "$version" != "0.12.12" ]; then
    echo "setup-worker: uv 0.12.12 is required exactly; found ${version:-unknown}. No substitution or global upgrade is attempted." >&2
    exit 3
fi

UV_NO_CONFIG=1 PYTHONNOUSERSITE=1 PYTHONDONTWRITEBYTECODE=1 \
    exec "$uv_bin" run --no-project --python 3.12.14 python \
    "$here/setup_worker.py" "$@"

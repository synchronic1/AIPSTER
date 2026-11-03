"""Portable model-file identity. Stdlib only.

The vendored dendrite runtime identifies model files by filesystem stat
(device, inode, size, mtime); see vendor/eif/dendrite/hardware.py. That
identity is a cheap local invalidator, not a portable checksum: a moved
file reads as a new identity, and a stat-preserving copy reads as the
same file. This module adds a streaming SHA-256 content digest alongside
the stat fingerprint. It never replaces the fingerprint, never touches
the vendor tree, and never appears on any wire contract: adoption into
bindings or results would need a protocol revision and is out of scope.
Use the CLI to verify model files during install and qualify flows:

    python model_identity.py <path> [<path> ...]
"""

import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

CHUNK_BYTES = 8 * 1024 * 1024


class FileChangedError(OSError):
    """The file changed detectably while it was being measured."""


def stat_fingerprint(path):
    """Mirror the vendored stat fingerprint without importing vendor code.

    Field-for-field parity with dendrite.hardware.file_identity
    (resolved path + stat tuple hashed, GGUF magic probe, None-shape on
    missing/non-file/unreadable) is asserted by test_model_identity.py
    whenever the vendored module is importable.
    """
    target = Path(path)
    try:
        st = target.stat()
        if not target.is_file():
            return {"cached_on_disk": False, "fingerprint": None}
        with target.open("rb") as model_file:
            cached = model_file.read(4) == b"GGUF"
    except OSError:
        return {"cached_on_disk": False, "fingerprint": None}
    identity = (f"{target.resolve()}:{st.st_dev}:{st.st_ino}:"
                f"{st.st_size}:{st.st_mtime_ns}")
    return {
        "cached_on_disk": cached,
        "size_bytes": st.st_size,
        "fingerprint": hashlib.sha256(identity.encode()).hexdigest(),
        "fingerprint_kind": "local-file-stat",
    }


def _stat_key(stat_result):
    return (stat_result.st_dev, stat_result.st_ino, stat_result.st_size,
            stat_result.st_mtime_ns)


def content_digest(path):
    """Streaming SHA-256 of file bytes. Raises FileNotFoundError for missing
    paths and FileChangedError when the file changes detectably mid-read.

    Single open handle with pre/post fstat consistency: a size, mtime,
    inode or device change between open and end-of-read rejects the
    measurement instead of digesting a torn file. This does not defeat
    all adversarial concurrent modification, only detectable change.
    Deliberately unmemoized: a stat tuple can be identical while the bytes
    differ (same-size rewrite with restored mtime), which is exactly the
    case this digest exists to catch. Callers needing repeat reads must
    cache at their own layer and label cached values stale. The heartbeat
    path never calls this; it keeps the cheap stat check.
    """
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        before = _stat_key(os.fstat(handle.fileno()))
        while True:
            chunk = handle.read(CHUNK_BYTES)
            if not chunk:
                break
            digest.update(chunk)
        after = _stat_key(os.fstat(handle.fileno()))
    if before != after:
        raise FileChangedError(f"{path}: file changed during measurement")
    return f"sha256:{digest.hexdigest()}"


def identity_for(path):
    """Both identities for one model file: stat fingerprint + content digest.

    Single-open measurement: the stat tuple, GGUF magic probe, and content
    digest all come from one opened file descriptor with fstat
    before/after stability checks. A file that changes detectably during
    measurement raises FileChangedError instead of returning a mixed row
    (old stat beside a new digest); there is no cache, so `fresh` is
    always true and `measured_at` names this measurement. Any future
    cache must flip `fresh` to false on reuse.

    For a stable file the row is field-for-field identical to composing
    stat_fingerprint() with content_digest(): same resolved-path
    identity string, same magic rule, same digest. Open/read failures
    (missing, unreadable, non-file) propagate exactly as the composed
    calls raised them; identity_for never fabricates a row.

    This closes composition mixing, not all concurrent modification: a
    same-size rewrite with a restored mtime landing entirely between
    the two fstats is undetectable, and a path replacement during the
    read still measures the opened file consistently (never a mix).
    """
    target = Path(path)
    digest = hashlib.sha256()
    with open(target, "rb") as handle:
        before = _stat_key(os.fstat(handle.fileno()))
        magic = handle.read(4)
        digest.update(magic)
        while True:
            chunk = handle.read(CHUNK_BYTES)
            if not chunk:
                break
            digest.update(chunk)
        after = _stat_key(os.fstat(handle.fileno()))
    if before != after:
        raise FileChangedError(f"{path}: file changed during measurement")
    identity = (f"{target.resolve()}:{before[0]}:{before[1]}:"
                f"{before[2]}:{before[3]}")
    return {
        "cached_on_disk": magic == b"GGUF",
        "size_bytes": before[2],
        "fingerprint": hashlib.sha256(identity.encode()).hexdigest(),
        "fingerprint_kind": "local-file-stat",
        "content_digest": f"sha256:{digest.hexdigest()}",
        "measured_at": datetime.now(timezone.utc).isoformat(),
        "fresh": True,
    }


def main(argv):
    if len(argv) < 2:
        print("usage: python model_identity.py <path> [<path> ...]",
              file=sys.stderr)
        return 2
    failed = False
    for path in argv[1:]:
        try:
            row = {"path": path}
            row.update(identity_for(path))
        except OSError as exc:
            print(f"model_identity: {path}: {exc.strerror or exc}",
                  file=sys.stderr)
            failed = True
            continue
        print(json.dumps(row))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

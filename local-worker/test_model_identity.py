"""Model identity tests. Stdlib only; no venv needed.

Covers local-worker/model_identity.py: the portable content digest that
accompanies (never replaces) the stat-based fingerprint from the vendored
dendrite runtime. No model load, no inference, no network.
"""
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import model_identity


def vendored_file_identity():
    """The vendored stat fingerprint, or None when dendrite is not importable."""
    sys.dont_write_bytecode = True
    vendor = str(ROOT / "vendor" / "eif")
    if vendor not in sys.path:
        sys.path.insert(0, vendor)
    try:
        from dendrite import hardware
    except Exception:
        return None
    return hardware.file_identity


class ContentDigestTests(unittest.TestCase):
    def test_same_bytes_same_digest_across_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            a = Path(tmp) / "a.gguf"
            b = Path(tmp) / "sub" / "b.gguf"
            b.parent.mkdir()
            payload = os.urandom(4096) + b"model-bytes"
            a.write_bytes(payload)
            b.write_bytes(payload)
            os.utime(b, (1_000_000_000, 1_000_000_000))
            self.assertEqual(
                model_identity.content_digest(str(a)),
                model_identity.content_digest(str(b)),
            )
            self.assertEqual(
                model_identity.content_digest(str(a)),
                "sha256:" + hashlib.sha256(payload).hexdigest(),
            )

    def test_content_edit_changes_digest_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "w.gguf"
            target.write_bytes(b"v1-weights")
            before = model_identity.identity_for(str(target))
            st = target.stat()
            target.write_bytes(b"v2-weights")
            os.utime(target, ns=(st.st_atime_ns, st.st_mtime_ns))
            after = model_identity.identity_for(str(target))
            # Stat fingerprint is blind to stat-preserving edits by design.
            self.assertEqual(before["fingerprint"], after["fingerprint"])
            self.assertNotEqual(before["content_digest"], after["content_digest"])

    def test_missing_file_fails_closed(self):
        with self.assertRaises(FileNotFoundError):
            model_identity.content_digest(str(ROOT / "does-not-exist.gguf"))

    def test_mid_read_change_rejects_measurement(self):
        real_fstat = os.fstat
        calls = []

        def flip_size(fd):
            st = real_fstat(fd)
            calls.append(st)
            if len(calls) == 2:
                forged = list(st)
                forged[6] += 1
                return os.stat_result(tuple(forged))
            return st

        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "changing.gguf"
            target.write_bytes(b"stable-bytes")
            with mock.patch.object(os, "fstat", side_effect=flip_size):
                with self.assertRaises(model_identity.FileChangedError):
                    model_identity.content_digest(str(target))

    def test_measurement_labels_freshness(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "f.gguf"
            target.write_bytes(b"fresh")
            identity = model_identity.identity_for(str(target))
            self.assertTrue(identity["fresh"])
            self.assertRegex(
                identity["measured_at"],
                r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?\+00:00$",
            )

    def test_identity_shape(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "m.gguf"
            target.write_bytes(b"x" * 64)
            identity = model_identity.identity_for(str(target))
            self.assertRegex(identity["fingerprint"], r"^[0-9a-f]{64}$")
            self.assertEqual(identity["fingerprint_kind"], "local-file-stat")
            self.assertTrue(identity["content_digest"].startswith("sha256:"))
            self.assertFalse(identity["cached_on_disk"])

    def test_stat_fingerprint_matches_vendored(self):
        file_identity = vendored_file_identity()
        if file_identity is None:
            self.skipTest("vendored dendrite.hardware not importable here")
        with tempfile.TemporaryDirectory() as tmp:
            plain = Path(tmp) / "p.gguf"
            plain.write_bytes(os.urandom(1024))
            magic = Path(tmp) / "g.gguf"
            magic.write_bytes(b"GGUF" + os.urandom(1024))
            for target in (plain, magic):
                self.assertEqual(
                    model_identity.stat_fingerprint(str(target)),
                    file_identity(target),
                )
            self.assertTrue(
                model_identity.stat_fingerprint(str(magic))["cached_on_disk"]
            )


class CliTests(unittest.TestCase):
    def test_cli_prints_identity_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "c.gguf"
            target.write_bytes(b"cli-bytes")
            proc = subprocess.run(
                [sys.executable, str(ROOT / "model_identity.py"), str(target)],
                capture_output=True, text=True, timeout=60,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            row = json.loads(proc.stdout.strip())
            self.assertEqual(row["path"], str(target))
            self.assertTrue(row["content_digest"].startswith("sha256:"))

    def test_cli_missing_file_exits_nonzero(self):
        proc = subprocess.run(
            [sys.executable, str(ROOT / "model_identity.py"),
             str(ROOT / "does-not-exist.gguf")],
            capture_output=True, text=True, timeout=60,
        )
        self.assertNotEqual(proc.returncode, 0)


class _SpyReader:
    """Delegating proxy around a real binary file object.

    identity_for() resolves `open` through builtins at call time, so
    tests can observe each read call deterministically; C-level file
    types themselves are immutable and cannot be patched. Counts
    top-level read() calls and fires on_read(count) after each one.
    """

    def __init__(self, raw, on_read):
        self._raw = raw
        self._on_read = on_read
        self._calls = 0

    def read(self, size=-1):
        data = self._raw.read(size)
        self._calls += 1
        self._on_read(self._calls)
        return data

    def fileno(self):
        return self._raw.fileno()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return self._raw.__exit__(*exc)

    def __getattr__(self, name):
        return getattr(self._raw, name)


def _wrap_target_open(real_open, target, on_read):
    """builtins.open replacement that proxies reads of one target file."""
    def interfering_open(file, *args, **kwargs):
        handle = real_open(file, *args, **kwargs)
        if os.fspath(file) == os.fspath(target):
            return _SpyReader(handle, on_read)
        return handle
    return interfering_open


class IdentityForCompositionTests(unittest.TestCase):
    """identity_for() must never return a mixed row (P2 regression tests).

    All fixtures use tiny synthetic GGUF files; no model reads, no store
    access. Timing-sensitive interleavings use strict event ordering, so
    every assertion holds in all thread schedules.
    """

    def test_replacement_during_read_never_mixes(self):
        old = b"GGUF" + bytes(range(256)) * 16
        new = b"GGUF" + b"N" * 8192
        real_open = open
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "r.gguf"
            target.write_bytes(old)
            started = threading.Event()
            done = threading.Event()

            def replace():
                # Strictly after the first read began, so identity_for's
                # open already pins the old file; on platforms refusing
                # delete-while-open the replace fails and the file is
                # simply undisturbed. Either way the row must describe
                # exactly one generation.
                if not started.wait(timeout=30):
                    return
                other = Path(tmp) / "new.gguf"
                other.write_bytes(new)
                try:
                    os.replace(other, target)
                except OSError:
                    pass
                done.set()

            opener = _wrap_target_open(real_open, target,
                                       lambda n: started.set())
            worker = threading.Thread(target=replace)
            with mock.patch.object(model_identity, "CHUNK_BYTES", 16), \
                 mock.patch("builtins.open", side_effect=opener):
                worker.start()
                try:
                    row = model_identity.identity_for(str(target))
                finally:
                    worker.join(timeout=30)
            self.assertTrue(done.is_set(), "replacer must have run mid-read")
            self.assertTrue(row["fresh"])
            self.assertEqual(row["size_bytes"], len(old))
            self.assertEqual(row["content_digest"],
                             "sha256:" + hashlib.sha256(old).hexdigest())

    def test_inplace_change_mid_read_raises(self):
        real_open = open
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "c.gguf"
            target.write_bytes(b"GGUF" + b"A" * 1024)

            def on_read(n):
                if n == 2:
                    st = target.stat()
                    target.write_bytes(b"GGUF" + b"B" * 2048)
                    os.utime(target, ns=(st.st_atime_ns,
                                         st.st_mtime_ns + 5_000_000))

            opener = _wrap_target_open(real_open, target, on_read)
            with mock.patch.object(model_identity, "CHUNK_BYTES", 64), \
                 mock.patch("builtins.open", side_effect=opener):
                with self.assertRaises(model_identity.FileChangedError):
                    model_identity.identity_for(str(target))

    def test_missing_file_raises_filenotfound(self):
        with self.assertRaises(FileNotFoundError):
            model_identity.identity_for(str(ROOT / "does-not-exist.gguf"))

    def test_open_failure_propagates_without_row(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "u.gguf"
            target.write_bytes(b"GGUF" + b"secret")
            with mock.patch("builtins.open",
                            side_effect=PermissionError(13, "denied")):
                with self.assertRaises(PermissionError):
                    model_identity.identity_for(str(target))

    def test_non_file_path_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(OSError):
                model_identity.identity_for(tmp)

    def test_canonical_path_spellings_agree(self):
        with tempfile.TemporaryDirectory() as tmp:
            sub = Path(tmp) / "sub"
            sub.mkdir()
            target = Path(tmp) / "m.gguf"
            target.write_bytes(b"GGUF" + os.urandom(64))
            direct = model_identity.identity_for(str(target))
            dotted = model_identity.identity_for(str(sub / ".." / "m.gguf"))
            self.assertEqual(direct["fingerprint"], dotted["fingerprint"])
            self.assertEqual(direct["content_digest"], dotted["content_digest"])
            link = Path(tmp) / "link.gguf"
            try:
                link.symlink_to(target)
            except OSError:
                pass
            else:
                linked = model_identity.identity_for(str(link))
                self.assertEqual(direct["fingerprint"], linked["fingerprint"])
                self.assertEqual(direct["content_digest"],
                                 linked["content_digest"])


if __name__ == "__main__":
    unittest.main()

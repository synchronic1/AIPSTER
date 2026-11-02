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


if __name__ == "__main__":
    unittest.main()

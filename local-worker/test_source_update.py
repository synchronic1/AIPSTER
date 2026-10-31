"""Source-install update procedure tests (README: Update an existing source install).

Two layers. Fixture tests build a synthetic git repo with an old and a
reviewed commit, hand-apply the reviewed pairing.py as a CRLF overlay,
then execute the README's literal hash-gate command and git steps: the
pass case must update to the reviewed revision with .venv preserved,
and both negative cases (extra local change, tampered overlay) must
STOP before anything is discarded. Real-pin tests assert the documented
f3e115e -> 3fa309c claims (ancestry, no lock/vendor changes, reviewed
blob present) against this checkout's history, skipping honestly when
the pins are unreachable (shallow clone). No network fetch, no global
git config mutation, no touch of the real checkout: the fixture lives
in a temp dir and the real-pin layer only reads history.
"""
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

REPO_ROOT = ROOT.parent
OLD_PIN = "f3e115e"  # historical broken pin; the moving pin parses from README

V1 = b"WORKER_PIN = 1\n"
V2 = b"WORKER_PIN = 2\n"


def update_section():
    text = (ROOT / "README.md").read_text(encoding="utf-8")
    try:
        section = text.split("## Update an existing source install", 1)[1]
    except IndexError:
        raise AssertionError("README lost its update section; test needs a rewrite")
    return section.split("\n## ", 1)[0]


def readme_blob_payload():
    """The exact `python -c` payload from the README hash gate."""
    marker = 'python.exe -c "'
    for line in update_section().splitlines():
        if marker in line:
            payload = line.split(marker, 1)[1].rsplit('"', 1)[0]
            assert payload.startswith("import hashlib"), payload[:60]
            return payload
    raise AssertionError("README hash-gate command not found; test needs a rewrite")


def readme_reviewed_pin():
    """The full reviewed SHA from the README fetch step (the moving pin)."""
    match = re.search(r"git fetch origin ([0-9a-f]{40})", update_section())
    assert match, "README fetch pin not found; test needs a rewrite"
    return match.group(1)


def git(repo, *args):
    return subprocess.run(
        ["git", "-c", "core.autocrlf=false", "-c", "user.email=t@t.t",
         "-c", "user.name=t", *args],
        cwd=repo, capture_output=True, text=True, check=True)


def status_gate_ok(repo):
    """The README status gate: exactly one modified file, pairing.py."""
    out = git(repo, "status", "--short").stdout.splitlines()
    return out == [" M local-worker/pairing.py"]


@unittest.skipUnless(shutil.which("git"), "git CLI required")
class SourceUpdateProcedureTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="aipster-srcupd-")
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name) / "repo"
        (self.repo / "local-worker").mkdir(parents=True)
        git(self.repo, "-c", "init.defaultBranch=main", "init")
        (self.repo / ".gitignore").write_text(".venv/\n")
        (self.repo / "local-worker" / "pairing.py").write_bytes(V1)
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-m", "old")
        self.old = git(self.repo, "rev-parse", "HEAD").stdout.strip()
        (self.repo / "local-worker" / "pairing.py").write_bytes(V2)
        git(self.repo, "commit", "-am", "reviewed")
        self.reviewed = git(self.repo, "rev-parse", "HEAD").stdout.strip()
        git(self.repo, "checkout", "--detach", self.old)
        # Hand-applied overlay, Windows-style CRLF over an LF blob,
        # exactly like a reviewed fix applied on a Windows checkout.
        (self.repo / "local-worker" / "pairing.py").write_bytes(
            V2.replace(b"\n", b"\r\n"))
        venv = self.repo / "local-worker" / ".venv"
        venv.mkdir()
        (venv / "SENTINEL").write_text("venv-marker")

    def blob_of_working(self):
        proc = subprocess.run(
            [sys.executable, "-c", readme_blob_payload()],
            cwd=self.repo, capture_output=True, text=True, timeout=60)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return proc.stdout.strip()

    def test_gate_pass_updates_and_preserves_venv(self):
        self.assertTrue(status_gate_ok(self.repo))
        blob = self.blob_of_working()
        want = git(self.repo, "rev-parse",
                   self.reviewed + ":local-worker/pairing.py").stdout.strip()
        self.assertEqual(blob, want, "LF-normalized overlay must equal the reviewed blob")
        git(self.repo, "checkout", "--", "local-worker/pairing.py")
        self.assertEqual(git(self.repo, "status", "--short").stdout.strip(), "")
        git(self.repo, "checkout", "--detach", self.reviewed)
        self.assertEqual(git(self.repo, "rev-parse", "HEAD").stdout.strip(),
                         self.reviewed)
        self.assertEqual((self.repo / "local-worker" / "pairing.py").read_bytes(), V2)
        self.assertEqual(
            (self.repo / "local-worker" / ".venv" / "SENTINEL").read_text(),
            "venv-marker", ".venv must survive the update")

    def test_extra_change_stops_before_discard(self):
        (self.repo / ".gitignore").write_text(".venv/\n*.bak\n")
        self.assertFalse(status_gate_ok(self.repo),
                         "anything beyond pairing.py must STOP the procedure")
        self.assertIn(b"WORKER_PIN = 2",
                      (self.repo / "local-worker" / "pairing.py").read_bytes(),
                      "STOP means nothing discarded")

    def test_tampered_overlay_stops_before_discard(self):
        target = self.repo / "local-worker" / "pairing.py"
        target.write_bytes(target.read_bytes() + b"# tamper\r\n")
        self.assertTrue(status_gate_ok(self.repo), "still a single-file overlay")
        blob = self.blob_of_working()
        want = git(self.repo, "rev-parse",
                   self.reviewed + ":local-worker/pairing.py").stdout.strip()
        self.assertNotEqual(blob, want, "tampered overlay must print STOP")
        self.assertIn(b"# tamper", target.read_bytes(), "STOP means nothing discarded")
        self.assertEqual(git(self.repo, "rev-parse", "HEAD").stdout.strip(), self.old)


def real_pins_reachable():
    try:
        if not (REPO_ROOT / "local-worker" / "pairing.py").exists():
            return False
        pin = readme_reviewed_pin()
    except (OSError, AssertionError):
        return False
    for rev in (pin + "^{commit}", OLD_PIN):
        proc = subprocess.run(["git", "cat-file", "-e", rev], cwd=REPO_ROOT,
                              capture_output=True)
        if proc.returncode != 0:
            return False
    return True


@unittest.skipUnless(shutil.which("git"), "git CLI required")
@unittest.skipUnless(real_pins_reachable(),
                     "reviewed pins not reachable (shallow clone?)")
class ReviewedPinTests(unittest.TestCase):
    """The documented f3e115e -> 3fa309c claims, read from real history."""

    def test_reviewed_blob_resolves(self):
        proc = subprocess.run(
            ["git", "rev-parse",
             readme_reviewed_pin() + ":local-worker/pairing.py"],
            cwd=REPO_ROOT, capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertRegex(proc.stdout.strip(), r"^[0-9a-f]{40}$")

    def test_old_is_ancestor_of_reviewed(self):
        proc = subprocess.run(
            ["git", "merge-base", "--is-ancestor", OLD_PIN, readme_reviewed_pin()],
            cwd=REPO_ROOT, capture_output=True)
        self.assertEqual(proc.returncode, 0, "update direction must be old -> reviewed")

    def test_no_lock_or_vendor_changes(self):
        proc = subprocess.run(
            ["git", "diff", "--name-only", OLD_PIN, readme_reviewed_pin(), "--",
             "local-worker/requirements.lock", "local-worker/build-requirements.lock",
             "local-worker/vendor"],
            cwd=REPO_ROOT, capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout.strip(), "",
                         "step 6 keeps .venv only when no lock/vendor changes")


if __name__ == "__main__":
    unittest.main()

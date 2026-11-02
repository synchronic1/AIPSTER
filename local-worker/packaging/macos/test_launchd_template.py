"""Structural checks for the macOS launchd template. Stdlib only.

The template is never installed by anything here; this only proves it is a
valid property list, restarts on failure but not after a clean stop, and
carries no secret or unqualified flag. `plutil -lint` is the platform's own
parser, so it is used when present.
"""
import plistlib
import re
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TEMPLATE = ROOT / "dev.aipster.worker.serve-jobs.plist"

# Anything that would be a credential or an unqualified escape hatch.
SECRET_PATTERN = re.compile(
    r"(AIPSTER_GANGLION_TOKEN\s*[=:]|Authorization|Bearer\s+\S|heartbeat[_-]?key\s*[=:])",
    re.IGNORECASE)


class LaunchdTemplateTests(unittest.TestCase):
    def setUp(self):
        self.text = TEMPLATE.read_text(encoding="utf-8")
        with TEMPLATE.open("rb") as handle:
            self.plist = plistlib.load(handle)

    def test_plutil_accepts_the_template(self):
        plutil = shutil.which("plutil")
        if plutil is None:
            self.skipTest("plutil is macOS-only")
        result = subprocess.run([plutil, "-lint", "-s", str(TEMPLATE)],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_runs_serve_jobs_for_the_given_data_dir(self):
        argv = self.plist["ProgramArguments"]
        self.assertEqual(argv[-1], "serve-jobs")
        self.assertIn("--data-dir", argv)
        self.assertTrue(argv[argv.index("--data-dir") + 1].strip())
        self.assertTrue(argv[0] == "__PYTHON__" or argv[0].startswith("/"),
                        "interpreter is a placeholder or an absolute path")
        self.assertTrue(argv[1].endswith("/pairing.py"))

    def test_restarts_on_crash_only(self):
        self.assertEqual(self.plist["KeepAlive"], {"SuccessfulExit": False})
        self.assertIs(self.plist["RunAtLoad"], True)
        self.assertGreaterEqual(self.plist["ThrottleInterval"], 10,
                                "a crash loop must not spin")

    def test_no_secret_and_no_unqualified_network_override(self):
        self.assertNotIn("EnvironmentVariables", self.plist,
                         "the template carries no environment, so no token")
        self.assertIsNone(SECRET_PATTERN.search(self.text))
        self.assertNotIn("--allow-non-loopback-ganglion", self.plist["ProgramArguments"])

    def test_logs_go_to_explicit_paths(self):
        self.assertTrue(self.plist["StandardOutPath"].endswith(".log"))
        self.assertTrue(self.plist["StandardErrorPath"].endswith(".log"))
        self.assertEqual(self.plist["Label"], "dev.aipster.worker.serve-jobs")
        self.assertIn("__", self.text, "placeholders stay visible until filled in")


if __name__ == "__main__":
    unittest.main()

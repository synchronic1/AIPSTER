"""Controlled loopback/mocked storage failures; no real pair, engine or state."""
import argparse
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
from urllib.request import Request

import pairing

SECRET = "synthetic-private-key-never-a-real-credential"


class PairingSecurityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data = Path(self.tmp.name)
        self.args = argparse.Namespace(data_dir=str(self.data), api_base="https://new.synthetic.invalid",
                                       name=None, config=None, code="synthetic-one-time-code", interval=60)

    def pair(self, **kw):
        reply = {"resourceId": "r_new", "heartbeatKey": "new-" + SECRET, "keyPrefix": "synthetic-prefix", **kw}
        with patch.object(pairing, "claim", return_value=reply), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return pairing.cmd_pair(self.args)

    def legacy(self):
        pairing.write_private(self.data / "pairing.json", json.dumps({"api_base": "https://old.synthetic.invalid", "resource_id": "r_old"}))
        pairing.write_private(self.data / "heartbeat-key.txt", SECRET)
        pairing.load_or_create_node_id(self.data / "state")
        return pairing.load_pairing(self.data)

    def test_cross_origin_and_same_origin_redirects_are_refused(self):
        seen = []
        class Sink(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self):
                seen.append(self.headers.get("Authorization"))
                self.send_response(200); self.send_header("Content-Length", "2")
                self.end_headers(); self.wfile.write(b"{}")
        sink = ThreadingHTTPServer(("127.0.0.1", 0), Sink)
        self.addCleanup(sink.server_close); self.addCleanup(sink.shutdown)
        threading.Thread(target=sink.serve_forever, daemon=True).start()
        plan = {"code": 302}
        class Redirect(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", 0)))
                self.send_response(plan["code"])
                self.send_header("Location", f"http://localhost:{sink.server_port}/outside")
                self.send_header("Content-Length", "0"); self.end_headers()
        source = ThreadingHTTPServer(("127.0.0.1", 0), Redirect)
        self.addCleanup(source.server_close); self.addCleanup(source.shutdown)
        threading.Thread(target=source.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{source.server_port}"
        for code in [301, 302, 303, 307, 308]:
            plan["code"] = code
            with self.subTest(code=code), self.assertRaises(pairing.PairingError):
                pairing.send_heartbeat(base, "r_synthetic", SECRET, False)
        self.assertEqual(seen, [])
        handler = pairing.NoRedirects()
        request = Request("https://synthetic.invalid/api", headers={"Authorization": "Bearer " + SECRET})
        for target in ["http://synthetic.invalid/api", "https://other.invalid/api", "https://synthetic.invalid/other"]:
            self.assertIsNone(handler.redirect_request(request, None, 302, "redirect", {}, target))

    def test_acl_failure_stops_before_claim_and_never_publishes_a_secret(self):
        with patch.object(pairing, "restrict_file", return_value=False), patch.object(pairing, "claim") as claim, \
             contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(pairing.cmd_pair(self.args), pairing.EXIT_USAGE)
        claim.assert_not_called()
        self.assertFalse((self.data / "pairing.json").exists())
        self.assertFalse(list(self.data.glob("heartbeat-key*.txt")))

    def test_native_permissions_replace_broad_grants(self):
        if os.name == "nt":
            result = subprocess.run(["icacls", str(self.data), "/grant", "*S-1-1-0:(OI)(CI)R"], capture_output=True, check=False)
            self.assertEqual(result.returncode, 0)
        self.assertEqual(self.pair(), pairing.EXIT_OK)
        meta = json.loads((self.data / "pairing.json").read_text())
        paths = [self.data, self.data / "pairing.json", pairing.pairing_key_path(self.data, meta)]
        if os.name != "nt":
            self.assertEqual(paths[0].stat().st_mode & 0o777, 0o700)
            self.assertTrue(all(p.stat().st_mode & 0o777 == 0o600 for p in paths[1:]))
        else:
            script = r'''$items = [Console]::In.ReadToEnd() | ConvertFrom-Json
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
foreach ($path in $items) {
  $acl = Get-Acl -LiteralPath $path
  if (-not $acl.AreAccessRulesProtected) { exit 1 }
  foreach ($entry in $acl.Access) {
    if ($entry.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid) { exit 2 }
  }
}'''
            ps = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
            checked = subprocess.run([str(ps), "-NoProfile", "-NonInteractive", "-Command", script],
                                     input=json.dumps([str(p) for p in paths]), text=True, capture_output=True,
                                     creationflags=subprocess.CREATE_NO_WINDOW)
            self.assertEqual(checked.returncode, 0, checked.stderr)

    def test_key_or_manifest_failure_preserves_the_old_origin_key_tuple(self):
        original = self.legacy()
        real_write = pairing.write_private
        for phase in ["key", "manifest"]:
            def fail(path, value):
                if (phase == "manifest" and Path(path).name == "pairing.json") or (phase == "key" and Path(path).name.startswith("heartbeat-key.")):
                    raise OSError("synthetic disk fault")
                return real_write(path, value)
            with self.subTest(phase=phase), patch.object(pairing, "write_private", side_effect=fail):
                self.assertEqual(self.pair(), pairing.EXIT_USAGE)
            self.assertEqual(pairing.load_pairing(self.data), original)
        self.assertEqual(self.pair(), pairing.EXIT_OK)
        stored = pairing.load_pairing(self.data)
        self.assertEqual((stored["api_base"], stored["resource_id"], stored["heartbeat_key"]),
                         ("https://new.synthetic.invalid", "r_new", "new-" + SECRET))

    def test_lost_manifest_promotion_result_leaves_a_complete_new_tuple(self):
        self.legacy()
        replace = pairing.os.replace
        def lost(src, dest):
            replace(src, dest)
            if Path(dest).name == "pairing.json": raise OSError("synthetic lost promotion response")
        with patch.object(pairing.os, "replace", side_effect=lost):
            self.assertEqual(self.pair(), pairing.EXIT_USAGE)
        stored = pairing.load_pairing(self.data)
        self.assertEqual((stored["api_base"], stored["resource_id"], stored["heartbeat_key"]),
                         ("https://new.synthetic.invalid", "r_new", "new-" + SECRET))

    def test_reader_holding_an_old_manifest_keeps_its_original_key(self):
        self.assertEqual(self.pair(), pairing.EXIT_OK)
        old = pairing.load_pairing(self.data)
        real_path = pairing.pairing_key_path
        def publish(data, meta):
            with patch.object(pairing, "pairing_key_path", real_path):
                self.assertEqual(self.pair(resourceId="r_later", heartbeatKey="later-" + SECRET), pairing.EXIT_OK)
            return real_path(data, meta)
        with patch.object(pairing, "pairing_key_path", side_effect=publish):
            self.assertEqual(pairing.load_pairing(self.data), old)
        self.assertEqual(pairing.load_pairing(self.data)["resource_id"], "r_later")

    def test_invalid_manifest_key_path_cannot_escape_storage(self):
        self.legacy()
        (self.data / "pairing.json").write_text(json.dumps({"api_base":"https://synthetic.invalid", "resource_id":"r_x", "key_file":"../foreign-key"}))
        with self.assertRaises(pairing.PairingError) as error: pairing.load_pairing(self.data)
        self.assertEqual(error.exception.code, "BAD_PAIRING_STORE")

    def test_usable_is_refreshed_on_every_beat(self):
        self.legacy()
        with patch.object(pairing, "decide_usable", side_effect=[True, False, False]), \
             patch.object(pairing, "send_heartbeat", side_effect=[{}, {}, pairing.RePairRequired(401,"KEY_REVOKED","synthetic")]) as beat, \
             patch.object(pairing.time, "sleep"), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(pairing.cmd_heartbeat(self.args, loop=True), pairing.EXIT_REPAIR_REQUIRED)
        self.assertEqual([call.args[3] for call in beat.call_args_list], [True, False, False])

    def test_failures_replace_stale_success_and_surface_repair_codes(self):
        self.legacy()
        for error in [pairing.PairingError(None,"NETWORK","synthetic"), pairing.PairingError(429,"HEARTBEAT_TOO_SOON","synthetic",7),
                      pairing.PairingError(404,"NOT_FOUND","synthetic"), pairing.RePairRequired(401,"KEY_EXPIRED","synthetic")]:
            pairing.write_status(self.data, {"ok":True, "at":0, "heartbeatAt":"2000-01-01T00:00:00Z"})
            with patch.object(pairing,"send_heartbeat",side_effect=error), contextlib.redirect_stderr(io.StringIO()):
                self.assertNotEqual(pairing.cmd_heartbeat(self.args, loop=False), pairing.EXIT_OK)
            status = json.loads(pairing.pairing_files(self.data)["status"].read_text())
            self.assertIs(status["ok"], False)
            self.assertEqual(status["code"], error.code)
            out = io.StringIO()
            with contextlib.redirect_stdout(out): pairing.cmd_status(self.args)
            self.assertIn(error.code, out.getvalue())
            self.assertNotIn(SECRET, out.getvalue())

    def test_status_derives_staleness_without_claiming_live_success(self):
        self.legacy()
        pairing.write_status(self.data, {"ok":True, "at":0, "heartbeatAt":"2000-01-01T00:00:00Z"})
        out = io.StringIO()
        with contextlib.redirect_stdout(out): pairing.cmd_status(self.args)
        self.assertIn("stale", out.getvalue())
        self.assertNotIn("ok=True", out.getvalue())

    def test_network_retries_are_bounded_without_real_sleep(self):
        self.legacy()
        error = pairing.PairingError(None,"NETWORK","synthetic")
        with patch.object(pairing,"send_heartbeat",side_effect=error) as beat, patch.object(pairing.time,"sleep") as sleep, \
             contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(pairing.cmd_heartbeat(self.args, loop=True), pairing.EXIT_NETWORK)
        self.assertEqual(beat.call_count, pairing.MAX_ATTEMPTS_NETWORK + 1)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [2,4,8,16,32])

    def test_unpair_forgets_all_managed_generations_and_legacy_key(self):
        self.legacy()
        self.assertEqual(self.pair(), pairing.EXIT_OK)
        self.assertEqual(self.pair(), pairing.EXIT_OK)
        with contextlib.redirect_stdout(io.StringIO()): self.assertEqual(pairing.cmd_unpair(self.args), pairing.EXIT_OK)
        self.assertFalse((self.data / "pairing.json").exists())
        self.assertFalse(list(self.data.glob("heartbeat-key*.txt")))

    def test_transient_server_failures_recover_but_auth_rejections_do_not_retry(self):
        self.legacy()
        for status in [500, 502, 503, 504]:
            with self.subTest(status=status), patch.object(pairing, "send_heartbeat", side_effect=[
                    pairing.PairingError(status,"UPSTREAM","synthetic"), {}, pairing.RePairRequired(401,"KEY_REVOKED","synthetic")]) as beat, \
                 patch.object(pairing.time,"sleep") as sleep, contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(pairing.cmd_heartbeat(self.args, loop=True), pairing.EXIT_REPAIR_REQUIRED)
                self.assertEqual(beat.call_count, 3)
                self.assertEqual([call.args[0] for call in sleep.call_args_list], [2, 60])
        for status in [401, 403, 404]:
            with self.subTest(status=status), patch.object(pairing,"send_heartbeat",side_effect=pairing.PairingError(status,"REJECTED","synthetic")) as beat, \
                 patch.object(pairing.time,"sleep") as sleep, contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(pairing.cmd_heartbeat(self.args, loop=True), pairing.EXIT_PAIRING_REJECTED)
                self.assertEqual(beat.call_count, 1)
                sleep.assert_not_called()

    def test_loader_refuses_shared_metadata_and_selected_generation(self):
        self.assertEqual(self.pair(), pairing.EXIT_OK)
        meta = json.loads((self.data / "pairing.json").read_text())
        for path in [self.data / "pairing.json", pairing.pairing_key_path(self.data, meta)]:
            if os.name == "nt":
                granted = subprocess.run(["icacls", str(path), "/grant", "*S-1-1-0:R"], capture_output=True)
                self.assertEqual(granted.returncode, 0)
            else:
                path.chmod(0o666)
            try:
                with self.assertRaises(pairing.PairingError) as error: pairing.load_pairing(self.data)
                self.assertEqual(error.exception.code, "BAD_PAIRING_STORE")
            finally:
                pairing.restrict_file(path)


if __name__ == "__main__": unittest.main()

"""Cross-language pairing E2E: real pairing.py CLI against real worker.js.

Spawns website/scripts/pairing-e2e-bridge.mjs (worker.js + in-memory D1 over
loopback) and drives the full install->consent->registration->heartbeat path
with disposable users and fake engines. Skips honestly when node or the
website dependencies are unavailable; run it for real evidence.

Scenarios: two-user isolation, repeat startup, lost-response reclaim,
expired/replayed codes, duplicate re-pair, rotation, revocation, disabled
owner, deleted resource, quota rejection, stale telemetry, secret-free CLI.
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
import urllib.error
from pathlib import Path

import pairing

ROOT = Path(__file__).resolve().parent
BRIDGE = ROOT / ".." / "website" / "scripts" / "pairing-e2e-bridge.mjs"
MOCK_CONFIG = ROOT / "configs" / "mock.toml"
CLI = [sys.executable, str(ROOT / "pairing.py")]


def bridge_deps_present():
    return (BRIDGE.exists() and shutil.which("node")
            and (ROOT / ".." / "website" / "node_modules" / "better-auth").exists())


class Bridge:
    def __init__(self):
        self.proc = subprocess.Popen(
            ["node", str(BRIDGE)], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1)
        port = None
        deadline = time.time() + 60
        while time.time() < deadline:
            line = self.proc.stdout.readline()
            if line.startswith("BRIDGE_READY"):
                port = int(line.strip().split("=")[1])
                break
            if self.proc.poll() is not None:
                break
        if port is None:
            err = self.proc.stderr.read() if self.proc.stderr else ""
            self.proc.kill()
            raise RuntimeError(f"bridge did not start: {err[:2000]}")
        self.base = f"http://127.0.0.1:{port}"

    def close(self):
        try:
            self.proc.terminate()
            self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()
        finally:
            for pipe in (self.proc.stdout, self.proc.stderr):
                try:
                    if pipe:
                        pipe.close()
                except Exception:
                    pass

    def api(self, method, path, body=None, headers=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method,
                                     headers={"Content-Type": "application/json",
                                              **(headers or {})})
        try:
            with urllib.request.urlopen(req, timeout=15) as res:
                return res.status, json.loads(res.read().decode() or "{}")
        except urllib.error.HTTPError as exc:
            try:
                payload = json.loads(exc.read().decode() or "{}")
            except ValueError:
                payload = {}
            return exc.code, payload


class PairingE2ETests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not bridge_deps_present():
            raise unittest.SkipTest("node or website/node_modules missing; cannot run E2E")
        cls.bridge = Bridge()
        cls.addClassCleanup(cls.bridge.close)
        cls.tmp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.tmp.cleanup)

    def setUp(self):
        self.seq = 0

    def data_dir(self, tag):
        self.seq += 1
        path = Path(self.tmp.name) / f"{tag}-{self.seq}-{time.time_ns()}"
        pairing.private_dir(path)
        return path

    def seed_user(self, email, name):
        status, out = self.bridge.api("POST", "/__test/seed-user",
                                      {"email": email, "name": name})
        self.assertEqual(status, 200, out)
        return out

    def mint_code(self, cookie, ttl=None):
        body = {} if ttl is None else {"ttlMinutes": ttl}
        status, out = self.bridge.api("POST", "/api/pairing/codes", body,
                                      {"Cookie": cookie, "X-Aipster-CSRF": "1"})
        self.assertEqual(status, 201, out)
        return out

    def run_cli(self, *args, data_dir):
        proc = subprocess.run(
            CLI + ["--api-base", self.bridge.base, "--data-dir", str(data_dir)]
            + list(args), capture_output=True, text=True, timeout=60)
        return proc.returncode, proc.stdout, proc.stderr

    def pair(self, data_dir, code, node_id=None, extra=()):
        if node_id:
            statedir = data_dir / "state"
            pairing.private_dir(statedir)
            pairing.write_private(statedir / "node-id", node_id + "\n")
        return self.run_cli("pair", "--code", code, "--config", str(MOCK_CONFIG),
                            *extra, data_dir=data_dir)

    def pairing_meta(self, data_dir):
        return json.loads((data_dir / "pairing.json").read_text())

    def pairing_secret(self, data_dir):
        return (data_dir / self.pairing_meta(data_dir)["key_file"]).read_text().strip()

    def test_two_users_isolated_repeat_startup(self):
        alice = self.seed_user("e2e-alice@example.com", "E2E Alice")
        bob = self.seed_user("e2e-bob@example.com", "E2E Bob")
        code_a = self.mint_code(alice["cookie"])
        code_b = self.mint_code(bob["cookie"])
        dir_a, dir_b = self.data_dir("a"), self.data_dir("b")
        rc, out, err = self.pair(dir_a, code_a["code"], node_id="n_shared_e2e")
        self.assertEqual(rc, 0, err)
        rc, out, err = self.pair(dir_b, code_b["code"], node_id="n_shared_e2e")
        self.assertEqual(rc, 0, err)
        meta_a, meta_b = self.pairing_meta(dir_a), self.pairing_meta(dir_b)
        self.assertNotEqual(meta_a["resource_id"], meta_b["resource_id"])
        # Repeat startup: first beat ok, immediate second hits the 25s window.
        rc, _, err = self.run_cli("heartbeat-once", "--config", str(MOCK_CONFIG), data_dir=dir_a)
        self.assertEqual(rc, 0, err)
        rc, _, err = self.run_cli("heartbeat-once", "--config", str(MOCK_CONFIG), data_dir=dir_a)
        self.assertEqual(rc, 5, "quota rejection surfaces as network/backoff exit: " + err)
        # After the window passes (backdated), startup succeeds again.
        past = "2020-01-01T00:00:00.000Z"
        st, _ = self.bridge.api("POST", "/__test/backdate-heartbeat",
                                {"id": meta_a["resource_id"], "at": past})
        self.assertEqual(st, 200)
        rc, _, err = self.run_cli("heartbeat-once", "--config", str(MOCK_CONFIG), data_dir=dir_a)
        self.assertEqual(rc, 0, err)

    def test_lost_response_reclaim_and_rotation(self):
        user = self.seed_user("e2e-reclaim@example.com", "E2E Reclaim")
        code = self.mint_code(user["cookie"])
        # First claim "succeeds" but the response is lost on the wire.
        status, first = self.bridge.api("POST", "/api/pairing/claim",
                                        {"code": code["code"], "nodeId": "n_reclaim",
                                         "name": "reclaim-box"})
        self.assertEqual(status, 201, first)
        lost_key = first["heartbeatKey"]
        # Same node retries the spent code: re-binds with a FRESH key.
        data_dir = self.data_dir("reclaim")
        rc, _, err = self.pair(data_dir, code["code"], node_id="n_reclaim")
        self.assertEqual(rc, 0, err)
        meta = self.pairing_meta(data_dir)
        self.assertEqual(meta["resource_id"], first["resourceId"], "no duplicate row")
        fresh_key = self.pairing_secret(data_dir)
        self.assertNotEqual(fresh_key, lost_key, "lost key rotated, not reissued")
        # Lost key is dead; fresh key beats.
        status, _ = self.bridge.api(
            "POST", f"/api/resources/{meta['resource_id']}/heartbeat", {"usable": False},
            {"Authorization": "Bearer " + lost_key})
        self.assertEqual(status, 401)
        rc, _, err = self.run_cli("heartbeat-once", "--config", str(MOCK_CONFIG), data_dir=data_dir)
        self.assertEqual(rc, 0, err)

    def test_expired_replayed_and_foreign_codes(self):
        user = self.seed_user("e2e-codes@example.com", "E2E Codes")
        code = self.mint_code(user["cookie"])
        status, _ = self.bridge.api("POST", "/__test/expire-code", {"id": code["id"]})
        self.assertEqual(status, 200)
        rc, _, err = self.pair(self.data_dir("exp"), code["code"], node_id="n_exp")
        self.assertEqual(rc, 3, "expired code rejected: " + err)
        live = self.mint_code(user["cookie"])
        rc, _, err = self.pair(self.data_dir("used1"), live["code"], node_id="n_owner")
        self.assertEqual(rc, 0, err)
        rc, _, err = self.pair(self.data_dir("used2"), live["code"], node_id="n_other")
        self.assertEqual(rc, 3, "spent code rejects other nodes: " + err)
        rc, _, err = self.pair(self.data_dir("ghost"), "pair-00000000-0000-0000-0000",
                               node_id="n_ghost")
        self.assertEqual(rc, 3, "unknown code rejected: " + err)

    def test_repair_rotation_revocation_and_delete(self):
        user = self.seed_user("e2e-rotate@example.com", "E2E Rotate")
        data_dir = self.data_dir("rot")
        rc, _, err = self.pair(data_dir, self.mint_code(user["cookie"])["code"], node_id="n_rot")
        self.assertEqual(rc, 0, err)
        meta = self.pairing_meta(data_dir)
        old_key = self.pairing_secret(data_dir)
        # Re-pair rotates: same resource, new key, old key dead.
        rc, _, err = self.pair(data_dir, self.mint_code(user["cookie"])["code"], node_id="n_rot")
        self.assertEqual(rc, 0, err)
        meta2 = self.pairing_meta(data_dir)
        self.assertEqual(meta2["resource_id"], meta["resource_id"])
        new_key = self.pairing_secret(data_dir)
        self.assertNotEqual(new_key, old_key)
        status, body = self.bridge.api(
            "POST", f"/api/resources/{meta['resource_id']}/heartbeat", {"usable": False},
            {"Authorization": "Bearer " + old_key})
        self.assertEqual(status, 401)
        self.assertEqual(body.get("code"), "KEY_REVOKED")
        # Server-side revocation surfaces as re-pair-required on next beat.
        status, _ = self.bridge.api("POST", "/__test/revoke-key", {"id": meta2["key_id"]})
        self.assertEqual(status, 200)
        rc, _, err = self.run_cli("heartbeat-once", "--config", str(MOCK_CONFIG), data_dir=data_dir)
        self.assertEqual(rc, 4, "revoked key demands re-pair: " + err)
        # Deleting the resource retires the sender key the same honest way.
        status, _ = self.bridge.api("DELETE", f"/api/inventory/{meta['resource_id']}",
                                    None, {"Cookie": user["cookie"], "X-Aipster-CSRF": "1"})
        self.assertEqual(status, 200, "owner delete works")
        status, body = self.bridge.api(
            "POST", f"/api/resources/{meta['resource_id']}/heartbeat", {"usable": False},
            {"Authorization": "Bearer " + new_key})
        self.assertEqual(status, 401)
        self.assertEqual(body.get("code"), "KEY_REVOKED")

    def test_disabled_owner_and_stale_telemetry(self):
        user = self.seed_user("e2e-stale@example.com", "E2E Stale")
        data_dir = self.data_dir("stale")
        rc, _, err = self.pair(data_dir, self.mint_code(user["cookie"])["code"], node_id="n_stale")
        self.assertEqual(rc, 0, err)
        meta = self.pairing_meta(data_dir)
        rc, _, err = self.run_cli("heartbeat-once", "--config", str(MOCK_CONFIG), data_dir=data_dir)
        self.assertEqual(rc, 0, err)
        # Stale telemetry reads stale on the real status strip.
        ten_min_ago = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(time.time() - 600))
        status, _ = self.bridge.api("POST", "/__test/backdate-heartbeat",
                                    {"id": meta["resource_id"], "at": ten_min_ago})
        self.assertEqual(status, 200)
        status, strip = self.bridge.api("GET", "/api/status", None, {"Cookie": user["cookie"]})
        self.assertEqual(status, 200, strip)
        mine = [r for r in strip.get("items", []) if r.get("id") == meta["resource_id"]]
        self.assertEqual(len(mine), 1)
        self.assertEqual(mine[0].get("liveness"), "stale")
        # Disabled owners authorize nothing further.
        status, _ = self.bridge.api("POST", "/__test/disable-user", {"id": user["id"]})
        self.assertEqual(status, 200)
        rc, _, _ = self.pair(self.data_dir("dis"), "pair-00000000-0000-0000-0000",
                             node_id="n_dis")
        self.assertEqual(rc, 3)
        status, _ = self.bridge.api(
            "POST", f"/api/resources/{meta['resource_id']}/heartbeat", {"usable": False},
            {"Authorization": "Bearer " + self.pairing_secret(data_dir)})
        self.assertEqual(status, 401, "disabled owner heartbeat rejected")

    def test_launcher_pair_sender_revoke_cycle(self):
        """Worker-connect W1: the installed console entry pairs/beats/re-pairs."""
        launcher = [sys.executable, str(ROOT / "packaging" / "windows" / "launcher.py")]
        user = self.seed_user("e2e-launcher@example.com", "E2E Launcher")
        data_dir = self.data_dir("launcher")
        code = self.mint_code(user["cookie"])["code"]
        proc = subprocess.run(
            launcher + ["pair", "--api-base", self.bridge.base, "--data-dir", str(data_dir),
                        "--config", str(MOCK_CONFIG), "--code", code],
            capture_output=True, text=True, timeout=60)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("THIS computer", proc.stdout, "consent line precedes the claim")
        self.assertNotIn(code, proc.stdout + proc.stderr)
        meta = self.pairing_meta(data_dir)
        once = subprocess.run(
            launcher + ["sender", "--once", "--api-base", self.bridge.base,
                        "--data-dir", str(data_dir), "--config", str(MOCK_CONFIG)],
            capture_output=True, text=True, timeout=60)
        self.assertEqual(once.returncode, 0, once.stderr)
        self.assertIn("heartbeat ok", once.stdout)
        status, _ = self.bridge.api("POST", "/__test/revoke-key", {"id": meta["key_id"]})
        self.assertEqual(status, 200)
        dead = subprocess.run(
            launcher + ["sender", "--once", "--api-base", self.bridge.base,
                        "--data-dir", str(data_dir), "--config", str(MOCK_CONFIG)],
            capture_output=True, text=True, timeout=60)
        self.assertEqual(dead.returncode, 4, "revoked sender demands re-pair: " + dead.stderr)
        self.assertIn("pair again", dead.stderr)

    def test_cli_never_prints_secrets(self):
        user = self.seed_user("e2e-quiet@example.com", "E2E Quiet")
        data_dir = self.data_dir("quiet")
        rc, out, err = self.pair(data_dir, self.mint_code(user["cookie"])["code"], node_id="n_q")
        self.assertEqual(rc, 0, err)
        secret = self.pairing_secret(data_dir)
        rc2, out2, err2 = self.run_cli("status", data_dir=data_dir)
        self.assertEqual(rc2, 0, err2)
        rc3, out3, err3 = self.run_cli("heartbeat-once", "--config", str(MOCK_CONFIG),
                                       data_dir=data_dir)
        self.assertEqual(rc3, 0, err3)
        combined = out + err + out2 + err2 + out3 + err3
        self.assertNotIn(secret, combined)
        logs = list((data_dir / "state").glob("*.json"))
        for log in logs:
            self.assertNotIn(secret, log.read_text(), log.name)


if __name__ == "__main__":
    unittest.main()

"""Exclusive-create provenance at the native ACL boundary; synthetic temp data."""
import argparse
import contextlib
import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import pairing
from private_storage_win32 import PrivateStorageError, protect_path


@unittest.skipUnless(os.name == "nt", "native Windows storage contract")
class WindowsStorageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data = Path(self.tmp.name) / "synthetic-data"
        self.args = argparse.Namespace(data_dir=str(self.data), api_base="https://synthetic.invalid",
                                       name=None, config=None, code="synthetic-code")

    def pair(self):
        with patch.object(pairing, "claim", return_value={"resourceId":"synthetic-resource",
                          "heartbeatKey":"synthetic-key", "keyPrefix":"synthetic-prefix"}), \
             contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return pairing.cmd_pair(self.args)

    def test_exclusive_directories_and_empty_temp_files_are_the_only_new_paths(self):
        observations = []
        def observe(path, **flags):
            path = Path(path)
            observations.append((path, flags.copy(), None if path.is_dir() else path.read_bytes()))
            return protect_path(path, **flags)
        with patch.object(pairing, "protect_path", side_effect=observe, create=True):
            self.assertEqual(self.pair(), pairing.EXIT_OK)
        fresh_dirs = [p for p,f,_ in observations if f.get("new") and f.get("directory")]
        self.assertEqual(fresh_dirs,[self.data,self.data / "state"])
        fresh_files = [(p,contents) for p,f,contents in observations if f.get("new") and not f.get("directory")]
        self.assertEqual(len(fresh_files),3, "node, immutable key and manifest each use an exclusive temp")
        self.assertTrue(all(contents == b"" for _,contents in fresh_files), "no bytes before native ACL succeeds")
        self.assertTrue(all(not p.exists() for p,_ in fresh_files), "temporary names never remain published")
        # Existing directories never acquire new-path permission on later use.
        self.assertTrue(any(p == self.data and f.get("new") is False for p,f,_ in observations))

    def test_existing_foreign_or_default_group_owner_stops_before_claim(self):
        pairing.private_dir(self.data)
        for owner in ["synthetic-foreign-owner","S-1-5-32-544"]:
            def refuse(path, **flags):
                self.assertFalse(flags.get("new"), "an existing directory cannot be normalized")
                raise PrivateStorageError(2,"owner-mismatch", "synthetic-user",owner,owner)
            with self.subTest(owner=owner), patch.object(pairing, "protect_path", side_effect=refuse, create=True), \
                 patch.object(pairing, "claim") as claim, contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(pairing.cmd_pair(self.args),pairing.EXIT_USAGE)
            claim.assert_not_called()
            self.assertEqual(list(self.data.iterdir()),[])

    def _collide_then(self, boundary):
        mkdir = Path.mkdir
        collision = False

        def race(path, *args, **kw):
            nonlocal collision
            if path == self.data and not collision:
                collision = True
                mkdir(path, *args, **kw)
                raise FileExistsError("synthetic concurrent creator")
            return mkdir(path, *args, **kw)
        return patch.object(Path, "mkdir", new=race), patch.object(pairing, "protect_path", side_effect=boundary, create=True)

    def test_concurrent_creator_still_normalizing_is_waited_out(self):
        # The racer that created the directory still shows the token's default
        # owner for an instant; the loser waits for the same strict check.
        user, default = "S-1-5-21-1-2-3-1001", "S-1-5-32-544"
        calls = []

        def boundary(path, **flags):
            calls.append(flags)
            if len(calls) < 3:
                raise PrivateStorageError(2, "owner-mismatch", user, default, default)
        mkdir_patch, protect_patch = self._collide_then(boundary)
        with mkdir_patch, protect_patch, patch.object(pairing.time, "sleep", lambda s: None):
            self.assertEqual(pairing.private_dir(self.data), self.data)
        self.assertEqual(len(calls), 3)
        self.assertTrue(all(flags["new"] is False for flags in calls), calls)

    def test_foreign_owner_fails_on_first_check_without_waiting(self):
        user, default = "S-1-5-21-1-2-3-1001", "S-1-5-32-544"
        calls = []

        def boundary(path, **flags):
            calls.append(flags)
            raise PrivateStorageError(2, "owner-mismatch", user, default, "S-1-5-21-9-9-9-2002")
        mkdir_patch, protect_patch = self._collide_then(boundary)
        with mkdir_patch, protect_patch, patch.object(pairing.time, "sleep", lambda s: None):
            with self.assertRaises(pairing.PairingError):
                pairing.private_dir(self.data)
        self.assertEqual(len(calls), 1)

    def test_settling_wait_is_bounded(self):
        user, default = "S-1-5-21-1-2-3-1001", "S-1-5-32-544"

        def boundary(path, **flags):
            raise PrivateStorageError(2, "owner-mismatch", user, default, default)
        clock = iter(range(0, 1000))
        mkdir_patch, protect_patch = self._collide_then(boundary)
        with mkdir_patch, protect_patch, patch.object(pairing.time, "sleep", lambda s: None), \
                patch.object(pairing.time, "monotonic", lambda: next(clock)):
            with self.assertRaises(pairing.PairingError):
                pairing.private_dir(self.data)

    def test_unsupported_hard_links_fail_closed_as_private_storage(self):
        state = self.data / "state"
        with patch.object(pairing.os, "link", side_effect=PermissionError(1, "synthetic no hard links")):
            with self.assertRaises(pairing.PairingError) as caught:
                pairing.load_or_create_node_id(state)
        self.assertEqual(caught.exception.code, "PRIVATE_STORAGE")
        self.assertFalse((state / "node-id").exists())
        self.assertEqual([p.name for p in state.iterdir()], [], "no temp litter")

    def test_mkdir_collision_never_claims_another_creators_new_path(self):
        mkdir = Path.mkdir
        collision = False
        def race(path, *args, **kw):
            nonlocal collision
            if path == self.data and not collision:
                collision = True
                mkdir(path, *args, **kw)
                raise FileExistsError("synthetic concurrent creator")
            return mkdir(path, *args, **kw)
        flags_seen = []
        def boundary(path, **flags):
            flags_seen.append(flags)
            raise PrivateStorageError(2,"owner-mismatch")
        with patch.object(Path,"mkdir",new=race), patch.object(pairing,"protect_path",side_effect=boundary,create=True):
            with self.assertRaises(pairing.PairingError): pairing.private_dir(self.data)
        self.assertEqual(len(flags_seen),1)
        self.assertIs(flags_seen[0]["new"],False)

    def test_native_rejection_keeps_empty_temp_unpublished_and_never_claims(self):
        pairing.private_dir(self.data)
        empty = []
        def boundary(path, **flags):
            path = Path(path)
            if not flags.get("directory"):
                self.assertTrue(flags.get("new"))
                empty.append(path.read_bytes())
                raise PrivateStorageError(5,"write-private-security")
            return protect_path(path, **flags)
        with patch.object(pairing,"protect_path",side_effect=boundary,create=True), patch.object(pairing,"claim") as claim, \
             contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(pairing.cmd_pair(self.args),pairing.EXIT_USAGE)
        claim.assert_not_called()
        self.assertEqual(empty,[b""])
        self.assertEqual([p for p in self.data.rglob("*") if p.is_file()],[])

    def test_existing_foreign_file_is_not_replaced_or_treated_as_new(self):
        pairing.private_dir(self.data)
        target = self.data / "synthetic-existing.txt"
        pairing.write_private(target,"synthetic-original")
        def boundary(path, **flags):
            if Path(path) == target:
                self.assertFalse(flags.get("new"))
                raise PrivateStorageError(2,"owner-mismatch")
            return protect_path(path, **flags)
        with patch.object(pairing,"protect_path",side_effect=boundary,create=True):
            with self.assertRaises(pairing.PairingError): pairing.write_private(target,"synthetic-replacement")
        self.assertEqual(target.read_text(),"synthetic-original")
        self.assertEqual(list(self.data.iterdir()),[target])

    def test_load_only_verifies_owner_and_exact_acl_without_repair(self):
        self.assertEqual(self.pair(),pairing.EXIT_OK)
        observations = []
        def verify(path, **flags):
            observations.append((Path(path),flags))
            self.assertTrue(flags.get("verify"))
            self.assertFalse(flags.get("new"))
            return protect_path(path, **flags)
        with patch.object(pairing,"protect_path",side_effect=verify,create=True):
            self.assertEqual(pairing.load_pairing(self.data)["heartbeat_key"],"synthetic-key")
        self.assertTrue(any(path.name.startswith("heartbeat-key.") for path,_ in observations))


if __name__ == "__main__": unittest.main()

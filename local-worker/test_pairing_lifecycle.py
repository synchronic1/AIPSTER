"""Pairing lifecycle errors and in-flight status use synthetic private stores."""
import argparse
import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import pairing


class PairingLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.data=Path(self.tmp.name)/"synthetic-data"
        self.args=argparse.Namespace(data_dir=str(self.data),api_base="https://synthetic.invalid",
                                     name=None,config=None,code="synthetic-code",interval=30)

    def pair(self,resource="synthetic-a",key="synthetic-key-a"):
        with patch.object(pairing,"claim",return_value={"resourceId":resource,"heartbeatKey":key,"keyPrefix":"synthetic-prefix"}), \
             contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(pairing.cmd_pair(self.args),pairing.EXIT_OK)
        return pairing.load_pairing(self.data)

    def status(self):
        out=io.StringIO()
        with contextlib.redirect_stdout(out): code=pairing.cmd_status(self.args)
        self.assertEqual(code,pairing.EXIT_OK)
        return out.getvalue()

    def heartbeat(self,result):
        effect=({"return_value":result} if isinstance(result,dict) else {"side_effect":result})
        with patch.object(pairing,"send_heartbeat",**effect),contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
            return pairing.cmd_heartbeat(self.args,loop=False)

    def test_unpair_all_locked_files_fails_truthfully_and_keeps_credentials(self):
        meta=self.pair();manifest=self.data/"pairing.json";key=self.data/meta["key_file"]
        unlink=Path.unlink
        def locked(path,*args,**kw):
            if path in (manifest,key):raise PermissionError("synthetic sharing violation")
            return unlink(path,*args,**kw)
        out,err=io.StringIO(),io.StringIO()
        with patch.object(Path,"unlink",new=locked),contextlib.redirect_stdout(out),contextlib.redirect_stderr(err):
            code=pairing.cmd_unpair(self.args)
        self.assertNotEqual(code,pairing.EXIT_OK)
        self.assertTrue(manifest.exists());self.assertTrue(key.exists())
        self.assertNotIn("not paired",out.getvalue());self.assertNotIn("unpaired locally",out.getvalue())
        self.assertIn("could not",err.getvalue());self.assertIn("revoke",out.getvalue()+err.getvalue())
        self.assertNotIn("synthetic-key-a",out.getvalue()+err.getvalue())

    def test_unpair_partial_failure_is_nonzero_and_next_retry_finishes(self):
        meta=self.pair();key=self.data/meta["key_file"];unlink=Path.unlink
        def locked(path,*args,**kw):
            if path==key:raise PermissionError("synthetic locked key")
            return unlink(path,*args,**kw)
        out,err=io.StringIO(),io.StringIO()
        with patch.object(Path,"unlink",new=locked),contextlib.redirect_stdout(out),contextlib.redirect_stderr(err):
            self.assertNotEqual(pairing.cmd_unpair(self.args),pairing.EXIT_OK)
        self.assertTrue(key.exists());self.assertNotIn("unpaired locally",out.getvalue())
        with contextlib.redirect_stdout(io.StringIO()):self.assertEqual(pairing.cmd_unpair(self.args),pairing.EXIT_OK)
        self.assertFalse(key.exists())

    def test_unpair_concurrently_missing_files_remains_idempotent(self):
        meta=self.pair();key=self.data/meta["key_file"];unlink=Path.unlink
        def gone(path,*args,**kw):
            if path==key:
                unlink(path)
                raise FileNotFoundError("synthetic concurrent removal")
            return unlink(path,*args,**kw)
        with patch.object(Path,"unlink",new=gone),contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(pairing.cmd_unpair(self.args),pairing.EXIT_OK)
        with contextlib.redirect_stdout(io.StringIO()):self.assertEqual(pairing.cmd_unpair(self.args),pairing.EXIT_OK)

    def test_unpair_enumeration_error_cannot_report_absent_credentials(self):
        meta=self.pair();out,err=io.StringIO(),io.StringIO()
        with patch.object(pairing,"managed_key_files",side_effect=PermissionError("synthetic directory failure")), \
             contextlib.redirect_stdout(out),contextlib.redirect_stderr(err):
            self.assertNotEqual(pairing.cmd_unpair(self.args),pairing.EXIT_OK)
        self.assertNotIn("not paired",out.getvalue());self.assertIn("could not",err.getvalue())
        self.assertTrue((self.data/meta["key_file"]).exists())

    def test_underlying_directory_enumeration_failure_preserves_all_pairing_files(self):
        meta=self.pair();manifest=self.data/"pairing.json";key=self.data/meta["key_file"]
        out,err=io.StringIO(),io.StringIO()
        # Path.glob catches this actual filesystem boundary error internally.
        # The managed-key enumerator must propagate it before any unlink.
        with patch.object(os,"scandir",side_effect=PermissionError("synthetic directory read denied")), \
             contextlib.redirect_stdout(out),contextlib.redirect_stderr(err):
            self.assertNotEqual(pairing.cmd_unpair(self.args),pairing.EXIT_OK)
        self.assertTrue(manifest.exists());self.assertTrue(key.exists())
        self.assertNotIn("unpaired locally",out.getvalue());self.assertIn("could not",err.getvalue())

    @unittest.skipIf(os.name=="nt","POSIX directory read/search permissions")
    def test_posix_write_search_only_directory_repairs_then_completes_cleanup(self):
        # macOS lane 2026-11-01 (renamed; was ..._cannot_claim_complete_cleanup):
        # raw 0o300 denies scandir, but pair_lock provisions via private_dir
        # since 811709f, repairing user-owned 0o300 to 0o700 before
        # enumeration. Enumeration then succeeds and unpair honestly
        # completes. The mocked enumeration test still covers true failures.
        if os.geteuid()==0:self.skipTest("root bypasses POSIX read denial")
        meta=self.pair();manifest=self.data/"pairing.json";key=self.data/meta["key_file"]
        sentinel=self.data/"unmanaged.txt";sentinel.write_text("synthetic unrelated file")
        self.data.chmod(0o300)
        try:
            with self.assertRaises(OSError):
                with os.scandir(self.data):
                    pass
        finally:
            pass
        out,err=io.StringIO(),io.StringIO()
        try:
            with contextlib.redirect_stdout(out),contextlib.redirect_stderr(err):
                self.assertEqual(pairing.cmd_unpair(self.args),pairing.EXIT_OK)
            self.assertFalse(manifest.exists());self.assertFalse(key.exists())
            self.assertTrue(sentinel.exists())
            self.assertIn("unpaired locally",out.getvalue())
        finally:
            try:self.data.chmod(0o700)
            except OSError:pass

    @unittest.skipUnless(os.name=="nt","Windows sharing semantics")
    def test_native_open_key_handle_reports_unpair_failure(self):
        meta=self.pair();key=self.data/meta["key_file"]
        out,err=io.StringIO(),io.StringIO()
        with key.open("rb"),contextlib.redirect_stdout(out),contextlib.redirect_stderr(err):
            self.assertNotEqual(pairing.cmd_unpair(self.args),pairing.EXIT_OK)
        self.assertTrue(key.exists());self.assertIn("could not",err.getvalue())
        with contextlib.redirect_stdout(io.StringIO()):self.assertEqual(pairing.cmd_unpair(self.args),pairing.EXIT_OK)
        self.assertFalse(key.exists())

    def test_repair_and_success_status_do_not_carry_over_to_new_pairing(self):
        for result,old in [(pairing.RePairRequired(401,"KEY_REVOKED","synthetic"),"KEY_REVOKED"),
                           ({"heartbeatAt":"OLD-SUCCESS"},"OLD-SUCCESS")]:
            with self.subTest(result=old):
                self.pair();self.heartbeat(result)
                self.assertIn(old,self.status(),"positive control: current generation status is visible")
                self.pair("synthetic-b","synthetic-key-b")
                text=self.status();self.assertIn("synthetic-b",text);self.assertNotIn(old,text)
                self.assertNotIn("last beat ok=True",text)

    def test_old_inflight_sender_cannot_label_new_pairing_with_old_success_or_failure(self):
        for failure in [False,True]:
            with self.subTest(failure=failure):
                old=self.pair();self.args.api_base="https://synthetic.invalid"
                def completing_old(*args):
                    self.assertEqual(args[1],old["resource_id"])
                    self.args.api_base="https://later.synthetic.invalid"
                    self.pair("synthetic-new-resource","synthetic-new-key")
                    if failure:raise pairing.RePairRequired(401,"KEY_EXPIRED","synthetic")
                    return {"heartbeatAt":"OLD-INFLIGHT-BEAT"}
                with patch.object(pairing,"send_heartbeat",side_effect=completing_old),contextlib.redirect_stdout(io.StringIO()),contextlib.redirect_stderr(io.StringIO()):
                    pairing.cmd_heartbeat(self.args,loop=False)
                text=self.status();self.assertIn("synthetic-new-resource",text)
                self.assertNotIn("OLD-INFLIGHT-BEAT",text);self.assertNotIn("KEY_EXPIRED",text)
                self.assertNotIn("last beat ok=True",text)
                self.assertEqual(self.heartbeat({"heartbeatAt":"CURRENT-GENERATION-BEAT"}),pairing.EXIT_OK)
                self.assertIn("CURRENT-GENERATION-BEAT",self.status())

    def test_legacy_status_requires_binding_and_flat_key_rotation_invalidates_it(self):
        pairing.private_dir(self.data)
        pairing.write_private(self.data/"pairing.json",json.dumps({"api_base":self.args.api_base,"resource_id":"synthetic-legacy"}))
        pairing.write_private(self.data/"heartbeat-key.txt","synthetic-legacy-key")
        status=pairing.pairing_files(self.data)["status"]
        pairing.write_private(status,json.dumps({"ok":True,"at":pairing.time.time(),"heartbeatAt":"UNBOUND-OLD"}))
        self.assertNotIn("UNBOUND-OLD",self.status())
        self.assertEqual(self.heartbeat({"heartbeatAt":"BOUND-LEGACY"}),pairing.EXIT_OK)
        self.assertIn("BOUND-LEGACY",self.status())
        record=status.read_text();self.assertNotIn("synthetic-legacy-key",record)
        self.assertEqual(len(json.loads(record)["pairing_generation"]),64)
        pairing.write_private(self.data/"heartbeat-key.txt","synthetic-rotated-legacy-key")
        self.assertNotIn("BOUND-LEGACY",self.status())


if __name__=="__main__":unittest.main()

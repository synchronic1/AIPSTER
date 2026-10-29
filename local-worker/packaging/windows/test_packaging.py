"""Controlled packaging regressions. No installer, tray, registry, or inference runs."""
import importlib.util
import io
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

WINDOWS = Path(__file__).resolve().parent
ROOT = WINDOWS.parent.parent
sys.path.insert(0, str(ROOT / 'vendor/eif'))
sys.path.insert(0, str(WINDOWS.parent))
from aipster_tray import firstrun as first, child, controller, state
spec = importlib.util.spec_from_file_location('packaging_build', WINDOWS / 'build.py')
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class PackagingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='aipster-pure-')
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name)

    def test_acl_failure_never_publishes_token(self):
        token = self.data / 'api-token.txt'
        with patch.object(first, 'restrict_file', return_value=False):
            with self.assertRaises(SystemExit): first.ensure_private_token(token)
        self.assertFalse(token.exists())
        self.assertFalse(list(self.data.glob('.api-token-*')))

    def test_restrict_process_failure_is_terminal(self):
        with patch.object(first.subprocess, 'run', side_effect=OSError('synthetic missing ACL executable')):
            with self.assertRaises(SystemExit): first.ensure_private_token(self.data / 'api-token.txt')
        self.assertFalse((self.data / 'api-token.txt').exists())

    def test_native_acl_removes_explicit_grants_and_ignores_username(self):
        token = self.data / 'api-token.txt'
        token.write_text('synthetic-token-' + 'x' * 40)
        if os.name == 'nt':
            self.assertEqual(subprocess.run(['icacls', str(token), '/grant', '*S-1-1-0:R'], capture_output=True).returncode, 0)
        else:
            token.chmod(0o644)
        self.assertFalse(first.private_token_acl(token))
        with patch.dict(os.environ, {'USERNAME': 'synthetic-not-the-process-user'}):
            self.assertEqual(first.ensure_private_token(token), ('synthetic-token-' + 'x' * 40, False))
        self.assertTrue(first.private_token_acl(token))

    def test_new_token_is_private_and_stable(self):
        path = self.data / 'api-token.txt'
        value, fresh = first.ensure_private_token(path)
        self.assertTrue(fresh)
        self.assertTrue(first.token_is_strong(value))
        self.assertTrue(first.private_token_acl(path))
        self.assertEqual(first.ensure_private_token(path), (value, False))

    def test_concurrent_first_run_keeps_published_winner(self):
        path = self.data / 'api-token.txt'
        winner = 'synthetic-other-writer-' + 'z' * 40
        def race(src, dest):
            Path(dest).write_text(winner)
            raise FileExistsError('synthetic publication race')
        with patch.object(first.os, 'link', side_effect=race):
            self.assertEqual(first.ensure_private_token(path), (winner, False))
        self.assertEqual(path.read_text(), winner)
        self.assertFalse(list(self.data.glob('.api-token-*')))

    def test_file_token_is_refreshed_without_environment_pollution(self):
        config = self.data / 'config.toml'
        config.write_text((WINDOWS / 'default.toml').read_text())
        token = self.data / 'api-token.txt'
        token.write_text('synthetic-before-' + 'x' * 40)
        ctl = controller.Controller(self.data, None)
        ctl.config = config
        with patch.dict(os.environ, {'SYSTEMROOT': os.environ.get('SYSTEMROOT', r'C:\Windows')}, clear=True):
            self.assertEqual(ctl._reload(), '')
            token.write_text('synthetic-after-' + 'y' * 40)
            self.assertEqual(ctl._reload(), '')
            self.assertEqual(ctl.child_env()[ctl.token_env], token.read_text())
            self.assertNotIn(ctl.token_env, os.environ)

    def test_inherited_token_remains_authoritative(self):
        config = self.data / 'config.toml'
        config.write_text((WINDOWS / 'default.toml').read_text())
        ctl = controller.Controller(self.data, None)
        ctl.config = config
        with patch.dict(os.environ, {'DENDRITE_API_TOKEN': 'synthetic-inherited-' + 'x' * 40}):
            self.assertEqual(ctl._reload(), '')
            self.assertEqual(ctl.child_env()[ctl.token_env], os.environ[ctl.token_env])
        self.assertFalse((self.data / 'api-token.txt').exists())

    def test_ipv6_port_probe_and_health_url(self):
        with socket.socket(socket.AF_INET6) as probe:
            try: probe.bind(('::1', 0))
            except OSError: self.skipTest('IPv6 loopback unavailable')
            port = probe.getsockname()[1]
            self.assertTrue(child.port_busy('::1', port))
        self.assertFalse(child.port_busy('::1', port))
        with patch.object(controller.urllib.request, 'urlopen', return_value=io.BytesIO(b'{"status":"ok"}')) as request:
            self.assertTrue(controller._health_ok('::1', port))
            self.assertEqual(request.call_args.args[0], f'http://[::1]:{port}/healthz')
        self.assertIn('http://[::1]:1234', state.describe({'state': 'running', 'host': '::1', 'port': 1234}))

    def test_restart_reaps_prior_job_before_new_spawn(self):
        worker = child.WorkerChild(self.data, self.data / 'unused.log')
        old_job = object()
        worker.job = old_job
        events = []
        class Proc:
            pid = 123456
            stdout = stderr = None
            def poll(self): return 1
        worker.proc = Proc()
        def close(): events.append('close'); worker.job = None
        def confine(proc): self.assertIsNone(worker.job); events.append('confine')
        with patch.object(worker, '_close_job', side_effect=close), patch.object(worker, '_confine', side_effect=confine), \
             patch.object(child, 'dendrite_exe', return_value='synthetic.exe'), patch.object(child.subprocess, 'Popen', return_value=Proc()), \
             patch.object(child.threading, 'Thread'):
            worker.start('synthetic-config', {})
        self.assertEqual(events, ['close', 'confine'])

    def test_stop_closes_job_even_without_process(self):
        worker = child.WorkerChild(self.data, self.data / 'unused.log')
        with patch.object(worker, '_close_job') as close:
            worker.stop()
        close.assert_called_once()

    def test_uninstall_list_preserves_unrelated_files_and_data(self):
        payload = self.data / 'payload'
        payload.mkdir()
        (payload / 'dendrite.exe').write_bytes(b'synthetic')
        (payload / 'licenses').mkdir()
        (payload / 'licenses/LICENSE.txt').write_text('synthetic license')
        include = self.data / 'uninstall.nsh'
        build.write_uninstall_files(payload, include)
        text = include.read_text()
        self.assertNotIn('/r', text)
        installed = self.data / 'installed'
        shutil.copytree(payload, installed)
        (installed / 'config.toml').write_text('private synthetic data')
        (installed / 'licenses/unrelated.txt').write_text('unrelated sentinel')
        # Apply only generated exact Delete operations to a verified temp target.
        for line in text.splitlines():
            if line.startswith('Delete '):
                relative = line.split('$INSTDIR\\', 1)[1][:-1]
                target = installed / relative
                self.assertTrue(target.resolve().is_relative_to(installed.resolve()))
                target.unlink()
        self.assertEqual((installed / 'config.toml').read_text(), 'private synthetic data')
        self.assertTrue((installed / 'licenses/unrelated.txt').exists())
        self.assertFalse((installed / 'dendrite.exe').exists())
        self.assertNotIn('RMDir /r "$INSTDIR"', (WINDOWS / 'worker.nsi').read_text())

    def test_cpython_license_is_byte_exact_and_required(self):
        home = self.data / 'python'
        home.mkdir()
        source = home / 'LICENSE.txt'
        source.write_bytes(b'synthetic CPython notice\r\n')
        build.copy_python_license(home, self.data)
        self.assertEqual((self.data / 'CPYTHON-LICENSE.txt').read_bytes(), source.read_bytes())
        source.unlink()
        with self.assertRaises(SystemExit): build.copy_python_license(home, self.data)


if __name__ == '__main__': unittest.main(verbosity=2)

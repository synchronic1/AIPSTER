"""Controlled packaging regressions. No installer, tray, registry, or inference runs."""
import importlib.util
from contextlib import contextmanager
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
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / 'vendor/eif'))
sys.path.insert(0, str(WINDOWS.parent))
sys.path.insert(0, str(ROOT))
import private_storage_win32 as native
from aipster_tray import firstrun as first, child, controller, state
spec = importlib.util.spec_from_file_location('packaging_build', WINDOWS / 'build.py')
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


def find_makensis():
    found = shutil.which('makensis')
    fallback = Path(r'C:\Program Files (x86)\NSIS\makensis.exe')
    return found or (str(fallback) if fallback.is_file() else None)


DOLLAR_NAMES = ['lib$PLUGINSDIR.dll', 'x${APPDIR}y.txt', '$INSTDIR.txt', 'a$$b.txt', 'tail$', 'd$x/r.txt']


class PackagingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='aipster-pure-')
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name) / 'worker-data'

    def test_acl_failure_never_publishes_token(self):
        token = self.data / 'api-token.txt'
        with patch.object(first, 'restrict_file', return_value=False):
            with self.assertRaises(SystemExit): first.ensure_private_token(token)
        self.assertFalse(token.exists())
        self.assertFalse(list(self.data.glob('.api-token-*')))

    def test_restrict_process_failure_is_terminal(self):
        with patch.object(native, '_api', side_effect=OSError('synthetic unavailable ACL interface')):
            with self.assertRaises(SystemExit): first.ensure_private_token(self.data / 'api-token.txt')
        self.assertFalse((self.data / 'api-token.txt').exists())

    def test_native_acl_removes_explicit_grants_and_ignores_username(self):
        token = self.data / 'api-token.txt'
        first.private_directory(self.data)
        token.write_text('synthetic-token-' + 'x' * 40)
        first._private_path(token, created=True)  # This fixture just exclusively created the file.
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
            first._private_path(dest, created=True)  # Simulate the other writer's private publication.
            raise FileExistsError('synthetic publication race')
        with patch.object(first.os, 'link', side_effect=race):
            self.assertEqual(first.ensure_private_token(path), (winner, False))
        self.assertEqual(path.read_text(), winner)
        self.assertFalse(list(self.data.glob('.api-token-*')))

    def test_file_token_is_refreshed_without_environment_pollution(self):
        config = self.data / 'config.toml'
        first.private_directory(self.data)
        config.write_text((WINDOWS / 'default.toml').read_text())
        token = self.data / 'api-token.txt'
        first.ensure_private_token(token)
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
        first.private_directory(self.data)
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

    def test_only_exclusively_created_directories_get_new_path_authority(self):
        with patch.object(first, '_private_path', return_value=True) as protect:
            first.private_directory(self.data)
            self.assertTrue(protect.call_args.kwargs['created'])
            first.private_directory(self.data)
            self.assertFalse(protect.call_args.kwargs['created'])

    def test_default_group_owner_is_normalized_only_for_a_proven_new_path(self):
        token = self.data / 'api-token.txt'
        first.ensure_private_token(token)
        user, _ = native._identity()
        real_security = native._security
        adv, _ = native._api()
        for owner, new, allowed in [('S-1-5-32-544', False, False),
                                    ('S-1-5-18', True, False),
                                    ('S-1-5-32-544', True, True)]:
            calls = 0
            @contextmanager
            def snapshot(path):
                nonlocal calls
                calls += 1
                with real_security(path) as (actual, descriptor, dacl):
                    yield (owner if calls == 1 else actual), descriptor, dacl
            with self.subTest(owner=owner, new=new), patch.object(native, '_identity', return_value=(user, 'S-1-5-32-544')), \
                 patch.object(native, '_security', side_effect=snapshot), \
                 patch.object(adv, 'SetNamedSecurityInfoW', wraps=adv.SetNamedSecurityInfoW) as write:
                if allowed:
                    self.assertTrue(native.protect_path(token, new=True))
                    self.assertTrue(write.call_args.args[2] & native.OWNER_SECURITY_INFORMATION)
                else:
                    with self.assertRaises(native.PrivateStorageError) as error:
                        native.protect_path(token, new=new)
                    self.assertEqual(error.exception.reason, 'owner-mismatch')
                    write.assert_not_called()

    def test_existing_foreign_owned_secret_is_never_read_or_changed(self):
        token = self.data / 'api-token.txt'
        first.ensure_private_token(token)
        before = token.read_bytes()
        real_security = native._security
        @contextmanager
        def snapshot(path):
            with real_security(path) as (owner, descriptor, dacl):
                yield ('S-1-5-32-544' if Path(path) == token else owner), descriptor, dacl
        with patch.object(native, '_security', side_effect=snapshot), patch.object(Path, 'read_text', side_effect=AssertionError('secret read before owner check')):
            with self.assertRaises(SystemExit): first.ensure_private_token(token)
        self.assertEqual(token.read_bytes(), before)

    def test_readback_failure_aborts_before_token_publication(self):
        with patch.object(native, '_assert_private', side_effect=native.PrivateStorageError(0, 'synthetic-readback')):
            with self.assertRaises(SystemExit): first.ensure_private_token(self.data / 'api-token.txt')
        self.assertFalse((self.data / 'api-token.txt').exists())
        self.assertFalse(list(self.data.glob('.api-token-*')))

    def test_windowed_log_bootstrap_provisions_private_data_before_writing(self):
        with patch.object(controller.sys, 'stdout', None), patch.object(controller.sys, 'stderr', io.StringIO()):
            self.assertTrue(controller._redirect_to_log(self.data))
            handle = controller.sys.stdout
            self.assertTrue(first._private_path(self.data, directory=True, verify=True))
            self.assertTrue((self.data / 'logs/tray.log').exists())
            handle.close()

    def test_uninstall_list_preserves_unrelated_files_and_data(self):
        payload = self.data / 'payload'
        payload.mkdir(parents=True)
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

    def test_uninstall_verify_lists_exact_payload_files(self):
        payload = self.data / 'payload'
        payload.mkdir(parents=True)
        (payload / 'dendrite.exe').write_bytes(b'synthetic')
        (payload / 'licenses').mkdir()
        (payload / 'licenses/LICENSE.txt').write_text('synthetic license')
        verify = self.data / 'uninstall-verify.nsh'
        build.write_uninstall_verify(payload, verify)
        lines = verify.read_text().splitlines()
        self.assertEqual(len(lines), 2)
        for line, name in zip(lines, ['dendrite.exe', 'licenses\\LICENSE.txt']):
            self.assertTrue(line.startswith('IfFileExists "$INSTDIR\\'), line)
            self.assertTrue(line.endswith(f'{name}" uninstall_incomplete'), line)
        self.assertNotIn('/r', verify.read_text())

    def test_payload_dir_ending_in_dollar_is_refused(self):
        # "$$\r" compiles to "$" + carriage return in NSIS (verified with
        # makensis), so such a directory could never be removed by name.
        with self.assertRaises(ValueError):
            build._payload_literal(Path('$/r.txt'))
        with self.assertRaises(ValueError):
            build._payload_literal(Path('lib/cache$/x.bin'))
        self.assertEqual(build._payload_literal(Path('a$b/$INSTDIR.txt')), 'a$$b\\$$INSTDIR.txt')

    @unittest.skipUnless(os.name == 'nt' and find_makensis(), 'needs NSIS on Windows')
    def test_compiled_nsis_removes_and_verifies_literal_dollar_payload_names(self):
        # Real makensis + a silent harness on a scratch directory: no registry,
        # no shortcuts, no installer UI. The generated lists must delete exactly
        # the payload (including names NSIS would otherwise expand as $VAR,
        # ${DEFINE} or the $\r escape) and leave unrelated files alone.
        payload = self.data / 'payload'
        for name in DOLLAR_NAMES + ['dendrite.exe']:
            (payload / name).parent.mkdir(parents=True, exist_ok=True)
            (payload / name).write_text('synthetic')
        removal, verify = self.data / 'uninstall.nsh', self.data / 'uninstall-verify.nsh'
        build.write_uninstall_files(payload, removal)
        build.write_uninstall_verify(payload, verify)

        def run_harness(target, tag):
            result = self.data / f'result-{tag}.txt'
            script = self.data / f'harness-{tag}.nsi'
            script.write_text('\n'.join([
                'Unicode true', 'SilentInstall silent', 'RequestExecutionLevel user',
                f'OutFile "{self.data / f"harness-{tag}.exe"}"',
                'Section', f'  StrCpy $INSTDIR "{target}"',
                f'  !include "{removal}"', f'  !include "{verify}"',
                f'  FileOpen $0 "{result}" w', '  FileWrite $0 "verified"', '  FileClose $0',
                '  Return', '  uninstall_incomplete:',
                f'  FileOpen $0 "{result}" w', '  FileWrite $0 "incomplete"', '  FileClose $0',
                'SectionEnd', '']), encoding='utf-8')
            compiled = subprocess.run([find_makensis(), '/V2', str(script)], capture_output=True, text=True)
            self.assertEqual(compiled.returncode, 0, compiled.stdout[-2000:] + compiled.stderr[-2000:])
            subprocess.run([str(self.data / f'harness-{tag}.exe')], check=True, timeout=60)
            return result.read_text()

        installed = self.data / 'installed'
        shutil.copytree(payload, installed)
        (installed / 'unrelated $INSTDIR sentinel.txt').write_text('keep')
        self.assertEqual(run_harness(installed, 'clean'), 'verified')
        for name in DOLLAR_NAMES + ['dendrite.exe']:
            self.assertFalse((installed / name).exists(), name)
        self.assertEqual((installed / 'unrelated $INSTDIR sentinel.txt').read_text(), 'keep')

        # A payload file that survives removal (held open without delete
        # sharing) must be reported, not silently verified.
        locked_dir = self.data / 'locked'
        shutil.copytree(payload, locked_dir)
        with open(locked_dir / 'lib$PLUGINSDIR.dll', 'rb'):
            self.assertEqual(run_harness(locked_dir, 'locked'), 'incomplete')
        self.assertTrue((locked_dir / 'lib$PLUGINSDIR.dll').exists())

    def test_cpython_license_is_byte_exact_and_required(self):
        home = self.data / 'python'
        home.mkdir(parents=True)
        source = home / 'LICENSE.txt'
        source.write_bytes(b'synthetic CPython notice\r\n')
        build.copy_python_license(home, self.data)
        self.assertEqual((self.data / 'CPYTHON-LICENSE.txt').read_bytes(), source.read_bytes())
        source.unlink()
        with self.assertRaises(SystemExit): build.copy_python_license(home, self.data)


if __name__ == '__main__': unittest.main(verbosity=2)

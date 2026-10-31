"""Controlled packaging regressions. No installer, tray, registry, or inference runs."""
import importlib.util
from contextlib import contextmanager, redirect_stderr, redirect_stdout
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

WINDOWS = Path(__file__).resolve().parent
ROOT = WINDOWS.parent.parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT / 'vendor/eif'))
sys.path.insert(0, str(WINDOWS.parent))
sys.path.insert(0, str(ROOT))
import pairing
import private_storage_win32 as native
from aipster_tray import firstrun as first, child, controller, state
from aipster_tray import backend_win32
from aipster_tray.backend_headless import HeadlessBackend
spec = importlib.util.spec_from_file_location('packaging_build', WINDOWS / 'build.py')
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)
launcher_spec = importlib.util.spec_from_file_location('installed_launcher', WINDOWS / 'launcher.py')
launcher = importlib.util.module_from_spec(launcher_spec)
launcher_spec.loader.exec_module(launcher)


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


class PairOverlayTests(unittest.TestCase):
    """Worker-connect W1: pairing overlay derivation, menu, honesty."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='aipster-pair-')
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name) / 'worker-data'

    def paired(self, resource_id='r_test01'):
        key_name = 'heartbeat-key.0123456789abcdef0123456789abcdef.txt'
        secret = 'synthetic-sender-key-0123456789abcdef'
        pairing.write_private(self.data / key_name, secret + '\n')
        meta = {'api_base': 'https://aipster.net', 'resource_id': resource_id,
                'node_id': 'n_test01', 'key_file': key_name,
                'key_sha256': hashlib.sha256(secret.encode()).hexdigest()}
        pairing.write_private(self.data / 'pairing.json', json.dumps(meta) + '\n')
        return pairing.load_pairing(self.data)

    def beat(self, meta, **fields):
        record = {'pairing_generation': pairing.pairing_status_binding(meta)}
        record.update(fields)
        pairing.write_private(self.data / 'state' / 'heartbeat-status.json',
                              json.dumps(record) + '\n')

    def test_unpaired_default(self):
        overlay = state.pairing_overlay(self.data)
        self.assertEqual(overlay['key'], state.PAIR_UNPAIRED)
        self.assertIn('Not paired', overlay['line'])
        self.assertIn('Pair this computer', overlay['line'])
        self.assertEqual(overlay['sender'], 'Sender: stopped')

    def test_registered_awaiting_first_heartbeat(self):
        meta = self.paired()
        overlay = state.pairing_overlay(self.data)
        self.assertEqual(overlay['key'], state.PAIR_REGISTERED)
        self.assertIn(meta['resource_id'], overlay['line'])
        self.assertIn('awaiting first heartbeat', overlay['line'])

    def test_unbound_status_counts_as_awaiting(self):
        meta = self.paired()
        self.beat(meta, at=time.time(), ok=True, usable=False,
                  heartbeatAt='2026-10-31T00:00:00Z',
                  pairing_generation='0' * 64)
        overlay = state.pairing_overlay(self.data)
        self.assertEqual(overlay['key'], state.PAIR_REGISTERED)

    def test_reachable_is_reachability_only(self):
        meta = self.paired()
        self.beat(meta, at=time.time(), ok=True, usable=False,
                  heartbeatAt='2026-10-31T00:00:00Z')
        overlay = state.pairing_overlay(self.data, sender='running')
        self.assertEqual(overlay['key'], state.PAIR_REACHABLE)
        self.assertIn('reachability only', overlay['line'])
        self.assertIn('usable=False', overlay['line'])
        self.assertEqual(overlay['sender'], 'Sender: running')

    def test_stale_beat_names_last_beat(self):
        meta = self.paired()
        self.beat(meta, at=time.time() - 3600, ok=True, usable=False,
                  heartbeatAt='2026-10-30T00:00:00Z')
        overlay = state.pairing_overlay(self.data)
        self.assertEqual(overlay['key'], state.PAIR_STALE)
        self.assertIn('2026-10-30T00:00:00Z', overlay['line'])
        self.assertIn('start the sender', overlay['line'])

    def test_dead_key_is_repair_required(self):
        meta = self.paired()
        self.beat(meta, at=time.time(), ok=False, status='repair-required',
                  code='KEY_REVOKED')
        overlay = state.pairing_overlay(self.data)
        self.assertEqual(overlay['key'], state.PAIR_REPAIR)
        self.assertIn('pair again with a new code', overlay['line'])

    def test_failed_beat_is_actionable_error(self):
        meta = self.paired()
        self.beat(meta, at=time.time(), ok=False, status='failed', code='EDGE_BLOCKED')
        overlay = state.pairing_overlay(self.data)
        self.assertEqual(overlay['key'], state.PAIR_ERROR)
        self.assertIn('EDGE_BLOCKED', overlay['line'])
        self.assertIn('Start worker retries', overlay['line'])

    def test_broken_store_is_actionable_not_unpaired(self):
        first.private_directory(self.data)
        (self.data / 'pairing.json').write_text('not json{', encoding='utf-8')
        overlay = state.pairing_overlay(self.data)
        self.assertEqual(overlay['key'], state.PAIR_ERROR)
        self.assertIn('pair again', overlay['line'])

    def test_unexpected_io_failure_degrades_never_unpairs(self):
        self.paired()
        with patch.object(pairing, 'load_pairing', side_effect=RuntimeError('synthetic')):
            overlay = state.pairing_overlay(self.data)
        self.assertEqual(overlay['key'], state.PAIR_ERROR)
        self.assertIn('unreadable', overlay['line'])

    def test_menu_carries_pair_action_and_overlay_in_every_state(self):
        self.paired()
        overlay = state.pairing_overlay(self.data)
        for st in state.STATES:
            model = state.menu_model(st, 'http://127.0.0.1:8090', 'sample detail', overlay)
            actions = {i['id']: i for i in model if i['kind'] == 'action'}
            self.assertIn('pair', actions, st)
            self.assertTrue(actions['pair']['enabled'], st)
            self.assertEqual(actions['pair']['label'], 'Pair this computer…')
            labels = [i.get('label', '') for i in model if i['kind'] == 'text']
            self.assertIn(overlay['line'], labels, st)
            self.assertIn(overlay['sender'], labels, st)
            for item in model:
                if item['kind'] == 'action':
                    for word in state.FORBIDDEN_STATUS_WORDS:
                        self.assertNotIn(word, item['label'].lower(), (st, item['id']))

    def test_menu_defaults_to_unpaired_without_overlay(self):
        model = state.menu_model('stopped')
        labels = [i.get('label', '') for i in model if i['kind'] == 'text']
        self.assertIn(state.UNPAIRED_LINE, labels)

    def test_honesty_gate_covers_new_templates(self):
        self.paired('r_sample01')
        fixtures = [state.pairing_overlay(self.data)['line']]
        meta = pairing.load_pairing(self.data)
        for fields in ({'at': time.time(), 'ok': True, 'usable': False, 'heartbeatAt': 'now'},
                       {'at': 0, 'ok': True, 'usable': False, 'heartbeatAt': 'old'},
                       {'at': time.time(), 'ok': False, 'status': 'repair-required', 'code': 'x'},
                       {'at': time.time(), 'ok': False, 'status': 'failed', 'code': 'EDGE_BLOCKED'}):
            self.beat(meta, **fields)
            fixtures.append(state.pairing_overlay(self.data)['line'])
        for line in [state.UNPAIRED_LINE, *fixtures, 'Sender: running',
                     'Sender: stopped', 'Sender: stopped (exit 4)']:
            state.check_honest(line)
        for event in ('paired', 'pair_again', 'sender_stopped', 'port_busy'):
            state.check_honest(state.balloon_for(event, 'running', 'sample')[1])
        for bad in ('Connected', 'inference-ready', 'Worker is online', 'go live now'):
            with self.assertRaises(ValueError):
                state.check_honest(bad)

    def test_state_file_carries_pairing_and_status_line(self):
        overlay = state.pairing_overlay(self.data)
        path = self.data / 'state.json'
        first.private_directory(self.data)
        state.write_state(path, 'running', '', 4242, '127.0.0.1', 8090, 0, 'v', pairing=overlay)
        payload = json.loads(path.read_text(encoding='utf-8'))
        self.assertEqual(payload['pairing']['key'], state.PAIR_UNPAIRED)
        self.assertIsNotNone(state.read_state(path))
        self.assertIn('pairing=unpaired', state.describe(payload))
        legacy = dict(payload)
        del legacy['pairing']
        self.assertNotIn('pairing=', state.describe(legacy))


class FakeChild:
    def __init__(self):
        self.started = []
        self.stops = 0
        self._pid = None
        self.confined = False
        self.confine_error = 'fake'

    def start(self, config, env):
        self.started.append((config, env))
        self._pid = 4242
        return self._pid

    def pid(self):
        return self._pid

    def running(self):
        return self._pid is not None

    def exited(self):
        return None

    def early_text(self):
        return ''

    def stop(self, timeout=10):
        self.stops += 1
        self._pid = None


class FakeSender:
    def __init__(self):
        self.starts = 0
        self.stops = 0
        self._running = False
        self._exit = None
        self.last_exit = None
        self.confined = False
        self.confine_error = 'fake'

    def start(self):
        self.starts += 1
        self._running = True
        self._exit = None
        return 4343

    def stop(self, timeout=10):
        self.stops += 1
        self._running = False

    def running(self):
        return self._running

    def exited(self):
        return self._exit


def free_loopback_port():
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


class SenderSupervisionTests(unittest.TestCase):
    """Worker-connect W1: tray sender lifecycle, port-busy decoupling, pair entry."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='aipster-sender-')
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name) / 'worker-data'
        self.data.mkdir(parents=True)
        self.logs = []
        self.backend = HeadlessBackend(self.logs.append)
        self.ctl = controller.Controller(self.data, self.backend)
        self.ctl.config = self.data / 'config.toml'
        self.ctl.loaded = SimpleNamespace(node=SimpleNamespace(
            host='127.0.0.1', port=free_loopback_port(), token_env='DENDRITE_API_TOKEN'))
        self.ctl.child = FakeChild()
        self.ctl.sender = FakeSender()
        self.ctl.last_heartbeat = time.monotonic()

    def pair_store(self):
        (self.data / 'pairing.json').write_text('{"resource_id": "r_fake01"}', encoding='utf-8')

    def test_start_runs_sender_when_paired(self):
        self.pair_store()
        with patch.object(self.ctl, '_reload', return_value=''), \
             patch.object(controller, 'port_busy', return_value=False):
            self.assertTrue(self.ctl.start_worker())
        self.assertEqual(len(self.ctl.child.started), 1)
        self.assertEqual(self.ctl.sender.starts, 1)
        self.assertEqual(self.ctl.state, state.STARTING)

    def test_start_skips_sender_when_unpaired(self):
        self.ctl.console = True
        out = io.StringIO()
        with patch.object(self.ctl, '_reload', return_value=''), \
             patch.object(controller, 'port_busy', return_value=False):
            with redirect_stdout(out):
                self.assertTrue(self.ctl.start_worker())
        self.assertEqual(len(self.ctl.child.started), 1)
        self.assertEqual(self.ctl.sender.starts, 0)
        self.assertIn('not paired', out.getvalue())

    def test_port_busy_never_blocks_or_signals_but_starts_sender(self):
        self.pair_store()
        with patch.object(self.ctl, '_reload', return_value=''), \
             patch.object(controller, 'port_busy', return_value=True):
            self.assertFalse(self.ctl.start_worker())
        self.assertEqual(self.ctl.state, state.PORT_BUSY)
        self.assertEqual(self.ctl.child.started, [], 'no daemon spawn over a foreign holder')
        self.assertEqual(self.ctl.sender.starts, 1, 'port-independent sender still runs')
        self.assertIn(('port_busy', state.PORT_BUSY, str(self.ctl.loaded.node.port)),
                      self.backend.events)

    def test_sender_exit4_notifies_pair_again_once(self):
        self.ctl.sender._exit = 4
        self.ctl.tick()
        self.ctl.tick()
        paired = [e for e in self.backend.events if e[0] == 'pair_again']
        self.assertEqual(len(paired), 1)
        self.assertEqual(self.ctl.sender.starts, 0, 'no auto-restart without a fresh code')

    def test_sender_unexpected_exit_reports_and_waits_for_start(self):
        self.ctl.sender._exit = 1
        self.ctl.sender.last_exit = 1
        self.ctl.tick()
        self.assertIn(('sender_stopped', state.STOPPED, 'exit 1'), self.backend.events)
        self.assertEqual(self.ctl.sender.starts, 0)
        payload = json.loads((self.data / 'state.json').read_text(encoding='utf-8'))
        self.assertIn('exit 1', payload['pairing']['sender'])

    def test_stop_and_shutdown_stop_sender(self):
        self.ctl.sender._running = True
        self.ctl.stop_worker()
        self.assertEqual(self.ctl.sender.stops, 1)
        self.assertEqual(self.ctl.state, state.STOPPED)
        self.ctl.sender._running = True
        self.ctl.shutdown()
        self.assertEqual(self.ctl.sender.stops, 2)

    def test_menu_pair_launches_console_entry(self):
        self.ctl.menu_action('pair')
        kinds = [e[0] for e in self.backend.events]
        self.assertIn('pair_console', kinds)
        event = next(e for e in self.backend.events if e[0] == 'pair_console')
        self.assertTrue(event[1].endswith('python.exe') or event[1].endswith('aipster-worker.exe'))
        self.assertIn('pair', event[2])

    def test_pair_target_missing_bundle_is_honest(self):
        self.ctl.console = True
        out = io.StringIO()
        with patch.object(controller, 'bundle_dir', return_value=self.data / 'empty'), \
             patch.object(sys, 'frozen', True, create=True):
            with redirect_stdout(out):
                self.assertIsNone(self.ctl.pair_target())
                self.assertFalse(self.ctl.launch_pair())
        self.assertIn('pair unavailable', out.getvalue())

    def test_sender_argv_prefers_frozen_entry(self):
        bundle = Path(self.temp.name) / 'bundle'
        bundle.mkdir()
        argv = child.sender_argv(bundle, self.data)
        self.assertEqual(argv[0], sys.executable)
        self.assertTrue(Path(argv[1]).exists(), 'dev fallback is the real launcher')
        self.assertEqual(argv[2:], ['sender', '--data-dir', str(self.data)])
        exe = bundle / ('aipster-worker.exe' if os.name == 'nt' else 'aipster-worker')
        exe.write_bytes(b'fake')
        self.assertEqual(child.sender_argv(bundle, self.data),
                         [str(exe), 'sender', '--data-dir', str(self.data)])

    def test_sender_repair_exit_matches_pairing(self):
        self.assertEqual(child.EXIT_REPAIR_REQUIRED, pairing.EXIT_REPAIR_REQUIRED)
        self.assertEqual(child.EXIT_REPAIR_REQUIRED, 4)


class TrayConnectActionsTests(unittest.TestCase):
    """Worker-connect W2: Connect/Settings/copy-address tray actions."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='aipster-connect-')
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name) / 'worker-data'
        self.data.mkdir(parents=True)
        self.logs = []
        self.backend = HeadlessBackend(self.logs.append)
        self.ctl = controller.Controller(self.data, self.backend)
        self.ctl.config = self.data / 'config.toml'
        self.ctl.loaded = SimpleNamespace(node=SimpleNamespace(
            host='127.0.0.1', port=free_loopback_port(), token_env='DENDRITE_API_TOKEN'))
        self.ctl.child = FakeChild()
        self.ctl.sender = FakeSender()
        self.ctl.last_heartbeat = time.monotonic()

    def pair_store(self):
        (self.data / 'pairing.json').write_text('{"resource_id": "r_fake01"}', encoding='utf-8')

    def actions(self, st, endpoint='http://127.0.0.1:8090', detail=''):
        model = state.menu_model(st, endpoint, detail)
        return {i['id']: i for i in model if i['kind'] == 'action'}

    def test_menu_carries_connect_settings_and_copy_in_every_state(self):
        for st in state.STATES:
            acts = self.actions(st)
            for aid in ('connect', 'settings', 'copy_endpoint'):
                self.assertIn(aid, acts, st)
            self.assertTrue(acts['connect']['enabled'], st)
            self.assertTrue(acts['settings']['enabled'], st)
            serving = st in (state.STARTING, state.RUNNING)
            self.assertEqual(acts['copy_endpoint']['enabled'], serving, st)

    def test_menu_action_labels_are_honest(self):
        acts = self.actions(state.RUNNING)
        self.assertEqual(acts['connect']['label'], 'Connect this computer…')
        self.assertEqual(acts['settings']['label'], 'Settings')
        self.assertEqual(acts['copy_endpoint']['label'], 'Copy endpoint address')
        for aid in ('connect', 'settings', 'copy_endpoint'):
            state.check_honest(acts[aid]['label'])

    def test_copy_endpoint_disabled_without_endpoint_text(self):
        acts = self.actions(state.RUNNING, endpoint='')
        self.assertFalse(acts['copy_endpoint']['enabled'])

    def test_menu_dispatches_connect_settings_and_copy(self):
        self.pair_store()
        with patch.object(self.ctl, '_reload', return_value=''), \
             patch.object(controller, 'port_busy', return_value=False):
            self.ctl.menu_action('connect')
        kinds = [e[0] for e in self.backend.events]
        self.assertNotIn('pair_console', kinds)
        self.ctl.menu_action('settings')
        self.ctl.menu_action('copy_endpoint')
        kinds = [e[0] for e in self.backend.events]
        self.assertIn('open_config', kinds)
        self.assertIn('copy_text', kinds)

    def test_connect_starts_pairs_and_sender_when_fresh(self):
        with patch.object(self.ctl, '_reload', return_value=''), \
             patch.object(controller, 'port_busy', return_value=False):
            self.assertTrue(self.ctl.connect())
        self.assertEqual(len(self.ctl.child.started), 1)
        kinds = [e[0] for e in self.backend.events]
        self.assertIn('pair_console', kinds)
        self.assertEqual(self.ctl.state, state.STARTING)

    def test_connect_skips_pair_console_when_paired(self):
        self.pair_store()
        with patch.object(self.ctl, '_reload', return_value=''), \
             patch.object(controller, 'port_busy', return_value=False):
            self.assertTrue(self.ctl.connect())
        kinds = [e[0] for e in self.backend.events]
        self.assertNotIn('pair_console', kinds)
        self.assertEqual(self.ctl.sender.starts, 1)

    def test_connect_is_idempotent_when_running_paired_with_sender(self):
        self.pair_store()
        self.ctl.sender._running = True
        self.ctl.state = state.RUNNING
        self.assertTrue(self.ctl.connect())
        self.assertEqual(len(self.ctl.child.started), 0)
        kinds = [e[0] for e in self.backend.events]
        self.assertNotIn('pair_console', kinds)

    def test_connect_pairs_even_when_port_busy(self):
        with patch.object(self.ctl, '_reload', return_value=''), \
             patch.object(controller, 'port_busy', return_value=True):
            self.assertFalse(self.ctl.connect())
        self.assertEqual(self.ctl.state, state.PORT_BUSY)
        kinds = [e[0] for e in self.backend.events]
        self.assertIn('pair_console', kinds)

    def test_connect_revives_dead_sender_when_serving(self):
        self.pair_store()
        self.ctl.state = state.RUNNING
        self.ctl.sender._running = False
        self.ctl.sender._exit = 1
        self.ctl.sender.last_exit = 1
        self.assertTrue(self.ctl.connect())
        self.assertEqual(self.ctl.sender.starts, 1)
        self.assertEqual(len(self.ctl.child.started), 0)

    def test_settings_returns_config_path(self):
        self.assertEqual(self.ctl.open_settings(), str(self.data / 'config.toml'))
        self.assertIn(('open_config', str(self.data / 'config.toml')), self.backend.events)

    def test_copy_endpoint_payload_is_secret_free(self):
        self.ctl.token_value = 'SENTINEL-TOKEN-VALUE'
        self.assertTrue(self.ctl.copy_endpoint())
        event = next(e for e in self.backend.events if e[0] == 'copy_text')
        self.assertEqual(event[1], 'http://127.0.0.1:%d' % self.ctl.loaded.node.port)
        self.assertNotIn('SENTINEL-TOKEN-VALUE', event[1])

    def test_copy_endpoint_refuses_without_endpoint(self):
        self.ctl.loaded = None
        self.assertFalse(self.ctl.copy_endpoint())
        self.assertNotIn('copy_text', [e[0] for e in self.backend.events])

    def test_sender_reconnects_on_start_after_death(self):
        self.pair_store()
        self.ctl.sender._exit = 1
        self.ctl.sender.last_exit = 1
        self.ctl.tick()
        self.assertEqual(self.ctl.sender.starts, 0)
        with patch.object(self.ctl, '_reload', return_value=''), \
             patch.object(controller, 'port_busy', return_value=False):
            self.assertTrue(self.ctl.start_worker())
        self.assertEqual(self.ctl.sender.starts, 1)


class FirstrunChildDirTests(unittest.TestCase):
    """Worker-connect W2b: setup hardens children, adopts legacy shape."""

    def test_ensure_setup_hardens_state_and_logs(self):
        from private_storage_win32 import protect_path
        with tempfile.TemporaryDirectory(prefix='aipster-firstrun-') as tmp:
            data = Path(tmp) / 'worker-data'
            first.ensure_setup(data)
            self.assertTrue(protect_path(data / 'state', directory=True, verify=True))
            self.assertTrue(protect_path(data / 'logs', directory=True, verify=True))

    def test_ensure_setup_adopts_plain_precreated_children(self):
        from private_storage_win32 import protect_path
        with tempfile.TemporaryDirectory(prefix='aipster-firstrun-') as tmp:
            data = Path(tmp) / 'worker-data'
            first.private_directory(data)
            (data / 'state').mkdir()
            (data / 'logs').mkdir()
            first.ensure_setup(data)
            self.assertTrue(protect_path(data / 'state', directory=True, verify=True))
            self.assertTrue(protect_path(data / 'logs', directory=True, verify=True))

    def test_redirect_to_log_adopts_plain_logs_dir(self):
        from private_storage_win32 import protect_path
        with tempfile.TemporaryDirectory(prefix='aipster-firstrun-') as tmp:
            data = Path(tmp) / 'worker-data'
            data.mkdir()
            (data / 'logs').mkdir()
            real_out, real_err = sys.stdout, sys.stderr
            try:
                with patch.object(sys, 'stdout', None):
                    self.assertTrue(controller._redirect_to_log(data))
            finally:
                sys.stdout, sys.stderr = real_out, real_err
            self.assertTrue((data / 'logs' / 'tray.log').exists())
            self.assertTrue(protect_path(data / 'logs', directory=True, verify=True))


class LauncherPairEntryTests(unittest.TestCase):
    """Worker-connect W1: installed console entry for pair/sender."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='aipster-entry-')
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name) / 'worker-data'

    def test_pair_forwards_without_code_and_prints_consent(self):
        out = io.StringIO()
        with patch.object(pairing, 'main', return_value=0) as run:
            with redirect_stdout(out):
                code = launcher.main(['pair', '--data-dir', str(self.data)])
        self.assertEqual(code, 0)
        run.assert_called_once_with(['--data-dir', str(self.data), 'pair'])
        self.assertIn('THIS computer', out.getvalue())
        self.assertIn('single-use', out.getvalue())
        self.assertTrue((self.data / 'config.toml').exists(), 'setup runs on the named dir')

    def test_empty_code_cancels_pair(self):
        args = SimpleNamespace(api_base='http://127.0.0.1:9/', data_dir=str(self.data),
                               config=None, name=None, code=None)
        err = io.StringIO()
        with patch.object(pairing.getpass, 'getpass', return_value='  '):
            with redirect_stderr(err):
                self.assertEqual(pairing.cmd_pair(args), pairing.EXIT_USAGE)
        self.assertIn('no code entered', err.getvalue())

    def test_sender_once_uses_installed_config(self):
        with patch.object(pairing, 'main', return_value=0) as run:
            with redirect_stdout(io.StringIO()):
                self.assertEqual(launcher.main(['sender', '--once', '--data-dir', str(self.data)]), 0)
        run.assert_called_once_with(['--data-dir', str(self.data), 'heartbeat-once',
                                     '--config', str(self.data / 'config.toml')])

    def test_sender_loop_forwards_interval(self):
        with patch.object(pairing, 'main', return_value=0) as run:
            with redirect_stdout(io.StringIO()):
                launcher.main(['sender', '--data-dir', str(self.data), '--interval', '45'])
        run.assert_called_once_with(['--data-dir', str(self.data), 'heartbeat-loop',
                                     '--config', str(self.data / 'config.toml'), '--interval', '45'])

    def test_pairing_module_is_frozen_with_launcher(self):
        source = (WINDOWS / 'launcher.py').read_text(encoding='utf-8')
        self.assertIn('from pairing import main', source)
        spec_text = (WINDOWS / 'dendrite.spec').read_text(encoding='utf-8')
        self.assertIn('str(PACKAGING.parent)', spec_text, 'spec pathex covers local-worker/')


class InstallerPairingSurfaceTests(unittest.TestCase):
    """Worker-connect W1: config pointer, uninstall preservation, pair console."""

    def test_default_config_points_at_pair_entry(self):
        text = (WINDOWS / 'default.toml').read_text(encoding='utf-8')
        self.assertIn('Pair this computer', text)
        self.assertIn('aipster-worker pair', text)
        self.assertNotIn('not implemented', text)

    def test_uninstall_preserves_pairing_by_default(self):
        text = (WINDOWS / 'worker.nsi').read_text(encoding='utf-8')
        self.assertIn('StrCpy $RemoveData 0', text)
        self.assertEqual(text.count('RMDir /r "$LOCALAPPDATA\\AIPSTER-Worker"'), 1)
        head, removal = text.split('RMDir /r "$LOCALAPPDATA\\AIPSTER-Worker"')
        self.assertIn('${If} $RemoveData == 1', head.rsplit('Section "Uninstall"', 1)[1])
        self.assertIn('pairing', removal[:2000].lower() + head[-2000:].lower(),
                      'data messages name pairing as preserved content')
        self.assertIn('(config, token, pairing, state, logs) was preserved', text)

    def test_win32_pair_console_shell_executes(self):
        calls = []

        class FakeShell:
            def ShellExecuteW(self, *args):
                calls.append(args)
                return 42

        logs = []
        backend = backend_win32.Win32Backend(logs.append, '.')
        with patch.object(backend_win32, '_shell', return_value=FakeShell()):
            result = backend.run_pair_console('C:\\fake\\aipster-worker.exe', ['pair'])
        self.assertEqual(result, ('C:\\fake\\aipster-worker.exe', ['pair']))
        self.assertEqual(calls, [(None, 'open', 'C:\\fake\\aipster-worker.exe', 'pair', None, 1)])
        self.assertEqual(logs, [])

    def test_headless_pair_console_records_without_spawn(self):
        logs = []
        backend = HeadlessBackend(logs.append)
        result = backend.run_pair_console('synthetic-exe', ['pair'])
        self.assertEqual(result, ('synthetic-exe', ['pair']))
        self.assertIn(('pair_console', 'synthetic-exe', 'pair'), backend.events)


if __name__ == '__main__': unittest.main(verbosity=2)

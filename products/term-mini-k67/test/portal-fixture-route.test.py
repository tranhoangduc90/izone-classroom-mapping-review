"""Kiểm việc mở/khôi phục route giả không ghi file dùng chung; không SSH/mạng thật.
Mô phỏng writer khác đổi vhost đúng lúc kiểm cấu hình; thay đổi đó phải được giữ.
"""
from pathlib import Path
import importlib.util
import io
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('portal_route', ROOT / 'tools/prepare-portal-fixture-route.py')
route = importlib.util.module_from_spec(spec); spec.loader.exec_module(route)
INTENT = 'bf9c05b3ed514e1a9ed0e37ee2efac12'
INCLUDE = '/etc/nginx/conf.d/k67-portal-fixture-' + INTENT + '.conf'

class File(io.BytesIO):
    def __init__(self, store, name, mode):
        self.store, self.name, self.mode = store, name, mode
        if 'w' in mode:
            if 'x' in mode and name in store: raise FileExistsError(name)
            super().__init__()
        else:
            if name not in store: raise FileNotFoundError(name)
            super().__init__(store[name])
    def close(self):
        if 'w' in self.mode: self.store[self.name] = self.getvalue()
        super().close()

class Sftp:
    def __init__(self, store): self.store = store
    def open(self, name, mode): return File(self.store, name, mode)
    def chmod(self, name, mode): pass
    def rename(self, old, new):
        if new in self.store: raise FileExistsError(new)
        self.store[new] = self.store.pop(old)
    def close(self): pass

class Host:
    def __init__(self, fixture): self.fixture = fixture
    def open_sftp(self): return Sftp(self.fixture.files)

class Helpers:
    def atomic(self, path, value): pass

class Native:
    def __init__(self, fixture): self.fixture = fixture
    def remote(self, client, argv, include_stderr=False):
        f = self.fixture
        if argv == ['nginx', '-T']:
            # Barrier: một task khác thay vhost trong lúc task này đang dựng route mới.
            if f.concurrent: f.files[route.VHOST] = b'configuration written by another task'
            rendered = '# configuration file ' + INCLUDE + ':\nlisten 18868 ssl;\n' if INCLUDE in f.files else ''
            return rendered.encode()
        if argv[0] == 'ss': return b'LISTEN 18868' if f.bound else b''
        if argv == ['nginx', '-t']:
            if f.config_failure: raise RuntimeError('CONFIG_INVALID')
            return b'nginx configuration is valid'
        if argv == ['systemctl', 'reload', 'nginx']:
            f.bound = INCLUDE in f.files; f.reloads += 1; return b''
        raise AssertionError(argv)

class RouteTests(unittest.TestCase):
    def setUp(self):
        self.files = {'/etc/nginx/nginx.conf': b'http { include /etc/nginx/conf.d/*.conf; }', route.VHOST: b'baseline vhost443'}
        self.concurrent = self.config_failure = self.bound = False; self.reloads = 0
        self.state = {'intent': INTENT, 'include': INCLUDE}
        self.client = Host(self); self.u = Native(self); self.h = Helpers()
        self.temp = tempfile.TemporaryDirectory()
        self.directory = patch.object(route, 'PRIVATE', Path(self.temp.name)); self.directory.start()
        self.verifier = patch.object(route, 'verify', return_value={'own_get': 200}); self.verifier.start()
    def tearDown(self): self.verifier.stop(); self.directory.stop(); self.temp.cleanup()

    def test_shared_vhost_concurrent_change_is_never_overwritten(self):
        self.concurrent = True
        route.prepare(self.h, self.u, self.client, self.state, {})
        self.assertEqual(self.files[route.VHOST], b'configuration written by another task')
        self.assertEqual(self.files[INCLUDE], route.config(INTENT))
        self.assertEqual(self.state['stage'], 'ready'); self.assertEqual(self.reloads, 1)

    def test_foreign_include_or_busy_port_does_not_mutate(self):
        for collision in ['include', 'port']:
            with self.subTest(collision=collision):
                self.files.pop(INCLUDE, None); self.bound = collision == 'port'
                if collision == 'include': self.files[INCLUDE] = b'foreign bytes'
                before = dict(self.files)
                with self.assertRaises(RuntimeError): route.prepare(self.h, self.u, self.client, self.state, {})
                self.assertEqual(self.files, before); self.assertEqual(self.reloads, 0)

    def test_config_failure_disables_only_own_file_without_reload(self):
        self.config_failure = True
        with self.assertRaisesRegex(RuntimeError, 'CONFIG_INVALID'): route.prepare(self.h, self.u, self.client, self.state, {})
        self.assertNotIn(INCLUDE, self.files); self.assertEqual(self.files[INCLUDE + '.disabled'], route.config(INTENT))
        self.assertEqual(self.files[route.VHOST], b'baseline vhost443'); self.assertEqual(self.reloads, 0)

    def test_lost_ack_after_disable_resumes_rollback_without_shared_write(self):
        self.files[INCLUDE + '.disabled'] = route.config(INTENT)
        self.state['stage'] = 'rollback_intent'; self.bound = True
        route.rollback(self.h, self.u, self.client, self.state)
        self.assertFalse(self.bound); self.assertEqual(self.state['stage'], 'rolled_back')
        self.assertEqual(self.files[route.VHOST], b'baseline vhost443'); self.assertEqual(self.reloads, 1)

    def test_resume_own_ready_include_never_recreates_or_rewrites(self):
        self.files[INCLUDE] = route.config(INTENT); self.bound = True
        self.state['stage'] = 'candidate_on_disk'; before = dict(self.files)
        route.prepare(self.h, self.u, self.client, self.state, {})
        self.assertEqual(self.files, before); self.assertEqual(self.state['stage'], 'ready')

if __name__ == '__main__': unittest.main(verbosity=2)

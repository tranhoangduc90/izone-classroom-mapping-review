"""Switch K56 paper admission without running two writing workers at once."""
import argparse
import fcntl
import os
import stat
from pathlib import Path
from time import monotonic

from deploy import NGINX, PORTS, PREVIOUS, ROOT, MODE, TERM2_MODE, TERM2_RELEASE, Release, digest, read, record
from datetime import datetime, timezone


class Cutover:
    def __init__(self):
        self.release = Release()
        self.api = self.release.api
        self.staged = read(ROOT / 'staged.json')
        assert read(ROOT / 'migrated.json')['rowsUnchanged'] is True
        self.variants = self.staged['variants']
        self.backup = ROOT / 'nginx.before.conf'

    def remember_route(self, original):
        assert digest(original) == self.staged['routeHash']
        if self.backup.exists():
            assert self.backup.read_bytes() == original
            return
        with self.backup.open('xb') as file:
            file.write(original)
            file.flush()
            os.fsync(file.fileno())

    def route(self, mode):
        old = self.backup.read_bytes()
        assert digest(old) == self.staged['routeHash']
        return old.replace(self.release.loopback('old').encode(), self.release.loopback(mode).encode())

    def status(self, mode):
        row = self.variants[mode]
        assert row['port'] == PORTS[mode]
        result = self.api['inspect'](row['container'])
        env = self.api['environment'](result)
        assert env['BUILD_SHA'] == row['build'] and env.get(MODE, 'off') == ('off' if mode == 'old' else mode)
        assert env.get(TERM2_MODE) == 'on'
        return result['State']['Running']

    def start_only(self, mode):
        for other, row in self.variants.items():
            if other != mode and self.status(other):
                self.api['run']('docker', 'stop', '--time', '8', row['container'])
        if not self.status(mode):
            self.api['run']('docker', 'start', self.variants[mode]['container'])
        assert self.status(mode) and not any(self.status(other) for other in self.variants if other != mode)

    def ready(self, mode, addresses, probes):
        self.api['await_health'](addresses, self.variants[mode]['build'])
        self.release.check_hashes(self.variants[mode]['container'], 'preimage' if mode == 'old' else 'sha256')
        for base in addresses:
            assert self.api['probes']('k56', base) == probes, base
        self.release.health()

    def proxy(self, mode):
        assert NGINX.is_file() and not NGINX.is_symlink()
        current, wanted = NGINX.read_bytes(), self.route(mode)
        assert current in tuple(self.route(m) for m in PORTS), 'K56 route changed independently'
        if current != wanted:
            metadata = NGINX.stat()
            self.api['install_file'](NGINX, wanted, stat.S_IMODE(metadata.st_mode), metadata.st_uid, metadata.st_gid)
        self.api['run']('nginx', '-t')
        self.api['run']('systemctl', 'reload', 'nginx')

    def restart_policy(self, active):
        for mode, row in self.variants.items():
            policy = 'unless-stopped' if mode == active else 'no'
            self.api['run']('docker', 'update', '--restart', policy, row['container'])

    def recover(self, modes, baseline):
        for mode in modes:
            try:
                self.start_only(mode)
                self.ready(mode, (self.release.loopback(mode),), baseline)
                self.proxy(mode)
                self.ready(mode, (self.release.production,), baseline)
                self.restart_policy(mode)
                stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
                record(f'recovered-{mode}-{stamp}.json',
                       {'mode': mode, **self.variants[mode], 'probes': len(baseline)})
                return
            except Exception as error:
                # Command errors can include private connection configuration.
                print(f'recovery_failed mode={mode} type={type(error).__name__}', flush=True)
        raise RuntimeError('Neither staged recovery variant passed readback')

    def change(self, current, target, baseline):
        assert NGINX.read_bytes() == self.route(current)
        public_may_have_changed = False
        started = monotonic()
        try:
            self.start_only(target)
            self.ready(target, (self.release.loopback(target),), baseline)
            public_may_have_changed = True
            self.proxy(target)
            self.ready(target, (self.release.production,), baseline)
            self.restart_policy(target)
            record('serving-' + target + '.json', {'previousMode': current, 'mode': target,
                   **self.variants[target], 'probes': len(baseline),
                   'switchMs': round((monotonic() - started) * 1000)})
        except Exception:
            if current == 'old' and not public_may_have_changed:
                self.recover(('old',), baseline)
            else:
                self.recover(('drain', 'on'), baseline)
            raise

    def open(self):
        assert not (ROOT / 'serving-on.json').exists()
        _, original, _ = self.release.window()
        self.remember_route(original)
        baseline = self.api['probes']('k56', self.release.loopback('old'))
        assert self.api['probes']('k56', self.release.production) == baseline
        assert self.status('old') and not self.status('on') and not self.status('drain')
        self.change('old', 'on', baseline)

    def drain(self):
        assert not (ROOT / 'serving-drain.json').exists()
        assert self.status('on') and not self.status('old') and not self.status('drain')
        active = self.variants['on']
        assert self.api['build'](self.release.production) == active['build']
        self.release.health()
        _, sql = self.release.guard['private_db'](self.api['inspect'](active['container']))
        self.release.guard['check_idle'](sql)
        baseline = self.api['probes']('k56', self.release.loopback('on'))
        assert self.api['probes']('k56', self.release.production) == baseline
        self.change('on', 'drain', baseline)


if __name__ == '__main__':
    assert __debug__ and os.geteuid() == 0 and ROOT.resolve() == ROOT
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=('open', 'drain'))
    args = parser.parse_args()
    with (PREVIOUS / 'operate.lock').open('a') as previous, \
         (TERM2_RELEASE / 'operate.lock').open('a') as term2, (ROOT / 'operate.lock').open('a') as release:
        for handle in (previous, term2, release):
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        getattr(Cutover(), args.action)()

"""Stage Term 1 K56 paper profiles and verify old rows before changing the live route."""
import argparse
from copy import deepcopy
from datetime import datetime, timezone
import fcntl
from hashlib import sha256
import json
import os
from pathlib import Path
from runpy import run_path
import subprocess


ROOT = Path('/opt/izone-mini-k56-paper-profile-20261120')
TERM1_RELEASE = Path('/opt/izone-term1-k56-paper-profile-20261119')
TERM2_RELEASE = Path('/opt/izone-term2-k56-paper-bridge-20261119')
PREVIOUS = Path('/opt/izone-cbt-signed-renewal-r3-20261119')
GUARD = '/opt/izone-mini-k56-recovery-20261112/operator.py'
NGINX = Path('/etc/nginx/snippets/izone-k56-route.conf')
PORTS = {'old': 19854, 'on': 19856, 'drain': 19857}
MODE = 'K56_MINI_PAPER_PARALLEL_ENTRY_MODE'
TERM1_MODE = 'K56_TERM1_PAPER_PARALLEL_ENTRY_MODE'
MINI_CBT_MODE = 'K56_MINI_CBT_PARALLEL_ENTRY_MODE'
TERM2_MODE = 'K56_TERM2_PAPER_PARALLEL_ENTRY_MODE'
FILES = ('k56-exam-order.js', 'mini-k56-recovery-core.mjs', 'mini-paper-parallel-entry.mjs')


def digest(body):
    return sha256(body).hexdigest()


def read(path):
    return json.loads(path.read_bytes())


def record(name, result):
    result = {'at': datetime.now(timezone.utc).isoformat(), **result}
    with (ROOT / name).open('x', encoding='utf-8') as output:
        json.dump(result, output, indent=2)
        output.write('\n')
        output.flush()
        os.fsync(output.fileno())
    print(json.dumps(result), flush=True)


class Release:
    def __init__(self):
        self.api = run_path(str(PREVIOUS / 'operate.py'))
        self.baseline = read(TERM1_RELEASE / 'serving-on.json')
        self.production = self.api['PUBLIC']['k56'][0]
        self.manifest = read(ROOT / 'MANIFEST.json')
        assert set(self.manifest['files']) == set(FILES)
        assert self.manifest['baseBuild'] == self.baseline['build']
        assert digest((ROOT / 'migration.sql').read_bytes()) == self.manifest['migrationSha256']
        self.guard = run_path(GUARD)

    def loopback(self, mode):
        return self.api['loopback'](PORTS[mode])

    def check_hashes(self, identifier, field):
        for name, item in self.manifest['files'].items():
            path = '/app/src/' + name
            if item[field] is None:
                self.api['run']('docker', 'exec', identifier, 'test', '!', '-e', path)
            else:
                actual = self.api['run']('docker', 'exec', identifier, 'sha256sum', path)
                assert actual.split()[0].decode() == item[field], name

    def health(self):
        for port in (13982, 13983):
            status, body = self.api['get'](self.api['loopback'](port), '/health')
            assert status == 200 and body['ok'] is True, port
            if port == 13982:
                assert body['operations']['intake']['ready'] is True

    def old(self):
        old = self.api['inspect'](self.baseline['container'])
        assert old['State']['Running'] is True
        env = self.api['environment'](old)
        assert env['BUILD_SHA'] == self.manifest['baseBuild'] and env.get(MODE, 'off') == 'off'
        assert all(env.get(key) == 'on' for key in (TERM1_MODE, TERM2_MODE, MINI_CBT_MODE))
        for base in (self.loopback('old'), self.production):
            assert self.api['build'](base) == self.manifest['baseBuild']
        assert NGINX.is_file() and not NGINX.is_symlink()
        route = NGINX.read_bytes()
        assert route.count(self.loopback('old').encode()) == 3
        assert all(self.loopback(mode).encode() not in route for mode in ('on', 'drain'))
        self.check_hashes(old['Id'], 'preimage')
        return old, route

    def window(self):
        old, route = self.old()
        self.health()
        _, sql = self.guard['private_db'](old)
        self.guard['check_idle'](sql)
        return old, route, sql

    def check_ports(self):
        assert all(not self.api['run']('ss', '-H', '-ltn', f'sport = :{port}').strip()
                   for mode, port in PORTS.items() if mode != 'old')

    def preflight(self):
        old, route, _ = self.window()
        self.check_ports()
        print(json.dumps({'build': self.manifest['baseBuild'], 'container': old['Id'],
                          'routeHash': digest(route), 'collectorAndAgentReady': True,
                          'checkedQuietWindow': True}), flush=True)

    def stage(self):
        assert not (ROOT / 'staged.json').exists()
        # Mount and syntax checks use a disconnected probe. The two API
        # variants are only created here. Migration and cutover use window().
        old, route = self.old()
        self.check_ports()
        verification = read(PREVIOUS / 'incoming' / 'preflight.json')['helper']
        helper_path = Path(verification['path'])
        assert digest(helper_path.read_bytes()) == verification['sha256']
        helper = run_path(str(helper_path))
        engine = helper['engine']
        engine.__globals__['SOCKET'] = Path('/var/run/docker.sock')
        overlays = {}
        for name, item in self.manifest['files'].items():
            source = ROOT / 'src' / name
            body = source.read_bytes()
            assert digest(body) == item['sha256'] and not source.is_symlink()
            os.chmod(source, 0o444)
            overlays['/app/src/' + name] = str(source)

        old['HostConfig'].setdefault('Mounts', [])
        payload = helper['clone_payload'](old, overlays)
        payload['HostConfig']['RestartPolicy'] = {'Name': 'no', 'MaximumRetryCount': 0}
        [binding] = payload['HostConfig']['PortBindings']
        assert payload['HostConfig']['PortBindings'][binding] == [
            {'HostIp': '127.0.0.1', 'HostPort': str(PORTS['old'])}]

        probe = deepcopy(payload)
        probe['HostConfig']['NetworkMode'] = 'none'
        probe['HostConfig']['PortBindings'] = {}
        probe['NetworkingConfig'] = {'EndpointsConfig': {}}
        probe['Entrypoint'] = ['/bin/sh', '-ec']
        probe['Cmd'] = ['\n'.join(f'node --check /app/src/{name}' for name in FILES) + '\necho paper-ready']
        probe_name = 'izone-mini-k56-paper-profile-syntax-20261120'
        identifier = engine('POST', '/v1.48/containers/create?name=' + probe_name, probe, (201,))['Id']
        try:
            result = subprocess.run(('docker', 'start', '-a', identifier), capture_output=True, timeout=14)
            assert result.returncode == 0 and result.stdout.strip() == b'paper-ready'
        finally:
            self.api['run']('docker', 'rm', '-f', identifier)

        variants = {'old': {'container': old['Id'], 'port': PORTS['old'], 'build': self.manifest['baseBuild']}}
        for mode in ('on', 'drain'):
            target = deepcopy(payload)
            build = self.manifest['build']
            if mode == 'drain':
                build = digest((build + '\ndrain').encode())[:40]
            environment = self.api['environment'](old) | {MODE: mode, 'BUILD_SHA': build}
            target['Env'] = [f'{key}={value}' for key, value in environment.items()]
            target['HostConfig']['PortBindings'][binding][0]['HostPort'] = str(PORTS[mode])
            name = 'izone-mini-k56-paper-profile-' + mode + '-20261120'
            identifier = engine('POST', '/v1.48/containers/create?name=' + name, target, (201,))['Id']
            candidate = self.api['inspect'](identifier)
            assert candidate['Image'] == old['Image'] and candidate['State']['Status'] == 'created'
            assert self.api['environment'](candidate) == environment
            assert self.api['mounts'](candidate) == (self.api['mounts'](old) |
                                                   {path: (local, False) for path, local in overlays.items()})
            for key in ('Cmd', 'Entrypoint', 'User', 'WorkingDir'):
                assert candidate['Config'][key] == old['Config'][key]
            variants[mode] = {'container': identifier, 'port': PORTS[mode], 'build': build}
        assert self.old()[1] == route
        record('staged.json', {'variants': variants, 'routeHash': digest(route), 'servingChanged': False})

    def migrate(self):
        assert not (ROOT / 'migrated.json').exists()
        staged = read(ROOT / 'staged.json')
        _, route, sql = self.window()
        assert digest(route) == staged['routeHash']
        for mode in ('on', 'drain'):
            target = self.api['inspect'](staged['variants'][mode]['container'])
            assert target['State']['Status'] == 'created'
        migration = run_path(str(ROOT / 'protect-migration.py'))['guarded_sql']
        statement = migration((ROOT / 'migration.sql').read_text(encoding='utf-8'), 'assessment_k56')
        output = sql(statement).decode('utf-8')
        records = [json.loads(line) for line in output.splitlines() if line.strip().startswith('{')]
        [data] = records
        assert data['rowsUnchanged'] is True and output.strip().endswith('COMMIT')
        record('migrated.json', {**data, 'servingBuild': self.manifest['baseBuild'], 'schemaIsAdditive': True})


if __name__ == '__main__':
    assert __debug__ and os.geteuid() == 0 and ROOT.resolve() == ROOT
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=('preflight', 'stage', 'migrate'))
    args = parser.parse_args()
    with (PREVIOUS / 'operate.lock').open('a') as previous, \
         (TERM2_RELEASE / 'operate.lock').open('a') as term2, \
         (TERM1_RELEASE / 'operate.lock').open('a') as term1, (ROOT / 'operate.lock').open('a') as release:
        for handle in (previous, term2, term1, release):
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        getattr(Release(), args.action)()

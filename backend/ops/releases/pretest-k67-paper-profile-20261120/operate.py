"""Stage and switch only the Pretest K67 paper API over the current K67 build."""

import argparse
import fcntl
import json
import os
from copy import deepcopy
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from runpy import run_path

ROOT = Path('/opt/izone-pretest-k67-paper-t4-20261120')
PREVIOUS = Path('/opt/izone-mini-k67-paper-t4-20261119')
TERM2 = Path('/opt/izone-term2-k67-paper-collector-20261119')
TERM1 = Path('/opt/izone-term1-k67-paper-journal-closed-20261119')
PORTS = {'on': 19846, 'drain': 19847}
MODE = 'K67_PRETEST_PAPER_PARALLEL_ENTRY_MODE'
ROOT_ROUTE = '/api/term-tests/pretest-lesson-16/paper-journey'
CONSTRAINT = "conrelid='assessment.term_test_exam_session'::regclass AND conname='pretest_parallel_entry_session_scope'"


def digest(data):
    return sha256(data).hexdigest()


def read(path):
    return json.loads(path.read_bytes())


def receipt(label, value):
    utc = datetime.now(timezone.utc)
    record = {'at': utc.isoformat(), **value}
    with (ROOT / (label + '-' + utc.strftime('%Y%m%dT%H%M%S%fZ') + '.json')).open('x') as handle:
        json.dump(record, handle, indent=2)
        handle.flush()
        os.fsync(handle.fileno())
    print(json.dumps(record), flush=True)


def migration_transaction(data):
    migration = data.decode('utf-8').strip().splitlines()
    assert migration[:2] == ['BEGIN;', "SET LOCAL lock_timeout = '5s';"] and migration[-1] == 'COMMIT;'
    statement = '\n'.join(migration[2:-1])
    signature = """SELECT count(*) AS n, encode(sha256(convert_to(coalesce(
        string_agg(md5(to_jsonb(s)::text), '' ORDER BY s.id), ''), 'UTF8')), 'hex') AS h
        FROM assessment.{table} s"""
    session_signature = signature.format(table="term_test_exam_session")
    attempt_signature = signature.format(table="term_test_attempt")
    return f"""
        BEGIN;
        SET LOCAL lock_timeout='5s';
        SET LOCAL statement_timeout='12s';
        LOCK TABLE assessment.term_test_exam_session IN ACCESS EXCLUSIVE MODE;
        LOCK TABLE assessment.term_test_attempt IN SHARE MODE;
        CREATE TEMP TABLE pretest_paper_before ON COMMIT DROP AS {session_signature};
        CREATE TEMP TABLE pretest_attempt_before ON COMMIT DROP AS {attempt_signature};
        DO $$ BEGIN
          IF NOT EXISTS (SELECT FROM pg_constraint WHERE {CONSTRAINT} AND convalidated
            AND strpos(pg_get_constraintdef(oid), 'cbt')>0 AND strpos(pg_get_constraintdef(oid),'legacy')=0)
          THEN RAISE EXCEPTION 'Previous Pretest guard differs'; END IF;
        END $$;
        {statement}
        CREATE TEMP TABLE pretest_paper_after ON COMMIT DROP AS {session_signature};
        CREATE TEMP TABLE pretest_attempt_after ON COMMIT DROP AS {attempt_signature};
        DO $$ BEGIN
          IF EXISTS (SELECT * FROM pretest_paper_before EXCEPT SELECT * FROM pretest_paper_after)
             OR EXISTS (SELECT * FROM pretest_attempt_before EXCEPT SELECT * FROM pretest_attempt_after)
             OR NOT EXISTS (SELECT FROM pg_constraint WHERE {CONSTRAINT} AND convalidated
                AND strpos(pg_get_constraintdef(oid), 'cbt')>0 AND strpos(pg_get_constraintdef(oid),'legacy')>0)
          THEN RAISE EXCEPTION 'Pretest guard or old rows differ'; END IF;
        END $$;
        SELECT json_build_object('rowsUnchanged',true,'sessions',json_build_object('count', s.n, 'digest', s.h),
          'attempts',json_build_object('count', a.n, 'digest', a.h)) FROM pretest_paper_after s CROSS JOIN pretest_attempt_after a;
        COMMIT;"""


def create_release():
    make_previous = run_path(str(PREVIOUS / 'operate-mini-k67-paper-t4-20261119.py'))['create_release']
    previous_release = make_previous()
    base = type(previous_release)

    class PretestPaperRelease(base):
        def __init__(self):
            self.previous = previous_release
            self.previous.variants_from_disk()
            self.prior = self.previous.prior
            self.api, self.term2, self.public = self.previous.api, self.previous.term2, self.previous.public
            self.old = self.previous.variants['on']
            self.manifest_path = ROOT / 'MANIFEST.json'
            self.manifest = read(self.manifest_path)
            assert self.manifest['servingBuild'] == self.old['build']
            files = self.manifest['files']
            assert set(files) == {'config.js', 'mini-cbt-journey.js', 'app.js'}
            self.before = {'/app/src/' + name: item['serving'] for name, item in files.items()}
            self.after = {'/app/src/' + name: item['candidate'] for name, item in files.items()}
            self.inherited = self.previous.inherited | self.previous.after
            self.inherited = {name: pin for name, pin in self.inherited.items() if name not in self.before}

        def window(self):
            return self.previous.window()

        def paper(self, address, mode):
            self.previous.paper(address, 'on')
            status, body = self.api['get'](address, ROOT_ROUTE + '/availability')
            assert status == 200 and body.get('ok') is True and body.get('enabled') is True
            assert bool(body.get('parallelEntryAvailable')) is (mode == 'on')
            status, body = self.api['get'](address, ROOT_ROUTE + '/prepare', b'{}', self.api['ORIGIN'])
            assert (status, body.get('error')) == (400, 'OFFLINE_INVALID')

        def original(self):
            self.previous.verify_current('on')
            self.term2['check_hashes'](self.api, self.old['container'], self.inherited | self.before)
            for address in (self.previous.address('on'), *self.public):
                self.paper(address, 'old')

        def stage(self):
            self.original()
            terminal = self.api['inspect'](self.old['container'])
            environment = self.api['environment'](terminal)
            assert environment.get(MODE, 'off') == 'off' and environment['K67_PRETEST_PAPER_JOURNEY_MODE'] == 'on'
            assert environment['K67_PRETEST_PARALLEL_ENTRY_MODE'] == environment['K67_PRETEST_CBT_JOURNEY_MODE'] == 'on'
            assert all(not self.api['run']('ss', '-H', '-ltn', f'sport = :{port}').strip() for port in PORTS.values())
            mounts = self.api['mounts'](terminal)
            replacements = {}
            for path, pin in self.after.items():
                source = ROOT / Path(path).name
                assert source.is_file() and not source.is_symlink() and digest(source.read_bytes()) == pin
                assert path not in mounts or mounts[path][1] is False
                os.chmod(source, 0o444)
                replacements[path] = str(source)

            helper = run_path(self.term2['HELPER'])
            engine = helper['engine']
            engine.__globals__['SOCKET'] = Path('/var/run/docker.sock')
            payload = helper['clone_payload'](terminal, replacements)
            payload['HostConfig']['RestartPolicy'] = {'Name': 'no', 'MaximumRetryCount': 0}
            smoke = deepcopy(payload)
            smoke['HostConfig']['NetworkMode'] = 'none'
            smoke['HostConfig']['PortBindings'] = {}
            smoke['NetworkingConfig'] = {'EndpointsConfig': {}}
            smoke['Entrypoint'] = ['node']
            smoke['Cmd'] = ['--input-type=module', '-e',
                            'await import("/app/src/app.js"); console.log("pretest-k67-paper-t4-import-ok");']
            test_id = engine('POST', '/v1.48/containers/create?name=izone-pretest-paper-t4-import-20261120', smoke, (201,))['Id']
            try:
                output = self.api['run']('docker', 'start', '-a', test_id)
                assert b'pretest-k67-paper-t4-import-ok' in output and self.api['inspect'](test_id)['State']['ExitCode'] == 0
            finally:
                if self.api['inspect'](test_id)['State']['Running']:
                    self.api['run']('docker', 'stop', '--time', '5', test_id)
                self.api['run']('docker', 'rm', test_id)

            variants = {'old': self.old}
            created = []
            try:
                for mode, port in PORTS.items():
                    build = digest(f'{self.old["build"]}\n{digest(self.manifest_path.read_bytes())}\n{mode}'.encode())[:40]
                    target = deepcopy(payload)
                    desired = environment | {MODE: mode, 'K67_BUILD_SHA': build}
                    target['Env'] = [f'{key}={value}' for key, value in desired.items()]
                    [binding] = target['HostConfig']['PortBindings']
                    target['HostConfig']['PortBindings'][binding] = [{'HostIp': '127.0.0.1', 'HostPort': str(port)}]
                    name = f'izone-pretest-k67-paper-t4-{mode}-20261120'
                    identifier = engine('POST', '/v1.48/containers/create?name=' + name, target, (201,))['Id']
                    created.append(identifier)
                    found = self.api['inspect'](identifier)
                    assert found['State']['Status'] == 'created' and found['Image'] == terminal['Image']
                    assert self.api['environment'](found) == desired
                    assert self.api['mounts'](found) == mounts | {p: (s, False) for p, s in replacements.items()}
                    assert all(found['Config'][key] == terminal['Config'][key] for key in ('Cmd', 'Entrypoint', 'User', 'WorkingDir'))
                    variants[mode] = {'build': build, 'port': port, 'container': identifier}
                self.original()
                with (ROOT / 'staged.json').open('x') as handle:
                    json.dump(variants, handle)
            except BaseException:
                for identifier in reversed(created):
                    assert self.api['inspect'](identifier)['State']['Status'] == 'created'
                    self.api['run']('docker', 'rm', identifier)
                raise
            receipt('staged', {'variants': variants, 'importsVerifiedOffline': True, 'servingChanged': False})

        def schema(self, mode):
            sql, _ = self.prior.previous.mini['window']()
            checked = sql(f"BEGIN READ ONLY; SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE {CONSTRAINT} AND convalidated; ROLLBACK;").strip()
            assert "'cbt'::text" in checked and ("'legacy'::text" in checked) is (mode == 'compatible')
            return sql

        def migrate(self):
            self.original()
            self.window()
            self.variants_from_disk()
            assert all(self.api['inspect'](self.variants[m]['container'])['State']['Status'] == 'created' for m in PORTS)
            sql = self.schema('previous')
            pin = self.manifest['migration']
            assert pin['name'] == '051-pretest-parallel-paper-entry.sql'
            data = (ROOT / pin['name']).read_bytes()
            assert digest(data) == pin['sha256']
            result = json.loads(sql(migration_transaction(data)))
            assert result['rowsUnchanged'] is True
            self.schema('compatible')
            receipt('migrate', result | {'sqlSha256': pin['sha256']})

        def variants_from_disk(self):
            self.variants = read(ROOT / 'staged.json')
            assert self.variants['old'] == self.old and all(self.variants[m]['port'] == p for m, p in PORTS.items())
            self.proxies = {}
            for path, (versions, meta) in self.previous.proxies.items():
                original = versions['on']
                target = f'127.0.0.1:{self.old["port"]}'.encode()
                assert target in original
                self.proxies[path] = {mode: original.replace(target, f'127.0.0.1:{row["port"]}'.encode())
                                      for mode, row in self.variants.items()}, meta

    return PretestPaperRelease()


def main():
    assert __debug__ and os.geteuid() == 0 and ROOT.resolve() == ROOT
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=('stage', 'migrate', 'verify', 'switch'))
    parser.add_argument('previous', nargs='?', choices=('old', 'on', 'drain'))
    parser.add_argument('target', nargs='?', choices=('on', 'drain'))
    args = parser.parse_args()
    with (TERM1 / '.lock').open('a') as first, (TERM2 / '.lock').open('a') as second, (PREVIOUS / '.lock').open('a') as previous, (ROOT / '.lock').open('a') as own:
        for handle in (first, second, previous, own):
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        release = create_release()
        if args.action == 'stage':
            assert not (ROOT / 'staged.json').exists() and args.previous is None
            release.stage()
        elif args.action == 'migrate':
            assert args.previous is None
            release.migrate()
        else:
            assert args.previous is not None
            release.variants_from_disk()
            if args.action == 'verify':
                assert args.target is None
                mode = args.previous
                release.verify_current(mode)
            else:
                assert args.target is not None
                if args.previous == 'old':
                    release.window()
                core = run_path(str(release.term2['MINI'] / 'mini_api_switch.py'))
                core['switch'].__globals__['TRANSITIONS'] = {('old', 'on'), ('on', 'drain'), ('drain', 'on')}
                mode = core['switch'](args.previous, args.target, release)
            receipt(args.action, {'mode': mode, **release.variants[mode], 'publicEndpoints': len(release.public),
                                  'collectorReady': True, 'pretestPaperParallelMode': mode})


if __name__ == '__main__':
    main()

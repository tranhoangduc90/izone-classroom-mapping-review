"""Chuẩn bị ledger bền vững trên C rồi kiểm API/DB sau chuyển bản đã duyệt.
prepare chỉ tạo UUID/ERP âm riêng; run yêu cầu commit sạch, ba candidate live và Pages đúng.
Không tự deploy/retry; receipt riêng chỉ chứng minh API/DB/cleanup, còn UI/boundary vẫn cần.
"""
import argparse
import datetime
import hashlib
import importlib.util
import json
import os
import secrets
import shlex
import sys
import uuid
from pathlib import Path
import release_adapter as adapter
import canary_remote as canary

HERE = Path(__file__).resolve().parent


def save_new(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.flush()
        os.fsync(stream.fileno())


def prepare(config):
    directory = Path(config['evidence_dir'])
    run = config['acceptance_binding']['acceptance_run_id']
    canary.acceptance_path(config['acceptance_binding'])
    numbers = set()
    def negative_id():
        while True:
            value = -1000000 - secrets.randbelow(2000000000)
            if value not in numbers:
                numbers.add(value)
                return value
    manifest = json.loads((HERE/'candidate.json').read_text(encoding='utf-8'))
    value = {'run_id': run, 'manifest': manifest, 'acceptance_binding':config['acceptance_binding'],
             'created_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
             'task_id': '01a0ffd0-778e-7723-99e3-a4bdee78fbb7',
             'identities': [{'name': target['name'], 'attempt_id': str(uuid.uuid4()),
                             'marker': 'CODEX_D08_' + run + '_' + str(index),
                             'course_id': canary.DEMO_COURSE_ID if target['name']==canary.NAMES[2] else negative_id(), 'student_id': negative_id()}
                            for index, target in enumerate(manifest['targets'])]}
    canary.validate(value)
    path = directory/'production-canary-ledger.json'
    save_new(path, value)
    return {'status': 'prepared', 'ledger': str(path), 'production_mutated': False}


def run(config):
    directory = Path(config['evidence_dir'])
    request = json.loads((directory/'production-canary-ledger.json').read_text(encoding='utf-8'))
    manifest = json.loads((HERE/'candidate.json').read_text(encoding='utf-8'))
    if request['manifest'] != manifest:
        raise RuntimeError('canary_manifest_changed_reprepare_required')
    adapter.checkpoint_inputs(config, manifest)
    rows = adapter.remote(config, 'probe')
    if any(row['image'] != target['candidate_image'] or not row['running'] or row['healthy'] != 'healthy' for row, target in zip(rows, manifest['targets'])):
        raise RuntimeError('canary_requires_deployed_candidates')
    public = adapter.public_readback(config)
    request['expected'] = rows
    request['core'] = (HERE/'canary_contract.mjs').read_text(encoding='utf-8')
    for target, base in zip(manifest['targets'], json.loads((HERE/'baseline.json').read_text(encoding='utf-8'))['targets']):
        target['baseline_hashes'] = base['source_hashes']
    request['manifest'] = manifest
    # Ghi đúng request trước gửi; file tồn tại thì dừng để đối soát journal, không gửi hai sender.
    save_new(directory/'production-canary-request.json', request)
    remote = """import json,sys,tempfile
from pathlib import Path
packet=json.load(sys.stdin)
with tempfile.TemporaryDirectory(prefix='codex-d08-canary-') as folder:
 for name,source in packet['files'].items():
  if name not in ('release_remote.py','canary_remote.py','database_binding.py'): raise RuntimeError('source_invalid')
  (Path(folder)/name).write_text(source,encoding='utf-8')
 sys.path.insert(0,folder)
 import canary_remote as c
 print(json.dumps(c.exercise(packet['request']),ensure_ascii=False))
"""
    helper_spec = importlib.util.spec_from_file_location('ssh_credentials',HERE/'ssh_credentials.py')
    helper = importlib.util.module_from_spec(helper_spec)
    helper_spec.loader.exec_module(helper)
    client, password = helper.connect('vps_1')
    password = ''
    try:
        stdin, stdout, stderr = client.exec_command('python3 -c ' + shlex.quote(remote), timeout=900)
        packet = {'request': request, 'files': {name:(HERE/name).read_text(encoding='utf-8') for name in ('release_remote.py','canary_remote.py','database_binding.py')}}
        stdin.write(json.dumps(packet,ensure_ascii=False))
        stdin.channel.shutdown_write()
        output = stdout.read().decode('utf-8')
        remote_stderr = stderr.read().decode('utf-8')
        code = stdout.channel.recv_exit_status()
        # Giữ stdout/stderr riêng trước phân tích; lỗi preflight không bị gọi nhầm mất phản hồi.
        save_new(directory/'production-canary-transport.private.json', {'exit_code':code,'stdout':output,'stderr':remote_stderr})
        if code or not output:
            raise RuntimeError('canary_remote_response_unknown_reconcile_journal_do_not_replay')
        value = json.loads(output)
        value['snapshots'] = adapter.snapshots(config)
        value['public_assets'] = public
        value['producer_sources'] = {name:hashlib.sha256((HERE/name).read_bytes()).hexdigest() for name in ('canary_contract.mjs','canary_remote.py','canary_producer.py')}
        save_new(directory/'production-canary-api-database.json',value)
        return {'status':value['status'],'evidence_reference':str(directory/'production-canary-api-database.json'), 'browser_outcome':'not_run'}
    finally:
        client.close()


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser()
    parser.add_argument('--config',required=True)
    parser.add_argument('action',choices=['prepare','run'])
    args = parser.parse_args()
    try:
        config = json.loads(Path(args.config).read_text(encoding='utf-8'))
        print(json.dumps(globals()[args.action](config),ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'status':'unknown','error':str(error)},ensure_ascii=False))
        sys.exit(1)

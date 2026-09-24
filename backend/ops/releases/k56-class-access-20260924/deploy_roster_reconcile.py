"""Phát hành riêng API K56 với đối soát ERP, kiểm Compose và đọc lại production."""

import argparse
from hashlib import sha256
import json
from pathlib import Path
import sys

import paramiko
import win32cred


OVERLAY = Path(__file__).parent / "compose.roster-reconcile.override.yml"
REMOTE_OVERLAY = "/opt/izone-k56-shared-db-20260924/compose.roster-reconcile.override.yml"
REMOTE_SCRIPT = r"""
# Dữ liệu vào: image K56 đã kiểm và một override chỉ đổi service K56.
# Việc chính: so Compose, backup, quyền và số liệu rồi tái tạo duy nhất API K56.
# Kết quả: health, roster, checkpoint và K67 đọc lại, không in học viên/secret.
# Khi lỗi: giữ nguyên image hiện có để điều tra; không tự restore database.
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from urllib.error import HTTPError
from urllib.request import urlopen

deploy = __DEPLOY__
overlay = Path('__REMOTE_OVERLAY__')
overlay_sha = '__OVERLAY_SHA__'
new_tag = 'izone-k56-live-results:20260924.4-roster-reconcile'
new_id = 'sha256:5b1e9e7e65809673dd6c453750a0bebe99185a371e5cdd484298732ca4b4a956'
old_id = 'sha256:4e10ec690991ac9137e3a349f219f6017e7b15715e955aec15648d096a764ad7'
backup = Path('/opt/backups/k56-shared-cutover-ZsFjJl7l/mapping_db-before-k56.dump')
backup_sha = 'd1b9acd30d543d6bf251576d9349d5737514ef5f302e1e8cdd6bfa32913ebe3d'
mutation_attempted = False

def run(args, code, env=None, input_text=None, timeout=60):
    process = subprocess.run(args, input=input_text, text=True,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             env=env, timeout=timeout, check=False)
    if process.returncode != 0:
        raise RuntimeError(code)
    return process.stdout.strip()

def inspect(name):
    items = json.loads(run(['docker', 'inspect', name], 'CONTAINER_INSPECT_FAILED'))
    if len(items) != 1:
        raise RuntimeError('CONTAINER_INSPECT_AMBIGUOUS')
    return items[0]

def counts():
    sql = "SELECT json_build_object(" + \
      "'latest',(SELECT run.id::text FROM mapping.sync_run AS run " + \
      "WHERE run.source='n8n_k56_erp_ongoing' ORDER BY run.id DESC LIMIT 1)," + \
      "'roster',(SELECT count(*) FROM assessment_k56.term_test_roster)," + \
      "'access',(SELECT count(*) FROM assessment_k56.term_test_class_access WHERE enabled)," + \
      "'attempts',(SELECT count(*) FROM assessment_k56.term_test_attempt)," + \
      "'checkpoint',(SELECT last_sync_run_id::text FROM " + \
      "assessment_k56.k56_roster_sync_checkpoint " + \
      "WHERE source_name='n8n_k56_erp_ongoing')," + \
      "'k67Roster',(SELECT count(*) FROM assessment.term_test_roster))::text;"
    return json.loads(run(['docker','exec','-i','mapping-postgres','sh','-lc',
      'psql -X -q -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d mapping_db'],
      'COUNTS_FAILED', input_text=sql))

def roster(class_code, slug):
    url = ('http://127.0.0.1:8795/api/term-tests/roster?class=' + class_code
           + '&test=' + slug)
    try:
        with urlopen(url, timeout=8) as response:
            return response.status, json.loads(response.read().decode('utf-8'))
    except HTTPError as error:
        return error.code, {}

try:
    if (not overlay.is_file() or hashlib.sha256(overlay.read_bytes()).hexdigest()
            != overlay_sha or not backup.is_file()
            or hashlib.sha256(backup.read_bytes()).hexdigest() != backup_sha):
        raise RuntimeError('RELEASE_FILE_OR_BACKUP_CHANGED')
    if run(['docker','image','inspect','--format','{{.Id}}',new_tag],
           'IMAGE_NOT_FOUND') != new_id:
        raise RuntimeError('CANDIDATE_IMAGE_CHANGED')
    before = inspect('izone-k56-ic2264-api')
    k67_before = inspect('mapping-review-api')
    if (before['Image'] != old_id
            or before['State'].get('Health',{}).get('Status') != 'healthy'
            or k67_before['State'].get('Health',{}).get('Status') != 'healthy'):
        raise RuntimeError('SERVICE_BASELINE_CHANGED')
    labels = before['Config']['Labels']
    files = labels['com.docker.compose.project.config_files'].split(',')
    workdir = labels['com.docker.compose.project.working_dir']
    project = labels['com.docker.compose.project']
    service = labels['com.docker.compose.service']
    if service != 'k56-ic2264-api' or len(files) != 9:
        raise RuntimeError('COMPOSE_SOURCE_CHANGED')
    runtime_env = {line.split('=',1)[0]:line.split('=',1)[1]
                   for line in before['Config']['Env'] if '=' in line}
    for filename in files:
        for key in re.findall(r'\$\{([A-Z][A-Z0-9_]*):\?',
                              Path(filename).read_text(encoding='utf-8')):
            runtime_env.setdefault(key, runtime_env.get('BUILD_SHA') or 'fac9082')
    process_env = {**os.environ, **runtime_env}
    base = ['docker','compose','--project-directory',workdir,'-p',project]
    for filename in files:
        base.extend(['-f',filename])
    candidate = base + ['-f',str(overlay)]
    old_config = json.loads(run(base + ['config','--format','json'],
                                'OLD_COMPOSE_INVALID', env=process_env))
    new_config = json.loads(run(candidate + ['config','--format','json'],
                                'NEW_COMPOSE_INVALID', env=process_env))
    old_service = old_config['services'][service]
    new_service = new_config['services'][service]
    old_env = old_service['environment']
    new_env = new_service['environment']
    changed_env = sorted(key for key in set(old_env) | set(new_env)
                         if old_env.get(key) != new_env.get(key))
    if (changed_env != ['APP_VERSION','BUILD_SHA','K56_ROSTER_RECONCILE_ENABLED']
            or new_service['image'] != new_tag
            or new_env.get('K56_ROSTER_RECONCILE_ENABLED') != 'true'
            or new_env.get('DEPLOYMENT_PROFILE') != 'k56-ic2264'
            or new_env.get('DATABASE_URL') != old_env.get('DATABASE_URL')):
        raise RuntimeError('COMPOSE_ENV_CONTRACT_CHANGED')
    for key in set(old_service) | set(new_service):
        if key not in ('image','environment') and old_service.get(key) != new_service.get(key):
            raise RuntimeError('COMPOSE_UNEXPECTED_CHANGE_' + key.upper())
    before_counts = counts()
    if before_counts != {'latest':'105','roster':1341,'access':87,
                         'attempts':0,'checkpoint':None,'k67Roster':46}:
        raise RuntimeError('DATA_BASELINE_CHANGED')
    if not deploy:
        print(json.dumps({'toolOutcome':'success',
          'businessOutcome':'roster_reconcile_deploy_ready',
          'changedEnvKeys':changed_env,'sourceComposeFiles':len(files),
          'counts':before_counts,'productionServiceChanged':False}))
        raise SystemExit(0)
    mutation_attempted = True
    run(candidate + ['up','-d','--no-deps','--no-build','--force-recreate',service],
        'COMPOSE_UP_FAILED',env=process_env,timeout=120)
    after = None
    for _ in range(40):
        after = inspect('izone-k56-ic2264-api')
        if after['Image'] == new_id and after['State'].get('Health',{}).get('Status') == 'healthy':
            break
        time.sleep(2)
    if (after['Image'] != new_id
            or after['State'].get('Health',{}).get('Status') != 'healthy'
            or sorted(after['NetworkSettings']['Networks']) !=
              ['izone-k56-demo_default','mapping-api-net']):
        raise RuntimeError('NEW_SERVICE_NOT_HEALTHY')
    checkpoint = None
    for _ in range(20):
        checkpoint = counts()
        if checkpoint['checkpoint'] == '105':
            break
        time.sleep(2)
    expected = {**before_counts,'checkpoint':'105'}
    if checkpoint != expected:
        raise RuntimeError('ROSTER_WORKER_READBACK_FAILED')
    smoke = {}
    for code,wanted in [('IC2264',12),('IC2322',19),('IC2326',14)]:
        for slug in ('term-test-1-k56','term-test-2-k56','mini-test-k56'):
            status,body = roster(code,slug)
            if status != 200 or len(body.get('students') or []) != wanted:
                raise RuntimeError('K56_ROSTER_HTTP_MISMATCH')
            smoke[code + ':' + slug] = wanted
    hidden,_ = roster('IC2322','term-test-1')
    if hidden != 404:
        raise RuntimeError('K67_SLUG_EXPOSED')
    k67_after = inspect('mapping-review-api')
    if (k67_after['Image'] != k67_before['Image']
            or k67_after['State'].get('Health',{}).get('Status') != 'healthy'):
        raise RuntimeError('K67_SERVICE_CHANGED')
    print(json.dumps({'toolOutcome':'success',
      'businessOutcome':'roster_reconcile_deployed_verified',
      'imageId':after['Image'],'checkpoint':checkpoint['checkpoint'],
      'roster':checkpoint['roster'],'access':checkpoint['access'],
      'httpSmoke':len(smoke),'k67ImageUnchanged':True,
      'productionServiceChanged':True}))
except Exception as exc:
    code = str(exc) if isinstance(exc,RuntimeError) else type(exc).__name__
    current_image = None
    try:
        current_image = inspect('izone-k56-ic2264-api')['Image']
    except Exception:
        pass
    print(json.dumps({'toolOutcome':'failure','errorCode':code,
      'mutationAttempted':mutation_attempted,'currentImageId':current_image,
      'automaticRollback':False}),file=sys.stderr)
    raise SystemExit(2)
"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--deploy", action="store_true")
    args = parser.parse_args()
    expected_sha = sha256(OVERLAY.read_bytes()).hexdigest()
    credential = win32cred.CredRead("Codex/SSH/vps_1", win32cred.CRED_TYPE_GENERIC, 0)
    username = ((credential.get("UserName") or "root").strip().split("@", 1)[0]
                or "root")
    password = credential["CredentialBlob"].decode("utf-16-le")
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    client.connect("ducizone.ddns.net", port=22, username=username,
                   password=password, timeout=15, auth_timeout=15)
    try:
        sftp = client.open_sftp()
        try:
            try:
                existing = sftp.open(REMOTE_OVERLAY, "rb")
            except FileNotFoundError:
                sftp.put(str(OVERLAY), REMOTE_OVERLAY)
                sftp.chmod(REMOTE_OVERLAY, 0o600)
            else:
                with existing:
                    if sha256(existing.read()).hexdigest() != expected_sha:
                        raise RuntimeError("REMOTE_OVERLAY_ALREADY_DIFFERENT")
        finally:
            sftp.close()
        script = REMOTE_SCRIPT.replace("__DEPLOY__", "True" if args.deploy else "False")
        script = script.replace("__REMOTE_OVERLAY__", REMOTE_OVERLAY)
        script = script.replace("__OVERLAY_SHA__", expected_sha)
        stdin, stdout, stderr = client.exec_command("python3 -", timeout=180)
        stdin.write(script)
        stdin.channel.shutdown_write()
        body = stdout.read().decode("utf-8").strip()
        error = stderr.read().decode("utf-8").strip()
        status = stdout.channel.recv_exit_status()
        if status != 0:
            try:
                report = json.loads(error)
            except (ValueError, TypeError):
                report = {"toolOutcome":"failure","errorCode":"DEPLOY_REMOTE_FAILED"}
            print(json.dumps(report), file=sys.stderr)
            raise SystemExit(2)
        report = json.loads(body)
        expected = ("roster_reconcile_deployed_verified" if args.deploy
                    else "roster_reconcile_deploy_ready")
        if report.get("businessOutcome") != expected:
            raise RuntimeError("DEPLOY_REPORT_INVALID")
        print(json.dumps(report))
    finally:
        client.close()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    main()

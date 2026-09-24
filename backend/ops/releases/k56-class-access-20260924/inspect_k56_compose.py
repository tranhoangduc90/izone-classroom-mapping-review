"""Đọc cấu hình Compose K56 đã hợp nhất, chỉ xuất metadata không nhạy cảm."""

import json
import sys

import paramiko
import win32cred


REMOTE_SCRIPT = r"""
# Dữ liệu vào: labels Compose của API K56 đang chạy.
# Việc chính: dựng config từ đúng chuỗi file hiện hành và chỉ lấy cấu trúc.
# Kết quả: network, port, mount và tên biến môi trường; không in secret.
# Khi lỗi: dừng trước khi tạo override hoặc đổi service.
import json
import os
from pathlib import Path
import re
import subprocess
import sys

def run(args, code, env=None):
    result = subprocess.run(args, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=45, check=False, env=env)
    if result.returncode != 0:
        if code == 'COMPOSE_CONFIG_FAILED':
            lowered = result.stderr.lower()
            if 'no such file' in lowered:
                code = 'COMPOSE_CONFIG_FILE_MISSING'
            elif 'permission denied' in lowered:
                code = 'COMPOSE_CONFIG_PERMISSION_DENIED'
            elif 'unknown flag' in lowered or 'unknown command' in lowered:
                code = 'COMPOSE_CONFIG_UNSUPPORTED_OPTION'
            elif 'variable is not set' in lowered:
                keys = re.findall(r'([A-Z][A-Z0-9_]+).*variable is not set',
                                  result.stderr)
                code = 'COMPOSE_CONFIG_ENV_MISSING_' + ','.join(sorted(set(keys)))
            elif 'not a docker command' in lowered or 'command not found' in lowered:
                code = 'COMPOSE_CLI_UNAVAILABLE'
            elif 'invalid' in lowered or 'validating' in lowered:
                code = 'COMPOSE_CONFIG_INVALID'
            elif 'yaml' in lowered:
                code = 'COMPOSE_YAML_ERROR'
            else:
                flags = [name for name, pattern in [
                    ('INVALID_INTERPOLATION', 'invalid interpolation format'),
                    ('ESCAPE_DOLLAR', 'escape any $'),
                    ('REQUIRED_VARIABLE', 'required variable'),
                    ('MISSING_VALUE', 'missing a value'),
                    ('EMPTY_VARIABLE', 'empty string'),
                    ('MISSING_CONFIG', 'no configuration file'),
                    ('BAD_PROJECT', 'project name'),
                    ('BAD_SERVICE', 'service'),
                    ('BAD_VOLUME', 'volume'),
                    ('BAD_NETWORK', 'network'),
                    ('INTERPOLATION', 'interpolat'),
                    ('ENV_FILE', 'env file'),
                    ('FORMAT', 'format'),
                    ('UNDEFINED', 'undefined'),
                    ('UNSUPPORTED', 'unsupported'),
                    ('WARNING', 'warning'),
                ] if pattern in lowered]
                variables = sorted(set(re.findall(r'\$\{([A-Z][A-Z0-9_]*)',
                                                  result.stderr)
                                       + re.findall(r'([A-Z][A-Z0-9_]{2,})[^\n]{0,40}required variable',
                                                    result.stderr)))
                mentioned_keys = sorted(key for key in (env or {})
                                        if len(key) > 3 and key != 'PATH'
                                        and key in result.stderr)
                code = ('COMPOSE_CONFIG_OTHER_ERROR_'
                        + ','.join(flags or ['UNCLASSIFIED'])
                        + ('_VARS_' + ','.join(variables) if variables else '')
                        + ('_KEYS_' + ','.join(mentioned_keys) if mentioned_keys else ''))
        raise RuntimeError(code)
    return result.stdout.strip()

try:
    inspected = json.loads(run(['docker', 'inspect', 'izone-k56-ic2264-api'],
                               'API_INSPECT_FAILED'))
    if len(inspected) != 1:
        raise RuntimeError('API_INSPECT_AMBIGUOUS')
    item = inspected[0]
    labels = item['Config']['Labels']
    files = labels['com.docker.compose.project.config_files'].split(',')
    workdir = labels['com.docker.compose.project.working_dir']
    project = labels['com.docker.compose.project']
    service = labels['com.docker.compose.service']
    if service != 'k56-ic2264-api' or len(files) < 2:
        raise RuntimeError('COMPOSE_LABELS_UNEXPECTED')
    args = ['docker', 'compose', '--project-directory', workdir,
            '-p', project]
    for filename in files:
        args.extend(['-f', filename])
    runtime_env = {line.split('=', 1)[0]: line.split('=', 1)[1]
                   for line in item['Config']['Env'] if '=' in line}
    build_sha_fallback = not bool(runtime_env.get('BUILD_SHA'))
    if build_sha_fallback:
        runtime_env['BUILD_SHA'] = '9b50aca6c0f1c5630dfa8f75d177dd97bc6e1a20'
    build_sha_forms = sorted(set(
        form for filename in files
        for form in re.findall(r'\$\{[^}]*BUILD_SHA[^}]*\}',
                               Path(filename).read_text(encoding='utf-8'))))
    required_variables = sorted(set(
        name for filename in files
        for name in re.findall(r'\$\{([A-Z][A-Z0-9_]*):\?',
                               Path(filename).read_text(encoding='utf-8'))))
    for name in required_variables:
        runtime_env.setdefault(name, runtime_env['BUILD_SHA'])
    config = json.loads(run(args + ['config', '--format', 'json'],
                            'COMPOSE_CONFIG_FAILED',
                            env={**os.environ, **runtime_env}))
    raw_config = json.loads(run(args + ['config', '--no-interpolate', '--format', 'json'],
                                'COMPOSE_RAW_CONFIG_FAILED',
                                env={**os.environ, **runtime_env}))
    component = config['services'][service]
    raw_component = raw_config['services'][service]
    env = component.get('environment') or {}
    env_keys = (sorted(env) if isinstance(env, dict)
                else sorted(line.split('=', 1)[0] for line in env))
    networks = component.get('networks') or {}
    result = {
        'toolOutcome': 'success',
        'businessOutcome': 'read_only_compose_topology',
        'project': project,
        'service': service,
        'configFileCount': len(files),
        'currentImage': component.get('image'),
        'currentContainerImageId': item['Image'],
        'environmentKeys': env_keys,
        'envFileCount': len(component.get('env_file') or []),
        'sourceEnvFiles': raw_component.get('env_file') or [],
        'serviceNetworks': sorted(networks),
        'networkDefinitions': {
            name: {'external': bool(value.get('external')),
                   'name': value.get('name')}
            for name, value in (config.get('networks') or {}).items()},
        'publishedPorts': [port.get('published')
                           for port in component.get('ports') or []],
        'mountTargets': [mount.get('target')
                         for mount in component.get('volumes') or []],
        'restart': component.get('restart'),
        'readOnly': component.get('read_only'),
        'buildShaFallbackForAudit': build_sha_fallback,
        'buildShaForms': build_sha_forms,
        'requiredVariables': required_variables,
        'productionWrites': 0,
    }
    print(json.dumps(result))
except Exception as exc:
    code = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
    print(json.dumps({'toolOutcome': 'failure', 'errorCode': code,
                      'buildShaLength': len(locals().get('runtime_env', {}).get('BUILD_SHA', '')),
                      'buildShaFallback': locals().get('build_sha_fallback')}),
          file=sys.stderr)
    raise SystemExit(2)
"""


def main():
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
        stdin, stdout, stderr = client.exec_command("python3 -", timeout=60)
        stdin.write(REMOTE_SCRIPT)
        stdin.channel.shutdown_write()
        body = stdout.read().decode("utf-8").strip()
        error = stderr.read().decode("utf-8").strip()
        status = stdout.channel.recv_exit_status()
        if status != 0:
            try:
                details = json.loads(error)
                code = details.get("errorCode", "COMPOSE_AUDIT_FAILED")
            except (ValueError, TypeError):
                details = {}
                code = "COMPOSE_AUDIT_FAILED"
            print(json.dumps({"toolOutcome": "failure", "errorCode": code,
                              "buildShaLength": details.get("buildShaLength"),
                              "buildShaFallback": details.get("buildShaFallback")}),
                  file=sys.stderr)
            raise SystemExit(2)
        report = json.loads(body)
        if report.get("businessOutcome") != "read_only_compose_topology":
            raise RuntimeError("COMPOSE_REPORT_INVALID")
        print(json.dumps(report))
    finally:
        client.close()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    main()

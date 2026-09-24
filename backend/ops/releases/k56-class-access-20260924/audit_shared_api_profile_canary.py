"""Chẩn đoán canary K56 bằng metadata và mã HTTP, không đọc roster/secret."""

import json
import sys

import paramiko
import win32cred


REMOTE_SCRIPT = r"""
import json
import re
import subprocess
import sys

name = 'izone-k56-shared-api-profile-canary-20260924'
try:
    inspected = subprocess.run(['docker', 'inspect', name], text=True,
                               capture_output=True, timeout=15, check=True)
    item = json.loads(inspected.stdout)[0]
    script = r'''
// Chỉ đọc cờ cấu hình và HTTP status; không in URL, token hoặc nội dung roster.
import { loadConfig } from '/app/src/config.js';
const report = {config: {}, http: {}};
try {
  const config = loadConfig();
  const endpoint = new URL(config.databaseUrl);
  report.config = {
    profile: config.deploymentProfileName,
    demoIsolated: config.demoIsolatedMode,
    portalEnabled: config.k56PortalPilotEnabled,
    dbHost: endpoint.hostname,
    dbUser: endpoint.username,
    dbName: endpoint.pathname.slice(1),
    hasAssets: Boolean(config.termTestAssetDir)
  };
  const base = 'http://127.0.0.1:' + config.port;
  for (const [key, suffix] of [
    ['health', '/health'],
    ['pilot', '/api/term-tests/roster?class=IC2264&test=term-test-1-k56'],
    ['newClass', '/api/term-tests/roster?class=IC2322&test=term-test-1-k56'],
    ['k67', '/api/term-tests/roster?class=IC2322&test=term-test-1'],
  ]) {
    try {
      const response = await fetch(base + suffix);
      const payload = await response.json();
      report.http[key] = {status: response.status,
        error: typeof payload.error === 'string' ? payload.error : null,
        profile: key === 'health' ? payload.deploymentProfile : undefined};
    } catch (error) { report.http[key] = {networkError: error.name}; }
  }
} catch (error) { report.configError = error.name; }
process.stdout.write(JSON.stringify(report) + '\n');
'''
    result = subprocess.run(['docker', 'exec', '-i', name, 'node',
                             '--input-type=module', '-'], input=script,
                            text=True, capture_output=True, timeout=20,
                            check=False)
    report = json.loads(result.stdout) if result.returncode == 0 else {
        'execExitCode': result.returncode,
        'execErrorType': 'NODE_SCRIPT_FAILED'
    }
    state = item['State']
    logs = subprocess.run(['docker', 'logs', '--tail', '80', name],
                          text=True, capture_output=True, timeout=15,
                          check=False)
    log_text = (logs.stdout + '\n' + logs.stderr).lower()
    log_signals = [label for label, fragment in [
        ('CONFIG_VALIDATION', 'zoderror'),
        ('MISSING_CLIENT_ID', 'google_client_id'),
        ('MISSING_ASSET', 'term_test_asset'),
        ('FILE_MISSING', 'enoent'),
        ('PERMISSION_DENIED', 'eacces'),
        ('DB_PERMISSION', 'permission denied for'),
        ('MODULE_IMPORT', 'err_module'),
        ('BIND_PORT', 'eaddrinuse'),
        ('NODE_EXIT', 'error:'),
    ] if fragment in log_text]
    log_fields = sorted(set(re.findall(
        r'(?i)(?:"path"\s*:\s*\[\s*"|path:\s*\[\s*\x27)([A-Z][A-Z0-9_]*)',
        logs.stdout + '\n' + logs.stderr)))
    mentioned_config_keys = sorted(key for key in [
        'ERP_SYNC_URL', 'ERP_SYNC_SECRET', 'TERM_TEST_ASSET_DIR',
        'TERM_TEST_SESSION_SECRET', 'AUTH_MODE', 'GOOGLE_CLIENT_ID',
        'DATABASE_URL', 'DEPLOYMENT_PROFILE', 'PORT', 'APP_VERSION',
    ] if key.lower() in log_text)
    output = {'toolOutcome': 'success',
              'businessOutcome': 'read_only_profile_canary_audit',
              'containerStatus': state['Status'],
              'health': (state.get('Health') or {}).get('Status'),
              'exitCode': state['ExitCode'],
              'imageId': item['Image'],
              'publishedPortCount': sum(
                  1 for value in (item['NetworkSettings'].get('Ports') or {}).values()
                  if value),
              'logSignals': log_signals,
              'logFieldPaths': log_fields,
              'mentionedConfigKeys': mentioned_config_keys,
              'logLineCount': len(log_text.splitlines()),
              'probe': report, 'productionWrites': 0}
    print(json.dumps(output))
except Exception as exc:
    print(json.dumps({'toolOutcome': 'failure',
                      'errorCode': type(exc).__name__}), file=sys.stderr)
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
                code = json.loads(error).get("errorCode", "PROFILE_CANARY_AUDIT_FAILED")
            except (ValueError, TypeError):
                code = "PROFILE_CANARY_AUDIT_FAILED"
            print(json.dumps({"toolOutcome": "failure", "errorCode": code}),
                  file=sys.stderr)
            raise SystemExit(2)
        print(body)
    finally:
        client.close()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    main()

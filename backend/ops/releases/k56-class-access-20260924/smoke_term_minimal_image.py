"""Thử module lọc Portal bên trong image K56 mới, không nối mạng hoặc đổi service."""

import json
import sys

import paramiko
import win32cred


IMAGE = "izone-k56-live-results:20260924.6-term-minimal-portal-rc"
IMAGE_ID = "sha256:81dcbf688730155737084b87bc2250851317d283aeb2519a4c47276012517608"
PRODUCTION = "izone-k56-ic2264-api"
BASE_IMAGE_ID = "sha256:5b1e9e7e65809673dd6c453750a0bebe99185a371e5cdd484298732ca4b4a956"

REMOTE_SCRIPT = r"""
# Dữ liệu vào: image ứng viên đã đóng dấu, dữ liệu Portal hoàn toàn giả.
# Việc chính: chạy module lọc trong container không có mạng, cổng hoặc ổ ghi.
# Kết quả: chỉ in số kiểm tra và trạng thái production image, không in hồ sơ.
# Khi lỗi: container tự gỡ; API production và database không bị đổi.
import json
import subprocess
import sys

image = 'izone-k56-live-results:20260924.6-term-minimal-portal-rc'
image_id = 'sha256:81dcbf688730155737084b87bc2250851317d283aeb2519a4c47276012517608'
production = 'izone-k56-ic2264-api'
base_image_id = 'sha256:5b1e9e7e65809673dd6c453750a0bebe99185a371e5cdd484298732ca4b4a956'

def output(args, error_code, input_text=None):
    result = subprocess.run(args, input=input_text, text=True, capture_output=True,
                            timeout=45, check=False)
    if result.returncode != 0:
        raise RuntimeError(error_code)
    return result.stdout.strip()

javascript = r'''
// Dữ liệu vào: phản hồi Portal giả có trường liên hệ và điểm của hai học viên.
// Việc chính: gọi đúng module đã đóng trong image với GET giả, không dùng mạng.
// Kết quả: chỉ ba cột/điểm của học viên đích; kiểm cả Term 1 và Term 2.
// Khi lỗi: dừng smoke test, không có tác động đến Portal thật.
import { readTermK56PortalSnapshot } from '/app/src/term-test-portal-snapshot.js';
import { createApp } from '/app/src/app.js';
const marker = 'DO_NOT_EXPOSE_PRIVATE_FIXTURE';
const portal = {
  class_tests: [
    { id: 11, name: 'Term Test 1 Listening', max_grade: 40 },
    { id: 12, name: 'Term Test 1 Reading', max_grade: 26 },
    { id: 13, name: 'Term Test 1 Writing', max_grade: 9 },
    { id: 21, name: 'Term Test 2 Listening', max_grade: 40 },
    { id: 22, name: 'Term Test 2 Reading', max_grade: 40 },
    { id: 23, name: 'Term Test 2 Writing', max_grade: 9 }
  ],
  student_test_grades: [
    { student_id: 9002, class_test_id: 11, grade: 20 },
    { student_id: 9002, class_test_id: 12, grade: 13 },
    { student_id: 9002, class_test_id: 13, grade: null },
    { student_id: 9002, class_test_id: 21, grade: 30 },
    { student_id: 9002, class_test_id: 22, grade: 25 },
    { student_id: 9002, class_test_id: 23, grade: 5 },
    { student_id: 9003, class_test_id: 13, grade: 9 }
  ],
  class_registrations: [{ contact: { email: marker }, teacher_feedback: marker }]
};
let calls = 0;
const fakeFetch = async (url, options) => {
  calls += 1;
  if (url !== 'https://gateway.izone.edu.vn/portal/v1/course-classes/99000001/student-tests'
      || options.method !== 'GET' || options.redirect !== 'error') {
    throw new Error('FIXED_PORTAL_URL_MISMATCH');
  }
  return new Response(JSON.stringify(portal), { status: 200 });
};
for (const [slug, ids] of [
  ['term-test-1-k56', [11, 12, 13]],
  ['term-test-2-k56', [21, 22, 23]]
]) {
  const snapshot = await readTermK56PortalSnapshot({
    classId: 99000001, studentId: 9002, testSlug: slug, fetchImpl: fakeFetch
  });
  if (JSON.stringify(snapshot.class_tests.map(row => row.id)) !== JSON.stringify(ids)
      || snapshot.student_test_grades.length !== 3
      || snapshot.student_test_grades.some(row => row.student_id !== 9002)
      || JSON.stringify(snapshot).includes(marker)) {
    throw new Error('SNAPSHOT_SCOPE_MISMATCH');
  }
}
if (calls !== 2) throw new Error('FETCH_COUNT_MISMATCH');
// Dữ liệu vào: hai request HTTP loopback và secret chỉ dùng cho fixture.
// Việc chính: xác nhận route chặn khách lạ, lọc Portal cho K56, không mở cho K67.
// Kết quả: bản image thật trả 401/200/404; không có HTTP ra ngoài container.
// Khi lỗi: đóng cổng loopback rồi để container tự gỡ.
const app = createApp({
  config: {
    nodeEnv: 'test', authMode: 'legacy', googleClientId: '',
    legacyReviewToken: '', allowedOrigins: new Set(), trustProxyHops: 0,
    deploymentProfileName: 'k56-ic2264', erpSyncSecret: 'fixture-secret'
  },
  pool: { async query() { throw new Error('DATABASE_MUST_NOT_BE_CALLED'); } },
  portalSnapshotFetchImpl: fakeFetch,
  logger: { info() {}, warn() {}, error() {} }
});
const server = app.listen(0, '127.0.0.1');
try {
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const path = '/api/term-tests/writing-grading/portal-snapshot'
    + '?classId=99000001&studentId=9002&testSlug=term-test-1-k56';
  if ((await fetch(base + path)).status !== 401) throw new Error('AUTH_MISSING');
  const response = await fetch(base + path, {
    headers: { 'x-term-test-sync': 'fixture-secret' }
  });
  const body = await response.json();
  if (response.status !== 200 || JSON.stringify(body).includes(marker)
      || body.student_test_grades.length !== 3) {
    throw new Error('HTTP_SNAPSHOT_MISMATCH');
  }
} finally {
  await new Promise(resolve => server.close(resolve));
}
const k67 = createApp({
  config: {
    nodeEnv: 'test', authMode: 'legacy', googleClientId: '',
    legacyReviewToken: '', allowedOrigins: new Set(), trustProxyHops: 0,
    deploymentProfileName: 'k67', erpSyncSecret: 'fixture-secret'
  },
  pool: { async query() { throw new Error('DATABASE_MUST_NOT_BE_CALLED'); } },
  portalSnapshotFetchImpl: fakeFetch,
  logger: { info() {}, warn() {}, error() {} }
});
const k67Server = k67.listen(0, '127.0.0.1');
try {
  await new Promise(resolve => k67Server.once('listening', resolve));
  const url = `http://127.0.0.1:${k67Server.address().port}`
    + '/api/term-tests/writing-grading/portal-snapshot';
  if ((await fetch(url)).status !== 404) throw new Error('K67_ROUTE_EXPOSED');
} finally {
  await new Promise(resolve => k67Server.close(resolve));
}
if (calls !== 3) throw new Error('HTTP_FETCH_COUNT_MISMATCH');
process.stdout.write(JSON.stringify({ toolOutcome: 'success', cases: 5,
  privateFieldExposed: false, networkUsed: false }) + '\n');
'''

try:
    if output(['docker', 'image', 'inspect', '--format', '{{.Id}}', image],
              'CANDIDATE_IMAGE_MISSING') != image_id:
        raise RuntimeError('CANDIDATE_IMAGE_CHANGED')
    if output(['docker', 'inspect', '--format', '{{.Image}}', production],
              'PRODUCTION_API_MISSING') != base_image_id:
        raise RuntimeError('PRODUCTION_API_CHANGED')
    result = output([
        'docker', 'run', '--rm', '-i', '--network', 'none', '--read-only',
        '--tmpfs', '/tmp:rw,size=16m', '--entrypoint', 'node', image,
        '--input-type=module', '-'
    ], 'ISOLATED_IMAGE_SMOKE_FAILED', javascript)
    report = json.loads(result)
    if report != {'toolOutcome': 'success', 'cases': 5,
                  'privateFieldExposed': False, 'networkUsed': False}:
        raise RuntimeError('ISOLATED_IMAGE_SMOKE_MISMATCH')
    if output(['docker', 'inspect', '--format', '{{.Image}}', production],
              'PRODUCTION_API_READBACK_FAILED') != base_image_id:
        raise RuntimeError('PRODUCTION_API_CHANGED_DURING_SMOKE')
    print(json.dumps({'toolOutcome': 'success', 'businessOutcome': 'isolated_image_smoke',
                      'cases': 5, 'productionApiChanged': False,
                      'networkEnabled': False, 'publicPortPublished': False}))
except Exception as exc:
    code = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
    print(json.dumps({'toolOutcome': 'failure', 'errorCode': code}), file=sys.stderr)
    raise SystemExit(2)
"""


def main():
    """Dùng credential cục bộ; chỉ trả kết quả tổng hợp, không log secret."""
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
        stdin, stdout, stderr = client.exec_command("python3 -", timeout=120)
        stdin.write(REMOTE_SCRIPT)
        stdin.channel.shutdown_write()
        body = stdout.read().decode("utf-8").strip()
        error = stderr.read().decode("utf-8").strip()
        if stdout.channel.recv_exit_status() != 0:
            try:
                code = json.loads(error).get("errorCode", "ISOLATED_IMAGE_SMOKE_FAILED")
            except (ValueError, TypeError):
                code = "ISOLATED_IMAGE_SMOKE_FAILED"
            print(json.dumps({"toolOutcome": "failure", "errorCode": code}),
                  file=sys.stderr)
            raise SystemExit(2)
        report = json.loads(body)
        if report.get("businessOutcome") != "isolated_image_smoke":
            raise RuntimeError("ISOLATED_IMAGE_SMOKE_READBACK_INVALID")
        print(json.dumps(report))
    finally:
        client.close()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    main()

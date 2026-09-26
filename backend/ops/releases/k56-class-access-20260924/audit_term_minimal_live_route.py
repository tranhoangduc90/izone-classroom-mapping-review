"""Đọc lại route K56 production với điểm Portal thật; không in định danh."""

import json
import sys

import paramiko
import win32cred


REMOTE_SCRIPT = r"""
# Dữ liệu vào: một lớp K56 đã có điểm Term 1/2 trên Portal và secret API trong RAM.
# Việc chính: chọn đúng một học viên đủ sáu cột, gọi route K56 cho từng Term,
# so cột/điểm với nguồn và kiểm phản hồi chỉ có trường tối thiểu.
# Kết quả: chỉ in số cột/điểm và cờ khớp, không in ID, điểm hoặc dữ liệu cá nhân.
# Khi lỗi: in mã bước an toàn, không ghi Portal hoặc database.
import json
import subprocess
import sys
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

class_id = 1164
max_bytes = 4 * 1024 * 1024
stage = 'start'

def get_json(url, headers=None):
    request = Request(url, headers=headers or {'Accept': 'application/json'})
    try:
        with urlopen(request, timeout=12) as response:
            raw = response.read(max_bytes + 1)
            if response.status != 200 or len(raw) > max_bytes:
                raise RuntimeError('HTTP_SIZE_OR_STATUS')
            return json.loads(raw)
    except HTTPError as exc:
        raise RuntimeError(f'HTTP_NOT_OK_{exc.code}') from None

try:
    stage = 'image'
    image = subprocess.run(['docker', 'inspect', '--format', '{{.Image}}',
                            'izone-k56-ic2264-api'], text=True,
                           capture_output=True, timeout=10, check=False)
    if (image.returncode != 0 or image.stdout.strip() !=
            'sha256:81dcbf688730155737084b87bc2250851317d283aeb2519a4c47276012517608'):
        raise RuntimeError('IMAGE_CHANGED')
    stage = 'secret'
    command = ['docker', 'inspect', '--format', '{{json .Config.Env}}',
               'izone-k56-ic2264-api']
    env_result = subprocess.run(command, text=True, capture_output=True,
                                timeout=10, check=False)
    if env_result.returncode != 0:
        raise RuntimeError('ENV_UNAVAILABLE')
    environment = {item.split('=', 1)[0]: item.split('=', 1)[1]
                   for item in json.loads(env_result.stdout) if '=' in item}
    secret = environment.get('ERP_SYNC_SECRET', '')
    if len(secret) < 16:
        raise RuntimeError('SYNC_SECRET_UNAVAILABLE')

    stage = 'portal'
    source = get_json('https://gateway.izone.edu.vn/portal/v1/course-classes/'
                      + str(class_id) + '/student-tests')
    columns = {}
    for term in (1, 2):
        names = [f'Term Test {term} {skill}'
                 for skill in ('Listening', 'Reading', 'Writing')]
        matches = [[row for row in source.get('class_tests', [])
                    if row.get('name') == name] for name in names]
        if any(len(items) != 1 for items in matches):
            raise RuntimeError('PORTAL_COLUMNS_AMBIGUOUS')
        columns[term] = [items[0] for items in matches]
    ids = {int(row['id']) for rows in columns.values() for row in rows}
    by_student = {}
    for row in source.get('student_test_grades', []):
        student = row.get('student_id')
        column = row.get('class_test_id')
        if (isinstance(student, int) and isinstance(column, int)
                and column in ids and isinstance(row.get('grade'), (int, float))):
            by_student.setdefault(student, {})[column] = row['grade']
    student_id = next((student for student, grades in sorted(by_student.items())
                       if ids.issubset(grades)), None)
    if student_id is None:
        raise RuntimeError('COMPLETE_TERM_GRADES_MISSING')

    stage = 'k56_route'
    results = []
    for term in (1, 2):
        query = urlencode({'classId': class_id, 'studentId': student_id,
                           'testSlug': f'term-test-{term}-k56'})
        body = get_json('http://127.0.0.1:8795/api/term-tests/writing-grading/'
                        + 'portal-snapshot?' + query,
                        {'Accept': 'application/json', 'x-term-test-sync': secret})
        if set(body) != {'class_tests', 'student_test_grades'}:
            raise RuntimeError('EXTRA_TOP_LEVEL_FIELDS')
        expected_columns = columns[term]
        returned_columns = body['class_tests']
        returned_grades = body['student_test_grades']
        if (len(returned_columns) != 3 or len(returned_grades) != 3
                or [row.get('id') for row in returned_columns] !=
                   [row.get('id') for row in expected_columns]):
            raise RuntimeError('WRONG_TERM_OR_STUDENT')
        for row in returned_columns:
            if set(row) != {'id', 'name', 'max_grade'}:
                raise RuntimeError('EXTRA_COLUMN_FIELDS')
        for row in returned_grades:
            column = row.get('class_test_id')
            if (row.get('student_id') != student_id
                    or row.get('grade') != by_student[student_id].get(column)
                    or not set(row).issubset({'student_id', 'class_test_id',
                                              'grade', 'meta'})):
                raise RuntimeError('GRADE_MISMATCH_OR_EXTRA_FIELDS')
            if row.get('meta') is not None:
                records = row['meta'].get('records')
                if (not isinstance(records, list) or len(records) != 1
                        or set(records[0]) != {'id'}):
                    raise RuntimeError('EXTRA_META_FIELDS')
        results.append({'term': term, 'columns': len(returned_columns),
                        'gradeRows': len(returned_grades), 'matched': True})
    print(json.dumps({'toolOutcome': 'success',
                      'businessOutcome': 'live_minimal_route_verified',
                      'results': results, 'personalFieldsEmitted': False,
                      'productionWrites': 0}))
except Exception as exc:
    code = str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__
    print(json.dumps({'toolOutcome': 'failure', 'stage': stage,
                      'errorCode': code, 'productionWrites': 0}), file=sys.stderr)
    raise SystemExit(2)
"""


def main():
    """Dùng quyền SSH sẵn có và giữ mọi định danh/secret ngoài stdout."""
    credential = win32cred.CredRead('Codex/SSH/vps_1', win32cred.CRED_TYPE_GENERIC, 0)
    username = ((credential.get('UserName') or 'root').strip().split('@', 1)[0]
                or 'root')
    password = credential['CredentialBlob'].decode('utf-16-le')
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    client.connect('ducizone.ddns.net', port=22, username=username,
                   password=password, timeout=15, auth_timeout=15)
    try:
        stdin, stdout, stderr = client.exec_command('python3 -', timeout=90)
        stdin.write(REMOTE_SCRIPT)
        stdin.channel.shutdown_write()
        body = stdout.read().decode('utf-8').strip()
        error = stderr.read().decode('utf-8').strip()
        if stdout.channel.recv_exit_status() != 0:
            try:
                report = json.loads(error)
            except (ValueError, TypeError):
                report = {'toolOutcome': 'failure', 'errorCode': 'REMOTE_FAILED'}
            print(json.dumps(report), file=sys.stderr)
            raise SystemExit(2)
        report = json.loads(body)
        if report.get('businessOutcome') != 'live_minimal_route_verified':
            raise RuntimeError('READBACK_OUTCOME_MISMATCH')
        print(json.dumps(report))
    finally:
        client.close()


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
    main()

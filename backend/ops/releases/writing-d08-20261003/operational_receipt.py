"""Đọc bằng chứng vận hành đã khóa bằng hash; không gọi mạng hoặc ghi hệ thống.
Đối chiếu gói, lần phát hành, thời gian và file nguồn. Thiếu/sai dữ liệu trả lỗi.
"""
import datetime
import hashlib
import json
import re
from pathlib import Path


def need(value, code):
    if not value:
        raise ValueError(code)


def time(value):
    need(isinstance(value, str) and re.search(r'(Z|[+-]\d\d:\d\d)$', value), 'operational_time_offset')
    try:
        return datetime.datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(datetime.timezone.utc)
    except ValueError as error:
        raise ValueError('operational_time_invalid') from error


def fresh(value):
    at = time(value)
    age = datetime.datetime.now(datetime.timezone.utc) - at
    need(datetime.timedelta(0) <= age <= datetime.timedelta(hours=24), 'operational_time_stale_or_future')
    return at


def raw(root, reference):
    filename = reference.get('path')
    need(isinstance(filename, str) and filename and not Path(filename).is_absolute()
         and '..' not in Path(filename).parts, 'operational_artifact_path')
    root = Path(root).resolve()
    path = root / filename
    need(path.is_file() and path.resolve().is_relative_to(root)
         and all(not parent.is_symlink() for parent in (path, *path.parents) if parent != root),
         'operational_artifact_missing_or_link')
    content = path.read_bytes()
    need(hashlib.sha256(content).hexdigest() == reference.get('sha256'), 'operational_artifact_hash')
    return content


def read(root, reference):
    return json.loads(raw(root, reference).decode('utf-8'))


def context(item, config, snapshots, root, role):
    need(item.get('schema') == 'd08-' + role.replace('_', '-') + '/v1'
         and item.get('status') == 'passed', role + '_schema')
    need(item.get('product_revision') == config['product_revision']
         and item.get('release_run_id') == config['run_id']
         and item.get('snapshots') == snapshots, role + '_binding')
    fresh(item['captured_at'])
    contract = config.get('operational_contract', {}).get(role)
    need(isinstance(contract, dict), role + '_contract_missing')
    refs = item.get('artifacts', {})
    need(isinstance(refs, dict) and {'before', 'after'}.issubset(refs), role + '_artifacts_missing')
    need(refs['before']['sha256'] == contract.get('before_sha256'), role + '_baseline_hash')
    before, after = (read(root, refs[key]) for key in ('before', 'after'))
    started = time(config['release_started_at'])
    need(fresh(before['captured_at']) <= started <= fresh(after['captured_at'])
         <= time(item['captured_at']), role + '_observation_window')
    return contract, refs, before, after


def hashes(value):
    return isinstance(value, dict) and bool(value) and all(
        isinstance(k, str) and re.fullmatch('[0-9a-f]{64}', v or '') for k, v in value.items())


def workflow_equal(before, after):
    # Bản lấy qua API phải giữ nguyên phiên bản và mọi phần ảnh hưởng thực thi.
    keys = ('id', 'versionId', 'active', 'nodes', 'connections', 'settings')
    need(all(key in before and key in after for key in keys), 'operational_workflow_fields')
    need(all(before[key] == after[key] for key in keys), 'operational_workflow_changed')


def execution_source(workflow, snapshot):
    # n8n thêm giá trị mặc định khi lưu execution; chỉ nhận đúng những mặc định đã kiểm.
    defaults = {'multipleMethods': False, 'authentication': 'none', 'mode': 'runOnceForAllItems',
                'language': 'javaScript', 'curlImport': '', 'provideSslCertificates': False,
                'sendQuery': False, 'sendHeaders': False, 'sendBody': False,
                'looseTypeValidation': False, 'contentType': 'json'}
    notices = {'notice', 'webhookNotice', 'infoMessage', 'generalNotice'}
    need(snapshot['id'] == workflow['id'] and snapshot['connections'] == workflow['connections']
         and snapshot['settings'] == workflow['settings'], 'operational_execution_source')
    need(len(snapshot['nodes']) == len(workflow['nodes']), 'operational_execution_nodes')
    for current, saved in zip(snapshot['nodes'], workflow['nodes']):
        need({k: v for k, v in current.items() if k != 'parameters'} ==
             {k: v for k, v in saved.items() if k != 'parameters'}, 'operational_execution_node_identity')
        need(all(current['parameters'].get(k) == v for k, v in saved['parameters'].items()),
             'operational_execution_parameters')
        for key, value in current['parameters'].items():
            if key not in saved['parameters'] and key not in notices:
                need(key in defaults and value == defaults[key], 'operational_execution_unknown_default')

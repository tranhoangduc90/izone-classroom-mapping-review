"""Kiểm bảo toàn cấu hình điểm danh và execution Portal chỉ đọc, không ghi điểm danh.
Nhận snapshot đúng API/database trước/sau cùng phản hồi Portal và execution thô.
Không suy job hoàn tất thành Portal đã ghi và không chứng nhận job mới từ preview cũ.
"""
from operational_receipt import context, execution_source, hashes, need, read, time, workflow_equal

ENV = {'LEARNING_ENABLED', 'LEARNING_DATABASE_URL', 'LEARNING_ATTENDANCE_SYNC_URL', 'ERP_SYNC_SECRET'}
TARGETS = ('mapping-review-api', 'izone-k56-ic2264-api', 'izone-k56-demo-k56-demo-api-1')
IDENTITY = ('entityKey', 'unitKey', 'operationKey', 'idempotencyKey', 'classId', 'studentId', 'sessionNumber')


def validate(item, config, snapshots, root):
    contract, refs, before, after = context(item, config, snapshots, root, 'attendance_preservation')
    need(set(refs) == {'before', 'after', 'request', 'response', 'execution'}, 'attendance_artifact_set')
    need(tuple(t['name'] for t in before['targets']) == tuple(t['name'] for t in after['targets']) == TARGETS,
         'attendance_target_set')
    images = contract['candidate_images']
    for old, new in zip(before['targets'], after['targets']):
        name = new['name']
        need(new['image'] == images[name] and new['running'] is True and new['health'] == 'healthy'
             and new['restart_count'] == 0, 'attendance_target_runtime')
        need(set(old['attendance_environment']) == set(new['attendance_environment']) == ENV
             and old['attendance_environment'] == new['attendance_environment'], 'attendance_environment_changed')
        need(old['learning_enabled'] == new['learning_enabled'] == (name == TARGETS[0]), 'attendance_enabled_profile')
        need(old['observation']['database'] == new['observation']['database'] ==
             ('izone_mapping_demo' if name == TARGETS[2] else 'mapping_db')
             and new['observation']['read_only'] == 'on'
             and old['observation']['role'] == new['observation']['role'], 'attendance_database_destination')
        need(old['worker_sources'] == new['worker_sources'] and hashes(new['worker_sources'])
             and new['worker_sources'] == contract['worker_sources'][name], 'attendance_worker_changed')
        if name == TARGETS[0]:
            need(all(v['present'] is True for v in new['attendance_environment'].values()), 'attendance_config_missing')
            queue = new['observation']['queue']
            old_queue = old['observation']['queue']
            states = ('queued', 'processing', 'retry_wait', 'failed', 'complete', 'review_required')
            need(all(type(queue[k]) is int and queue[k] >= 0 for k in (*states, 'total', 'unknown_statuses'))
                 and sum(queue[k] for k in states) == queue['total'] and queue['unknown_statuses'] == 0
                 and queue['failed'] <= old_queue['failed'] and queue['complete'] >= old_queue['complete'],
                 'attendance_queue_counts_incomplete_or_regressed')
            need(queue['job_type'] == 'sync_portal_attendance'
                 and type(queue['expired_leases']) is int and queue['expired_leases'] == 0
                 and type(queue['review_required']) is int
                 and queue['review_required'] <= old_queue['review_required'], 'attendance_queue_unhealthy')
    workflow_equal(before['workflow'], after['workflow'])
    workflow = after['workflow']
    need(workflow['id'] == 'gnk0f2qZlKr1mIES' and workflow['active'] is True, 'attendance_workflow_destination')
    body = read(root, refs['request'])['packet']['preview']['body']
    response = read(root, refs['response'])
    execution = read(root, refs['execution'])
    need(body['commit'] is False and response['httpStatus'] == 200 and response['commit'] is False,
         'attendance_readonly_request')
    need(execution['workflowId'] == workflow['id'] and execution['finished'] is True
         and execution['status'] == 'success', 'attendance_execution_not_success')
    need(time(config['release_started_at']) <= time(execution['startedAt'])
         <= time(execution['stoppedAt']) <= time(after['captured_at']), 'attendance_preview_window')
    execution_source(workflow, execution['workflowData'])
    runs = execution['data']['resultData']['runData']
    need('Ghi có mặt vào Portal' not in runs and 'Đọc lại sau khi ghi' not in runs,
         'attendance_preview_executed_write')
    def first(name):
        entries = runs[name]
        need(len(entries) == 1 and entries[0].get('error') is None, 'attendance_execution_node_error')
        rows = entries[0]['data']['main'][0]
        need(len(rows) == 1, 'attendance_execution_duplicate_identity')
        return rows[0]['json']
    need(first('Nhận yêu cầu điểm danh')['body'] == body, 'attendance_execution_payload')
    decision, returned = first('Chọn đúng buổi và quyết định'), first('Trả kết quả cho Progress Log')
    need(decision['needsWrite'] is False and decision['status'] in ('preview', 'already_present', 'conflict')
         and returned['status'] == decision['status'] and response['response'] == returned,
         'attendance_preview_outcome')
    need(all(returned[key] == body[key] for key in IDENTITY), 'attendance_identity_changed')
    # GET phải thực sự chạy; trạng thái conflict vẫn là bằng chứng đọc, không phải ghi thành công.
    first('Đọc trạng thái lớp trên Portal')
    return {'status': 'passed', 'scope': 'configuration_worker_and_existing_identity_read_preserved',
            'portal_read_outcome': returned['status'], 'new_attendance_job_verified': False,
            'portal_write_nodes_executed': 0}

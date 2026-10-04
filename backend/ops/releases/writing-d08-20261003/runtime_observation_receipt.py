"""Kiểm nhiều lần đọc trạng thái sau phát hành, không coi một HTTP200 là vận hành đạt.
Nhận image/config/source/activity và log lỗi theo cửa sổ; thiếu/khác đích trả lỗi.
"""
import hashlib
import json
import re
from pathlib import Path
from operational_receipt import context, hashes, need, raw, time


def log_errors(content, start, end):
    # Docker --timestamps cung cấp thời điểm từng dòng. Dòng không đọc được là unknown.
    errors = 0
    for line in content.decode('utf-8').splitlines():
        if not line.strip():
            continue
        parts = line.split(' ', 1)
        need(len(parts) == 2, 'runtime_log_timestamp_missing')
        at = time(parts[0])
        need(start <= at <= end, 'runtime_log_outside_window')
        message = parts[1]
        try:
            parsed = json.loads(message)
        except ValueError:
            parsed = None
        if isinstance(parsed, dict):
            level = parsed.get('level')
            if level in ('error', 'fatal', 50, 60) or parsed.get('err') or parsed.get('error'):
                errors += 1
        elif re.search(r'\b(error|fatal|panic|exception|unhandled)\b', message, re.I):
            errors += 1
    return errors


def validate(item, config, snapshots, root):
    contract, refs, before, after = context(item, config, snapshots, root, 'runtime_observation')
    need(set(refs) == {'before', 'after'}, 'runtime_artifact_set')
    observations = after['observations']
    need(len(observations) >= 3, 'runtime_observation_count')
    names = contract['target_names']
    baseline = {row['name']: row for row in before['targets']}
    need(len(baseline) == len(names) == 3 and set(baseline) == set(names), 'runtime_baseline_targets')
    started = time(config['release_started_at'])
    prior = started
    for observation in observations:
        at = time(observation['captured_at'])
        need(prior <= at <= time(after['captured_at']), 'runtime_observation_time_order')
        prior = at
        rows = observation['targets']
        need(len(rows) == 3 and [row['name'] for row in rows] == names, 'runtime_target_set')
        for row in rows:
            name = row['name']
            need(row['image'] == contract['candidate_images'][name] and row['running'] is True
                 and row['healthy'] == 'healthy' and row['restart_count'] == 0
                 and row['oom_killed'] is False, 'runtime_image_or_health')
            need(row['config_hash'] == baseline[name]['config_hash']
                 and hashes(row['source_hashes']) and row['source_hashes'] == contract['source_hashes'][name],
                 'runtime_config_or_source_changed')
            activity = row['activity']
            need(set(activity) == {'listening', 'reading', 'writing'}
                 and all(type(v) is int and v >= 0 for v in activity.values()), 'runtime_activity_invalid')
            log = row['log_window']
            need(time(log['start']) == started and time(log['end']) == at
                 and log['truncated'] is False and type(log['error_count']) is int
                 and log['error_count'] == 0 and log['transport_exit_code'] == 0
                 and log['parser_sha256'] == contract['log_parser_sha256'], 'runtime_error_or_unread_log')
            need(log['parser_sha256'] == hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                 'runtime_log_parser_changed')
            need(log_errors(raw(root, log['artifact']), started, at) == log['error_count'],
                 'runtime_log_error_count_mismatch')
    need((time(observations[-1]['captured_at']) - time(observations[0]['captured_at'])).total_seconds()
         >= contract['minimum_observation_seconds'] >= 60, 'runtime_window_too_short')
    return {'status': 'passed', 'observations_checked': len(observations),
            'scope': 'runtime_preservation_and_errors; API_browser_user_outcome_checked_separately'}

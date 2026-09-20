#!/usr/bin/env bash
set -euo pipefail

release_dir='/opt/izone-dashboard-access-hardening-20260920/backend/ops/releases/dashboard-access-hardening-20260920'
service_name='izone-teacher-dashboard-health.service'
timer_name='izone-teacher-dashboard-health.timer'
test -x "$release_dir/run-teacher-dashboard-health.sh"
install -m 0644 "$release_dir/$service_name" "/etc/systemd/system/$service_name"
install -m 0644 "$release_dir/$timer_name" "/etc/systemd/system/$timer_name"
systemctl daemon-reload
systemctl enable --now "$timer_name"
systemctl start "$service_name"
systemctl is-active "$timer_name"
systemctl is-enabled "$timer_name"
systemctl show "$timer_name" -p NextElapseUSecRealtime --value
jq -e '.access.outcome != "critical" and .canary.outcome == "healthy"' \
  /var/lib/izone-teacher-dashboard-health/latest.json >/dev/null

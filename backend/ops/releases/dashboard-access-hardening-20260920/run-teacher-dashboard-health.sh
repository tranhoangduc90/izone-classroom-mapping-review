#!/usr/bin/env bash
set -euo pipefail

# Dữ liệu nhận vào: hai bảng quyền, metadata sync và hai lớp demo canary.
# Việc chính: chỉ bổ sung cặp phân công bị thiếu, kiểm độ mới, rồi chạy chuỗi API thật.
# Kết quả: ghi một JSON chỉ có số đếm/trạng thái; không ghi email, cookie hay dữ liệu học viên.
# Khi lỗi: trả exit khác 0 để systemd và lịch giám sát phát hiện ngay.

state_dir='/var/lib/izone-teacher-dashboard-health'
state_file="$state_dir/latest.json"
temporary_file="$state_file.new"
install -d -m 0750 "$state_dir"

reconciled="$(docker exec -i mapping-postgres sh -lc 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At' <<'SQL'
WITH inserted AS (
  INSERT INTO mapping.reviewer_class_access (reviewer_email, erp_course_class_id)
  SELECT DISTINCT assignment.reviewer_email, course.erp_course_class_id
  FROM mapping.reviewer_class_assignment AS assignment
  JOIN mapping.reviewer_account AS reviewer
    ON reviewer.email = assignment.reviewer_email
   AND reviewer.status = 'active'
  JOIN mapping.classroom_course_mapping AS course
    ON upper(trim(course.erp_class_name_snapshot)) = upper(trim(assignment.class_name))
  ON CONFLICT (reviewer_email, erp_course_class_id) DO NOTHING
  RETURNING 1
)
SELECT count(*)::int FROM inserted;
SQL
)"

access_json="$(docker exec mapping-review-api node scripts/check-teacher-class-access.mjs --freshness-hours=36)"
canary_json="$(docker exec mapping-review-api node scripts/teacher-dashboard-canary.mjs)"

jq -cn \
  --argjson reconciled "$reconciled" \
  --argjson access "$access_json" \
  --argjson canary "$canary_json" \
  '{schemaVersion:1, checkedAt:(now|todateiso8601), reconciledPairs:$reconciled, access:$access, canary:$canary}' \
  > "$temporary_file"
chmod 0640 "$temporary_file"
mv -f "$temporary_file" "$state_file"
jq -c '{outcome:(if .access.outcome=="critical" or .canary.outcome!="healthy" then "critical" else .access.outcome end),checkedAt,reconciledPairs,accessReasons:.access.criticalReasons,canaryOutcome:.canary.outcome}' "$state_file"
jq -e '.access.outcome != "critical" and .canary.outcome == "healthy"' "$state_file" >/dev/null

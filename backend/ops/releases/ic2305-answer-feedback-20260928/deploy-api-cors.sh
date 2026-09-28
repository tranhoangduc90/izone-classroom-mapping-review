#!/usr/bin/env bash
# Dữ liệu nhận vào: image hotfix, ID image và container API đang chạy.
# Việc chính: giữ bản v6 làm điểm quay lui rồi chuyển sang bản sửa CORS.
# Kết quả: API khỏe, đích điểm danh giữ nguyên và trình duyệt lưu nháp được.
# Khi lỗi: tự khôi phục bản v6 và báo lỗi.
set -Eeuo pipefail

mode=${1:-}
expected_image_id=${2:-}
if [[ "$mode" != '--check' && "$mode" != '--deploy' ]] || [[ ! "$expected_image_id" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  printf 'usage: deploy-api-cors.sh --check|--deploy sha256:<image-id>\n' >&2
  exit 2
fi

name='mapping-review-api'
backup='mapping-review-api-before-ic2305-cors-20260928'
old_image='izone-term-test-backend:20260928.6-ic2305-answer-feedback'
new_image='izone-term-test-backend:20260928.7-ic2305-answer-feedback-cors'
private='/opt/mapping-review-api/speaking-private'
stopped=0
renamed=0

rollback() {
  local code=$?
  trap - ERR
  if (( renamed )); then
    docker rm -f "$name" >/dev/null 2>&1 || true
    docker rename "$backup" "$name"
    docker update --restart=unless-stopped "$name" >/dev/null
    docker start "$name" >/dev/null
  elif (( stopped )); then
    docker start "$name" >/dev/null
  fi
  printf 'answer_feedback_cors_deploy_failed_rollback_attempted exit=%s\n' "$code" >&2
  exit "$code"
}
trap rollback ERR

test "$(docker inspect "$name" --format '{{.Config.Image}}')" = "$old_image"
test "$(docker inspect "$name" --format '{{.State.Health.Status}}')" = healthy
test "$(docker inspect "$name" --format '{{.Image}}')" = 'sha256:92627f3c7c07972efdba1b82f043df3f815df013b3084ee0127426114fdadc5f'
test "$(docker image inspect "$new_image" --format '{{.Id}}')" = "$expected_image_id"
if docker container inspect "$backup" >/dev/null 2>&1; then
  printf 'backup_name_already_exists\n' >&2
  exit 2
fi
test -f "$private/speaking.env"
test -f "$private/attendance.env"
test "$(stat -c %a "$private/speaking.env")" = 600
test "$(stat -c %a "$private/attendance.env")" = 600
docker exec "$name" sh -c 'test -n "$LEARNING_ENABLED" && test -n "$LEARNING_DATABASE_URL" && test -n "$LEARNING_ATTENDANCE_SYNC_URL" && test -n "$ERP_SYNC_SECRET"'
attendance_hash=$(docker exec "$name" sh -c 'printf %s "$LEARNING_ATTENDANCE_SYNC_URL" | sha256sum | cut -d " " -f 1')
docker exec "$name" sh -c "grep -q 'startLearningAttendanceWorker' /app/src/server.js"
if [[ "$mode" == '--check' ]]; then
  printf 'answer_feedback_cors_deploy_check_passed image=%s attendance_target_present=true\n' "$new_image"
  trap - ERR
  exit 0
fi

docker stop --time 15 "$name" >/dev/null
stopped=1
docker rename "$name" "$backup"
renamed=1
docker update --restart=no "$backup" >/dev/null

docker run -d \
  --name "$name" --network mapping-api-net \
  -p 127.0.0.1:8788:8788 --restart unless-stopped \
  --memory 256m --cpus 0.5 --pids-limit 100 \
  --read-only --tmpfs /tmp:size=16m,noexec,nosuid,nodev \
  --cap-drop ALL --security-opt no-new-privileges --init \
  --log-driver json-file --log-opt max-file=3 --log-opt max-size=10m \
  --stop-timeout 15 \
  --mount type=bind,src=/opt/mapping-review-api/private-assets,dst=/app/private-assets,readonly \
  --env-file <(docker inspect "$backup" --format '{{range .Config.Env}}{{println .}}{{end}}') \
  --env-file "$private/speaking.env" \
  --env-file "$private/attendance.env" \
  "$new_image" >/dev/null

for attempt in $(seq 1 30); do
  if test "$(docker inspect "$name" --format '{{.State.Health.Status}}')" = healthy; then
    docker exec "$name" sh -c 'test -n "$LEARNING_DATABASE_URL" && test -n "$LEARNING_ATTENDANCE_SYNC_URL" && test -n "$ERP_SYNC_SECRET"'
    test "$(docker exec "$name" sh -c 'printf %s "$LEARNING_ATTENDANCE_SYNC_URL" | sha256sum | cut -d " " -f 1')" = "$attendance_hash"
    docker exec "$name" sh -c "grep -q 'startLearningAttendanceWorker' /app/src/server.js"
    printf 'answer_feedback_cors_deploy_healthy image=%s attempt=%s attendance_target_preserved=true\n' "$new_image" "$attempt"
    trap - ERR
    exit 0
  fi
  sleep 2
done
false

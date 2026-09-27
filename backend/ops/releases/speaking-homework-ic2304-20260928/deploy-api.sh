#!/usr/bin/env bash
# Dữ liệu vào: image đã qua canary, container API hiện tại và hai file env riêng tư.
# Việc chính: giữ container cũ, chuyển cổng 8788 sang image mới có Speaking và worker điểm danh.
# Kết quả: API khỏe, đủ cấu hình; khi lỗi thì tự khởi động lại container cũ.
set -Eeuo pipefail

name='mapping-review-api'
backup='mapping-review-api-before-speaking-20260928'
old_image='izone-term-test-backend:20260925.4-learning-contract-compat'
new_image='izone-term-test-backend:20260928.3-speaking-attendance-ic2304'
private='/opt/mapping-review-api/speaking-private'
stopped=0
renamed=0

rollback() {
  local result=$?
  trap - ERR
  if (( renamed )); then
    if docker container inspect "$name" >/dev/null 2>&1; then
      docker rm -f "$name" >/dev/null || true
    fi
    docker rename "$backup" "$name"
    docker update --restart=unless-stopped "$name" >/dev/null
    docker start "$name" >/dev/null
  elif (( stopped )); then
    docker start "$name" >/dev/null
  fi
  printf 'api_deploy_failed_rollback_attempted exit=%s\n' "$result" >&2
  exit "$result"
}
trap rollback ERR

test "$(docker inspect "$name" --format '{{.Config.Image}}')" = "$old_image"
test "$(docker inspect "$name" --format '{{.State.Health.Status}}')" = healthy
if docker container inspect "$backup" >/dev/null 2>&1; then
  printf 'backup_name_already_exists\n' >&2
  exit 2
fi
docker image inspect "$new_image" >/dev/null
test -f "$private/speaking.env"
test -f "$private/attendance.env"
test "$(stat -c %a "$private/speaking.env")" = 600
test "$(stat -c %a "$private/attendance.env")" = 600
test "$(docker inspect "$name" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -c '^LEARNING_DATABASE_URL=')" = 1
test "$(docker inspect "$name" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -c '^ERP_SYNC_SECRET=')" = 1

docker stop --time 15 "$name" >/dev/null
stopped=1
docker rename "$name" "$backup"
renamed=1
docker update --restart=no "$backup" >/dev/null

# Mượn env của bản live, thêm cấu hình Speaking và khôi phục đích điểm danh đã kiểm.
docker run -d \
  --name "$name" \
  --network mapping-api-net \
  -p 127.0.0.1:8788:8788 \
  --restart unless-stopped \
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
    docker exec "$name" sh -c 'test -n "$LEARNING_ATTENDANCE_SYNC_URL" && test -n "$SPEAKING_HOMEWORK_DATABASE_URL"'
    docker exec "$name" sh -c "grep -q 'startLearningAttendanceWorker' /app/src/server.js"
    printf 'api_deploy_healthy image=%s attempt=%s\n' "$new_image" "$attempt"
    trap - ERR
    exit 0
  fi
  sleep 2
done
false

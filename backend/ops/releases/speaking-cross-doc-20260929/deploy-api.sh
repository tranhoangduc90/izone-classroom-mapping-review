#!/usr/bin/env bash
# Đầu vào: image Speaking đã build, API khỏe và cấu hình điểm danh hiện hành.
# Việc chính: giữ container cũ để quay lại rồi chuyển sang image chỉ sửa Speaking.
# Kết quả: API mới khỏe hoặc khôi phục bản cũ; xem health và stdout khi lỗi.
set -Eeuo pipefail

name='mapping-review-api'
backup='mapping-review-api-before-speaking-cross-doc-20260929'
old_image='izone-term-test-backend:20260928.speaking-cta-white-v1'
new_image='izone-term-test-backend:20260929.speaking-cross-doc-v1'
expected_module='8b523d92aff3a5ae99be1730864aabe3f875e35a4328d4fbe80bae6d5777b06b'
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
  printf 'speaking_cross_doc_deploy_failed_rollback_attempted exit=%s\n' "$code" >&2
  exit "$code"
}
trap rollback ERR

test "$(docker inspect "$name" --format '{{.Config.Image}}')" = "$old_image"
test "$(docker inspect "$name" --format '{{.State.Health.Status}}')" = healthy
if docker container inspect "$backup" >/dev/null 2>&1; then
  printf 'backup_name_already_exists\n' >&2
  exit 2
fi
docker image inspect "$new_image" >/dev/null
test "$(docker run --rm --entrypoint sha256sum "$new_image" /app/src/speaking-homework.js | cut -d' ' -f1)" = "$expected_module"
docker exec "$name" sh -c 'test -n "$LEARNING_ATTENDANCE_SYNC_URL" && test -n "$SPEAKING_HOMEWORK_DATABASE_URL"'

docker stop --time 15 "$name" >/dev/null
stopped=1
docker rename "$name" "$backup"
renamed=1
docker update --restart=no "$backup" >/dev/null

# Đầu vào là toàn bộ env hiệu lực của container vừa sao lưu; không in giá trị ra log.
# Giữ mạng, cổng, mount và giới hạn tài nguyên của bản đang chạy.
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
  "$new_image" >/dev/null

for attempt in $(seq 1 30); do
  if test "$(docker inspect "$name" --format '{{.State.Health.Status}}')" = healthy; then
    docker exec "$name" sh -c 'test -n "$LEARNING_ATTENDANCE_SYNC_URL" && test -n "$SPEAKING_HOMEWORK_DATABASE_URL"'
    docker exec "$name" sh -c "grep -q 'startLearningAttendanceWorker' /app/src/server.js"
    test "$(docker exec "$name" sha256sum /app/src/speaking-homework.js | cut -d' ' -f1)" = "$expected_module"
    printf 'speaking_cross_doc_deploy_healthy image=%s attempt=%s\n' "$new_image" "$attempt"
    trap - ERR
    exit 0
  fi
  sleep 2
done
false

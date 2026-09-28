#!/usr/bin/env bash
# Đầu vào: image mới đã build từ đúng image Speaking đang chạy.
# Việc chính: giữ container cũ và toàn bộ cấu hình điểm danh rồi chuyển API.
# Kết quả: API mới khỏe, hoặc tự khôi phục container cũ khi chuyển lỗi.
set -Eeuo pipefail

mode=${1:-}
if [[ "$mode" != '--check' && "$mode" != '--deploy' ]]; then
  printf 'usage: deploy-api.sh --check|--deploy\n' >&2
  exit 2
fi

name='mapping-review-api'
backup='mapping-review-api-before-speaking-doctor-20260929'
old_image='izone-term-test-backend:20260929.speaking-cross-doc-v1'
new_image='izone-term-test-backend:20260929.speaking-doctor-v1'
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
  printf 'speaking_doctor_deploy_failed_rollback_attempted exit=%s\n' "$code" >&2
  exit "$code"
}
trap rollback ERR

test "$(docker inspect "$name" --format '{{.Config.Image}}')" = "$old_image"
test "$(docker inspect "$name" --format '{{.State.Health.Status}}')" = healthy
test "$(docker inspect "$name" --format '{{.HostConfig.NetworkMode}}')" = mapping-api-net
test "$(docker inspect "$name" --format '{{.HostConfig.Memory}}')" = 268435456
test "$(docker inspect "$name" --format '{{.HostConfig.NanoCpus}}')" = 500000000
if docker container inspect "$backup" >/dev/null 2>&1; then
  printf 'backup_name_already_exists\n' >&2
  exit 2
fi
docker image inspect "$new_image" >/dev/null
for key in LEARNING_ENABLED LEARNING_DATABASE_URL LEARNING_ATTENDANCE_SYNC_URL ERP_SYNC_SECRET SPEAKING_HOMEWORK_DATABASE_URL SPEAKING_HOMEWORK_ENABLED; do
  docker exec "$name" sh -c 'test -n "$(printenv "$1")"' sh "$key"
done
attendance_hash=$(docker exec "$name" sh -c 'printf %s "$LEARNING_ATTENDANCE_SYNC_URL" | sha256sum | cut -d " " -f 1')
docker exec "$name" sh -c "grep -q 'startLearningAttendanceWorker' /app/src/server.js"
test "$(docker run --rm --entrypoint sha256sum "$new_image" /app/src/learning-attendance-worker.js | cut -d' ' -f1)" = \
  'fbfee853fecf12d1ae55aeb750b245b71934438f3dbfa55c67cd670335eaae2d'
if [[ "$mode" == '--check' ]]; then
  printf 'speaking_doctor_deploy_check_passed image=%s\n' "$new_image"
  trap - ERR
  exit 0
fi

docker stop --time 15 "$name" >/dev/null
stopped=1
docker rename "$name" "$backup"
renamed=1
docker update --restart=no "$backup" >/dev/null

# Đầu vào là env hiệu lực của API đã sao lưu; giữ nguyên mạng, cổng và giới hạn.
# Không in giá trị biến ra log. Container cũ được giữ để quay lại nếu cần.
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
    for key in LEARNING_ENABLED LEARNING_DATABASE_URL LEARNING_ATTENDANCE_SYNC_URL ERP_SYNC_SECRET SPEAKING_HOMEWORK_DATABASE_URL SPEAKING_HOMEWORK_ENABLED; do
      docker exec "$name" sh -c 'test -n "$(printenv "$1")"' sh "$key"
    done
    test "$(docker exec "$name" sh -c 'printf %s "$LEARNING_ATTENDANCE_SYNC_URL" | sha256sum | cut -d " " -f 1')" = "$attendance_hash"
    docker exec "$name" sh -c "grep -q 'startLearningAttendanceWorker' /app/src/server.js"
    docker exec "$name" sh -c "grep -q 'startSpeakingDoctorWorker' /app/src/server.js"
    printf 'speaking_doctor_deploy_healthy image=%s attempt=%s attendance_target_preserved=true\n' "$new_image" "$attempt"
    trap - ERR
    exit 0
  fi
  sleep 2
done
false

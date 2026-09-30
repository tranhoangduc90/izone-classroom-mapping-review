#!/usr/bin/env bash
# Dữ liệu vào: image Speaking khóa 67 đã dựng từ đúng image API đang chạy.
# Việc chính: giữ container cũ, chuyển sang image mới và đợi health check.
# Kết quả: API mới khỏe; khi lỗi, container cũ được khởi động lại.
set -Eeuo pipefail

old_name='mapping-review-api'
backup_name='mapping-review-api-before-speaking-course67-20260930'
base_image='izone-speaking-lesson2:20260930-v1'
base_digest='sha256:e215ec229d4f8dc1d4c97aee883a7a6462bdfaa0fa4daf71f27378373ff8b60b'
new_image='izone-speaking-course67:20260930-v2'
stopped=0
switched=0

rollback() {
  local result=$?
  trap - ERR
  if (( switched )); then
    if docker container inspect "$old_name" >/dev/null 2>&1; then
      docker rm -f "$old_name" >/dev/null || true
    fi
    docker rename "$backup_name" "$old_name"
    docker update --restart=unless-stopped "$old_name" >/dev/null
    docker start "$old_name" >/dev/null
  elif (( stopped )); then
    docker start "$old_name" >/dev/null
  fi
  printf 'deploy_failed_rollback_attempted exit=%s\n' "$result" >&2
  exit "$result"
}
trap rollback ERR

test "$(docker inspect "$old_name" --format '{{.Config.Image}}')" = "$base_image"
test "$(docker inspect "$old_name" --format '{{.Image}}')" = "$base_digest"
test "$(docker inspect "$old_name" --format '{{.State.Health.Status}}')" = 'healthy'
if docker container inspect "$backup_name" >/dev/null 2>&1; then
  printf 'backup_container_already_exists\n' >&2
  exit 2
fi
docker image inspect "$new_image" >/dev/null
test "$(docker inspect "$old_name" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -c '^LEARNING_DATABASE_URL=')" = 1
test "$(docker inspect "$old_name" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -c '^SPEAKING_HOMEWORK_DATABASE_URL=')" = 1

docker stop --time 15 "$old_name" >/dev/null
stopped=1
docker rename "$old_name" "$backup_name"
switched=1
docker update --restart=no "$backup_name" >/dev/null

# Biến môi trường chỉ đi qua file descriptor; không in hoặc ghi secret ra đĩa.
docker run -d \
  --name "$old_name" \
  --network mapping-api-net \
  -p 127.0.0.1:8788:8788 \
  --restart unless-stopped \
  --memory 256m --cpus 0.5 --pids-limit 100 \
  --read-only --tmpfs /tmp:size=16m,noexec,nosuid,nodev \
  --cap-drop ALL --security-opt no-new-privileges --init \
  --log-driver json-file --log-opt max-file=3 --log-opt max-size=10m \
  --stop-timeout 15 \
  --mount type=bind,src=/opt/mapping-review-api/private-assets,dst=/app/private-assets,readonly \
  --env-file <(docker inspect "$backup_name" --format '{{range .Config.Env}}{{println .}}{{end}}') \
  "$new_image" >/dev/null

for attempt in $(seq 1 30); do
  if test "$(docker inspect "$old_name" --format '{{.State.Health.Status}}')" = 'healthy'; then
    printf 'deploy_healthy image=%s attempt=%s\n' "$new_image" "$attempt"
    trap - ERR
    exit 0
  fi
  sleep 2
done
false

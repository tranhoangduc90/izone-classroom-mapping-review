#!/usr/bin/env bash
# Dữ liệu nhận vào: image ứng viên và container API production hiện hành.
# Việc chính: giữ container cũ, chuyển sang image mới và đợi health check.
# Kết quả: API mới chạy khỏe; container cũ nằm lại để hoàn tác.
# Khi lỗi: khởi động lại container cũ và báo lỗi cho người vận hành.
set -Eeuo pipefail

old_name='mapping-review-api'
backup_name='mapping-review-api-before-ic2305-feedback-cors-20260924'
base_image='izone-term-test-backend:20260924.1-progress-log-session4'
new_image='izone-term-test-backend:20260924.2-progress-log-feedback-cors'
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
test "$(docker inspect "$old_name" --format '{{.State.Health.Status}}')" = 'healthy'
if docker container inspect "$backup_name" >/dev/null 2>&1; then
  printf 'backup_container_already_exists\n' >&2
  exit 2
fi
docker image inspect "$new_image" >/dev/null
test "$(docker inspect "$old_name" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -c '^LEARNING_DATABASE_URL=')" = 1

docker stop --time 15 "$old_name" >/dev/null
stopped=1
docker rename "$old_name" "$backup_name"
switched=1
docker update --restart=no "$backup_name" >/dev/null

# Biến môi trường đi qua file descriptor; không in hoặc ghi ra đĩa.
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

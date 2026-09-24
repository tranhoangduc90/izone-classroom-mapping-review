#!/usr/bin/env bash
# Dữ liệu nhận vào: image IC2304 đã build và container API production hiện hành.
# Việc chính: giữ nguyên container cũ, đổi sang image mới, kiểm health và quyền lớp.
# Kết quả: API mới chạy khỏe; container cũ còn nguyên để quay lại trước khi chuyển form.
# Khi lỗi: tự khôi phục container cũ; không sửa database.
set -Eeuo pipefail

old_name='mapping-review-api'
backup_name='mapping-review-api-before-ic2304-v3-20260924'
base_image='izone-term-test-backend:20260924.3-progress-log-feedback-lock'
new_image='izone-term-test-backend:20260924.4-ic2304-session2-v3'
mode="${1:---check}"
stopped=0
switched=0

rollback_failed_deploy() {
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

case "$mode" in --check|--deploy) ;; *) printf 'INVALID_MODE\n' >&2; exit 2 ;; esac
test "$(docker inspect "$old_name" --format '{{.Config.Image}}')" = "$base_image"
test "$(docker inspect "$old_name" --format '{{.State.Health.Status}}')" = 'healthy'
if docker container inspect "$backup_name" >/dev/null 2>&1; then
  printf 'BACKUP_CONTAINER_ALREADY_EXISTS\n' >&2
  exit 2
fi
docker image inspect "$new_image" >/dev/null
test "$(docker inspect "$old_name" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -c '^LEARNING_DATABASE_URL=')" = 1
if [[ "$mode" == '--check' ]]; then printf 'DEPLOY_CHECK_OK\n'; exit 0; fi
trap rollback_failed_deploy ERR

docker stop --time 15 "$old_name" >/dev/null
stopped=1
docker rename "$old_name" "$backup_name"
switched=1
docker update --restart=no "$backup_name" >/dev/null

# Dùng file descriptor để chuyển biến môi trường; không in credential hoặc ghi ra đĩa.
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
    docker exec "$old_name" node scripts/check-ic2304-release.mjs
    printf 'DEPLOY_HEALTHY image=%s attempt=%s\n' "$new_image" "$attempt"
    trap - ERR
    exit 0
  fi
  sleep 2
done
false

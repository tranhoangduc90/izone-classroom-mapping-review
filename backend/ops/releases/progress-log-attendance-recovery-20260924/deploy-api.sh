#!/usr/bin/env bash
# Nhận image mới đã build và API production hiện hành.
# Giữ nguyên toàn bộ env, chỉ đổi image; rollback khi health/config/database lỗi.
# Khi lỗi, container cũ được khởi động lại và bài trong hàng chờ được giữ nguyên.
set -Eeuo pipefail

api_name='mapping-review-api'
backup_name='mapping-review-api-before-lease-recovery-20260924'
base_image='izone-term-test-backend:20260924.4-ic2304-session2-v3'
new_image='izone-term-test-backend:20260924.5-progress-log-attendance-recovery'
expected_url='https://n8n-ai.izone.edu.vn/webhook/dong-bo-diem-danh-progress-log'
mode="${1:---check}"
stopped=0
switched=0

rollback() {
  local code=$?
  trap - ERR
  if (( switched )); then
    if docker container inspect "$api_name" >/dev/null 2>&1; then docker rm -f "$api_name" >/dev/null || true; fi
    docker rename "$backup_name" "$api_name"
    docker update --restart=unless-stopped "$api_name" >/dev/null
    docker start "$api_name" >/dev/null
  elif (( stopped )); then
    docker start "$api_name" >/dev/null
  fi
  printf 'DEPLOY_FAILED_ROLLBACK_ATTEMPTED exit=%s\n' "$code" >&2
  exit "$code"
}

case "$mode" in --check|--deploy) ;; *) printf 'INVALID_MODE\n' >&2; exit 2 ;; esac
test "$(docker inspect "$api_name" --format '{{.Config.Image}}')" = "$base_image"
test "$(docker inspect "$api_name" --format '{{.State.Health.Status}}')" = 'healthy'
if docker container inspect "$backup_name" >/dev/null 2>&1; then
  printf 'BACKUP_CONTAINER_ALREADY_EXISTS\n' >&2
  exit 2
fi
docker image inspect "$new_image" >/dev/null
current_env="$(docker inspect "$api_name" --format '{{range .Config.Env}}{{println .}}{{end}}')"
test "$(printf '%s\n' "$current_env" | grep -c '^LEARNING_ENABLED=true$')" = 1
test "$(printf '%s\n' "$current_env" | grep -c '^LEARNING_DATABASE_URL=.')" = 1
test "$(printf '%s\n' "$current_env" | grep -c '^ERP_SYNC_SECRET=.')" = 1
test "$(printf '%s\n' "$current_env" | grep -c "^LEARNING_ATTENDANCE_SYNC_URL=$expected_url$")" = 1
if [[ "$mode" == '--check' ]]; then printf 'DEPLOY_CHECK_OK\n'; exit 0; fi
trap rollback ERR

docker stop --time 15 "$api_name" >/dev/null
stopped=1
docker rename "$api_name" "$backup_name"
switched=1
docker update --restart=no "$backup_name" >/dev/null

# Env đi qua file descriptor; không in hoặc lưu credential ra đĩa.
docker run -d \
  --name "$api_name" \
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
  if test "$(docker inspect "$api_name" --format '{{.State.Health.Status}}')" = 'healthy'; then
    docker exec "$api_name" node --input-type=module -e "import { loadConfig } from './src/config.js'; import { createLearningDatabasePool } from './src/db.js'; import { createLearningAttendanceSync } from './src/learning-attendance-sync.js'; const config=loadConfig(); if (!createLearningAttendanceSync({config})) process.exit(2); const pool=createLearningDatabasePool(config); try { await pool.query('SELECT 1'); } finally { await pool.end(); }"
    printf 'DEPLOY_HEALTHY attempt=%s\n' "$attempt"
    trap - ERR
    exit 0
  fi
  sleep 2
done
false

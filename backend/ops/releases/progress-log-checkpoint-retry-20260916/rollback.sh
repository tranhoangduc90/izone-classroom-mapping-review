#!/usr/bin/env bash
set -euo pipefail

# Nhận vào container đã chuyển sang bản checkpoint và image nền còn giữ trên VPS.
# Việc chính: bỏ đúng overlay mới, dựng lại API từ chuỗi Compose trước phát hành.
# Kết quả: API trở về bản 1.8.7; dữ liệu bài làm, điểm danh và hàng đợi không bị xóa.
# Khi lỗi: dừng với mã khác 0 để người vận hành kiểm tra thủ công.

service='mapping-review-api'
base_image='izone-term-test-backend:20260916.3-progress-log-live-tracking'
new_image='izone-term-test-backend:20260916.4-progress-log-checkpoint-retry'
overlay='/opt/izone-progress-log-checkpoint-retry-20260916/compose.override.yml'
current_image="$(docker inspect "$service" --format '{{.Config.Image}}')"
if [[ "$current_image" != "$new_image" ]]; then
  printf 'WRONG_CURRENT_IMAGE %s\n' "$current_image" >&2
  exit 2
fi
base_sha="$(docker image inspect "$base_image" --format '{{.Id}}' | sed 's/^sha256://')"
test -n "$base_sha"
export AUDIO_HOTFIX_BUILD_SHA="$base_sha"
export UNIFIED_TERM_TEST_BUILD_SHA="$base_sha"
export TERM_TEST67_LIVE_BUILD_SHA="$base_sha"
export PROGRESS_LOG_JOURNEY_BUILD_SHA="$base_sha"
export IC2305_BUILD_SHA="$base_sha"
export PROGRESS_LOG_ATTENDANCE_BUILD_SHA="$base_sha"
export PROGRESS_LOG_LIVE_BUILD_SHA="$base_sha"
export LEARNING_AI_CLAIM_CREATED_AFTER="$(docker inspect learning-ai-worker --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^LEARNING_AI_CLAIM_CREATED_AFTER=//p' | head -1)"
export LEARNING_AI_ALLOWED_FORM_VERSION_IDS="$(docker inspect learning-ai-worker --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^LEARNING_AI_ALLOWED_FORM_VERSION_IDS=//p' | head -1)"
test -n "$LEARNING_AI_CLAIM_CREATED_AFTER"
test -n "$LEARNING_AI_ALLOWED_FORM_VERSION_IDS"

config_csv="$(docker inspect "$service" --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}')"
IFS=',' read -r -a config_paths <<< "$config_csv"
compose_args=()
removed=0
for config_path in "${config_paths[@]}"; do
  if [[ "$config_path" == "$overlay" ]]; then removed=$((removed + 1)); continue; fi
  test -f "$config_path"
  compose_args+=(-f "$config_path")
done
test "$removed" -eq 1

cd '/opt/mapping-review-api/releases/webtest34-ai-20260907T151700Z'
docker compose -p app "${compose_args[@]}" config --format json |
  jq -e --arg image "$base_image" '.services["mapping-review-api"] | .image == $image and .environment.APP_VERSION == "1.8.7-k56-live-tracking"' >/dev/null
if [[ "${1:-}" == '--check' ]]; then
  printf 'ROLLBACK_COMPOSE_VALID\n'
  exit 0
fi

docker compose -p app "${compose_args[@]}" up -d --no-deps --force-recreate "$service"
for attempt in {1..15}; do
  status="$(docker inspect "$service" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}')"
  if [[ "$status" == 'healthy' ]]; then break; fi
  sleep 2
done
docker inspect "$service" --format '{{.Config.Image}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}'
test "$status" == 'healthy'

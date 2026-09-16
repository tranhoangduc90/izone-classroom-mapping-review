#!/usr/bin/env bash
set -euo pipefail

# Nhận vào image mới đã build và cấu hình Compose hiện hành từ đúng container production.
# Việc chính: kiểm image nền/Compose, rồi chỉ dựng lại API khi không dùng --check.
# Kết quả: API chạy bản checkpoint mới; database, Portal và dịch vụ khác giữ nguyên.
# Khi lỗi: dừng trước khi dựng hoặc báo health; dùng rollback.sh với image nền.

service='mapping-review-api'
base_image='izone-term-test-backend:20260916.3-progress-log-live-tracking'
new_image='izone-term-test-backend:20260916.4-progress-log-checkpoint-retry'
overlay='/opt/izone-progress-log-checkpoint-retry-20260916/compose.override.yml'
current_image="$(docker inspect "$service" --format '{{.Config.Image}}')"
if [[ "$current_image" != "$base_image" ]]; then
  printf 'WRONG_BASE_IMAGE %s\n' "$current_image" >&2
  exit 2
fi
docker image inspect "$base_image" >/dev/null
docker image inspect "$new_image" >/dev/null
test -f "$overlay"

current_sha="$(docker inspect "$service" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^BUILD_SHA=//p' | head -1)"
test -n "$current_sha"
export AUDIO_HOTFIX_BUILD_SHA="$current_sha"
export UNIFIED_TERM_TEST_BUILD_SHA="$current_sha"
export TERM_TEST67_LIVE_BUILD_SHA="$current_sha"
export PROGRESS_LOG_JOURNEY_BUILD_SHA="$current_sha"
export IC2305_BUILD_SHA="$current_sha"
export PROGRESS_LOG_ATTENDANCE_BUILD_SHA="$current_sha"
export PROGRESS_LOG_LIVE_BUILD_SHA="$current_sha"
export PROGRESS_LOG_CHECKPOINT_BUILD_SHA="$(docker image inspect "$new_image" --format '{{.Id}}' | sed 's/^sha256://')"
export LEARNING_AI_CLAIM_CREATED_AFTER="$(docker inspect learning-ai-worker --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^LEARNING_AI_CLAIM_CREATED_AFTER=//p' | head -1)"
export LEARNING_AI_ALLOWED_FORM_VERSION_IDS="$(docker inspect learning-ai-worker --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^LEARNING_AI_ALLOWED_FORM_VERSION_IDS=//p' | head -1)"
test -n "$LEARNING_AI_CLAIM_CREATED_AFTER"
test -n "$LEARNING_AI_ALLOWED_FORM_VERSION_IDS"

config_csv="$(docker inspect "$service" --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}')"
IFS=',' read -r -a config_paths <<< "$config_csv"
compose_args=()
for config_path in "${config_paths[@]}"; do
  test -f "$config_path"
  compose_args+=(-f "$config_path")
done
compose_args+=(-f "$overlay")

cd '/opt/mapping-review-api/releases/webtest34-ai-20260907T151700Z'
docker compose -p app "${compose_args[@]}" config --format json |
  jq -e --arg image "$new_image" '.services["mapping-review-api"] | .image == $image and .environment.APP_VERSION == "1.8.8-k56-checkpoint-retry"' >/dev/null
if [[ "${1:-}" == '--check' ]]; then
  printf 'COMPOSE_VALID\n'
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

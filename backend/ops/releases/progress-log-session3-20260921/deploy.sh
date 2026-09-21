#!/usr/bin/env bash
set -euo pipefail

# Nhận chuỗi Compose đang chạy và image buổi 3 đã kiểm hash.
# Việc chính: chỉ dựng lại API chung, sau đó chạy lại checker quyền và canary dashboard.
# Kết quả: health, phân quyền và các dashboard cũ phải tiếp tục đạt.
# Khi lỗi: tự quay về image 1.10.0 và không xóa dữ liệu.

service='mapping-review-api'
base_image='izone-term-test-backend:20260920.2-dashboard-access'
new_image='izone-term-test-backend:20260921.1-progress-log-session3'
release_dir='/opt/izone-progress-log-session3-20260921/backend/ops/releases/progress-log-session3-20260921'
overlay="$release_dir/compose.override.yml"
mode="${1:---check}"
case "$mode" in --check|--deploy|--rollback) ;; *) echo 'INVALID_MODE' >&2; exit 2;; esac

current_image="$(docker inspect "$service" --format '{{.Config.Image}}')"
if [[ "$mode" == '--rollback' ]]; then
  test "$current_image" = "$new_image"
else
  test "$current_image" = "$base_image"
fi
docker image inspect "$base_image" >/dev/null
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
export PROGRESS_LOG_CHECKPOINT_BUILD_SHA="$current_sha"
export LISTENING_RETAKE_UNLIMITED_BUILD_SHA="$current_sha"
export TEACHER_SESSION_BUILD_SHA="$current_sha"
export DASHBOARD_ACCESS_BUILD_SHA="$(docker image inspect "$base_image" --format '{{.Id}}' | sed 's/^sha256://')"
export LEARNING_AI_CLAIM_CREATED_AFTER="$(docker inspect learning-ai-worker --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^LEARNING_AI_CLAIM_CREATED_AFTER=//p' | head -1)"
export LEARNING_AI_ALLOWED_FORM_VERSION_IDS="$(docker inspect learning-ai-worker --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^LEARNING_AI_ALLOWED_FORM_VERSION_IDS=//p' | head -1)"
test -n "$LEARNING_AI_CLAIM_CREATED_AFTER"
test -n "$LEARNING_AI_ALLOWED_FORM_VERSION_IDS"

config_csv="$(docker inspect "$service" --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}')"
IFS=',' read -r -a config_paths <<< "$config_csv"
compose_args=()
for config_path in "${config_paths[@]}"; do
  test -f "$config_path"
  if [[ "$config_path" != "$overlay" ]]; then compose_args+=(-f "$config_path"); fi
done

if [[ "$mode" == '--rollback' ]]; then
  expected_image="$base_image"
  expected_version='1.10.0-dashboard-access'
else
  docker image inspect "$new_image" >/dev/null
  export PROGRESS_LOG_SESSION3_BUILD_SHA="$(docker image inspect "$new_image" --format '{{.Id}}' | sed 's/^sha256://')"
  compose_args+=(-f "$overlay")
  expected_image="$new_image"
  expected_version='1.11.0-progress-log-session3'
fi

cd '/opt/mapping-review-api/releases/webtest34-ai-20260907T151700Z'
docker compose -p app "${compose_args[@]}" config --format json |
  jq -e --arg image "$expected_image" --arg version "$expected_version" \
    '.services["mapping-review-api"] | .image == $image and .environment.APP_VERSION == $version' >/dev/null
if [[ "$mode" == '--check' ]]; then echo 'COMPOSE_VALID'; exit 0; fi

docker compose -p app "${compose_args[@]}" up -d --no-deps --force-recreate "$service"
status='starting'
for attempt in {1..30}; do
  status="$(docker inspect "$service" | jq -r '.[0].State.Health.Status // .[0].State.Status')"
  if [[ "$status" == 'healthy' ]]; then break; fi
  sleep 2
done
if [[ "$status" != 'healthy' ]]; then
  echo 'HEALTH_CHECK_FAILED_ROLLING_BACK' >&2
  if [[ "$mode" == '--deploy' ]]; then "$0" --rollback || true; fi
  exit 2
fi

if [[ "$mode" == '--deploy' ]]; then
  if ! docker exec "$service" node scripts/check-teacher-class-access.mjs --freshness-hours=36; then
    "$0" --rollback
    exit 2
  fi
  if ! docker exec "$service" node scripts/teacher-dashboard-canary.mjs; then
    "$0" --rollback
    exit 2
  fi
fi
docker inspect "$service" | jq -r '.[0] | .Config.Image+"|"+(.State.Health.Status // .State.Status)'

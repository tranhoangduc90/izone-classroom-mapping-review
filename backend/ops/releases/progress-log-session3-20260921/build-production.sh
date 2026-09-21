#!/usr/bin/env bash
set -euo pipefail

# Nhận source đã kiểm thử và image production hiện hành.
# Việc chính: dựng một lớp image tối thiểu, Dockerfile tự kiểm hash trước/sau.
# Kết quả: image mới chứa đúng contract buổi 3 và vẫn giữ mọi hotfix đang chạy.
# Khi lỗi: lệnh dừng trước khi thay container production.

cd /opt/izone-progress-log-session3-20260921/backend
test "$(docker inspect mapping-review-api --format '{{.Config.Image}}')" = \
  'izone-term-test-backend:20260920.2-dashboard-access'
docker build \
  -f ops/releases/progress-log-session3-20260921/Dockerfile \
  -t izone-term-test-backend:20260921.1-progress-log-session3 \
  .
docker image inspect izone-term-test-backend:20260921.1-progress-log-session3 \
  --format '{{.Id}}|{{.Config.User}}'
docker run --rm --entrypoint sh izone-term-test-backend:20260921.1-progress-log-session3 -lc \
  'node --check /app/src/learning-contracts.js \
    && node --check /app/src/learning-domain.js \
    && node --check /app/src/learning-templates/ic2305-entrance-listening1-speaking2.js \
    && node --check /app/scripts/publish-ic2305-progress-log.mjs \
    && echo IMAGE_CHECKED'

#!/usr/bin/env bash
set -euo pipefail

cd /opt/izone-dashboard-access-hardening-20260920/backend
docker build \
  -f ops/releases/dashboard-access-hardening-20260920/Dockerfile \
  -t izone-term-test-backend:20260920.2-dashboard-access \
  .
docker image inspect izone-term-test-backend:20260920.2-dashboard-access \
  --format '{{.Id}}|{{.Config.User}}'
docker run --rm --entrypoint sh izone-term-test-backend:20260920.2-dashboard-access -lc \
  'test "$(stat -c %a /app/src/sql.js)" = 644 && test "$(stat -c %a /app/src/learning-sql.js)" = 644 && node --check /app/src/sql.js && node --check /app/src/learning-sql.js && echo IMAGE_CHECKED'

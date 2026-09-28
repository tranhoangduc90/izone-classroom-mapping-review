#!/usr/bin/env bash
# Đầu vào: image mới và env của API đang khỏe.
# Việc chính: chạy module kiểm thử với database thật trong transaction rồi rollback.
# Kết quả: báo pass/fail mà không tạo phiên học viên tồn tại lâu.
set -Eeuo pipefail

release='/opt/mapping-review-api/releases/speaking-cross-doc-20260929'
docker run --rm --network mapping-api-net --read-only \
  --tmpfs /tmp:size=16m,noexec,nosuid,nodev \
  --cap-drop ALL --security-opt no-new-privileges \
  --env-file <(docker inspect mapping-review-api --format '{{range .Config.Env}}{{println .}}{{end}}') \
  --mount "type=bind,src=$release/verify-cross-doc.mjs,dst=/app/verify-cross-doc.mjs,readonly" \
  izone-term-test-backend:20260929.speaking-cross-doc-v1 \
  node /app/verify-cross-doc.mjs

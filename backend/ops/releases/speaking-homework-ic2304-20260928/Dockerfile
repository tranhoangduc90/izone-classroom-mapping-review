FROM izone-term-test-backend:20260925.4-learning-contract-compat

USER root
COPY src/speaking-homework.js src/speaking-homework-routes.js src/speaking-docs-writer.js src/speaking-docs-jobs.js src/speaking-alerts.js src/speaking-share-reader.js src/speaking-checker.js src/speaking-check-worker.js src/speaking-grade-worker.js src/teacher-class-access-sql.js /app/src/
COPY src/db.js /tmp/speaking-db.js
COPY src/learning-outbox.js src/learning-attendance-sync.js src/learning-attendance-worker.js /app/src/
COPY ops/releases/speaking-homework-ic2304-20260928/patch-live.mjs /tmp/patch-live.mjs

# Dữ liệu vào: image API production đang chạy và source Speaking đã kiểm.
# Việc chính: đối chiếu hash file lõi, ghép đúng route/worker, giữ nguyên các luồng cũ.
# Kết quả: image mới; sai phiên bản gốc hoặc cú pháp thì build dừng trước deploy.
RUN test "$(sha256sum /app/src/db.js | cut -d' ' -f1)" = "e53e653c1e6a5769b5dcc24726c7ca5637f5bad563901ae13bf09ce864c47234" \
 && install -m 0644 /tmp/speaking-db.js /app/src/db.js \
 && node /tmp/patch-live.mjs \
 && node --check /app/src/app.js \
 && node --check /app/src/config.js \
 && node --check /app/src/server.js \
 && node --check /app/src/speaking-checker.js \
 && node --check /app/src/speaking-alerts.js

USER node

FROM izone-term-test-backend:20260916.1-ic2305

# Nhận các module Learning đã qua test; Term Test và các route khác giữ nguyên từ image nền.
COPY src/config.js /app/src/config.js
COPY src/server.js /app/src/server.js
COPY src/learning-outbox.js /app/src/learning-outbox.js
COPY src/learning-attendance-sync.js /app/src/learning-attendance-sync.js
COPY src/learning-attendance-worker.js /app/src/learning-attendance-worker.js
COPY src/learning-service.js /app/src/learning-service.js
COPY src/learning-sql.js /app/src/learning-sql.js
COPY src/learning-templates/ic2305-entrance-writing1.js /app/src/learning-templates/ic2305-entrance-writing1.js
COPY scripts/publish-ic2305-progress-log.mjs /app/scripts/publish-ic2305-progress-log.mjs

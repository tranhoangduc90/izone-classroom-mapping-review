FROM izone-term-test-backend:20260915.1-progress-log

# Chỉ phủ các module Learning đã kiểm thử; giữ nguyên toàn bộ Term Test đang chạy.
COPY src/learning-contracts.js /app/src/learning-contracts.js
COPY src/learning-domain.js /app/src/learning-domain.js
COPY src/learning-routes.js /app/src/learning-routes.js
COPY src/learning-service.js /app/src/learning-service.js
COPY src/learning-sql.js /app/src/learning-sql.js
COPY src/learning-templates/ic2305-entrance-reading1-listening1.js /app/src/learning-templates/ic2305-entrance-reading1-listening1.js
COPY scripts/grant-learning-course-lead.mjs /app/scripts/grant-learning-course-lead.mjs
COPY scripts/publish-ic2305-progress-log.mjs /app/scripts/publish-ic2305-progress-log.mjs

FROM izone-term-test-backend:20260924.5-progress-log-attendance-recovery

USER root

# Chỉ thay worker khi baseline production đúng phiên bản đã kiểm.
RUN test "$(sha256sum /app/src/learning-attendance-worker.js | cut -d' ' -f1)" = "5a90a79bd06528c6ceb444dc8a52dbac7e769b5bbabbe77feb626b075178abbb"

COPY backend/src/learning-attendance-worker.js /app/src/learning-attendance-worker.js

# Kiểm cú pháp và điều kiện lease bao trùm tối đa 10 lượt gọi Portal 15 giây.
RUN node --check /app/src/learning-attendance-worker.js \
 && node --input-type=module -e "import { ATTENDANCE_JOB_BATCH_LIMIT, ATTENDANCE_JOB_LEASE_SECONDS } from '/app/src/learning-attendance-worker.js'; if (ATTENDANCE_JOB_LEASE_SECONDS * 1000 < ATTENDANCE_JOB_BATCH_LIMIT * 15000 + 30000) process.exit(1);"

USER node

# Dữ liệu nhận vào: image API production đã kiểm tra và hai file Learning đã đổi.
# Việc chính: giữ toàn bộ chức năng hiện hành, chỉ thay chính sách phản hồi và job demo.
# Kết quả: image mới có mã nguồn và script phát hành cùng revision.
# Khi lỗi: hash guard hoặc kiểm cú pháp dừng build, không đổi container production.
FROM izone-term-test-backend:20260928.5-progress-log-session5

RUN test "$(sha256sum /app/src/learning-service.js | cut -d ' ' -f 1)" = a878bc18d5d0af14e2ddf2aa4d3dfe240fef83b5141cc4cc9f7bb61e4f1ff3b3 \
 && test "$(sha256sum /app/src/learning-sql.js | cut -d ' ' -f 1)" = c581e7a6c5f56d33d95649ee3b55c1f14cf355337e513d52653fd1eaf94dc4bb \
 && test "$(sha256sum /app/src/learning-attendance-worker.js | cut -d ' ' -f 1)" = fbfee853fecf12d1ae55aeb750b245b71934438f3dbfa55c67cd670335eaae2d \
 && test "$(sha256sum /app/src/server.js | cut -d ' ' -f 1)" = 1004594667ef68a59b540fae37f18eef4ac159d00dc92c566253301e1a5b85f8

COPY src/learning-service.js /app/src/learning-service.js
COPY src/learning-sql.js /app/src/learning-sql.js
COPY scripts/set-ic2305-answer-feedback.mjs /app/scripts/set-ic2305-answer-feedback.mjs
COPY scripts/create-ic2305-session5-student-demo.mjs /app/scripts/create-ic2305-session5-student-demo.mjs
COPY ops/learning-migrations/202609280001_assignment_answer_release.sql /app/ops/learning-migrations/202609280001_assignment_answer_release.sql

RUN node --check /app/src/learning-service.js \
 && node --check /app/src/learning-sql.js \
 && node --check /app/scripts/set-ic2305-answer-feedback.mjs \
 && node --check /app/scripts/create-ic2305-session5-student-demo.mjs \
 && node /app/scripts/set-ic2305-answer-feedback.mjs \
 && node /app/scripts/create-ic2305-session5-student-demo.mjs

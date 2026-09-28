FROM izone-term-test-backend:20260928.progress-log-admins-f7c8b91

USER root
# Đầu vào: image API đang chạy và module gắn CTA đã kiểm thử.
# Việc chính: khóa đúng revision nền, chỉ thay module Speaking để giữ các luồng khác.
# Kết quả: sai revision thì build dừng; image mới giữ nguyên server và điểm danh.
RUN test "$(sha256sum /app/src/speaking-classroom-copies.js | cut -d' ' -f1)" = "62766ed78e07b607d4ae856d181f43c63accdb0780dc6d45e7144e6afa2669aa" \
 && test "$(sha256sum /app/src/learning-attendance-worker.js | cut -d' ' -f1)" = "fbfee853fecf12d1ae55aeb750b245b71934438f3dbfa55c67cd670335eaae2d" \
 && test "$(sha256sum /app/src/server.js | cut -d' ' -f1)" = "1004594667ef68a59b540fae37f18eef4ac159d00dc92c566253301e1a5b85f8"
COPY src/speaking-classroom-copies.js /app/src/speaking-classroom-copies.js
RUN node --check /app/src/speaking-classroom-copies.js
USER node

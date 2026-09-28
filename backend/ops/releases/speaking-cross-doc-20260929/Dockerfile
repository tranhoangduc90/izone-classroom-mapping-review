FROM izone-term-test-backend:20260928.speaking-cta-white-v1

USER root
# Đầu vào: image API đang chạy và module Speaking đã qua kiểm thử.
# Việc chính: khóa đúng revision nền, chỉ thay module phân quyền Speaking.
# Kết quả: sai revision thì build dừng; các luồng API khác giữ nguyên.
RUN test "$(sha256sum /app/src/speaking-homework.js | cut -d' ' -f1)" = "ad6f400bfde496534cc6a36e92818d53d1ca3883fb4b4da32a1291c40a359cff" \
 && test "$(sha256sum /app/src/learning-attendance-worker.js | cut -d' ' -f1)" = "fbfee853fecf12d1ae55aeb750b245b71934438f3dbfa55c67cd670335eaae2d" \
 && test "$(sha256sum /app/src/server.js | cut -d' ' -f1)" = "1004594667ef68a59b540fae37f18eef4ac159d00dc92c566253301e1a5b85f8"
COPY src/speaking-homework.js /app/src/speaking-homework.js
RUN node --check /app/src/speaking-homework.js
USER node

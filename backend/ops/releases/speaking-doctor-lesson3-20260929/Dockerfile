FROM izone-term-test-backend:20260929.speaking-cross-doc-v1

USER root
# Đầu vào: image API Speaking đang chạy và đã đối chiếu trên VPS ngày 29/09.
# Việc chính: khóa revision của API cùng worker điểm danh trước khi thêm Bác sĩ AI.
# Kết quả: nếu image nền đổi, build dừng để kiểm lại thay vì phủ code cũ.
RUN test "$(sha256sum /app/src/server.js | cut -d' ' -f1)" = "1004594667ef68a59b540fae37f18eef4ac159d00dc92c566253301e1a5b85f8" \
 && test "$(sha256sum /app/src/speaking-homework.js | cut -d' ' -f1)" = "8b523d92aff3a5ae99be1730864aabe3f875e35a4328d4fbe80bae6d5777b06b" \
 && test "$(sha256sum /app/src/learning-attendance-worker.js | cut -d' ' -f1)" = "fbfee853fecf12d1ae55aeb750b245b71934438f3dbfa55c67cd670335eaae2d" \
 && test "$(sha256sum /app/src/speaking-grade-worker.js | cut -d' ' -f1)" = "4a1d709f961b9bddf3a5194ffd81ce9466a2451f6d92464ed08cf8bbec97307c"

COPY patch-server.mjs /app/patch-server.mjs
RUN node /app/patch-server.mjs && rm /app/patch-server.mjs
COPY src/speaking-homework.js /app/src/speaking-homework.js
COPY src/speaking-doctor-worker.js /app/src/speaking-doctor-worker.js
RUN test "$(sha256sum /app/src/server.js | cut -d' ' -f1)" = "b0e00393457d773fea15dd05ba1ee96487dbf8d848b812c4587c0a6ffc4ec9ef" \
 && node --check /app/src/server.js \
 && node --check /app/src/speaking-homework.js \
 && node --check /app/src/speaking-doctor-worker.js
USER node

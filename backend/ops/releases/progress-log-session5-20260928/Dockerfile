# Dữ liệu nhận vào: image API đang chạy và sáu file Learning đã kiểm thử trên cùng revision.
# Việc chính: khôi phục hợp đồng Progress Log hiện hành, thêm mẫu và lệnh phát hành Buổi 5.
# Kết quả: API giữ các tính năng khác của image gốc và đọc được phiếu Buổi 4/5.
# Khi lỗi: hash guard hoặc lệnh kiểm cú pháp dừng build trước khi chuyển container.
FROM izone-term-test-backend:20260928.4-speaking-copy-binding-ic2304

RUN test "$(sha256sum /app/src/learning-contracts.js | cut -d ' ' -f 1)" = ccdfa03d5cf4ff33f3059fdf33f248b3a25e2fee581bc03c35f0b1bb7f75b5c0 \
 && test "$(sha256sum /app/src/learning-attendance-worker.js | cut -d ' ' -f 1)" = fbfee853fecf12d1ae55aeb750b245b71934438f3dbfa55c67cd670335eaae2d

COPY src/learning-contracts.js /app/src/learning-contracts.js
COPY src/learning-domain.js /app/src/learning-domain.js
COPY src/learning-service.js /app/src/learning-service.js
COPY src/learning-routes.js /app/src/learning-routes.js
COPY src/learning-sql.js /app/src/learning-sql.js
COPY src/learning-templates/ic2305-session5-reading-writing-speaking.js /app/src/learning-templates/ic2305-session5-reading-writing-speaking.js
COPY scripts/publish-ic2305-progress-log.mjs /app/scripts/publish-ic2305-progress-log.mjs

RUN node --check /app/src/learning-contracts.js \
 && node --check /app/src/learning-domain.js \
 && node --check /app/src/learning-service.js \
 && node --check /app/src/learning-routes.js \
 && node --check /app/src/learning-sql.js \
 && node --check /app/scripts/publish-ic2305-progress-log.mjs \
 && node /app/scripts/publish-ic2305-progress-log.mjs --class=IC2305 --form=session5-reading-writing-speaking

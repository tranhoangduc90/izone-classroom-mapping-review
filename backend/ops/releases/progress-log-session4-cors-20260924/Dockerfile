FROM izone-term-test-backend:20260924.1-progress-log-session4

USER root
COPY src/app.js /tmp/app.js

# Dữ liệu nhận vào: image production đã kiểm và app.js chỉ bổ sung PUT trong CORS.
# Việc chính: đối chiếu hash trước/sau rồi mới thay file cấu hình API.
# Kết quả: image mới cho trình duyệt gửi nhận xét Speaking.
# Khi lỗi: build dừng, container production không đổi.
RUN test "$(sha256sum /app/src/app.js | cut -d' ' -f1)" = "b3cc6eb54a1e9dee8c0896f41ac94f5751c5e54361c622c70f401615c90459d0" \
 && test "$(sha256sum /tmp/app.js | cut -d' ' -f1)" = "226ecec59f41dc511ec34e909535941c5f2348bc5ceb34d9b691836038176ca1" \
 && install -m 0644 /tmp/app.js /app/src/app.js \
 && node --check /app/src/app.js

USER node

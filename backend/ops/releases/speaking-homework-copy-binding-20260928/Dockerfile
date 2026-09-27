FROM izone-term-test-backend:20260928.3-speaking-attendance-ic2304

USER root
# Đầu vào: image API Speaking và điểm danh đang chạy thật.
# Việc chính: chỉ nhận đúng revision đã đọc hash rồi thay ba module Speaking.
# Kết quả: image mới giữ các chức năng khác; sai hash thì build dừng.
RUN test "$(sha256sum /app/src/speaking-homework.js | cut -d' ' -f1)" = "9e11c2db02ca9536a37c9c5ad9543852b43edc237516f895ba01a01e1a14e5ed" \
 && test "$(sha256sum /app/src/speaking-homework-routes.js | cut -d' ' -f1)" = "3540db94f06a67a37258e6d0944cba5e8697f48adfeb07dfa77c074e83366150"
COPY src/speaking-homework.js src/speaking-homework-routes.js src/speaking-classroom-copies.js /app/src/
RUN node --check /app/src/speaking-homework.js \
 && node --check /app/src/speaking-homework-routes.js \
 && node --check /app/src/speaking-classroom-copies.js
USER node

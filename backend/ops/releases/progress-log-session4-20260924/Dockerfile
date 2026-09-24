FROM izone-term-test-backend:20260923.1-writing-webhook-4

USER root
COPY src/learning-contracts.js /tmp/learning-contracts.js
COPY src/learning-service.js /tmp/learning-service.js
COPY src/learning-routes.js /tmp/learning-routes.js
COPY src/learning-sql.js /tmp/learning-sql.js
COPY src/learning-replacement.js /tmp/learning-replacement.js
COPY src/learning-templates/ic2305-session4-listening1-speaking2.js /tmp/ic2305-session4-listening1-speaking2.js
COPY scripts/publish-ic2305-progress-log.mjs /tmp/publish-ic2305-progress-log.mjs

# Dữ liệu nhận vào: image production đang chạy và sáu file của tính năng Buổi 4.
# Việc chính: chặn base đổi ngoài dự kiến, xác nhận hash source rồi mới đặt file mới.
# Kết quả: image có phiếu, API nhận xét và publisher; các module production khác giữ nguyên.
# Khi lỗi: docker build dừng, không thay container hay dữ liệu học viên.
RUN test "$(sha256sum /app/src/learning-contracts.js | cut -d' ' -f1)" = "2a1133ed0d6f3e777fe4047de1534e744ebffec124fbc5046c51e682e63b76f7" \
 && test "$(sha256sum /app/src/learning-service.js | cut -d' ' -f1)" = "c71c698be44dddd4a88ee218c0e8cc2bfb5c843cf09039d4b6476535cb87e739" \
 && test "$(sha256sum /app/src/learning-routes.js | cut -d' ' -f1)" = "65f4cf7dcdc65ce3047c61899e0bc6477ba5b1381cf6a1ba97b45d2bf1fd9494" \
 && test "$(sha256sum /app/src/learning-sql.js | cut -d' ' -f1)" = "7fdfd20f62c6cb744e1cf4ece7949dc704a545def28de5875b270587428f3e7e" \
 && test "$(sha256sum /app/src/teacher-class-access-sql.js | cut -d' ' -f1)" = "11d904b9c7da298944eaada650940b2187f58d10de30450b5b66caca5a324b54" \
 && test ! -e /app/src/learning-replacement.js \
 && test ! -e /app/src/learning-templates/ic2305-session4-listening1-speaking2.js \
 && test ! -e /app/scripts/publish-ic2305-progress-log.mjs \
 && test "$(sha256sum /tmp/learning-contracts.js | cut -d' ' -f1)" = "9c1b476e914aed7dca264d1d1e6afb5bd7e326c8cc311f789e9e30c82a6fcd6e" \
 && test "$(sha256sum /tmp/learning-service.js | cut -d' ' -f1)" = "5b6199f4fd14091f73eb7f84ed328b4150dc6b707b9056f564f21792274ad565" \
 && test "$(sha256sum /tmp/learning-routes.js | cut -d' ' -f1)" = "321eacefd9d0d5f6537fde48f41a72e3ed7aa123c90a711ffed809fd2f1db098" \
 && test "$(sha256sum /tmp/learning-sql.js | cut -d' ' -f1)" = "379aef807646be727e8d8f4cfa49f35380393a417a34bd6464a0ed809af3f578" \
 && test "$(sha256sum /tmp/learning-replacement.js | cut -d' ' -f1)" = "dbeef6d5470cef95efc690745069c84334fb0ee75a5aa90ae5dfaea8bf7a603b" \
 && test "$(sha256sum /tmp/ic2305-session4-listening1-speaking2.js | cut -d' ' -f1)" = "d5acb50374376c1dc906946c98973d69961f380b37b940942ed1589031e2113d" \
 && test "$(sha256sum /tmp/publish-ic2305-progress-log.mjs | cut -d' ' -f1)" = "0c2241c65e7e97cdd8aad740f6f824429342182d1c3b61e2c6b3f064e59b070d" \
 && install -m 0644 /tmp/learning-contracts.js /app/src/learning-contracts.js \
 && install -m 0644 /tmp/learning-service.js /app/src/learning-service.js \
 && install -m 0644 /tmp/learning-routes.js /app/src/learning-routes.js \
 && install -m 0644 /tmp/learning-sql.js /app/src/learning-sql.js \
 && install -m 0644 /tmp/learning-replacement.js /app/src/learning-replacement.js \
 && install -m 0644 /tmp/ic2305-session4-listening1-speaking2.js /app/src/learning-templates/ic2305-session4-listening1-speaking2.js \
 && mkdir -p /app/scripts \
 && install -m 0644 /tmp/publish-ic2305-progress-log.mjs /app/scripts/publish-ic2305-progress-log.mjs \
 && node --check /app/src/learning-contracts.js \
 && node --check /app/src/learning-service.js \
 && node --check /app/src/learning-routes.js \
 && node --check /app/src/learning-sql.js \
 && node --check /app/src/learning-replacement.js \
 && node --check /app/src/learning-templates/ic2305-session4-listening1-speaking2.js \
 && node --check /app/scripts/publish-ic2305-progress-log.mjs
USER node

# Dữ liệu vào: image K56 hiện hành và cây src đã xuất từ bản stage qua test.
# Việc chính: khóa dấu source/package của image nền, chép cây mã ứng viên rồi kiểm lại.
# Kết quả: image mới chỉ được tạo khi đúng bản source đã thử; không đổi production.
# Khi lỗi: docker build dừng, image K56 đang chạy không bị thay đổi.
ARG BASE_IMAGE=izone-k56-live-results:20260920.1-teacher-session
FROM ${BASE_IMAGE}

USER root
WORKDIR /app

COPY ops/releases/k56-class-access-20260924/verify-source-hashes.mjs \
  /tmp/verify-source-hashes.mjs

ARG EXPECTED_BASE_SOURCE_SHA
ARG EXPECTED_BASE_PACKAGE_SHA
ARG EXPECTED_BASE_LOCK_SHA
RUN node /tmp/verify-source-hashes.mjs /app/src "$EXPECTED_BASE_SOURCE_SHA" \
    /app/package.json "$EXPECTED_BASE_PACKAGE_SHA" \
    /app/package-lock.json "$EXPECTED_BASE_LOCK_SHA"

COPY --chown=node:node src/ /app/src/

ARG EXPECTED_CANDIDATE_SOURCE_SHA
RUN node /tmp/verify-source-hashes.mjs /app/src "$EXPECTED_CANDIDATE_SOURCE_SHA" \
  && node --check /app/src/server.js \
  && node --check /app/src/app.js \
  && node --check /app/src/sql.js \
  && rm /tmp/verify-source-hashes.mjs

USER node

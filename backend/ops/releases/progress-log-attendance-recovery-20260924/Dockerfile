FROM izone-term-test-backend:20260924.4-ic2304-session2-v3

USER root

# Chỉ áp bản vá nếu hai file production vẫn là đúng baseline đã kiểm tra.
RUN test "$(sha256sum /app/src/config.js | cut -d' ' -f1)" = "302bb853067408cfeaece566e223c68837adb7f32097b4ad208fa2fd8f3fed00" \
 && test "$(sha256sum /app/src/learning-outbox.js | cut -d' ' -f1)" = "841ec22ddd05440c4c2863da22238f8c020e04885d19fde9d40e92a80848b342"

COPY backend/src/config.js /app/src/config.js
COPY backend/src/learning-outbox.js /app/src/learning-outbox.js

# Kiểm cú pháp hai file vừa thay trước khi image được dùng để phát hành.
RUN node --check /app/src/config.js && node --check /app/src/learning-outbox.js

USER node

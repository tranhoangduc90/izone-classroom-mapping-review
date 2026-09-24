FROM izone-term-test-backend:20260924.3-progress-log-feedback-lock

USER root

# Nhận image API đang chạy; kiểm đúng bốn module nền trước khi thêm chấm Listening và Speaking.
# Kết quả là image mới kế thừa mọi bản sửa production của IC2305/Term Test.
# Sai hash dừng build, container production không thay đổi.
RUN test "$(sha256sum /app/src/learning-contracts.js | cut -d' ' -f1)" = "9c1b476e914aed7dca264d1d1e6afb5bd7e326c8cc311f789e9e30c82a6fcd6e" \
 && test "$(sha256sum /app/src/learning-domain.js | cut -d' ' -f1)" = "16044ed12fed8fe17f2bde3348cd515b3d7f9f12200d31a625fd51e5cc4962fd" \
 && test "$(sha256sum /app/src/learning-service.js | cut -d' ' -f1)" = "5b6199f4fd14091f73eb7f84ed328b4150dc6b707b9056f564f21792274ad565" \
 && test "$(sha256sum /app/src/learning-sql.js | cut -d' ' -f1)" = "8d09430beb7eaf7f1de60ffb46b45f2a024ac0059c10795314365e7218b52b98"

COPY backend/src/learning-contracts.js /app/src/learning-contracts.js
COPY backend/src/learning-domain.js /app/src/learning-domain.js
COPY backend/src/learning-service.js /app/src/learning-service.js
COPY backend/src/learning-sql.js /app/src/learning-sql.js
COPY backend/src/learning-templates/ic2304-session2-listening-writing.js /app/src/learning-templates/ic2304-session2-listening-writing.js
COPY backend/src/learning-templates/ic2304-session2-scored.js /app/src/learning-templates/ic2304-session2-scored.js
COPY backend/src/learning-templates/ic2304-session2-speaking.js /app/src/learning-templates/ic2304-session2-speaking.js
COPY backend/scripts/upgrade-ic2304-session2-speaking.mjs /app/scripts/upgrade-ic2304-session2-speaking.mjs
COPY backend/scripts/check-ic2304-release.mjs /app/scripts/check-ic2304-release.mjs

# Đọc source mới, kiểm cú pháp và xác nhận form có ba phần cùng năm câu Listening chấm điểm.
# Nếu lỗi, Docker build dừng trước khi chuyển API đang chạy.
RUN node --check /app/src/learning-contracts.js \
 && node --check /app/src/learning-domain.js \
 && node --check /app/src/learning-service.js \
 && node --check /app/src/learning-sql.js \
 && node --check /app/scripts/upgrade-ic2304-session2-speaking.mjs \
 && node --check /app/scripts/check-ic2304-release.mjs \
 && node --input-type=module -e "import { buildIc2304Session2SpeakingDefinition, buildIc2304Session2SpeakingGradingKey } from '/app/src/learning-templates/ic2304-session2-speaking.js'; const form = buildIc2304Session2SpeakingDefinition(); const key = buildIc2304Session2SpeakingGradingKey(['A','A','A','A','A']); if (form.blocks.length !== 3 || Object.keys(key.items).length !== 5) process.exit(1);"

USER node

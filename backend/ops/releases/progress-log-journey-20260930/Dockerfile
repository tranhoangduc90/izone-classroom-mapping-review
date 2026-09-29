FROM speaking-docs-event:20260929-fix2

USER root
# Đầu vào: image production đã đọc lại. Kiểm từng module trước khi phủ Journey.
# Nếu source production thay đổi, dừng build để đối chiếu lại thay vì ghi đè.
RUN test "$(sha256sum /app/src/app.js | cut -d' ' -f1)" = '1c34d61a44fe7124ef04eb87f64f804e81191547e79c4e8a8225ef8042567141' \
 && test "$(sha256sum /app/src/config.js | cut -d' ' -f1)" = '065fcca9abd238f47d82b052155fa5790b083d4d27235ea579136c910f4dcb38' \
 && test "$(sha256sum /app/src/learning-routes.js | cut -d' ' -f1)" = '4173b2beccad28dc2b5d1b40650f23c9fc70786dd81e53eb8af386253b35a35c' \
 && test "$(sha256sum /app/src/learning-service.js | cut -d' ' -f1)" = '1dfbb7ae672b0085a17840730dc14b38ff1b57c9e2d1583157623141149907d6' \
 && test "$(sha256sum /app/src/learning-sql.js | cut -d' ' -f1)" = '33499d8ca6d2b4029d17e0a49c7505a4bf541ec0351665cef20a5275c1bf60bd' \
 && test "$(sha256sum /app/src/auth.js | cut -d' ' -f1)" = 'af50eac4d39f0c0c4e9c5042e672b3fbd34d52a18e9f094072e0d8451858394b' \
 && test "$(sha256sum /app/src/server.js | cut -d' ' -f1)" = 'fd5288050a1c771e15d8e70d12592e406fab7b6bd5a9cb43a1ac7e7b6a707e41' \
 && test "$(sha256sum /app/src/learning-attendance-worker.js | cut -d' ' -f1)" = 'fbfee853fecf12d1ae55aeb750b245b71934438f3dbfa55c67cd670335eaae2d'
COPY src/ /app/src/
RUN node --check /app/src/app.js \
 && node --check /app/src/config.js \
 && node --check /app/src/learning-routes.js \
 && node --check /app/src/learning-service.js \
 && node --check /app/src/learning-sql.js \
 && node --check /app/src/learning-erp-schedule.js \
 && node --check /app/src/learning-test-sources.js \
 && node --check /app/src/learning-test-results.js
USER node

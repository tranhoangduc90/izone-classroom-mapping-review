FROM speaking-lesson4:20260930-v1

USER root
# Đầu vào: image production đã đọc lại. Kiểm từng module trước khi phủ Journey.
# Nếu source production thay đổi, dừng build để đối chiếu lại thay vì ghi đè.
RUN test "$(sha256sum /app/src/app.js | cut -d' ' -f1)" = '1c34d61a44fe7124ef04eb87f64f804e81191547e79c4e8a8225ef8042567141' \
 && test "$(sha256sum /app/src/config.js | cut -d' ' -f1)" = '065fcca9abd238f47d82b052155fa5790b083d4d27235ea579136c910f4dcb38' \
 && test "$(sha256sum /app/src/learning-routes.js | cut -d' ' -f1)" = '4173b2beccad28dc2b5d1b40650f23c9fc70786dd81e53eb8af386253b35a35c' \
 && test "$(sha256sum /app/src/learning-service.js | cut -d' ' -f1)" = '1dfbb7ae672b0085a17840730dc14b38ff1b57c9e2d1583157623141149907d6' \
 && test "$(sha256sum /app/src/learning-sql.js | cut -d' ' -f1)" = '33499d8ca6d2b4029d17e0a49c7505a4bf541ec0351665cef20a5275c1bf60bd' \
 && test "$(sha256sum /app/src/auth.js | cut -d' ' -f1)" = 'af50eac4d39f0c0c4e9c5042e672b3fbd34d52a18e9f094072e0d8451858394b' \
 && test "$(sha256sum /app/src/server.js | cut -d' ' -f1)" = '5aa0068436adfaf1b1ea1b815ffa59a5c5011d6bf7ae045415fc181c182234e5' \
 && test "$(sha256sum /app/src/sql.js | cut -d' ' -f1)" = '474cde7d05fac8741ac80358ef46efff338196e2d7769c7562ce95d9625e9b8e' \
 && test "$(sha256sum /app/src/term-test-writing-grading.js | cut -d' ' -f1)" = '4919aa77a6e21a17c965898aa38637bea3a999f7d08c5bb51b3c9e2df0e80276' \
 && test "$(sha256sum /app/src/learning-attendance-worker.js | cut -d' ' -f1)" = 'fbfee853fecf12d1ae55aeb750b245b71934438f3dbfa55c67cd670335eaae2d'
COPY src/ /app/src/
RUN test -f /app/src/term-test-writing-notifier.js \
 && node --check /app/src/app.js \
 && node --check /app/src/config.js \
 && node --check /app/src/server.js \
 && node --check /app/src/sql.js \
 && node --check /app/src/term-test-writing-grading.js \
 && node --check /app/src/term-test-writing-notifier.js \
 && node --check /app/src/learning-routes.js \
 && node --check /app/src/learning-service.js \
 && node --check /app/src/learning-sql.js \
 && node --check /app/src/learning-erp-schedule.js \
 && node --check /app/src/learning-test-sources.js \
 && node --check /app/src/learning-test-results.js
USER node

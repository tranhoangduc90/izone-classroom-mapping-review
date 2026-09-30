FROM izone-speaking-lesson2:20260930-v1
# Giữ image API chung đã kiểm; chỉ thay các module Speaking thuộc gói này.
COPY speaking-catalog.js speaking-homework.js speaking-homework-routes.js speaking-classroom-copies.js speaking-alerts.js /app/src/
RUN node --check /app/src/speaking-catalog.js && node --check /app/src/speaking-homework.js && node --check /app/src/speaking-homework-routes.js && node --check /app/src/speaking-classroom-copies.js && node --check /app/src/speaking-alerts.js

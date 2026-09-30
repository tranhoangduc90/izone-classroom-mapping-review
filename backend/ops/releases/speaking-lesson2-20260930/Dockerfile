FROM izone-progress-log-journey:20260930-rc3
COPY speaking-homework.js /app/src/speaking-homework.js
COPY speaking-homework-routes.js /app/src/speaking-homework-routes.js
RUN node --check /app/src/speaking-homework.js && node --check /app/src/speaking-homework-routes.js

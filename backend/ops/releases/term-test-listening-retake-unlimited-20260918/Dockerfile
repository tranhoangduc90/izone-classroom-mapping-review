FROM izone-term-test-backend:20260916.4-progress-log-checkpoint-retry

USER root
COPY manifest.json listening-retake-unlimited.patch apply-unified-patch.mjs /tmp/
RUN node /tmp/apply-unified-patch.mjs /app /tmp/listening-retake-unlimited.patch /tmp/manifest.json \
  && node --check /app/src/app.js \
  && node --check /app/src/sql.js \
  && rm /tmp/manifest.json /tmp/listening-retake-unlimited.patch /tmp/apply-unified-patch.mjs
USER node

FROM izone-term-test-backend:20260920.1-teacher-session

USER root
COPY ops/releases/dashboard-access-hardening-20260920/manifest.json \
  ops/releases/dashboard-access-hardening-20260920/apply-dashboard-access-hardening.mjs \
  /tmp/
RUN node /tmp/apply-dashboard-access-hardening.mjs /app /tmp/manifest.json

COPY src/teacher-class-access-sql.js src/teacher-class-access-health.js /tmp/dashboard-access-src/
COPY scripts/check-teacher-class-access.mjs scripts/teacher-dashboard-canary.mjs /tmp/dashboard-access-scripts/
RUN install -m 0644 /tmp/dashboard-access-src/teacher-class-access-sql.js /app/src/teacher-class-access-sql.js \
  && install -m 0644 /tmp/dashboard-access-src/teacher-class-access-health.js /app/src/teacher-class-access-health.js \
  && install -m 0644 /tmp/dashboard-access-scripts/check-teacher-class-access.mjs /app/scripts/check-teacher-class-access.mjs \
  && install -m 0644 /tmp/dashboard-access-scripts/teacher-dashboard-canary.mjs /app/scripts/teacher-dashboard-canary.mjs \
  && chmod 0644 /app/src/sql.js /app/src/learning-sql.js \
  && node --check /app/src/sql.js \
  && node --check /app/src/learning-sql.js \
  && node --check /app/src/teacher-class-access-sql.js \
  && node --check /app/src/teacher-class-access-health.js \
  && node --check /app/scripts/check-teacher-class-access.mjs \
  && node --check /app/scripts/teacher-dashboard-canary.mjs \
  && test "$(stat -c '%a' /app/src/sql.js)" = "644" \
  && test "$(stat -c '%a' /app/src/learning-sql.js)" = "644" \
  && rm -rf /tmp/dashboard-access-src /tmp/dashboard-access-scripts \
  && rm /tmp/manifest.json /tmp/apply-dashboard-access-hardening.mjs
USER node

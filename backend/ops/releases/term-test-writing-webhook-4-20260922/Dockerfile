FROM izone-term-test-backend:20260922.1-admin-access

USER root
COPY --chown=node:node src/server.js /app/src/server.js
RUN node --check /app/src/server.js \
  && node --check /app/src/term-test-writing-grading.js \
  && node --check /app/src/term-test-writing-notifier.js
USER node

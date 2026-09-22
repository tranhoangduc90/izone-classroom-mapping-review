FROM et-unit1-phase1-mapping-review-api:kindfix

USER root
COPY ops/releases/admin-term-test-access-20260922/manifest.json \
  ops/releases/admin-term-test-access-20260922/production.patch \
  ops/releases/term-test-listening-retake-20260911/apply-unified-patch.mjs \
  /tmp/
RUN node /tmp/apply-unified-patch.mjs /app /tmp/production.patch /tmp/manifest.json \
  && node --check /app/src/auth.js \
  && node --check /app/src/app.js \
  && node --check /app/src/sql.js \
  && rm /tmp/manifest.json /tmp/production.patch /tmp/apply-unified-patch.mjs
USER node

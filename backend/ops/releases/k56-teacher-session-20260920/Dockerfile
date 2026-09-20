FROM izone-k56-live-results:20260915.1

USER root
COPY ops/releases/k56-teacher-session-20260920/manifest.json \
  ops/releases/k56-teacher-session-20260920/k56-session.patch \
  ops/releases/term-test-listening-retake-20260911/apply-unified-patch.mjs \
  /tmp/
RUN node /tmp/apply-unified-patch.mjs /app /tmp/k56-session.patch /tmp/manifest.json

COPY src/auth.js /tmp/auth.js
RUN sed -i 's/\r$//' /tmp/auth.js \
  && test "$(sha256sum /app/src/auth.js | cut -d' ' -f1)" = "7a576a7cc1cf6923c00504761e842cb28238009a2bfeea9dc599158e9fc46b85" \
  && test "$(sha256sum /tmp/auth.js | cut -d' ' -f1)" = "ccecebfedebbf6cf1170991a1d5243ebbf91b98e5b9baf9b500c26764dcfe132" \
  && install -m 0644 /tmp/auth.js /app/src/auth.js \
  && node --check /app/src/app.js \
  && node --check /app/src/config.js \
  && node --check /app/src/auth.js \
  && rm /tmp/manifest.json /tmp/k56-session.patch /tmp/apply-unified-patch.mjs /tmp/auth.js
USER node

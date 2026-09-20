FROM izone-term-test-backend:20260918.1-listening-retake-unlimited

USER root
COPY ops/releases/teacher-session-20260920/manifest.json \
  ops/releases/teacher-session-20260920/app-session.patch \
  ops/releases/term-test-listening-retake-20260911/apply-unified-patch.mjs \
  /tmp/
RUN node /tmp/apply-unified-patch.mjs /app /tmp/app-session.patch /tmp/manifest.json

COPY src/auth.js /tmp/auth.js
COPY src/config.js /tmp/config.js
RUN sed -i 's/\r$//' /tmp/auth.js /tmp/config.js \
  && test "$(sha256sum /app/src/auth.js | cut -d' ' -f1)" = "7a576a7cc1cf6923c00504761e842cb28238009a2bfeea9dc599158e9fc46b85" \
  && test "$(sha256sum /app/src/config.js | cut -d' ' -f1)" = "ee711cdf9e37265fb83259bde88eed1b3e11e1ac6ac98718e4731890294d6026" \
  && test "$(sha256sum /tmp/auth.js | cut -d' ' -f1)" = "ccecebfedebbf6cf1170991a1d5243ebbf91b98e5b9baf9b500c26764dcfe132" \
  && test "$(sha256sum /tmp/config.js | cut -d' ' -f1)" = "302bb853067408cfeaece566e223c68837adb7f32097b4ad208fa2fd8f3fed00" \
  && install -m 0644 /tmp/auth.js /app/src/auth.js \
  && install -m 0644 /tmp/config.js /app/src/config.js \
  && node --check /app/src/app.js \
  && node --check /app/src/auth.js \
  && node --check /app/src/config.js \
  && rm /tmp/manifest.json /tmp/app-session.patch /tmp/apply-unified-patch.mjs /tmp/auth.js /tmp/config.js
USER node

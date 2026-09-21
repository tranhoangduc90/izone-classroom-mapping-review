FROM izone-term-test-backend:20260920.2-dashboard-access

USER root
COPY src/learning-contracts.js /tmp/learning-contracts.js
COPY src/learning-domain.js /tmp/learning-domain.js
COPY src/learning-templates/ic2305-entrance-listening1-speaking2.js /tmp/ic2305-entrance-listening1-speaking2.js
COPY scripts/publish-ic2305-progress-log.mjs /tmp/publish-ic2305-progress-log.mjs

RUN sed -i 's/\r$//' \
      /tmp/learning-contracts.js \
      /tmp/learning-domain.js \
      /tmp/ic2305-entrance-listening1-speaking2.js \
      /tmp/publish-ic2305-progress-log.mjs \
  && test "$(sha256sum /app/src/learning-contracts.js | cut -d' ' -f1)" = "58d26cb188941b5213df3dc7e62d751c08efffaba984786281bfeb525a721065" \
  && test "$(sha256sum /app/src/learning-domain.js | cut -d' ' -f1)" = "77b482c66f28ce223e639041786ba45edf5025fcc364bddf1cf87abe8a58847a" \
  && test "$(sha256sum /tmp/learning-contracts.js | cut -d' ' -f1)" = "5730a49d048e50fa5538b342c06cecd0e8f355215aa4926778ed200ec1a8dad5" \
  && test "$(sha256sum /tmp/learning-domain.js | cut -d' ' -f1)" = "bc13e1d11e23f7c45f830d9400149d2cf7519e658fa58d9b888a823812b0ef0a" \
  && install -m 0644 /tmp/learning-contracts.js /app/src/learning-contracts.js \
  && install -m 0644 /tmp/learning-domain.js /app/src/learning-domain.js \
  && install -m 0644 /tmp/ic2305-entrance-listening1-speaking2.js /app/src/learning-templates/ic2305-entrance-listening1-speaking2.js \
  && install -m 0644 /tmp/publish-ic2305-progress-log.mjs /app/scripts/publish-ic2305-progress-log.mjs \
  && node --check /app/src/learning-contracts.js \
  && node --check /app/src/learning-domain.js \
  && node --check /app/src/learning-templates/ic2305-entrance-listening1-speaking2.js \
  && node --check /app/scripts/publish-ic2305-progress-log.mjs \
  && rm \
      /tmp/learning-contracts.js \
      /tmp/learning-domain.js \
      /tmp/ic2305-entrance-listening1-speaking2.js \
      /tmp/publish-ic2305-progress-log.mjs
USER node

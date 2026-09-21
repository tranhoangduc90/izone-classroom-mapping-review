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
  && echo BASE_HASHES_OK \
  && test "$(sha256sum /tmp/learning-contracts.js | cut -d' ' -f1)" = "2a1133ed0d6f3e777fe4047de1534e744ebffec124fbc5046c51e682e63b76f7" \
  && test "$(sha256sum /tmp/learning-domain.js | cut -d' ' -f1)" = "16044ed12fed8fe17f2bde3348cd515b3d7f9f12200d31a625fd51e5cc4962fd" \
  && echo NEW_HASHES_OK \
  && install -m 0644 /tmp/learning-contracts.js /app/src/learning-contracts.js \
  && install -m 0644 /tmp/learning-domain.js /app/src/learning-domain.js \
  && install -m 0644 /tmp/ic2305-entrance-listening1-speaking2.js /app/src/learning-templates/ic2305-entrance-listening1-speaking2.js \
  && install -m 0644 /tmp/publish-ic2305-progress-log.mjs /app/scripts/publish-ic2305-progress-log.mjs \
  && echo FILES_INSTALLED \
  && node --check /app/src/learning-contracts.js \
  && node --check /app/src/learning-domain.js \
  && node --check /app/src/learning-templates/ic2305-entrance-listening1-speaking2.js \
  && node --check /app/scripts/publish-ic2305-progress-log.mjs \
  && echo NODE_CHECKED \
  && rm \
      /tmp/learning-contracts.js \
      /tmp/learning-domain.js \
      /tmp/ic2305-entrance-listening1-speaking2.js \
      /tmp/publish-ic2305-progress-log.mjs
USER node

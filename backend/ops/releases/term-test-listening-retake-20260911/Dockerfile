FROM mapping-review-api:learning-audio-resume-20260910

USER root
COPY manifest.json listening-retake.patch apply-unified-patch.mjs /tmp/
RUN node /tmp/apply-unified-patch.mjs /app /tmp/listening-retake.patch /tmp/manifest.json \
  && node --check /app/src/app.js \
  && node --check /app/src/sql.js \
  && rm /tmp/manifest.json /tmp/listening-retake.patch /tmp/apply-unified-patch.mjs
USER node

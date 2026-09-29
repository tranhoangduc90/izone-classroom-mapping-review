FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY ops/learning-migrations ./ops/learning-migrations
COPY ops/learning-demo/*.sql ./ops/learning-demo/

RUN mkdir -p /app/demo-data && chown node:node /app/demo-data
USER node
EXPOSE 8797

HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:8797/health >/dev/null || exit 1

CMD ["node", "src/learning-demo-server.js"]

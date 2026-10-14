FROM node:24.15.0-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY src ./src
COPY db ./db
COPY tools/seed-content.mjs tools/bootstrap-database.mjs tools/register-copy.mjs tools/operate.mjs ./tools/
USER node
EXPOSE 8818
CMD ["node","src/server.js"]

FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY src ./src
USER node
ENV PORT=4341
EXPOSE 4341
CMD ["node","src/server.js"]

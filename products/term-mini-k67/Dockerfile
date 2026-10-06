FROM node@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
ENV K67_ENV=production
ENV K67_PORT=8796
USER node
EXPOSE 8796
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node --input-type=module -e "const r=await fetch('http://127.0.0.1:'+process.env.K67_PORT+'/ready');process.exit(r.ok?0:1)"
CMD ["node", "src/server.js"]

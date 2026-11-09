# syntax=docker/dockerfile:1
# DispatchDesk — single container: Express API + built React client + SQLite + in-process scheduler.

ARG NODE_IMAGE=node:24-bookworm-slim

# ---- 1. Build the client -------------------------------------------------
FROM ${NODE_IMAGE} AS client-build
WORKDIR /build/client
COPY client/package.json client/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY client/ ./
RUN npm run build

# ---- 2. Install server dependencies (native better-sqlite3) --------------
FROM ${NODE_IMAGE} AS server-deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /build/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server/prisma ./prisma
COPY server/prisma.config.mjs ./
RUN DATABASE_URL=file:/tmp/build.db npx prisma generate

# ---- 3. Runtime ----------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    PORT=3000 \
    DATA_DIR=/data \
    DATABASE_URL=file:/data/app.db \
    CLIENT_DIST=/app/client/dist
WORKDIR /app/server
COPY --from=server-deps /build/server/node_modules ./node_modules
COPY server/ ./
COPY --from=client-build /build/client/dist /app/client/dist
# Browser extension source, zipped on demand by GET /api/extension/download
COPY extension/ /app/extension/
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
  && rm -rf tests data \
  && mkdir -p /data/uploads \
  && chown -R node:node /data /app

USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "src/index.js"]

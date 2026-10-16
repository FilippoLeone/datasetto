# syntax=docker/dockerfile:1.7
# ---- build -----------------------------------------------------------------
FROM node:24-bookworm-slim AS build
# Toolchain so better-sqlite3 can compile when no prebuilt binary matches this Node ABI.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY assets ./assets
RUN npm run build && npm prune --omit=dev

# ---- runtime ---------------------------------------------------------------
FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    PORT=4000 \
    HOST=0.0.0.0 \
    TRUST_PROXY=true \
    DATABASE_PATH=/data/datasetto.db \
    LOG_FORMAT=json
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data && chown node:node /data
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/assets ./assets
COPY --chown=node:node package.json ./
USER node
VOLUME ["/data"]
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]

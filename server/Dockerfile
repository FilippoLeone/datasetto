# syntax=docker/dockerfile:1.7
# ---- base ------------------------------------------------------------------
# Both stages start here. The oldest Node the image may run is 24.22.1, which fixes
# CVE-2026-111497 (an out-of-bounds write in Node's bundled Brotli decoder). The tag
# floats so later patch releases flow in; this check stops a build that picked up a
# stale cached base image.
FROM node:24-bookworm-slim AS base
ARG NODE_FLOOR=24.22.1
RUN node <<'EOF'
const floor = process.env.NODE_FLOOR;
const want = floor.split('.').map(Number);
const have = process.versions.node.split('.').map(Number);
if (have[0] !== want[0]) {
  console.error('The base image has Node ' + process.versions.node + ' but NODE_FLOOR ' + floor + ' is for Node ' + want[0] + '. Set NODE_FLOOR to the first patched release of the new line.');
  process.exit(1);
}
if (have[1] < want[1] || (have[1] === want[1] && have[2] < want[2])) {
  console.error('Node ' + process.versions.node + ' is older than the security floor ' + floor + ' (CVE-2026-111497). Pull a newer base image (docker build --pull) and build again.');
  process.exit(1);
}
console.log('Node ' + process.versions.node + ' meets the security floor ' + floor);
EOF

# ---- build -----------------------------------------------------------------
FROM base AS build
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
FROM base
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

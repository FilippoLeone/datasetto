# syntax=docker/dockerfile:1.7
# Builds the web client and serves it with Caddy (TLS + reverse proxy).
FROM node:24-bookworm-slim AS build
# Node only runs at build time here, but the floor matches server/Dockerfile: 24.22.1 fixes
# CVE-2026-111497 (Brotli decoder). The tag floats; the check stops a stale cached base.
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
ARG SITE_URL=
# Release version of this build (the tag without the v); the app compares it with
# the latest GitHub release once a day. Empty means "unknown": no update notice.
ARG APP_VERSION=
ENV VITE_SITE_URL=${SITE_URL}
ENV VITE_APP_VERSION=${APP_VERSION}
WORKDIR /src
COPY client/package.json client/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY client/ ./
# client/src/features/activity/catalogue.test.ts type-checks the desktop shell game matcher
# from ../../../../desktop/games; the tsc gate in `npm run build` needs it at that path.
COPY desktop/games /desktop/games
RUN npm run build

FROM caddy:2.11-alpine
COPY ops/caddy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /src/dist /srv
# Fail the build on a broken Caddyfile (placeholders need a value to validate).
RUN SITE_ADDRESS=:80 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:8081/healthz || exit 1

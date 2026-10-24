# The coturn relay: the upstream image with its Alpine packages brought up to date.
# coturn/coturn:4.18-alpine3.24 was last rebuilt on 8 September 2026 and so misses Alpine's
# security fixes since then (Brotli 1.2.1-r0 for CVE-2026-111497 among them). turnserver itself
# is coturn's own build and is not touched. CI passes a new APK_REFRESH on every build, so the
# upgrade layer never comes from the cache. ops/docker-compose.yml mounts entrypoint.sh at run time.
FROM coturn/coturn:4.18-alpine3.24
USER root
ARG APK_REFRESH=
RUN echo "Alpine packages for build ${APK_REFRESH:-local}" && apk upgrade --no-cache
# The upstream image runs as nobody; keep it that way.
USER nobody:nogroup

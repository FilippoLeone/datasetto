#!/usr/bin/env bash
# Runs on the VM (via deploy.sh or manually): sync code, env and containers.
set -euo pipefail
APP_DIR=/opt/datasetto
META=http://metadata.google.internal/computeMetadata/v1/instance/attributes
meta() { curl -fsS -H 'Metadata-Flavor: Google' "$META/$1" 2>/dev/null || true; }

cd "$APP_DIR"
REF="$(meta datasetto-ref)"; REF="${REF:-main}"
git fetch --quiet --all --tags
git checkout --quiet "$REF"
git pull --quiet --ff-only 2>/dev/null || true

ENV_CONTENT="$(meta datasetto-env)"
if [[ -n "$ENV_CONTENT" ]]; then
  printf '%s\n' "$ENV_CONTENT" > ops/.env
  chmod 600 ops/.env
fi

cd ops
docker compose pull --quiet || echo "image pull failed; keeping current images" >&2
docker compose up -d --remove-orphans
docker image prune -f >/dev/null
docker compose ps

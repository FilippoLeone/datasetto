#!/bin/bash
# Nightly SQLite backup. Runs on the VM from /etc/cron.daily.
#   backup.sh [gcs-bucket]
# Keeps 7 local copies under /var/backups/datasetto; uploads to the bucket when given.
set -euo pipefail
BUCKET="${1:-}"
APP_DIR=/opt/datasetto
LOCAL_DIR=/var/backups/datasetto
STAMP="$(date -u +%Y-%m-%d_%H%M)"
NAME="datasetto-${STAMP}.db"

mkdir -p "$LOCAL_DIR"
cd "$APP_DIR/ops"
docker compose exec -T app node dist/scripts/backup.js "/data/backups/${NAME}"
docker compose cp "app:/data/backups/${NAME}" "$LOCAL_DIR/${NAME}"
docker compose exec -T app sh -c 'find /data/backups -name "*.db" -mtime +2 -delete' || true
gzip -f "$LOCAL_DIR/${NAME}"

if [[ -n "$BUCKET" ]]; then
  gcloud storage cp "$LOCAL_DIR/${NAME}.gz" "gs://${BUCKET}/${NAME}.gz" --quiet
fi

ls -1t "$LOCAL_DIR"/*.gz 2>/dev/null | tail -n +8 | xargs -r rm -f
echo "$(date -Is) backup ${NAME}.gz ok"

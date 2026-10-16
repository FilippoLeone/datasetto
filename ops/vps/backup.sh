#!/bin/bash
# Daily SQLite backup for a VPS install. Runs from the systemd timer
# datasetto-backup.timer that ops/vps/install.sh sets up; run it by hand any time.
#
# Same method as ops/gcp/backup.sh: the app container writes a consistent copy
# with SQLite's online backup API (safe while the server runs), the copy is
# gzipped into /var/backups/datasetto and the 14 newest copies are kept. When
# BACKUP_RCLONE_REMOTE is set in ops/.env (any rclone remote and path, for
# example "b2:my-bucket/datasetto" or "gdrive:datasetto-backups"), the copy is
# also uploaded there and uploads older than 30 days are removed from that
# directory.
#
#   backup.sh                               back up now
#   APP_DIR=/srv/datasetto backup.sh        checkout somewhere else than /opt/datasetto
#   BACKUP_KEEP=30 backup.sh                keep more local copies
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/datasetto}"
LOCAL_DIR="${BACKUP_DIR:-/var/backups/datasetto}"
KEEP="${BACKUP_KEEP:-14}"
REMOTE_KEEP_DAYS="${BACKUP_REMOTE_KEEP_DAYS:-30}"
STAMP="$(date -u +%Y-%m-%d_%H%M)"
NAME="datasetto-${STAMP}.db"

log() { printf '%s %s\n' "$(date -Is)" "$*"; }

env_value() {
  grep -E "^$1=" "$APP_DIR/ops/.env" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '\r' \
    | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/" || true
}
REMOTE="${BACKUP_RCLONE_REMOTE:-$(env_value BACKUP_RCLONE_REMOTE)}"

mkdir -p "$LOCAL_DIR"
chmod 700 "$LOCAL_DIR"
cd "$APP_DIR/ops"

# Consistent copy inside the container, then out to the host.
docker compose exec -T app node dist/scripts/backup.js "/data/backups/${NAME}"
docker compose cp "app:/data/backups/${NAME}" "$LOCAL_DIR/${NAME}"
docker compose exec -T app sh -c 'find /data/backups -name "*.db" -mtime +2 -delete' || true
gzip -f "$LOCAL_DIR/${NAME}"
chmod 600 "$LOCAL_DIR/${NAME}.gz"

# Local retention: newest $KEEP copies.
copies() { find "$LOCAL_DIR" -maxdepth 1 -name 'datasetto-*.db.gz' -printf '%T@ %p
' | sort -rn | cut -d' ' -f2-; }
copies | tail -n +"$(( KEEP + 1 ))" | xargs -r rm -f

status=0
if [[ -n "$REMOTE" ]]; then
  if ! command -v rclone >/dev/null 2>&1; then
    log "BACKUP_RCLONE_REMOTE is set but rclone is not installed (apt-get install rclone)" >&2
    status=1
  elif rclone copyto "$LOCAL_DIR/${NAME}.gz" "${REMOTE%/}/${NAME}.gz" --quiet; then
    rclone delete "$REMOTE" --include 'datasetto-*.db.gz' --min-age "${REMOTE_KEEP_DAYS}d" --max-depth 1 --quiet \
      || log "could not prune old copies on $REMOTE" >&2
  else
    log "upload of ${NAME}.gz to $REMOTE failed; the local copy is fine" >&2
    status=1
  fi
fi

log "backup ${NAME}.gz ok ($(du -h "$LOCAL_DIR/${NAME}.gz" | cut -f1)), $(copies | wc -l) local copies in $LOCAL_DIR${REMOTE:+, remote $REMOTE}"
exit "$status"

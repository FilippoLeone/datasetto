#!/bin/bash
# Restore a database backup into the app_data volume of a VPS install.
#
# Takes a copy written by ops/vps/backup.sh (datasetto-<stamp>.db.gz under
# /var/backups/datasetto, or the same file fetched back from the rclone remote)
# or any plain copy of datasetto.db. The checks and the copy itself run inside
# the app image (server/src/scripts/restore.ts): the backup must pass SQLite's
# integrity_check, be a Datasetto database, and carry a schema version this
# build knows (an older one is migrated at the next start; a newer one is
# refused). The stack is stopped for the copy, the live file is kept next to
# the restored one as datasetto.db.pre-restore-<stamp> (with its -wal/-shm),
# and the restored file is verified again: integrity_check plus the same row
# counts as the backup. Then the stack is started and waited for.
#
#   restore.sh /var/backups/datasetto/datasetto-2026-10-16_0400.db.gz            restore (asks first)
#   restore.sh <backup> --dry-run                                                verify only, stack untouched
#   restore.sh <backup> --yes                                                    no question (scripts)
#   APP_DIR=/srv/datasetto restore.sh <backup>                                   checkout elsewhere than /opt/datasetto
#
# Dry run first, always: it prints the backup's schema version and row counts
# next to the live database's, so you see what you are about to replace.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/datasetto}"
FILE=""
DRY_RUN=0
YES=0

usage() {
  sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --yes|-y) YES=1 ;;
    --help|-h) usage 0 ;;
    -*) echo "unknown option: $arg" >&2; usage 2 ;;
    *) FILE="$arg" ;;
  esac
done

log() { printf '%s %s\n' "$(date -Is)" "$*"; }
die() { log "$*" >&2; exit 1; }

[[ -n "$FILE" ]] || usage 2
[[ -f "$FILE" ]] || die "backup file not found: $FILE"
[[ -f "$APP_DIR/ops/docker-compose.yml" ]] || die "no Datasetto checkout in $APP_DIR (set APP_DIR)"
command -v docker >/dev/null 2>&1 || die "docker is not installed"
FILE="$(readlink -f "$FILE")"

cd "$APP_DIR/ops"

TMP="$(mktemp -d)"
chmod 700 "$TMP"
trap 'rm -rf "$TMP"' EXIT

case "$FILE" in
  *.gz) gunzip -c "$FILE" > "$TMP/backup.db" ;;
  *) cp "$FILE" "$TMP/backup.db" ;;
esac
chmod 600 "$TMP/backup.db"

# One-off app container: same image, env and data volume as the running service, plus the backup.
restore_in_app() {
  docker compose run --rm --no-deps -T -v "$TMP:/restore:ro" app node dist/scripts/restore.js /restore/backup.db "$@"
}

log "checking $FILE"
restore_in_app --dry-run
if (( DRY_RUN )); then
  log "dry run: the stack was not touched"
  exit 0
fi

if (( ! YES )); then
  if [[ ! -t 0 ]]; then
    die "no terminal to confirm on; pass --yes to restore without asking"
  fi
  printf 'Replace the live database with this backup? The stack is stopped meanwhile. [y/N] '
  read -r answer
  [[ "$answer" == "y" || "$answer" == "Y" ]] || die "aborted, nothing changed"
fi

log "stopping the stack"
docker compose stop
log "restoring"
restore_in_app
log "starting the stack"
docker compose up -d --remove-orphans

cid="$(docker compose ps -q app)"
for i in $(seq 1 45); do
  status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || echo unknown)"
  if [[ "$status" == "healthy" ]]; then
    log "app healthy after about $(( i * 2 )) s; restore done (the previous database is kept as datasetto.db.pre-restore-<stamp> in the volume)"
    exit 0
  fi
  sleep 2
done
log "app is '$status' after 90 s; check: cd $APP_DIR/ops && docker compose logs app" >&2
exit 1

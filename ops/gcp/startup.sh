#!/bin/bash
# GCE startup script: runs as root on every boot. Idempotent.
# Installs Docker, clones the repo, writes ops/.env from instance metadata and
# starts the stack. Also sets up swap (e2-micro has 1 GB RAM) and daily backups.
set -euo pipefail
exec > >(tee -a /var/log/datasetto-startup.log) 2>&1
echo "=== datasetto startup $(date -Is) ==="

APP_DIR=/opt/datasetto
META=http://metadata.google.internal/computeMetadata/v1/instance/attributes
meta() { curl -fsS -H 'Metadata-Flavor: Google' "$META/$1" 2>/dev/null || true; }

# ---- swap (1 GB RAM is tight while images are pulled) -----------------------
if ! swapon --show --noheadings | grep -q '^/swapfile'; then
  if [[ ! -f /swapfile ]]; then
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
  fi
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo 'vm.swappiness=10' > /etc/sysctl.d/90-datasetto.conf
  sysctl -q -p /etc/sysctl.d/90-datasetto.conf
fi

# ---- packages ----------------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
if ! command -v docker >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl git unattended-upgrades
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi
command -v git >/dev/null 2>&1 || apt-get install -y -qq git

# ---- code ----------------------------------------------------------------------
REPO="$(meta datasetto-repo)"; REPO="${REPO:-https://github.com/FilippoLeone/datasetto.git}"
REF="$(meta datasetto-ref)"; REF="${REF:-main}"
if [[ ! -d "$APP_DIR/.git" ]]; then
  git clone --quiet "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"
git fetch --quiet --all --tags
git checkout --quiet "$REF"
git pull --quiet --ff-only 2>/dev/null || true

# ---- configuration -------------------------------------------------------------
ENV_CONTENT="$(meta datasetto-env)"
if [[ -n "$ENV_CONTENT" ]]; then
  printf '%s\n' "$ENV_CONTENT" > ops/.env
  chmod 600 ops/.env
elif [[ ! -f ops/.env ]]; then
  echo "no datasetto-env metadata and no ops/.env; refusing to start" >&2
  exit 1
fi

# ---- run ---------------------------------------------------------------------------
cd ops
docker compose pull --quiet || echo "image pull failed; will try to build locally" >&2
docker compose up -d --remove-orphans || docker compose up -d --build --remove-orphans
docker compose ps

# ---- nightly backup to GCS (optional) ---------------------------------------
BUCKET="$(meta datasetto-backup-bucket)"
if [[ -n "$BUCKET" ]]; then
  cat > /etc/cron.daily/datasetto-backup <<EOF
#!/bin/bash
exec /bin/bash $APP_DIR/ops/gcp/backup.sh "$BUCKET" >> /var/log/datasetto-backup.log 2>&1
EOF
  chmod +x /etc/cron.daily/datasetto-backup
  echo "nightly backups to gs://$BUCKET enabled"
else
  rm -f /etc/cron.daily/datasetto-backup
fi

echo "=== datasetto startup done $(date -Is) ==="

#!/usr/bin/env bash
# Create the single VM that runs Datasetto on Google Cloud.
#
# Cheapest sensible setup: one e2-micro, 10 GB balanced disk, Standard network
# tier, ephemeral IP. Everything else (Docker, the app, TLS) is installed by
# ops/gcp/startup.sh on first boot. Re-running this script is safe: existing
# resources are left alone.
#
# Usage (from the repository root, after filling in ops/.env):
#   ops/gcp/create-vm.sh
#
# Tunables (environment variables):
#   PROJECT_ID=datasetto REGION=europe-west1 ZONE=europe-west1-b MACHINE_TYPE=e2-micro
#   STATIC_IP=false        reserve a static address (about 3 EUR/month extra, same as ephemeral while attached)
#   BUDGET_AMOUNT=15EUR    create a billing budget with 50/90/100 percent alerts (empty to skip)
#   BACKUP_BUCKET=         GCS bucket name for nightly SQLite backups (empty to skip)
#   GIT_REF=main           branch or tag the VM checks out
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=config.sh
source "$SCRIPT_DIR/config.sh"

ENV_FILE="$SCRIPT_DIR/../.env"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "ops/.env not found. Copy ops/.env.example, fill it in, then re-run." >&2
  exit 1
fi

env_value() { grep -E "^$1=" "$ENV_FILE" | tail -n1 | cut -d= -f2- | tr -d '\r'; }

SITE_ADDRESS="$(env_value SITE_ADDRESS)"
if [[ -z "$SITE_ADDRESS" || "$SITE_ADDRESS" == ":80" ]]; then
  echo "Warning: SITE_ADDRESS is '$SITE_ADDRESS'. Set it to your domain for automatic HTTPS." >&2
fi
if [[ "$(env_value REGISTRATION_MODE)" == "invite" && -z "$(env_value REGISTRATION_INVITE_CODE)" ]]; then
  echo "REGISTRATION_INVITE_CODE must be set when REGISTRATION_MODE=invite" >&2
  exit 1
fi
PROFILES="$(env_value COMPOSE_PROFILES)"

echo "==> Project $PROJECT_ID, zone $ZONE, machine $MACHINE_TYPE"
gcloud config set project "$PROJECT_ID" >/dev/null

echo "==> Enabling Compute Engine API (no-op if already enabled)"
gcloud services enable compute.googleapis.com >/dev/null

ensure_firewall() {
  local name="$1" rules="$2" description="$3" sources="${4:-0.0.0.0/0}"
  if gcloud compute firewall-rules describe "$name" >/dev/null 2>&1; then
    echo "    firewall $name exists"
  else
    gcloud compute firewall-rules create "$name" \
      --network=default --direction=INGRESS --priority=1000 --action=ALLOW \
      --rules="$rules" --source-ranges="$sources" --target-tags="$INSTANCE_TAG" \
      --description="$description" >/dev/null
    echo "    firewall $name created ($rules from $sources)"
  fi
}

echo "==> Firewall rules"
ensure_firewall "${INSTANCE}-web" "tcp:80,tcp:443,udp:443" "Datasetto web (HTTP/HTTPS/HTTP3)"
ensure_firewall "${INSTANCE}-rtmp" "tcp:1935" "Datasetto RTMP ingest (OBS, plain)"
ensure_firewall "${INSTANCE}-rtmps" "tcp:1936" "Datasetto RTMPS ingest (OBS over TLS)"
if [[ "$PROFILES" == *turn* ]]; then
  ensure_firewall "${INSTANCE}-turn" "tcp:3478,udp:3478,udp:49152-49400" "Datasetto TURN relay"
fi
# SSH only through Identity-Aware Proxy (gcloud compute ssh --tunnel-through-iap), never from the open internet.
ensure_firewall "${INSTANCE}-ssh-iap" "tcp:22" "Datasetto SSH via IAP" "35.235.240.0/20"
if gcloud compute firewall-rules describe default-allow-ssh >/dev/null 2>&1; then
  echo "    note: the default network still has 'default-allow-ssh' open to the world;"
  echo "          delete it once IAP SSH works: gcloud compute firewall-rules delete default-allow-ssh"
fi

ADDRESS_FLAG=""
if [[ "$STATIC_IP" == "true" ]]; then
  echo "==> Static IP"
  if ! gcloud compute addresses describe "${INSTANCE}-ip" --region="$REGION" >/dev/null 2>&1; then
    gcloud compute addresses create "${INSTANCE}-ip" --region="$REGION" --network-tier="$NETWORK_TIER" >/dev/null
  fi
  STATIC_ADDRESS="$(gcloud compute addresses describe "${INSTANCE}-ip" --region="$REGION" --format='value(address)')"
  ADDRESS_FLAG=",address=${STATIC_ADDRESS}"
fi

if [[ -n "$BACKUP_BUCKET" ]]; then
  echo "==> Backup bucket gs://$BACKUP_BUCKET"
  if ! gcloud storage buckets describe "gs://$BACKUP_BUCKET" >/dev/null 2>&1; then
    gcloud storage buckets create "gs://$BACKUP_BUCKET" --location="$REGION" --uniform-bucket-level-access >/dev/null
    echo '{"rule":[{"action":{"type":"Delete"},"condition":{"age":30}}]}' > /tmp/datasetto-lifecycle.json
    gcloud storage buckets update "gs://$BACKUP_BUCKET" --lifecycle-file=/tmp/datasetto-lifecycle.json >/dev/null
  fi
  PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
  gcloud storage buckets add-iam-policy-binding "gs://$BACKUP_BUCKET" \
    --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
    --role=roles/storage.objectAdmin >/dev/null
fi

echo "==> VM $INSTANCE"
if gcloud compute instances describe "$INSTANCE" --zone="$ZONE" >/dev/null 2>&1; then
  echo "    instance exists; updating metadata (env, repo, ref, startup script)"
  gcloud compute instances add-metadata "$INSTANCE" --zone="$ZONE" \
    --metadata-from-file="startup-script=$SCRIPT_DIR/startup.sh,datasetto-env=$ENV_FILE" \
    --metadata="datasetto-repo=$REPO_URL,datasetto-ref=$GIT_REF,datasetto-backup-bucket=$BACKUP_BUCKET" >/dev/null
else
  gcloud compute instances create "$INSTANCE" \
    --zone="$ZONE" \
    --machine-type="$MACHINE_TYPE" \
    --image-family=debian-12 --image-project=debian-cloud \
    --boot-disk-size="${DISK_SIZE_GB}GB" --boot-disk-type=pd-balanced \
    --network-interface="network-tier=${NETWORK_TIER},subnet=default${ADDRESS_FLAG}" \
    --tags="$INSTANCE_TAG" \
    --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
    --scopes=storage-rw,logging-write,monitoring-write \
    --metadata="enable-oslogin=TRUE,datasetto-repo=$REPO_URL,datasetto-ref=$GIT_REF,datasetto-backup-bucket=$BACKUP_BUCKET" \
    --metadata-from-file="startup-script=$SCRIPT_DIR/startup.sh,datasetto-env=$ENV_FILE" >/dev/null
  echo "    instance created"
fi

if [[ -n "$BUDGET_AMOUNT" ]]; then
  echo "==> Billing budget ($BUDGET_AMOUNT)"
  BILLING_ACCOUNT="$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingAccountName)')"
  PROJECT_NUMBER="${PROJECT_NUMBER:-$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')}"
  if gcloud services enable billingbudgets.googleapis.com >/dev/null 2>&1 &&
     ! gcloud billing budgets list --billing-account="$BILLING_ACCOUNT" --format='value(displayName)' 2>/dev/null | grep -qx "${INSTANCE} monthly"; then
    gcloud billing budgets create --billing-account="$BILLING_ACCOUNT" --display-name="${INSTANCE} monthly" \
      --budget-amount="$BUDGET_AMOUNT" --filter-projects="projects/${PROJECT_NUMBER}" \
      --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0 >/dev/null \
      && echo "    budget created (alerts go to billing admins by email)" \
      || echo "    could not create budget; create one in the console (Billing > Budgets & alerts)" >&2
  else
    echo "    budget exists or Budget API unavailable"
  fi
fi

echo "==> Waiting for external IP"
for _ in $(seq 1 30); do
  IP="$(gcloud compute instances describe "$INSTANCE" --zone="$ZONE" --format='get(networkInterfaces[0].accessConfigs[0].natIP)' 2>/dev/null || true)"
  [[ -n "$IP" ]] && break
  sleep 2
done

cat <<EOF

Done. The VM is installing Docker and starting the stack (3-5 minutes).

  External IP : ${IP:-pending}
  Site        : ${SITE_ADDRESS}
  SSH         : gcloud compute ssh ${INSTANCE} --zone ${ZONE}
  Logs        : gcloud compute ssh ${INSTANCE} --zone ${ZONE} -- sudo journalctl -u google-startup-scripts -f
  App logs    : gcloud compute ssh ${INSTANCE} --zone ${ZONE} -- 'cd /opt/datasetto/ops && sudo docker compose logs -f --tail 100'

Next:
  1. Create a DNS A record: ${SITE_ADDRESS#:} -> ${IP:-<external ip>}
     (Caddy obtains the Let's Encrypt certificate automatically once DNS resolves.)
  2. Open https://${SITE_ADDRESS#:}/app and register; the first account becomes admin.
  3. OBS: server rtmps://${SITE_ADDRESS#:}:1936/live (TLS, once Caddy has the certificate;
     plain rtmp://${SITE_ADDRESS#:}/live also works), stream key from the channel's key dialog.
EOF

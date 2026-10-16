#!/usr/bin/env bash
# Delete everything create-vm.sh made (VM, firewall rules, static IP). Backups
# in the GCS bucket are kept. Asks for confirmation.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/config.sh"

read -r -p "Type the instance name ($INSTANCE) to delete it and its firewall rules: " CONFIRM
[[ "$CONFIRM" == "$INSTANCE" ]] || { echo "aborted"; exit 1; }

gcloud compute instances delete "$INSTANCE" --zone="$ZONE" --project="$PROJECT_ID" --quiet || true
for rule in "${INSTANCE}-web" "${INSTANCE}-rtmp" "${INSTANCE}-turn"; do
  gcloud compute firewall-rules delete "$rule" --project="$PROJECT_ID" --quiet 2>/dev/null || true
done
gcloud compute addresses delete "${INSTANCE}-ip" --region="$REGION" --project="$PROJECT_ID" --quiet 2>/dev/null || true
echo "deleted"

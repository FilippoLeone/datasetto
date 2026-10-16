#!/usr/bin/env bash
# Roll out the latest images/config to the VM: pull the git ref, pull images,
# recreate changed containers. Run from your machine.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/config.sh"

# Push the current ops/.env to instance metadata so the VM picks up config changes.
if [[ -f "$SCRIPT_DIR/../.env" ]]; then
  gcloud compute instances add-metadata "$INSTANCE" --zone="$ZONE" --project="$PROJECT_ID" \
    --metadata-from-file="datasetto-env=$SCRIPT_DIR/../.env" >/dev/null
fi

gcloud compute ssh "$INSTANCE" --zone="$ZONE" --project="$PROJECT_ID" --command='sudo bash /opt/datasetto/ops/gcp/update.sh'

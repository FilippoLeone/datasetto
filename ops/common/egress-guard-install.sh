#!/bin/bash
# Install or remove the monthly egress guard (ops/common/egress-guard.sh) as a
# systemd timer that runs every 5 minutes. Idempotent; safe to re-run.
#
#   egress-guard-install.sh            install or refresh the guard and enable the timer
#   egress-guard-install.sh --remove   disable the timer, lift any shaping, delete the units
#
# APP_DIR (default /opt/datasetto) is the checkout the guard reads ops/.env from.
# Used by ops/gcp/startup.sh (every boot) and ops/vps/install.sh (--egress-guard).
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/datasetto}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN=/usr/local/sbin/datasetto-egress-guard
SERVICE=/etc/systemd/system/datasetto-egress-guard.service
TIMER=/etc/systemd/system/datasetto-egress-guard.timer

if [[ "${1:-}" == "--remove" ]]; then
  if [[ -f "$TIMER" ]]; then
    systemctl disable --now datasetto-egress-guard.timer >/dev/null 2>&1 || true
  fi
  if [[ -x "$BIN" ]]; then
    APP_DIR="$APP_DIR" "$BIN" --lift || true
  fi
  rm -f "$BIN" "$SERVICE" "$TIMER"
  systemctl daemon-reload
  echo "egress guard removed"
  exit 0
fi

# The guard needs python3 (state file) and tc (iproute2). Both ship with Debian and
# Ubuntu server images; install them when a minimal image lacks them.
if ! command -v python3 >/dev/null 2>&1 || ! command -v tc >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3 iproute2
  else
    echo "egress guard needs python3 and tc (iproute2); install them first" >&2
    exit 1
  fi
fi

install -m 0755 "$SCRIPT_DIR/egress-guard.sh" "$BIN"
cat > "$SERVICE" <<UNIT
[Unit]
Description=Datasetto monthly egress guard

[Service]
Type=oneshot
Environment=APP_DIR=$APP_DIR
ExecStart=$BIN
UNIT
cat > "$TIMER" <<'UNIT'
[Unit]
Description=Run the Datasetto egress guard every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now datasetto-egress-guard.timer >/dev/null
echo "egress guard installed: $BIN, timer datasetto-egress-guard.timer (limits from $APP_DIR/ops/.env)"

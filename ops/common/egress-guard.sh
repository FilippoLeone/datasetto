#!/bin/bash
# Monthly egress backstop for the VM. Runs every few minutes from a systemd timer
# (installed by ops/common/egress-guard-install.sh: on every boot by ops/gcp/startup.sh,
# on request by ops/vps/install.sh --egress-guard). Counts bytes sent on the primary
# interface since the start of the month and, independently of anything the app does:
#   soft limit -> shapes all outgoing traffic to a trickle (chat and voice signalling
#                 keep working, streaming and relaying become useless);
#   hard limit -> additionally stops the rtmp and turn containers.
# Everything is lifted automatically on the first run of the next month.
#
# Limits come from ops/.env (EGRESS_SOFT_LIMIT_GB, EGRESS_HARD_LIMIT_GB); GB are
# decimal, like the cloud bill. State lives in /var/lib/datasetto/egress.json.
#
#   datasetto-egress-guard            one accounting run (what the timer does)
#   datasetto-egress-guard --status   same, then print the month-to-date figure
#   datasetto-egress-guard --lift     remove the shaping and restart the containers now;
#                                     the counter keeps counting, so the next timer run
#                                     re-applies the limit if it is still exceeded
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/datasetto}"
STATE_DIR=/var/lib/datasetto
STATE="$STATE_DIR/egress.json"
LOG=/var/log/datasetto-egress.log
IFACE="${IFACE:-$(ip -o -4 route show to default | awk '{print $5}' | head -n1)}"
SOFT_RATE="${EGRESS_SOFT_RATE:-1mbit}"

log() { printf '%s %s\n' "$(date -Is)" "$*" | tee -a "$LOG"; }

# A key missing from .env must fall through to the default, not abort (pipefail).
if [[ -f "$APP_DIR/ops/.env" ]]; then
  SOFT_GB="$(grep -E '^EGRESS_SOFT_LIMIT_GB=' "$APP_DIR/ops/.env" | tail -n1 | cut -d= -f2 | tr -d '[:space:]' || true)"
  HARD_GB="$(grep -E '^EGRESS_HARD_LIMIT_GB=' "$APP_DIR/ops/.env" | tail -n1 | cut -d= -f2 | tr -d '[:space:]' || true)"
fi
SOFT_GB="${SOFT_GB:-190}"
HARD_GB="${HARD_GB:-230}"
SOFT_BYTES=$(( SOFT_GB * 1000000000 ))
HARD_BYTES=$(( HARD_GB * 1000000000 ))

[[ -n "$IFACE" ]] || { log "no default interface found"; exit 0; }
TX="$(cat "/sys/class/net/$IFACE/statistics/tx_bytes")"
MONTH="$(date -u +%Y-%m)"
mkdir -p "$STATE_DIR"

# state: month, last (counter at last run), total (bytes this month), level (0 none, 1 soft, 2 hard)
if [[ -f "$STATE" ]]; then
  read -r S_MONTH S_LAST S_TOTAL S_LEVEL < <(python3 - "$STATE" <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))
print(s.get("month", ""), s.get("last", 0), s.get("total", 0), s.get("level", 0))
PY
)
else
  S_MONTH=""; S_LAST=0; S_TOTAL=0; S_LEVEL=0
fi

lift() {
  tc qdisc del dev "$IFACE" root 2>/dev/null || true
  if command -v docker >/dev/null 2>&1 && [[ -d "$APP_DIR/ops" ]]; then
    (cd "$APP_DIR/ops" && docker compose start rtmp turn >/dev/null 2>&1) || true
  fi
}

if [[ "${1:-}" == "--lift" ]]; then
  log "lifting limits on request (month $MONTH, $(( S_TOTAL / 1000000000 )) GB used so far)"
  lift
  [[ -n "$S_MONTH" ]] || S_LAST="$TX"
  python3 - "$STATE" "$MONTH" "$S_LAST" "$S_TOTAL" 0 <<'PY'
import json, sys
json.dump({"month": sys.argv[2], "last": int(sys.argv[3]), "total": int(sys.argv[4]), "level": int(sys.argv[5])}, open(sys.argv[1], "w"))
PY
  exit 0
fi

if [[ "$S_MONTH" != "$MONTH" ]]; then
  if [[ -n "$S_MONTH" ]]; then
    log "new month $MONTH: previous month $S_MONTH used $(( S_TOTAL / 1000000000 )) GB; lifting limits"
    lift
  fi
  S_LAST="$TX"; S_TOTAL=0; S_LEVEL=0
fi

# Counter reset (reboot) -> count everything since boot.
if (( TX < S_LAST )); then
  S_TOTAL=$(( S_TOTAL + TX ))
else
  S_TOTAL=$(( S_TOTAL + TX - S_LAST ))
fi
S_LAST="$TX"

LEVEL=0
if (( S_TOTAL >= HARD_BYTES )); then LEVEL=2; elif (( S_TOTAL >= SOFT_BYTES )); then LEVEL=1; fi

if (( LEVEL >= 1 && S_LEVEL < 1 )); then
  log "soft limit reached: $(( S_TOTAL / 1000000000 )) GB >= ${SOFT_GB} GB; shaping egress to $SOFT_RATE"
  tc qdisc replace dev "$IFACE" root tbf rate "$SOFT_RATE" burst 64kbit latency 400ms
fi
if (( LEVEL >= 2 && S_LEVEL < 2 )); then
  log "hard limit reached: $(( S_TOTAL / 1000000000 )) GB >= ${HARD_GB} GB; stopping rtmp and turn"
  (cd "$APP_DIR/ops" && docker compose stop rtmp turn >/dev/null 2>&1) || true
fi
if (( LEVEL > S_LEVEL )); then S_LEVEL=$LEVEL; fi

python3 - "$STATE" "$MONTH" "$S_LAST" "$S_TOTAL" "$S_LEVEL" <<'PY'
import json, sys
json.dump({"month": sys.argv[2], "last": int(sys.argv[3]), "total": int(sys.argv[4]), "level": int(sys.argv[5])}, open(sys.argv[1], "w"))
PY

if [[ "${1:-}" == "--status" ]]; then
  echo "month=$MONTH interface=$IFACE used_gb=$(( S_TOTAL / 1000000000 )) soft_gb=$SOFT_GB hard_gb=$HARD_GB level=$S_LEVEL"
fi

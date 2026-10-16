#!/bin/sh
# coturn entrypoint: ephemeral credentials (use-auth-secret) shared with the app
# through TURN_SECRET. Discovers the public IP on GCP when TURN_EXTERNAL_IP is empty.
set -eu

: "${TURN_SECRET:?TURN_SECRET is required}"

EXTERNAL_IP="${TURN_EXTERNAL_IP:-}"
if [ -z "$EXTERNAL_IP" ]; then
  EXTERNAL_IP=$(wget -qO- --timeout=2 --header 'Metadata-Flavor: Google' \
    http://169.254.169.254/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip 2>/dev/null || true)
fi
if [ -z "$EXTERNAL_IP" ]; then
  EXTERNAL_IP=$(wget -qO- --timeout=3 https://api.ipify.org 2>/dev/null || true)
fi

set -- \
  -n \
  --log-file=stdout \
  --listening-port="${TURN_PORT:-3478}" \
  --min-port="${TURN_MIN_PORT:-49152}" \
  --max-port="${TURN_MAX_PORT:-49400}" \
  --realm="${TURN_REALM:-datasetto}" \
  --use-auth-secret \
  --static-auth-secret="${TURN_SECRET}" \
  --fingerprint \
  --no-tls \
  --no-dtls \
  --no-cli \
  --no-multicast-peers \
  --stale-nonce=600 \
  --user-quota=24 \
  --total-quota=200 \
  --max-bps=4000000 \
  --denied-peer-ip=10.0.0.0-10.255.255.255 \
  --denied-peer-ip=172.16.0.0-172.31.255.255 \
  --denied-peer-ip=192.168.0.0-192.168.255.255 \
  --denied-peer-ip=169.254.0.0-169.254.255.255 \
  --denied-peer-ip=127.0.0.0-127.255.255.255

if [ -n "$EXTERNAL_IP" ]; then
  echo "coturn: advertising external IP $EXTERNAL_IP"
  set -- "$@" --external-ip="$EXTERNAL_IP"
else
  echo "coturn: WARNING no external IP detected; relay candidates may be unreachable" >&2
fi

exec turnserver "$@"

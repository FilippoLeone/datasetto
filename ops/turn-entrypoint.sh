#!/bin/sh
set -eu

TURN_CMD="turnserver \
  --log-file=stdout \
  --fingerprint \
  --simple-log \
  --no-cli \
  --no-tls \
  --no-dtls \
  --lt-cred-mech \
  --realm=${TURN_REALM:-yourdomain.com} \
  --server-name=${TURN_REALM:-yourdomain.com} \
  --user=${TURN_USERNAME:-turnuser}:${TURN_PASSWORD:-turnpass} \
  --listening-port=${TURN_PORT:-3478} \
  --min-port=${TURN_MIN_PORT:-49160} \
  --max-port=${TURN_MAX_PORT:-49200} \
  --stale-nonce \
  --verbose"

# Allow peers on private networks (needed for local testing and some NAT scenarios)
# Remove --no-multicast-peers to allow relay to private IPs
# Add allowed-peer-ip ranges for common private networks
TURN_CMD="$TURN_CMD --allowed-peer-ip=10.0.0.0-10.255.255.255"
TURN_CMD="$TURN_CMD --allowed-peer-ip=172.16.0.0-172.31.255.255"
TURN_CMD="$TURN_CMD --allowed-peer-ip=192.168.0.0-192.168.255.255"

if [ -n "${TURN_LISTENING_IP:-}" ]; then
  TURN_CMD="$TURN_CMD --listening-ip=${TURN_LISTENING_IP}"
else
  TURN_CMD="$TURN_CMD --listening-ip=0.0.0.0"
fi

if [ -n "${TURN_ALT_LISTENING_IP:-}" ]; then
  TURN_CMD="$TURN_CMD --alt-listening-ip=${TURN_ALT_LISTENING_IP}"
fi

if [ -n "${TURN_EXTERNAL_IP:-}" ]; then
  TURN_CMD="$TURN_CMD --external-ip=${TURN_EXTERNAL_IP}"
fi

if [ -n "${TURN_EXTRA_ARGS:-}" ]; then
  TURN_CMD="$TURN_CMD ${TURN_EXTRA_ARGS}"
fi

exec $TURN_CMD
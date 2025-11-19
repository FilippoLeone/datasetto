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
  --no-multicast-peers \
  --stale-nonce"

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

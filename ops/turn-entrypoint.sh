#!/bin/sh
set -eu

CONFIG_FILE="/tmp/turnserver.conf"

# Generate config file
cat > "$CONFIG_FILE" << EOF
listening-port=${TURN_PORT:-3478}
min-port=${TURN_MIN_PORT:-49160}
max-port=${TURN_MAX_PORT:-49200}
lt-cred-mech
realm=${TURN_REALM:-localhost}
server-name=${TURN_REALM:-localhost}
user=${TURN_USERNAME:-turnuser}:${TURN_PASSWORD:-turnpass}
fingerprint
stale-nonce
no-tls
no-dtls
simple-log
log-file=stdout
verbose
no-cli
listening-ip=${TURN_LISTENING_IP:-0.0.0.0}
allowed-peer-ip=10.0.0.0/8
allowed-peer-ip=172.16.0.0/12
allowed-peer-ip=192.168.0.0/16
allowed-peer-ip=127.0.0.0/8
EOF

# Add external IP if set
if [ -n "${TURN_EXTERNAL_IP:-}" ]; then
  echo "external-ip=${TURN_EXTERNAL_IP}" >> "$CONFIG_FILE"
fi

# Add alt listening IP if set
if [ -n "${TURN_ALT_LISTENING_IP:-}" ]; then
  echo "alt-listening-ip=${TURN_ALT_LISTENING_IP}" >> "$CONFIG_FILE"
fi

# Add any extra args as config lines
if [ -n "${TURN_EXTRA_ARGS:-}" ]; then
  echo "${TURN_EXTRA_ARGS}" >> "$CONFIG_FILE"
fi

echo "Starting TURN server with config:"
cat "$CONFIG_FILE"
echo "---"

exec turnserver -c "$CONFIG_FILE"
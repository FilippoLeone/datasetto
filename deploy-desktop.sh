#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CLIENT_DIR="$PROJECT_ROOT/client"
DESKTOP_DIR="$PROJECT_ROOT/desktop"

first_non_empty() {
  for value in "$@"; do
    if [ -n "${value//[[:space:]]/}" ]; then
      printf '%s' "$value"
      return 0
    fi
  done
  return 0
}

derive_rtmp_from_server() {
  local server="$1"
  if [ -z "${server//[[:space:]]/}" ]; then
    printf '%s' 'rtmp://localhost:1935/live'
    return 0
  fi

  local without_scheme="${server#*://}"
  local host="${without_scheme%%/*}"
  host="${host%%:*}"
  if [ -z "${host//[[:space:]]/}" ]; then
    host='localhost'
  fi
  printf 'rtmp://%s:1935/live' "$host"
}

if ! command -v npm >/dev/null 2>&1; then
  echo "[deploy-desktop] npm not found in PATH" >&2
  exit 1
fi

if [ ! -d "$CLIENT_DIR" ] || [ ! -d "$DESKTOP_DIR" ]; then
  echo "[deploy-desktop] client/ or desktop/ directory not found" >&2
  exit 1
fi

pushd "$CLIENT_DIR" >/dev/null
if [ ! -d node_modules ]; then
  echo "[deploy-desktop] Installing client dependencies..."
  npm install
fi

echo "[deploy-desktop] Building web client..."
VITE_BUILD_TARGET=desktop npm run build
popd >/dev/null

pushd "$DESKTOP_DIR" >/dev/null
if [ ! -d node_modules ]; then
  echo "[deploy-desktop] Installing desktop dependencies..."
  npm install
fi

# Generate runtime config from ops/.env if it exists
OPS_ENV="$PROJECT_ROOT/ops/.env"
RUNTIME_CONFIG="$DESKTOP_DIR/resources/runtime-config.json"
if [ -f "$OPS_ENV" ]; then
  echo "[deploy-desktop] Generating runtime-config.json from ops/.env..."
  
  DEFAULT_SERVER_URL=$(first_non_empty "$DATASETTO_SERVER_URL" "$VITE_SERVER_URL" 'http://localhost:4000')
  SERVER_URL=$(grep -E '^SERVER_URL=' "$OPS_ENV" | cut -d '=' -f2- | tr -d '\r')
  if [ -z "${SERVER_URL//[[:space:]]/}" ]; then
    SERVER_URL="$DEFAULT_SERVER_URL"
  fi
  if [ -z "${SERVER_URL//[[:space:]]/}" ]; then
    SERVER_URL='http://localhost:4000'
  fi

  DEFAULT_HLS_URL=$(first_non_empty "$DATASETTO_HLS_BASE_URL" "$VITE_HLS_BASE_URL")
  if [ -z "${DEFAULT_HLS_URL//[[:space:]]/}" ]; then
    DEFAULT_HLS_URL="${SERVER_URL%/}/hls"
  fi
  HLS_URL=$(grep -E '^HLS_BASE_URL=' "$OPS_ENV" | cut -d '=' -f2- | tr -d '\r')
  if [ -z "${HLS_URL//[[:space:]]/}" ]; then
    HLS_URL="$DEFAULT_HLS_URL"
  fi

  DEFAULT_RTMP_URL=$(first_non_empty "$DATASETTO_RTMP_SERVER_URL" "$VITE_RTMP_SERVER_URL")
  if [ -z "${DEFAULT_RTMP_URL//[[:space:]]/}" ]; then
    DEFAULT_RTMP_URL=$(derive_rtmp_from_server "$SERVER_URL")
  fi
  RTMP_URL=$(grep -E '^RTMP_SERVER_URL=' "$OPS_ENV" | cut -d '=' -f2- | tr -d '\r')
  if [ -z "${RTMP_URL//[[:space:]]/}" ]; then
    RTMP_URL="$DEFAULT_RTMP_URL"
  fi
  
  cat > "$RUNTIME_CONFIG" <<EOF
{
  "serverUrl": "$SERVER_URL",
  "apiBaseUrl": "$SERVER_URL",
  "hlsBaseUrl": "$HLS_URL",
  "rtmpServerUrl": "$RTMP_URL"
}
EOF
  
  echo "[deploy-desktop] Desktop runtime config: $SERVER_URL"
fi

echo "[deploy-desktop] Copying client build into renderer/"
node scripts/copy-dist.mjs

echo "[deploy-desktop] Packaging Electron application..."
npm run build
popd >/dev/null

echo "[deploy-desktop] Done. Installers available under desktop/release/"

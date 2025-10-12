#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CLIENT_DIR="$PROJECT_ROOT/client"
DESKTOP_DIR="$PROJECT_ROOT/desktop"

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
  
  SERVER_URL=$(grep -E '^SERVER_URL=' "$OPS_ENV" | cut -d '=' -f2 | tr -d '\r' || echo 'https://datasetto.com')
  HLS_URL=$(grep -E '^HLS_BASE_URL=' "$OPS_ENV" | cut -d '=' -f2 | tr -d '\r' || echo "${SERVER_URL}/hls")
  RTMP_URL=$(grep -E '^RTMP_SERVER_URL=' "$OPS_ENV" | cut -d '=' -f2 | tr -d '\r' || echo 'rtmp://datasetto.com:1935/hls')
  
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

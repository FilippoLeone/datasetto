#!/usr/bin/env bash
#
# Helper script to prepare the Capacitor mobile workspace.
# Installs dependencies (if missing), builds web assets with the
# production/mobile endpoints, and syncs Android and iOS platforms.
#
# Usage: ./deploy-mobile.sh [--force-install]

set -euo pipefail

PROJECT_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CLIENT_DIR="$PROJECT_ROOT/client"
MOBILE_DIR="$PROJECT_ROOT/mobile"
OPS_ENV="$PROJECT_ROOT/ops/.env"
CLIENT_MOBILE_ENV="$CLIENT_DIR/.env.mobile"
CLIENT_PROD_ENV="$CLIENT_DIR/.env.production"
FORCE_INSTALL=false

show_help() {
  cat <<EOF
Usage: $(basename "$0") [options]

Options:
  --force-install    Always run npm install in client/ and mobile/ even if node_modules exists
  -h, --help         Show this message and exit

The script builds the Vite client with production/mobile configuration
and runs "npm run sync" inside the mobile workspace so Android/iOS assets
are updated under mobile/android and mobile/ios.
EOF
}

while (($#)); do
  case "$1" in
    --force-install)
      FORCE_INSTALL=true
      shift
      ;;
    -h|--help)
      show_help
      exit 0
      ;;
    *)
      echo "[deploy-mobile] Unknown option: $1" >&2
      echo "Try --help for usage." >&2
      exit 1
      ;;
  esac
done

if ! command -v npm >/dev/null 2>&1; then
  echo "[deploy-mobile] npm not found in PATH" >&2
  exit 1
fi

if [ ! -d "$CLIENT_DIR" ] || [ ! -d "$MOBILE_DIR" ]; then
  echo "[deploy-mobile] client/ or mobile/ directory not found" >&2
  exit 1
fi

if [ ! -f "$OPS_ENV" ] && [ ! -f "$CLIENT_MOBILE_ENV" ] && [ ! -f "$CLIENT_PROD_ENV" ]; then
  cat <<EOF
[deploy-mobile] WARNING: No environment file detected.
  The build script will fall back to localhost URLs.
  Add configuration in ops/.env, client/.env.mobile, or client/.env.production
  to bake production endpoints into the mobile bundle.
EOF
fi

pushd "$CLIENT_DIR" >/dev/null
if [ "$FORCE_INSTALL" = true ] || [ ! -d node_modules ]; then
  echo "[deploy-mobile] Installing client dependencies..."
  npm install
else
  echo "[deploy-mobile] client/node_modules already present; skipping npm install"
fi
popd >/dev/null

pushd "$MOBILE_DIR" >/dev/null
if [ "$FORCE_INSTALL" = true ] || [ ! -d node_modules ]; then
  echo "[deploy-mobile] Installing mobile workspace dependencies..."
  npm install
else
  echo "[deploy-mobile] mobile/node_modules already present; skipping npm install"
fi

echo "[deploy-mobile] Building web assets and syncing Capacitor platforms..."
npm run sync
popd >/dev/null

echo ""
echo "[deploy-mobile] Done. Updated assets are now available under mobile/android and mobile/ios." 
echo "[deploy-mobile] Next steps:"
echo "  - Open Android Studio: (cd mobile && npm run open:android)"
echo "  - Open Xcode:         (cd mobile && npm run open:ios)"
echo "  - Build native binaries or create APK/IPA from the respective IDE."

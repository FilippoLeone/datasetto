#!/bin/bash
#
# VPS Deployment Script for Datasetto with Docker Nginx Proxy
# Prerequisites: Docker and Docker Compose already installed
#
# Usage: sudo bash deploy-vps.sh

set -e

echo "========================================"
echo "  Datasetto Deployment"
echo "========================================"
echo ""

# Check if running as root
if [ "$(id -u)" -ne 0 ]; then 
  echo "ERROR: Please run as root (use sudo)"
  exit 1
fi

# Verify Docker is installed
if ! command -v docker > /dev/null 2>&1; then
  echo "ERROR: Docker is not installed. Please install Docker first."
  exit 1
fi

if ! docker compose version > /dev/null 2>&1; then
  echo "ERROR: Docker Compose is not installed. Please install Docker Compose first."
  exit 1
fi

# Get server IP
SERVER_IP=$(hostname -I | awk '{print $1}')
echo "Detected server IP: $SERVER_IP"

detect_public_ip() {
  local ip=""
  if command -v curl >/dev/null 2>&1; then
    ip=$(curl -s https://api.ipify.org || true)
  fi
  if [ -z "$ip" ] && command -v dig >/dev/null 2>&1; then
    ip=$(dig +short myip.opendns.com @resolver1.opendns.com 2>/dev/null || true)
  fi
  if [ -z "$ip" ] && command -v wget >/dev/null 2>&1; then
    ip=$(wget -qO- https://api.ipify.org || true)
  fi
  echo "$ip"
}

# Prompt for domain (optional)
printf "Do you have a domain name? (yes/no): "
read HAS_DOMAIN
if [ "$HAS_DOMAIN" = "yes" ]; then
  printf "Enter your domain (e.g., stream.example.com): "
  read DOMAIN
  
  # With Docker nginx reverse proxy, always use path-based routing
  SERVER_URL_ABSOLUTE="https://$DOMAIN"
  SERVER_URL="https://$DOMAIN"
  HLS_BASE_URL="https://$DOMAIN/hls"
  API_BASE_URL="https://$DOMAIN"
  # Include mobile app origins (Capacitor uses https://localhost and capacitor://localhost)
  CORS_ORIGIN="https://$DOMAIN,https://localhost,capacitor://localhost,http://localhost"
  echo "Using domain with Caddy reverse proxy: $DOMAIN"
  
  printf "Enter email for Let's Encrypt SSL (required for HTTPS): "
  read LETSENCRYPT_EMAIL
else
  DOMAIN=$SERVER_IP
  SERVER_URL_ABSOLUTE="http://$SERVER_IP"
  SERVER_URL="http://$SERVER_IP"
  HLS_BASE_URL="http://$SERVER_IP/hls"
  API_BASE_URL="http://$SERVER_IP"
  # Include mobile app origins for IP-based deployments
  CORS_ORIGIN="http://$SERVER_IP,https://localhost,capacitor://localhost,http://localhost"
  echo "Using IP address with Caddy reverse proxy: $SERVER_IP"
  LETSENCRYPT_EMAIL="admin@localhost"
  CADDY_SITE_ADDRESS="http://$SERVER_IP"
fi

if [ "$HAS_DOMAIN" = "yes" ]; then
  CADDY_SITE_ADDRESS="$DOMAIN"
fi

# TURN defaults (override later in ops/.env if needed)
TURN_REALM=${DOMAIN}
TURN_USERNAME="turnuser"

generate_turn_password() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 16
  elif command -v head >/dev/null 2>&1 && command -v od >/dev/null 2>&1; then
    head -c 16 /dev/urandom | od -An -vtx1 | tr -d ' \n'
  else
    date +%s | sha256sum | cut -c1-32
  fi
}

TURN_PASSWORD=$(generate_turn_password)

PUBLIC_IP_DETECTED=$(detect_public_ip)
if [ -z "$PUBLIC_IP_DETECTED" ]; then
  PUBLIC_IP_DETECTED="$SERVER_IP"
fi

echo ""
echo "TURN server networking configuration:"
echo "(Leave blank to let coturn listen on all interfaces inside the container)"
printf "Listening IP (private interface) [%s]: " "$SERVER_IP"
read TURN_LISTENING_IP_INPUT
if [ -z "$TURN_LISTENING_IP_INPUT" ]; then
  TURN_LISTENING_IP=""
else
  TURN_LISTENING_IP="$TURN_LISTENING_IP_INPUT"
fi

printf "External/Public IP [%s]: " "$PUBLIC_IP_DETECTED"
read TURN_EXTERNAL_IP_INPUT
if [ -z "$TURN_EXTERNAL_IP_INPUT" ]; then
  TURN_EXTERNAL_IP="$PUBLIC_IP_DETECTED"
else
  TURN_EXTERNAL_IP="$TURN_EXTERNAL_IP_INPUT"
fi

printf "Alternate listening IP (optional, press Enter to skip): "
read TURN_ALT_LISTENING_IP_INPUT
if [ -z "$TURN_ALT_LISTENING_IP_INPUT" ]; then
  TURN_ALT_LISTENING_IP=""
else
  TURN_ALT_LISTENING_IP="$TURN_ALT_LISTENING_IP_INPUT"
fi

# Check if using Cloudflare or similar proxy
echo ""
printf "Are you using Cloudflare tunnel or proxy? (yes/no) [no]: "
read USING_CLOUDFLARE
if [ "$USING_CLOUDFLARE" = "yes" ]; then
  echo ""
  echo "⚠️  Cloudflare tunnels do NOT support UDP traffic."
  echo "   TURN server must be accessed via public IP, not domain."
  echo "   Make sure to port-forward UDP 3478 and 49160-49200 on your router."
  echo ""
  # Use public IP for TURN when behind Cloudflare
  TURN_URL="turn:${TURN_EXTERNAL_IP}:3478"
  RTMP_URL="rtmp://${TURN_EXTERNAL_IP}/live"
  # Caddy should listen on HTTP only - Cloudflare handles HTTPS
  CADDY_SITE_ADDRESS=":80"
else
  # Use domain for TURN when not behind proxy
  TURN_URL="turn:${DOMAIN}:3478"
  RTMP_URL="rtmp://${DOMAIN}/live"
  # Keep CADDY_SITE_ADDRESS as domain (Caddy manages TLS)
fi

# Navigate to ops directory (assuming script is run from project root)
echo ""
echo "[1/3] Configuring environment..."

if [ ! -d "./ops" ]; then
  echo "ERROR: ops directory not found. Please run this script from the project root."
  exit 1
fi

cd ops

write_env_file() {
  cat > .env <<EOF
# Production Environment Variables
# Generated by deploy-vps.sh on $(date -u +"%Y-%m-%dT%H:%M:%SZ")

NODE_ENV=production

# Security & Sessions
PASSWORD_MIN_LENGTH=8
ACCOUNT_SESSION_TTL_MS=86400000

# Server URLs
SERVER_URL=/
HLS_BASE_URL=/hls
API_BASE_URL=/api

# SEO: Site URL for Open Graph, Twitter Cards, JSON-LD
SITE_URL=$SERVER_URL_ABSOLUTE

# Mobile/Desktop Defaults (Absolute URLs required)
VITE_MOBILE_DEFAULT_SERVER_URL=$SERVER_URL_ABSOLUTE
VITE_MOBILE_DEFAULT_HLS_URL=$SERVER_URL_ABSOLUTE/hls
VITE_MOBILE_DEFAULT_RTMP_URL=$RTMP_URL

# CORS Configuration
CORS_ORIGIN=$CORS_ORIGIN

# Resource Limits
MAX_CONNECTIONS_PER_IP=10
MAX_CHANNELS=50
MAX_USERS_PER_CHANNEL=50

# Server Port
PORT=4000
HOST=0.0.0.0

# TURN / Voice (update credentials as needed)
TURN_REALM=$TURN_REALM
TURN_USERNAME=$TURN_USERNAME
TURN_PASSWORD=$TURN_PASSWORD
TURN_PORT=3478
TURN_MIN_PORT=49160
TURN_MAX_PORT=49200
TURN_LISTENING_IP=$TURN_LISTENING_IP
TURN_ALT_LISTENING_IP=$TURN_ALT_LISTENING_IP
TURN_EXTERNAL_IP=$TURN_EXTERNAL_IP
TURN_EXTRA_ARGS=
VITE_TURN_URL=$TURN_URL
VITE_TURN_USERNAME=$TURN_USERNAME
VITE_TURN_CREDENTIAL=$TURN_PASSWORD
VITE_VOICE_OPUS_BITRATE=64000
VITE_VOICE_DTX_ENABLED=true
VITE_VOICE_OPUS_STEREO=false
VITE_VOICE_OPUS_MIN_PTIME=10
VITE_VOICE_OPUS_MAX_PTIME=20
VITE_VOICE_OPUS_MAX_PLAYBACK_RATE=48000
VITE_VOICE_VAD_THRESHOLD=0.07

# Reverse proxy (Caddy)
CADDY_SITE_ADDRESS=$CADDY_SITE_ADDRESS

# Deployment Info
DEPLOYED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
SERVER_IP=$SERVER_IP
DOMAIN=$DOMAIN
LETSENCRYPT_EMAIL=$LETSENCRYPT_EMAIL
EOF
  echo "Environment file created"
}

# Check if .env already exists
if [ -f ".env" ]; then
  printf "WARNING: .env file already exists. Overwrite? (yes/no): "
  read OVERWRITE
  if [ "$OVERWRITE" != "yes" ]; then
    echo "Keeping existing .env file. Skipping configuration."
    echo ""
  else
    echo "Creating new .env file..."
    write_env_file
  fi
else
  echo "Creating .env file..."
  write_env_file
fi

# Deploy application
echo ""
echo "[2/3] Building and starting containers..."
docker compose -f docker-compose.prod.yml down 2>/dev/null || true
docker compose -f docker-compose.prod.yml build --no-cache
docker compose -f docker-compose.prod.yml up -d

# Wait for services to start
echo ""
echo "Waiting for services to start..."
sleep 15

# Check service status
echo ""
echo "[3/3] Verifying deployment..."
docker compose -f docker-compose.prod.yml ps

# Display access information
echo ""
echo "========================================"
echo "Deployment Complete!"
echo "========================================"
echo ""
echo "Access your application at:"
if [ "$HAS_DOMAIN" = "yes" ]; then
  echo "  Web Interface: https://$DOMAIN"
  echo "  Backend API: https://$DOMAIN"
  echo "  HLS Streams: https://$DOMAIN/hls"
  echo ""
  echo "Note: Using Caddy reverse proxy - web traffic routes through port 80/443"
  if [ "$USING_CLOUDFLARE" = "yes" ]; then
    echo ""
    echo "⚠️  CLOUDFLARE MODE:"
    echo "  TURN uses public IP: $TURN_EXTERNAL_IP (not proxied through Cloudflare)"
    echo "  Make sure UDP ports 3478 and 49160-49200 are forwarded to this server"
  else
    echo "Ensure RTMP port 1935 is reachable (direct or via proxy)"
    echo "If using Cloudflare or similar proxy, set DNS A record to: $SERVER_IP"
  fi
else
  echo "  Web Interface: http://$DOMAIN"
  echo "  Backend API: http://$DOMAIN"
  echo "  HLS Streams: http://$DOMAIN/hls"
fi
echo "  RTMP Server: $RTMP_URL"
echo "  TURN Server: $TURN_URL"
echo ""
echo "OBS Streaming Setup:"
echo "  Server: $RTMP_URL"
echo "  Stream Key: Generated in app (admin feature)"
echo ""
echo "Useful commands:"
echo "  View logs:    cd ops && docker compose -f docker-compose.prod.yml logs -f"
echo "  Restart:      cd ops && docker compose -f docker-compose.prod.yml restart"
echo "  Stop:         cd ops && docker compose -f docker-compose.prod.yml stop"
echo "  Rebuild:      cd ops && docker compose -f docker-compose.prod.yml up --build -d"
echo ""
echo "========================================"

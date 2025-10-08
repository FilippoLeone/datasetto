#!/bin/bash
#
# GCP Deployment Script for RTMP-Disc
# Deploys to Google Cloud Platform Compute Engine
#

set -e

echo "========================================"
echo "  RTMP-Disc GCP Deployment Script"
echo "========================================"
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Check if gcloud is installed
if ! command -v gcloud &> /dev/null; then
  echo -e "${RED}gcloud CLI not found. Please install it first:${NC}"
  echo "https://cloud.google.com/sdk/docs/install"
  exit 1
fi

# Configuration
echo -e "${BLUE}GCP Project Configuration${NC}"
echo ""

# Get or set project ID
read -p "Enter GCP Project ID: " PROJECT_ID
gcloud config set project $PROJECT_ID

# Set region and zone
read -p "Enter region (default: us-central1): " REGION
REGION=${REGION:-us-central1}
read -p "Enter zone (default: us-central1-a): " ZONE
ZONE=${ZONE:-us-central1-a}

# Instance configuration
read -p "Enter instance name (default: rtmp-disc): " INSTANCE_NAME
INSTANCE_NAME=${INSTANCE_NAME:-rtmp-disc}

# Machine type selection
echo ""
echo "Select machine type:"
echo "  1) e2-micro (1 vCPU, 1GB RAM) - Free tier eligible, ~\$7/month"
echo "  2) e2-small (2 vCPU, 2GB RAM) - ~\$14/month [RECOMMENDED]"
echo "  3) e2-medium (2 vCPU, 4GB RAM) - ~\$28/month"
echo "  4) e2-standard-2 (2 vCPU, 8GB RAM) - ~\$56/month"
read -p "Choice (1-4): " MACHINE_CHOICE

case $MACHINE_CHOICE in
  1) MACHINE_TYPE="e2-micro" ;;
  2) MACHINE_TYPE="e2-small" ;;
  3) MACHINE_TYPE="e2-medium" ;;
  4) MACHINE_TYPE="e2-standard-2" ;;
  *) MACHINE_TYPE="e2-small" ;;
esac

echo -e "${GREEN}Using machine type: $MACHINE_TYPE${NC}"

# Disk size
read -p "Enter boot disk size in GB (default: 30): " DISK_SIZE
DISK_SIZE=${DISK_SIZE:-30}

# Superuser secret
read -sp "Enter superuser secret password: " SUPERUSER_SECRET
echo ""
if [ -z "$SUPERUSER_SECRET" ]; then
  SUPERUSER_SECRET=$(openssl rand -base64 32)
  echo -e "${YELLOW}Generated random superuser secret${NC}"
fi

# Domain (optional)
read -p "Do you have a domain name? (yes/no): " HAS_DOMAIN
if [ "$HAS_DOMAIN" = "yes" ]; then
  read -p "Enter your domain (e.g., stream.example.com): " DOMAIN
  USE_DOMAIN=true
else
  DOMAIN=""
  USE_DOMAIN=false
fi

# Create startup script
echo -e "\n${GREEN}Creating startup script...${NC}"
cat > /tmp/startup-script.sh <<'EOFSTARTUP'
#!/bin/bash
set -e

# Update system
apt-get update
apt-get upgrade -y

# Install Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sh get-docker.sh
systemctl start docker
systemctl enable docker

# Install Docker Compose
apt-get install -y docker-compose-plugin git

# Create application directory
mkdir -p /opt/rtmp-disc
cd /opt/rtmp-disc

# Mark instance as configured
touch /opt/rtmp-disc/.configured
echo "Docker and dependencies installed. Ready for deployment."
EOFSTARTUP

# Create instance
echo -e "\n${GREEN}Creating GCP Compute Engine instance...${NC}"
gcloud compute instances create $INSTANCE_NAME \
  --project=$PROJECT_ID \
  --zone=$ZONE \
  --machine-type=$MACHINE_TYPE \
  --network-interface=network-tier=PREMIUM,subnet=default \
  --maintenance-policy=MIGRATE \
  --provisioning-model=STANDARD \
  --tags=rtmp-server,http-server,https-server \
  --create-disk=auto-delete=yes,boot=yes,device-name=$INSTANCE_NAME,image=projects/ubuntu-os-cloud/global/images/ubuntu-2204-jammy-v20240319,mode=rw,size=$DISK_SIZE,type=projects/$PROJECT_ID/zones/$ZONE/diskTypes/pd-balanced \
  --metadata-from-file=startup-script=/tmp/startup-script.sh \
  --scopes=https://www.googleapis.com/auth/devstorage.read_only,https://www.googleapis.com/auth/logging.write,https://www.googleapis.com/auth/monitoring.write

echo -e "${GREEN}Instance created!${NC}"

# Create firewall rules
echo -e "\n${GREEN}Creating firewall rules...${NC}"

gcloud compute firewall-rules create rtmp-disc-web --project=$PROJECT_ID --direction=INGRESS --priority=1000 --network=default --action=ALLOW --rules=tcp:80,tcp:443 --source-ranges=0.0.0.0/0 --target-tags=http-server,https-server || true
gcloud compute firewall-rules create rtmp-disc-streaming --project=$PROJECT_ID --direction=INGRESS --priority=1000 --network=default --action=ALLOW --rules=tcp:443,tcp:80,tcp:4000 --source-ranges=0.0.0.0/0 --target-tags=rtmp-server || true

# Get external IP
echo -e "\n${YELLOW}Waiting for instance...${NC}"
sleep 20
EXTERNAL_IP=$(gcloud compute instances describe $INSTANCE_NAME --zone=$ZONE --format='get(networkInterfaces[0].accessConfigs[0].natIP)')

echo ""
echo "========================================"
echo -e "${GREEN}GCP Instance Created!${NC}"
echo "========================================"
echo ""
echo "External IP: $EXTERNAL_IP"
echo "Superuser Secret: $SUPERUSER_SECRET"
echo ""
echo "Next: SSH and deploy your app"
echo "  gcloud compute ssh $INSTANCE_NAME --zone=$ZONE"
echo ""

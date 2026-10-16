#!/usr/bin/env bash
# Shared settings for the GCP scripts. Override any of these in your shell.
PROJECT_ID="${PROJECT_ID:-datasetto}"
REGION="${REGION:-europe-west1}"
ZONE="${ZONE:-${REGION}-b}"
INSTANCE="${INSTANCE:-datasetto}"
INSTANCE_TAG="${INSTANCE_TAG:-datasetto}"
# e2-micro (0.25-2 vCPU burst, 1 GB) is enough for a handful of friends.
# e2-small (2 GB) if you host large voice rooms or long game sessions.
MACHINE_TYPE="${MACHINE_TYPE:-e2-micro}"
DISK_SIZE_GB="${DISK_SIZE_GB:-10}"
# STANDARD tier egress is cheaper than PREMIUM; latency difference is negligible for this use.
NETWORK_TIER="${NETWORK_TIER:-STANDARD}"
REPO_URL="${REPO_URL:-https://github.com/FilippoLeone/datasetto.git}"
GIT_REF="${GIT_REF:-main}"
STATIC_IP="${STATIC_IP:-false}"
BUDGET_AMOUNT="${BUDGET_AMOUNT:-15EUR}"
BACKUP_BUCKET="${BACKUP_BUCKET:-}"

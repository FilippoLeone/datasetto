#!/bin/sh
# Docker entrypoint for nginx reverse proxy

set -e

# Copy config (no template substitution needed for now)
cp /etc/nginx/templates/default.conf.template /etc/nginx/conf.d/default.conf

# Test nginx configuration
nginx -t

# Execute CMD
exec "$@"

# Datasetto Desktop Builder for ARM64 (Radxa)
# Builds Linux releases natively on ARM64 hosts
#
# Usage:
#   docker compose -f docker-compose.builder.yml up --build

FROM node:20-bookworm

# Install build dependencies for Linux
RUN apt-get update && apt-get install -y \
    fakeroot \
    dpkg \
    rpm \
    imagemagick \
    git \
    zip \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /build

# Copy package files first for better caching
COPY desktop/package*.json ./desktop/
COPY client/package*.json ./client/

# Install dependencies
WORKDIR /build/client
RUN npm ci --legacy-peer-deps

WORKDIR /build/desktop
RUN npm ci

# Copy source code
WORKDIR /build
COPY client ./client
COPY desktop ./desktop

# Build client
WORKDIR /build/client
ENV VITE_BUILD_TARGET=desktop
RUN npm run build

# Prepare desktop renderer
WORKDIR /build/desktop
RUN node ./scripts/copy-dist.mjs

# Generate icons
RUN node ./scripts/generate-icon.mjs || true

# Clean previous release
RUN node ./scripts/clean-release.mjs || true

ENTRYPOINT ["npx", "electron-builder"]
CMD ["--linux", "AppImage", "deb"]

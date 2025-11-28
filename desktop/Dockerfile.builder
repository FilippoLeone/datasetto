# Multi-platform Electron Builder
# Builds Datasetto desktop app without requiring npm on host

FROM node:20-bookworm

# Install build dependencies
RUN apt-get update && apt-get install -y \
    # For Linux builds
    rpm \
    fakeroot \
    dpkg \
    # For Windows builds (Wine)
    wine64 \
    # For icon generation
    imagemagick \
    # Utilities
    git \
    zip \
    && rm -rf /var/lib/apt/lists/*

# Set Wine to 64-bit mode
ENV WINEARCH=win64
ENV WINEPREFIX=/root/.wine

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

# Default: build for current platform
# Override with: docker run ... --platform linux
ENTRYPOINT ["npx", "electron-builder"]
CMD ["--linux", "AppImage", "deb"]

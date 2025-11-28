#!/bin/bash
#
# Docker-based Desktop Build Script for Datasetto
# Builds Electron app without requiring npm/node on host machine
#
# Usage:
#   ./build-docker.sh              # Build for Linux (default)
#   ./build-docker.sh linux        # Build Linux AppImage + deb
#   ./build-docker.sh win          # Build Windows exe (via Wine)
#   ./build-docker.sh all          # Build all platforms
#
# The built artifacts will be in desktop/release/
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
PLATFORM="${1:-linux}"

echo ""
echo "🚀 Datasetto Docker Builder"
echo "============================"
echo "Platform: $PLATFORM"
echo ""

cd "$PROJECT_ROOT"

# Build the builder image
echo "📦 Building Docker image..."
docker build -t datasetto-builder -f desktop/Dockerfile.builder .

# Create output directory
mkdir -p desktop/release

# Run the builder with appropriate platform flags
case "$PLATFORM" in
    linux)
        echo "🐧 Building for Linux..."
        docker run --rm \
            -v "$PROJECT_ROOT/desktop/release:/build/desktop/release" \
            datasetto-builder \
            --linux AppImage deb
        ;;
    win|windows)
        echo "🪟 Building for Windows (via Wine)..."
        docker run --rm \
            -v "$PROJECT_ROOT/desktop/release:/build/desktop/release" \
            datasetto-builder \
            --win nsis portable
        ;;
    mac|macos)
        echo "🍎 macOS builds require a Mac host. Skipping..."
        exit 1
        ;;
    all)
        echo "🌍 Building for all platforms..."
        # Linux first (native)
        docker run --rm \
            -v "$PROJECT_ROOT/desktop/release:/build/desktop/release" \
            datasetto-builder \
            --linux AppImage deb
        # Windows via Wine
        docker run --rm \
            -v "$PROJECT_ROOT/desktop/release:/build/desktop/release" \
            datasetto-builder \
            --win nsis portable
        ;;
    *)
        echo "❌ Unknown platform: $PLATFORM"
        echo "Usage: $0 [linux|win|all]"
        exit 1
        ;;
esac

# Generate builds manifest
echo ""
echo "📝 Generating build manifest..."

# Simple manifest generation in bash
MANIFEST_FILE="$PROJECT_ROOT/desktop/release/builds.json"
VERSION=$(grep '"version"' "$PROJECT_ROOT/desktop/package.json" | head -1 | sed 's/.*"version": "\([^"]*\)".*/\1/')
BUILD_DATE=$(date -Iseconds)

cat > "$MANIFEST_FILE" << EOF
{
  "version": "$VERSION",
  "buildDate": "$BUILD_DATE",
  "builds": [
EOF

FIRST=true
for file in "$PROJECT_ROOT/desktop/release"/*; do
    filename=$(basename "$file")
    
    # Skip non-distributable files
    case "$filename" in
        *.blockmap|*.yml|*.yaml|builds.json|builder-*) continue ;;
    esac
    
    # Skip directories
    [ -d "$file" ] && continue
    
    # Get file size
    size=$(stat -c%s "$file" 2>/dev/null || stat -f%z "$file" 2>/dev/null || echo 0)
    
    # Determine platform
    platform="unknown"
    case "$filename" in
        *-win-*|*.exe) platform="windows" ;;
        *-mac-*|*.dmg) platform="macos" ;;
        *-linux-*|*.AppImage|*.deb) platform="linux" ;;
    esac
    
    # Determine arch
    arch="x64"
    case "$filename" in
        *arm64*|*aarch64*) arch="arm64" ;;
    esac
    
    # Determine type
    type="unknown"
    case "$filename" in
        *.exe) 
            if [[ "$filename" == *"portable"* ]]; then
                type="portable"
            else
                type="installer"
            fi
            ;;
        *.dmg) type="dmg" ;;
        *.AppImage) type="appimage" ;;
        *.deb) type="deb" ;;
        *.zip) type="zip" ;;
    esac
    
    # Format size
    if [ "$size" -gt 1073741824 ]; then
        size_fmt="$(echo "scale=2; $size/1073741824" | bc) GB"
    elif [ "$size" -gt 1048576 ]; then
        size_fmt="$(echo "scale=2; $size/1048576" | bc) MB"
    elif [ "$size" -gt 1024 ]; then
        size_fmt="$(echo "scale=2; $size/1024" | bc) KB"
    else
        size_fmt="$size Bytes"
    fi
    
    if [ "$FIRST" = true ]; then
        FIRST=false
    else
        echo "," >> "$MANIFEST_FILE"
    fi
    
    cat >> "$MANIFEST_FILE" << EOF
    {
      "filename": "$filename",
      "platform": "$platform",
      "arch": "$arch",
      "type": "$type",
      "size": $size,
      "sizeFormatted": "$size_fmt"
    }
EOF
done

cat >> "$MANIFEST_FILE" << EOF

  ]
}
EOF

echo ""
echo "✅ Build completed!"
echo ""
echo "📁 Artifacts in: $PROJECT_ROOT/desktop/release/"
ls -lh "$PROJECT_ROOT/desktop/release/" | grep -v '\.blockmap\|\.yml\|builder-'
echo ""
